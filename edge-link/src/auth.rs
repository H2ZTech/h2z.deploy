//! Edge-side access control (design: access-and-onboarding v1.6 §4, §7).
//!
//! * The edge is **locked** until it is claimed. A claim pins the cloud's Ed25519
//!   public key and the project id (one-time pairing secret `k` from the QR code,
//!   the edge signs a nonce so the cloud knows it talks to the real edge).
//! * After the claim every request must carry a cloud-signed short-lived token
//!   (`x-h2z-token`): audience = this edge, bound to the viewer's iroh endpoint id
//!   (so a stolen token is useless on another phone), with scope, camera list,
//!   stream type and expiry. A long stream is cut at the token's expiry.
//! * A signed roster (pulled from the cloud, cached on disk) revokes devices/users
//!   and may rotate cloud keys. Older than 24 h: internet paths are refused, LAN
//!   paths keep working.
//! * Every decision of interest is written to a sequenced audit log (JSONL).
//!
//! Token wire format: `h2z1.<b64url(json claims)>.<b64url(ed25519 sig over "h2z1."+b64payload)>`.
//! All ids on the wire are lowercase hex (64 chars) of the ed25519 public key.
use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use iroh::{endpoint::Connection, EndpointId, PublicKey, SecretKey, Signature};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::wire::ReqHead;

pub const TOKEN_HEADER: &str = "x-h2z-token";
pub const ROSTER_MAX_AGE: u64 = 24 * 3600;
const CLOCK_SKEW: u64 = 60;
const MAX_TOKEN_LIFE: u64 = 24 * 3600;
const AUDIT_RING: usize = 500;
/// audit.jsonl rotation (override: H2Z_AUDIT_MAX_BYTES / H2Z_AUDIT_KEEP; registered in scripts/log-limits.mjs)
pub const AUDIT_FILE_MAX: u64 = 5 * 1024 * 1024;
pub const AUDIT_KEEP: u32 = 1;
/// A clock before this is "never set" (a board without a working RTC boots in 1970 / the image build date).
/// 2026-01-01 00:00:00 UTC; bump when the product ships much later.
pub const MIN_SANE_UNIX: u64 = 1_767_225_600;
/// Edge clock vs. cloud time (roster `iat`): up to WARN is fine, up to MAX still served (warned), beyond refuses internet requests.
pub const CLOCK_WARN_SEC: i64 = 60;
pub const CLOCK_MAX_SEC: i64 = 300;

pub fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Clock sanity (pure, unit tested). `roster_at` = edge time of the last authentic cloud contact (0 = never),
/// `skew` = edge_now - cloud_time measured at that contact.
///   unset      clock earlier than MIN_SANE_UNIX (no RTC / battery dead)   -> internet refused
///   behind     clock earlier than our own last cloud contact               -> internet refused
///   skewed     |skew| > max                                                -> internet refused
///   drift      warn < |skew| <= max                                        -> served, warned
///   unverified no cloud contact since boot (offline start)                 -> served
///   ok
pub fn clock_eval(now: u64, roster_at: u64, skew: Option<i64>, warn: i64, max: i64) -> &'static str {
    if now < MIN_SANE_UNIX {
        return "unset";
    }
    if roster_at > 0 && now + CLOCK_SKEW < roster_at {
        return "behind";
    }
    match skew {
        Some(s) if s.abs() > max => "skewed",
        Some(s) if s.abs() > warn => "drift",
        Some(_) => "ok",
        None => "unverified",
    }
}

pub fn clock_refuses(state: &str) -> bool {
    matches!(state, "unset" | "behind" | "skewed")
}

// ---------------------------------------------------------------- claims

#[derive(Deserialize, Clone, Debug)]
pub struct Claims {
    pub v: u32,
    pub aud: String,
    pub prj: String,
    pub sub: String,
    #[serde(default)]
    pub role: String,
    /// "view" (live/replay, read-only) or "admin" (everything incl. device settings)
    pub scope: String,
    pub dev: String,
    /// camera ids, or ["*"] for all
    #[serde(default)]
    pub cams: Vec<String>,
    /// "sub" | "main" | "any"
    #[serde(default = "any_st")]
    pub st: String,
    pub iat: u64,
    pub exp: u64,
    #[serde(default)]
    pub jti: String,
}
fn any_st() -> String {
    "any".into()
}

/// Deny reason: (http status, stable machine code).
pub type Deny = (u16, &'static str);

pub fn parse_pubkey(s: &str) -> Result<PublicKey> {
    let b = B64.decode(s.trim()).context("pubkey base64url")?;
    let a: [u8; 32] = b.try_into().map_err(|_| anyhow!("pubkey must be 32 bytes"))?;
    Ok(PublicKey::from_bytes(&a)?)
}

fn verify_sig(keys: &[PublicKey], msg: &[u8], sig_b64: &str) -> bool {
    let Ok(sb) = B64.decode(sig_b64) else { return false };
    let Ok(arr) = <[u8; 64]>::try_from(sb) else { return false };
    let sig = Signature::from_bytes(&arr);
    keys.iter().any(|k| k.verify(msg, &sig).is_ok())
}

/// Pure token check (no I/O) — unit tested.
pub fn verify_token(
    keys: &[PublicKey],
    tok: &str,
    edge_hex: &str,
    project: &str,
    remote_hex: &str,
    now: u64,
) -> Result<Claims, Deny> {
    let mut it = tok.splitn(3, '.');
    let (Some("h2z1"), Some(p), Some(s)) = (it.next(), it.next(), it.next()) else {
        return Err((401, "token-malformed"));
    };
    if !verify_sig(keys, format!("h2z1.{p}").as_bytes(), s) {
        return Err((401, "token-signature"));
    }
    let c: Claims = serde_json::from_slice(&B64.decode(p).map_err(|_| (401, "token-malformed"))?)
        .map_err(|_| (401, "token-malformed"))?;
    if c.v != 1 {
        return Err((401, "token-version"));
    }
    if c.aud != edge_hex {
        return Err((403, "token-audience"));
    }
    if c.prj != project {
        return Err((403, "token-project"));
    }
    if c.dev != remote_hex {
        return Err((403, "token-device"));
    }
    if now + CLOCK_SKEW < c.iat || c.exp <= c.iat || c.exp - c.iat > MAX_TOKEN_LIFE {
        return Err((401, "token-time"));
    }
    if now >= c.exp {
        return Err((401, "token-expired"));
    }
    if c.scope != "view" && c.scope != "admin" {
        return Err((403, "token-scope"));
    }
    Ok(c)
}

/// First run of digits starting at `s`.
fn digits(s: &str) -> Option<String> {
    let d: String = s.chars().take_while(|c| c.is_ascii_digit()).collect();
    if d.is_empty() {
        None
    } else {
        Some(d)
    }
}

/// Camera id a request path refers to, if any.
fn cam_of(path: &str) -> Option<String> {
    let p = path.split('?').next().unwrap_or(path);
    for key in ["/devices/", "/cameras/"] {
        if let Some(i) = p.find(key) {
            if let Some(d) = digits(&p[i + key.len()..]) {
                return Some(d);
            }
        }
    }
    p.strip_prefix("/media/cam/").and_then(digits)
}

/// Stream type a request path asks for, if any ("sub" / "main").
pub fn stream_of(path: &str) -> Option<&'static str> {
    let (p, q) = path.split_once('?').unwrap_or((path, ""));
    if q.split('&').any(|kv| kv == "profile=main" || kv == "hevc=1") {
        return Some("main");
    }
    if q.split('&').any(|kv| kv == "profile=sub") {
        return Some("sub");
    }
    if let Some(r) = p.strip_prefix("/media/cam/") {
        let stem = r.split('.').next().unwrap_or(r);
        if stem.ends_with("_main") {
            return Some("main");
        }
        if stem.ends_with("_sub") {
            return Some("sub");
        }
    }
    // Recorder playback (`/recorder/ws|mp4|thumb?camera=<id>&stream=main|sub`) names the stream as `stream=`.
    // Lowest priority: profile= / hevc= / the media file name keep deciding when present. `main` wins over `sub`
    // if both appear (a repeated parameter must not downgrade a main request).
    if q.split('&').any(|kv| kv == "stream=main") {
        return Some("main");
    }
    if q.split('&').any(|kv| kv == "stream=sub") {
        return Some("sub");
    }
    None
}

/// Percent-decode for *classification only* (never forwarded): `%72ecorder` must not hide a `recorder` segment.
fn pct_decode_lossy(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hv = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hv(b[i + 1]), hv(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).to_ascii_lowercase()
}

/// Recorder playback endpoints of the backend (`<prefix>/recorder/ws|mp4|thumb|play|...`): any path (query removed)
/// with a `recorder` segment. The camera is named in the query / body, which the edge does not map to a granted
/// camera, so these are open only to tokens that may see every camera ("*").
fn is_recorder_path(path: &str) -> bool {
    let p = path.split('?').next().unwrap_or(path);
    pct_decode_lossy(p).split('/').any(|seg| seg == "recorder")
}

/// What a valid token may do. `admin` may do everything; `view` is read-only
/// (plus releasing/prewarming its own streams), never touches device settings,
/// and is limited to the token's cameras and stream type.
pub fn path_allowed(c: &Claims, method: &str, path: &str) -> Result<(), Deny> {
    if path.contains("..") || path.to_ascii_lowercase().contains("%2e") || path.to_ascii_lowercase().contains("%2f") {
        return Err((400, "bad-path"));
    }
    if c.scope == "admin" {
        return Ok(());
    }
    let p = path.split('?').next().unwrap_or(path);
    let all_cams = c.cams.iter().any(|x| x == "*");
    // Minimal playback guard (FM-913): recorder playback paths (`/recorder/ws|mp4|thumb|play`, WebSocket upgrades
    // included: they arrive here as a plain GET) are open only to all-camera tokens, whatever the method. The camera
    // is in `?camera=` / the body and is not matched against the token's list, so a camera-limited token is refused.
    let recorder = is_recorder_path(p);
    if recorder && !all_cams {
        return Err((403, "camera-not-granted"));
    }
    let read = method.eq_ignore_ascii_case("GET") || method.eq_ignore_ascii_case("HEAD");
    let live_ctl = method.eq_ignore_ascii_case("POST")
        && (p.ends_with("/network/live/release") || p.ends_with("/network/live/prewarm"));
    // Recording search / playback are POSTs that only read. Their cameras are named in the body, which the edge
    // does not parse, so they are open only to tokens that may see every camera ("*"); a token limited to some
    // cameras keeps getting scope-readonly here (it could otherwise query cameras it was not granted).
    let rec_legacy = p.ends_with("/recordings/query") || p.ends_with("/recordings/play");
    let rec_read = method.eq_ignore_ascii_case("POST")
        && (rec_legacy || (recorder && p.ends_with("/recorder/play")))
        && p.starts_with("/api/ioc/projects/")
        && all_cams;
    if !read && !live_ctl && !rec_read {
        return Err((403, "scope-readonly"));
    }
    if p.starts_with("/api/ioc/device/") {
        return Err((403, "scope-device-admin"));
    }
    // GET/HEAD on the legacy search/play paths: same rule (POST by a limited token already got scope-readonly above).
    if rec_legacy && !all_cams {
        return Err((403, "camera-not-granted"));
    }
    if let Some(cam) = cam_of(path) {
        if !c.cams.iter().any(|x| x == "*" || *x == cam) {
            return Err((403, "camera-not-granted"));
        }
    }
    if let (Some(want), true) = (stream_of(path), c.st != "any") {
        if want != c.st {
            return Err((403, "stream-type-not-granted"));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- state

#[derive(Serialize, Deserialize, Clone, Default, Debug)]
struct State {
    /// empty = unclaimed
    #[serde(default)]
    project: String,
    #[serde(default)]
    cloud_url: String,
    /// pinned cloud public keys (b64url)
    #[serde(default)]
    keys: Vec<String>,
    /// one-time pairing secret, only meaningful while unclaimed
    #[serde(default)]
    pair_secret: String,
    #[serde(default)]
    roster_seq: u64,
    /// last successful contact with the cloud (unix s)
    #[serde(default)]
    roster_at: u64,
    #[serde(default)]
    revoked_dev: Vec<String>,
    #[serde(default)]
    revoked_sub: Vec<String>,
    /// identity this state belongs to (hex). A state whose key was lost/replaced must not stay "claimed".
    #[serde(default)]
    edge_id: String,
    /// highest audit seq acknowledged by the cloud (upload cursor)
    #[serde(default)]
    audit_uploaded: u64,
    /// Fields this version does not know (contract 13.3 reserves `admin_pub`; later versions may add more):
    /// ignored for every decision, but kept byte-for-byte when the file is rewritten.
    #[serde(flatten)]
    extra: serde_json::Map<String, Value>,
}

pub struct Provision {
    pub keys: Vec<String>,
    pub project: String,
    pub cloud_url: String,
}

struct Audit {
    seq: AtomicU64,
    ring: Mutex<VecDeque<Value>>,
    file: PathBuf,
    max_bytes: u64,
    keep: u32,
    quiet: Mutex<HashMap<String, Instant>>,
}

impl Audit {
    fn load(file: PathBuf, max_bytes: u64, keep: u32) -> Self {
        let mut seq = 0;
        let mut ring = VecDeque::new();
        if let Ok(s) = std::fs::read_to_string(&file) {
            for l in s.lines().rev().take(AUDIT_RING) {
                if let Ok(v) = serde_json::from_str::<Value>(l) {
                    seq = seq.max(v["seq"].as_u64().unwrap_or(0));
                    ring.push_front(v);
                }
            }
        }
        // the rotated copy may hold the highest seq if the live file was just rotated
        if let Ok(s) = std::fs::read_to_string(rotated(&file, 1)) {
            for l in s.lines().rev().take(8) {
                if let Ok(v) = serde_json::from_str::<Value>(l) {
                    seq = seq.max(v["seq"].as_u64().unwrap_or(0));
                }
            }
        }
        Self { seq: AtomicU64::new(seq), ring: Mutex::new(ring), file, max_bytes, keep, quiet: Mutex::new(HashMap::new()) }
    }

    fn last_seq(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    fn log(&self, ev: &str, mut f: Value) {
        let seq = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        let m = f.as_object_mut().unwrap();
        m.insert("seq".into(), json!(seq));
        m.insert("ts".into(), json!(now_unix()));
        m.insert("ev".into(), json!(ev));
        let line = f.to_string();
        {
            let mut r = self.ring.lock().unwrap();
            r.push_back(f);
            while r.len() > AUDIT_RING {
                r.pop_front();
            }
        }
        if std::fs::metadata(&self.file).map(|m| m.len() > self.max_bytes).unwrap_or(false) {
            // audit.jsonl -> audit.jsonl.1 -> ... -> audit.jsonl.<keep> (oldest dropped): disk use <= (keep+1) * max_bytes
            for i in (1..=self.keep).rev() {
                let from = if i == 1 { self.file.clone() } else { rotated(&self.file, i - 1) };
                let _ = std::fs::rename(&from, rotated(&self.file, i));
            }
            if self.keep == 0 {
                let _ = std::fs::remove_file(&self.file);
            }
        }
        if let Ok(mut fh) = std::fs::OpenOptions::new().create(true).append(true).open(&self.file) {
            let _ = writeln!(fh, "{line}");
        }
    }

    /// Same (key) at most once per 30 s — denial floods must not eat the log.
    fn log_coalesced(&self, key: String, ev: &str, f: Value) {
        {
            let mut q = self.quiet.lock().unwrap();
            if let Some(t) = q.get(&key) {
                if t.elapsed().as_secs() < 30 {
                    return;
                }
            }
            q.insert(key, Instant::now());
            if q.len() > 1024 {
                q.retain(|_, t| t.elapsed().as_secs() < 30);
            }
        }
        self.log(ev, f);
    }

    fn tail(&self, n: usize) -> Vec<Value> {
        let r = self.ring.lock().unwrap();
        r.iter().rev().take(n).cloned().collect::<Vec<_>>().into_iter().rev().collect()
    }

    /// Events with seq > `after`, oldest first, at most `max` (reads the rotated copies and the live file,
    /// so an upload backlog bigger than the in-memory ring is not lost while the files still hold it).
    fn since(&self, after: u64, max: usize) -> Vec<Value> {
        let mut out: Vec<Value> = Vec::new();
        let mut files: Vec<PathBuf> = (1..=self.keep).rev().map(|i| rotated(&self.file, i)).collect();
        files.push(self.file.clone());
        for f in files {
            let Ok(s) = std::fs::read_to_string(&f) else { continue };
            for l in s.lines() {
                if let Ok(v) = serde_json::from_str::<Value>(l) {
                    if v["seq"].as_u64().unwrap_or(0) > after {
                        out.push(v);
                    }
                }
            }
        }
        out.sort_by_key(|v| v["seq"].as_u64().unwrap_or(0));
        out.dedup_by_key(|v| v["seq"].as_u64().unwrap_or(0));
        out.truncate(max);
        out
    }
}

fn rotated(file: &Path, i: u32) -> PathBuf {
    let mut n = file.as_os_str().to_owned();
    n.push(format!(".{i}"));
    PathBuf::from(n)
}

struct ConnEntry {
    dev: String,
    conn: Connection,
    logged: bool,
}

/// Tunables (CLI / env), see main.rs.
#[derive(Clone, Debug)]
pub struct Opts {
    pub audit_max_bytes: u64,
    pub audit_keep: u32,
    pub clock_warn: i64,
    pub clock_max: i64,
}
impl Default for Opts {
    fn default() -> Self {
        Self { audit_max_bytes: AUDIT_FILE_MAX, audit_keep: AUDIT_KEEP, clock_warn: CLOCK_WARN_SEC, clock_max: CLOCK_MAX_SEC }
    }
}

/// Last measured edge-vs-cloud clock difference (from an authentic roster `iat`).
#[derive(Default, Clone, Copy)]
struct ClockObs {
    skew: Option<i64>,
    at: u64,
}

pub struct Auth {
    id: EndpointId,
    id_hex: String,
    secret: SecretKey,
    file: PathBuf,
    dir: PathBuf,
    open: bool,
    legacy_allow: bool,
    opts: Opts,
    st: Mutex<State>,
    audit: Audit,
    clock: Mutex<ClockObs>,
    upload: Mutex<Value>,
    claim_fails: Mutex<(u32, Instant)>,
    conns: Mutex<HashMap<u64, ConnEntry>>,
    next: AtomicU64,
}

pub struct ConnGuard {
    a: Arc<Auth>,
    key: u64,
}
impl Drop for ConnGuard {
    fn drop(&mut self) {
        self.a.conns.lock().unwrap().remove(&self.key);
    }
}

fn save_state(file: &Path, st: &State) -> Result<()> {
    let tmp = file.with_extension("json.tmp");
    {
        #[cfg(unix)]
        let mut f = {
            use std::os::unix::fs::OpenOptionsExt;
            std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?
        };
        #[cfg(not(unix))]
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(serde_json::to_string_pretty(st)?.as_bytes())?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, file)?;
    Ok(())
}

impl Auth {
    /// `open` = explicit validation mode (no auth at all while unclaimed).
    /// `legacy_allow` = an `--allow` list was given (works only while unclaimed).
    pub fn load(
        secret: SecretKey,
        dir: &Path,
        open: bool,
        legacy_allow: bool,
        provision: Option<Provision>,
    ) -> Result<Arc<Self>> {
        Self::load_with(secret, dir, open, legacy_allow, provision, Opts::default(), now_unix())
    }

    /// Same as `load` with explicit tunables and "now" (tests / contract vectors use fixed time).
    pub fn load_with(
        secret: SecretKey,
        dir: &Path,
        open: bool,
        legacy_allow: bool,
        provision: Option<Provision>,
        opts: Opts,
        now: u64,
    ) -> Result<Arc<Self>> {
        std::fs::create_dir_all(dir).ok();
        let file = dir.join("auth.json");
        let id = secret.public();
        let id_hex = hex(id.as_bytes());
        let audit = Audit::load(dir.join("audit.jsonl"), opts.audit_max_bytes, opts.audit_keep);
        let mut dirty = false;
        let mut st: State = match std::fs::read_to_string(&file) {
            Ok(s) => match serde_json::from_str(&s) {
                Ok(v) => v,
                Err(e) => {
                    // A damaged state file must not crash-loop the container, and must not silently claim:
                    // keep the evidence, come back unclaimed (locked) with a fresh pairing secret.
                    let aside = dir.join(format!("auth.json.corrupt-{now}"));
                    let _ = std::fs::rename(&file, &aside);
                    tracing::error!("auth.json is damaged ({e}); moved to {} and starting unclaimed", aside.display());
                    audit.log("auth_corrupt", json!({"aside": aside.file_name().map(|n| n.to_string_lossy().to_string())}));
                    dirty = true;
                    State::default()
                }
            },
            Err(_) => State::default(),
        };
        // The state belongs to one identity. Key lost / replaced (factory reset of the key only) while auth.json
        // survived: the cloud knows the OLD id, so staying "claimed" would be a dead end with no pairing QR.
        if !st.project.is_empty() && !st.edge_id.is_empty() && st.edge_id != id_hex {
            let aside = dir.join(format!("auth.json.orphan-{now}"));
            let _ = std::fs::rename(&file, &aside);
            tracing::error!(old = %st.edge_id, new = %id_hex, "edge identity changed: dropping the old claim, starting unclaimed");
            audit.log("identity_changed", json!({"old": st.edge_id, "new": id_hex}));
            st = State::default();
            dirty = true;
        }
        if st.project.is_empty() {
            if let Some(p) = provision {
                st.project = p.project;
                st.cloud_url = p.cloud_url;
                st.keys = p.keys;
                st.roster_at = now;
                st.pair_secret.clear();
                dirty = true;
            } else if st.pair_secret.is_empty() {
                st.pair_secret = B64.encode(&SecretKey::generate().to_bytes()[..16]);
                dirty = true;
            }
        }
        if !st.project.is_empty() && st.edge_id != id_hex {
            st.edge_id = id_hex.clone(); // adopt (older state files had no edge_id)
            dirty = true;
        }
        // upload cursor ahead of the log (log lost / reset): start over, do not skip new events forever
        if st.audit_uploaded > audit.last_seq() {
            st.audit_uploaded = 0;
            dirty = true;
        }
        if dirty {
            save_state(&file, &st)?;
        }
        Ok(Arc::new(Self {
            id,
            id_hex,
            secret,
            audit,
            file,
            dir: dir.to_path_buf(),
            open,
            legacy_allow,
            opts,
            st: Mutex::new(st),
            clock: Mutex::new(ClockObs::default()),
            upload: Mutex::new(json!({"state": "off"})),
            claim_fails: Mutex::new((0, Instant::now())),
            conns: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
        }))
    }

    #[cfg(test)]
    pub fn test_pair_secret(&self) -> String {
        self.st.lock().unwrap().pair_secret.clone()
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Clock verdict now (see `clock_eval`).
    pub fn clock_state(&self, now: u64) -> &'static str {
        let roster_at = self.st.lock().unwrap().roster_at;
        let obs = *self.clock.lock().unwrap();
        clock_eval(now, roster_at, obs.skew, self.opts.clock_warn, self.opts.clock_max)
    }

    pub fn clock_json(&self, now: u64) -> Value {
        let obs = *self.clock.lock().unwrap();
        let state = self.clock_state(now);
        json!({
            "state": state,
            "skewSec": obs.skew,
            "checkedAt": if obs.at > 0 { Some(obs.at) } else { None },
            "now": now,
            "refusesInternet": clock_refuses(state),
            "warnSec": self.opts.clock_warn,
            "maxSec": self.opts.clock_max,
        })
    }

    /// Audit helper for the clock watcher in main (wall-clock jump vs monotonic).
    pub fn note_clock_jump(&self, delta: i64) {
        self.audit.log("clock_jump", json!({"deltaSec": delta}));
    }

    // ---- audit upload (local half): batches are read from the files, the cloud acknowledges by seq ----
    pub fn audit_pending(&self, max: usize) -> Vec<Value> {
        let after = self.st.lock().unwrap().audit_uploaded;
        self.audit.since(after, max)
    }
    pub fn audit_mark_uploaded(&self, seq: u64) -> Result<()> {
        let mut st = self.st.lock().unwrap();
        if seq > st.audit_uploaded {
            st.audit_uploaded = seq;
            save_state(&self.file, &st)?;
        }
        Ok(())
    }
    pub fn audit_counters(&self) -> (u64, u64) {
        (self.audit.last_seq(), self.st.lock().unwrap().audit_uploaded)
    }
    pub fn is_open_mode(&self) -> bool {
        self.open && !self.claimed()
    }

    pub fn id_hex(&self) -> &str {
        &self.id_hex
    }
    pub fn claimed(&self) -> bool {
        !self.st.lock().unwrap().project.is_empty()
    }
    pub fn cloud_url(&self) -> String {
        self.st.lock().unwrap().cloud_url.clone()
    }
    /// "token" (claimed) | "open" (validation) | "allowlist" (legacy, unclaimed) | "locked" (unclaimed)
    pub fn mode(&self) -> &'static str {
        if self.claimed() {
            "token"
        } else if self.open {
            "open"
        } else if self.legacy_allow {
            "allowlist"
        } else {
            "locked"
        }
    }
    /// QR payload for the integrator's phone; none once claimed.
    pub fn pair_payload(&self) -> Option<String> {
        let st = self.st.lock().unwrap();
        if !st.project.is_empty() {
            return None;
        }
        Some(format!("h2z://pair?v=1&id={}&k={}", self.id.to_z32(), st.pair_secret))
    }
    fn keys(&self) -> Vec<PublicKey> {
        self.st.lock().unwrap().keys.iter().filter_map(|k| parse_pubkey(k).ok()).collect()
    }
    pub fn roster_age(&self) -> Option<u64> {
        let st = self.st.lock().unwrap();
        if st.project.is_empty() {
            None
        } else {
            Some(now_unix().saturating_sub(st.roster_at))
        }
    }

    pub fn audit(&self, ev: &str, f: Value) {
        self.audit.log(ev, f);
    }
    pub fn audit_coalesced(&self, key: String, ev: &str, f: Value) {
        self.audit.log_coalesced(key, ev, f);
    }

    /// Claims of a valid, non-revoked token on this request (None = no/invalid token or unclaimed). Used by the
    /// info endpoint to decide whether to include LAN hints; `authorize_at` stays the gate for everything else.
    pub fn token_claims(&self, head: &ReqHead, remote_hex: &str, now: u64) -> Option<Claims> {
        let (keys, project, rev_dev, rev_sub) = {
            let st = self.st.lock().unwrap();
            if st.project.is_empty() {
                return None;
            }
            (
                st.keys.iter().filter_map(|k| parse_pubkey(k).ok()).collect::<Vec<_>>(),
                st.project.clone(),
                st.revoked_dev.clone(),
                st.revoked_sub.clone(),
            )
        };
        let tok = head.h.iter().find(|(k, _)| k.eq_ignore_ascii_case(TOKEN_HEADER)).map(|(_, v)| v)?;
        let c = verify_token(&keys, tok, &self.id_hex, &project, remote_hex, now).ok()?;
        if rev_dev.iter().any(|d| *d == c.dev) || rev_sub.iter().any(|s| *s == c.sub) {
            return None;
        }
        Some(c)
    }

    /// LAN address hints written by host-agent into `<data dir>/lan.json` (it knows the real LAN address; this
    /// container only sees the docker bridge). Handed out only to token holders (see info endpoint).
    /// Plain LAN IPv4 list for the unauthenticated info endpoint (contract section 3): addresses only, valid
    /// dotted-quad strings that are private/link-local ranges, never loopback / docker bridge (host-agent filters
    /// the interfaces; this re-checks so a damaged file cannot inject anything else).
    pub fn lan_ips(&self) -> Vec<String> {
        let v = self.lan_hints(now_unix());
        v["ips"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .filter_map(|x| x.parse::<std::net::Ipv4Addr>().ok())
                    .filter(|ip| (ip.is_private() || ip.is_link_local()) && !ip.is_loopback() && !(ip.octets()[0] == 172 && ip.octets()[1] == 17))
                    .map(|ip| ip.to_string())
                    .take(8)
                    .collect()
            })
            .unwrap_or_default()
    }

    /// `lanHints.iroh` (contract 13.1): the edge's own fixed iroh UDP port + the LAN IPv4 list. The edge is the
    /// authority for the port (it knows what it bound), so whatever host-agent wrote into lan.json is replaced.
    pub fn iroh_hints(&self, port: u16) -> Value {
        let addrs: Vec<Value> = self.lan_ips().into_iter().map(|ip| json!({"ip": ip, "port": port})).collect();
        json!({"port": port, "addrs": addrs})
    }

    pub fn lan_hints(&self, now: u64) -> Value {
        let Ok(s) = std::fs::read_to_string(self.dir.join("lan.json")) else { return Value::Null };
        if s.len() > 16 * 1024 {
            return Value::Null;
        }
        let Ok(mut v) = serde_json::from_str::<Value>(&s) else { return Value::Null };
        if let Some(m) = v.as_object_mut() {
            let at = m.get("at").and_then(|x| x.as_u64()).unwrap_or(0);
            m.insert("ageSec".into(), json!(now.saturating_sub(at)));
        }
        v
    }

    /// Test hook: pretend the last roster contact was long ago (stale > 24 h) while a cloud URL is set.
    #[cfg(test)]
    pub fn test_set_stale(&self) {
        let mut st = self.st.lock().unwrap();
        st.cloud_url = "https://cloud.invalid".into();
        st.roster_at = 1;
    }

    /// Upload bookkeeping shown in /status (see audit_upload.rs).
    pub fn set_upload_state(&self, state: &str, err: Option<String>) {
        *self.upload.lock().unwrap() = json!({"state": state, "at": now_unix(), "error": err});
    }

    /// Track a connection (for kicks and one-time "connected" audit).
    pub fn register(self: &Arc<Self>, conn: &Connection) -> ConnGuard {
        let key = self.next.fetch_add(1, Ordering::Relaxed);
        self.conns
            .lock()
            .unwrap()
            .insert(key, ConnEntry { dev: hex(conn.remote_id().as_bytes()), conn: conn.clone(), logged: false });
        ConnGuard { a: self.clone(), key }
    }

    /// Connection-level gate (legacy allowlist only; token mode decides per request).
    pub fn pre_check(&self, remote: &EndpointId, allow: &std::collections::HashSet<EndpointId>) -> bool {
        match self.mode() {
            "allowlist" => allow.contains(remote),
            _ => true,
        }
    }

    /// Per-request decision. `lan` = the selected path is a private-address direct path.
    pub fn authorize(&self, head: &ReqHead, conn: &Connection, lan: bool) -> Result<Option<Claims>, Deny> {
        let remote = hex(conn.remote_id().as_bytes());
        self.authorize_at(head, &remote, lan, now_unix())
    }

    pub fn authorize_at(&self, head: &ReqHead, remote_hex: &str, lan: bool, now: u64) -> Result<Option<Claims>, Deny> {
        match self.mode() {
            "open" | "allowlist" => return Ok(None),
            "locked" => {
                self.audit.log_coalesced(
                    format!("locked:{remote_hex}"),
                    "deny",
                    json!({"code":"edge-unclaimed","dev":remote_hex,"path":head.p}),
                );
                return Err((403, "edge-unclaimed"));
            }
            _ => {}
        }
        let (keys, project, stale, rev_dev, rev_sub, roster_at) = {
            let st = self.st.lock().unwrap();
            let stale = !st.cloud_url.is_empty() && now.saturating_sub(st.roster_at) > ROSTER_MAX_AGE;
            (
                st.keys.iter().filter_map(|k| parse_pubkey(k).ok()).collect::<Vec<_>>(),
                st.project.clone(),
                stale,
                st.revoked_dev.clone(),
                st.revoked_sub.clone(),
                st.roster_at,
            )
        };
        let deny = |code: (u16, &'static str), sub: &str| {
            self.audit.log_coalesced(
                format!("{}:{remote_hex}", code.1),
                "deny",
                json!({"code":code.1,"dev":remote_hex,"sub":sub,"path":head.p}),
            );
            Err(code)
        };
        let Some(tok) = head.h.iter().find(|(k, _)| k.eq_ignore_ascii_case(TOKEN_HEADER)).map(|(_, v)| v) else {
            return deny((401, "token-missing"), "");
        };
        // A wrong clock makes every time-based decision (token iat/exp, roster age) meaningless. Internet requests
        // are refused with a clear reason; the LAN keeps working (same rule as an expired roster).
        if !lan {
            let cs = clock_eval(now, roster_at, self.clock.lock().unwrap().skew, self.opts.clock_warn, self.opts.clock_max);
            if clock_refuses(cs) {
                return deny((503, "clock-invalid"), "");
            }
        }
        let c = match verify_token(&keys, tok, &self.id_hex, &project, remote_hex, now) {
            Ok(c) => c,
            Err(e) => return deny(e, ""),
        };
        if rev_dev.iter().any(|d| *d == c.dev) {
            return deny((403, "device-revoked"), &c.sub);
        }
        if rev_sub.iter().any(|s| *s == c.sub) {
            return deny((403, "user-revoked"), &c.sub);
        }
        if stale && !lan {
            return deny((503, "roster-expired"), &c.sub);
        }
        if let Err(e) = path_allowed(&c, &head.m, &head.p) {
            return deny(e, &c.sub);
        }
        Ok(Some(c))
    }

    /// Audit "connected" once per connection after its first valid token.
    pub fn note_session(&self, conn: &Connection, c: &Claims, path: &str) {
        let key = conn.stable_id() as u64;
        let _ = key;
        let dev = hex(conn.remote_id().as_bytes());
        let mut log = false;
        {
            let mut m = self.conns.lock().unwrap();
            for e in m.values_mut() {
                if e.dev == dev && !e.logged && e.conn.stable_id() == conn.stable_id() {
                    e.logged = true;
                    log = true;
                }
            }
        }
        if log {
            self.audit.log(
                "session",
                json!({"sub":c.sub,"dev":c.dev,"role":c.role,"scope":c.scope,"path":path,"jti":c.jti,"exp":c.exp}),
            );
        }
    }

    // -------------------------------------------------------------- claim

    /// `POST /_h2z/claim` body: {k, cloudPub, project, cloudUrl, nonce, claimId}
    pub fn claim(&self, body: &[u8]) -> Result<Value, Deny> {
        {
            let mut f = self.claim_fails.lock().unwrap();
            if f.0 >= 5 && f.1.elapsed().as_secs() < 60 {
                return Err((429, "claim-locked"));
            }
            if f.1.elapsed().as_secs() >= 60 {
                *f = (0, Instant::now());
            }
        }
        #[derive(Deserialize)]
        struct Req {
            k: String,
            #[serde(rename = "cloudPub")]
            cloud_pub: String,
            project: String,
            #[serde(default, rename = "cloudUrl")]
            cloud_url: String,
            nonce: String,
            #[serde(default, rename = "claimId")]
            claim_id: String,
        }
        let r: Req = serde_json::from_slice(body).map_err(|_| (400, "claim-malformed"))?;
        if r.project.is_empty() || r.project.len() > 128 || r.nonce.len() < 16 || r.nonce.len() > 256 {
            return Err((400, "claim-malformed"));
        }
        parse_pubkey(&r.cloud_pub).map_err(|_| (400, "claim-malformed"))?;
        if !r.cloud_url.is_empty() && !(r.cloud_url.starts_with("https://") || r.cloud_url.starts_with("http://")) {
            return Err((400, "claim-malformed"));
        }
        let mut st = self.st.lock().unwrap();
        if !st.project.is_empty() {
            return Err((409, "already-claimed"));
        }
        // constant-time compare of the one-time secret
        let ok = {
            let (a, b) = (st.pair_secret.as_bytes(), r.k.as_bytes());
            a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
        };
        if !ok {
            let mut f = self.claim_fails.lock().unwrap();
            f.0 += 1;
            f.1 = Instant::now();
            drop(f);
            self.audit.log("claim_fail", json!({"project":r.project}));
            return Err((403, "claim-secret"));
        }
        st.project = r.project.clone();
        st.cloud_url = r.cloud_url.trim_end_matches('/').to_string();
        st.keys = vec![r.cloud_pub.clone()];
        st.roster_at = now_unix();
        st.roster_seq = 0;
        st.pair_secret.clear();
        st.edge_id = self.id_hex.clone();
        save_state(&self.file, &st).map_err(|_| (500, "claim-persist"))?;
        drop(st);
        let msg = format!("h2z-claim\n{}\n{}\n{}\n{}", r.nonce, r.project, r.cloud_pub, r.claim_id);
        let sig = self.secret.sign(msg.as_bytes());
        self.audit.log("claim_ok", json!({"project":r.project,"claimId":r.claim_id}));
        Ok(json!({"edge": self.id_hex, "sig": B64.encode(sig.to_bytes())}))
    }

    // -------------------------------------------------------------- roster

    /// Apply a signed roster document `{"p":b64(json),"s":b64(sig)}`.
    /// Returns the connections' device ids that must be kicked.
    pub fn apply_roster(&self, doc: &str, now: u64) -> Result<Vec<String>> {
        #[derive(Deserialize)]
        struct Doc {
            p: String,
            s: String,
        }
        #[derive(Deserialize)]
        struct Payload {
            v: u32,
            edge: String,
            seq: u64,
            /// cloud time at signing (the cloud signs a fresh roster per request) = our clock reference
            #[serde(default)]
            iat: u64,
            #[serde(default)]
            revoked_dev: Vec<String>,
            #[serde(default)]
            revoked_sub: Vec<String>,
            #[serde(default)]
            add_keys: Vec<String>,
            #[serde(default)]
            drop_keys: Vec<String>,
        }
        let d: Doc = serde_json::from_str(doc).context("roster json")?;
        if !verify_sig(&self.keys(), format!("h2z-roster1.{}", d.p).as_bytes(), &d.s) {
            self.audit.log("roster_reject", json!({"why":"signature"}));
            return Err(anyhow!("roster signature"));
        }
        let p: Payload = serde_json::from_slice(&B64.decode(&d.p)?)?;
        if p.v != 1 || p.edge != self.id_hex {
            return Err(anyhow!("roster not for this edge"));
        }
        // Clock reference: the cloud's signed time. A badly wrong edge clock must not be recorded as "fresh contact".
        let skew = if p.iat > 0 { Some(now as i64 - p.iat as i64) } else { None };
        if let Some(sk) = skew {
            let prev = self.clock.lock().unwrap().skew;
            *self.clock.lock().unwrap() = ClockObs { skew: Some(sk), at: now };
            let was_bad = prev.map(|x| x.abs() > self.opts.clock_warn).unwrap_or(false);
            let is_bad = sk.abs() > self.opts.clock_warn;
            if is_bad != was_bad || (is_bad && prev.is_none()) {
                self.audit.log("clock", json!({"skewSec": sk, "state": clock_eval(now, 0, Some(sk), self.opts.clock_warn, self.opts.clock_max)}));
            }
        }
        let clock_ok = skew.map(|sk| sk.abs() <= self.opts.clock_max).unwrap_or(true) && now >= MIN_SANE_UNIX;
        let mut st = self.st.lock().unwrap();
        if clock_ok {
            st.roster_at = now; // cloud reachable, authentic, and our clock agrees with it
        }
        if p.seq < st.roster_seq {
            save_state(&self.file, &st)?;
            return Err(anyhow!("roster seq went backwards ({} < {})", p.seq, st.roster_seq));
        }
        let changed = p.seq > st.roster_seq;
        st.roster_seq = p.seq;
        st.revoked_dev = p.revoked_dev.iter().map(|s| s.to_lowercase()).collect();
        st.revoked_sub = p.revoked_sub.clone();
        for k in &p.add_keys {
            parse_pubkey(k)?;
            if !st.keys.contains(k) {
                st.keys.push(k.clone());
            }
        }
        st.keys.retain(|k| !p.drop_keys.contains(k));
        if st.keys.is_empty() {
            return Err(anyhow!("roster would drop all keys"));
        }
        save_state(&self.file, &st)?;
        let kick: Vec<String> = st.revoked_dev.clone();
        drop(st);
        if changed {
            self.audit.log("roster", json!({"seq":p.seq,"revokedDev":p.revoked_dev.len(),"revokedSub":p.revoked_sub.len()}));
        }
        Ok(kick)
    }

    /// Close live connections of revoked devices. Revoked users are cut at the next
    /// request (tokens are short-lived) and when their streams hit the token expiry.
    pub fn kick_devices(&self, devs: &[String]) {
        let mut hit = Vec::new();
        {
            let m = self.conns.lock().unwrap();
            for e in m.values() {
                if devs.iter().any(|d| *d == e.dev) {
                    e.conn.close(2u32.into(), b"revoked");
                    hit.push(e.dev.clone());
                }
            }
        }
        for d in hit {
            self.audit.log("kick", json!({"dev":d,"why":"device-revoked"}));
        }
    }

    pub fn edge_auth_header(&self, method: &str, path: &str) -> String {
        self.edge_auth_header_at(method, path, now_unix())
    }

    /// Contract §5: `H2Z-Edge <edge>.<ts>.<sig>`, sig over `"h2z-edge-auth\n{edge}\n{ts}\n{METHOD} {path}"`.
    pub fn edge_auth_header_at(&self, method: &str, path: &str, ts: u64) -> String {
        let msg = format!("h2z-edge-auth\n{}\n{ts}\n{method} {path}", self.id_hex);
        let sig = self.secret.sign(msg.as_bytes());
        format!("H2Z-Edge {}.{ts}.{}", self.id_hex, B64.encode(sig.to_bytes()))
    }

    /// Request with a body (audit upload, proposed in contract §12): the signed text gets one more line,
    /// `sha256(body)` in lowercase hex, so a captured header cannot be replayed with another body.
    pub fn edge_auth_header_body_at(&self, method: &str, path: &str, ts: u64, body: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let msg = format!("h2z-edge-auth\n{}\n{ts}\n{method} {path}\n{}", self.id_hex, hex(Sha256::digest(body).as_slice()));
        let sig = self.secret.sign(msg.as_bytes());
        format!("H2Z-Edge {}.{ts}.{}", self.id_hex, B64.encode(sig.to_bytes()))
    }

    pub fn summary(&self) -> Value {
        let (claimed, rosterage) = {
            let st = self.st.lock().unwrap();
            (!st.project.is_empty(), now_unix().saturating_sub(st.roster_at))
        };
        let now = now_unix();
        json!({
            "mode": self.mode(),
            "claimed": claimed,
            // "open" = validation mode: anyone who knows the endpoint id can use the box. Shown prominently in the admin UI.
            "openMode": self.open && !claimed,
            "clock": self.clock_state(now),
            "rosterAgeSec": if claimed { Some(rosterage) } else { None },
        })
    }

    pub fn full(&self) -> Value {
        let now = now_unix();
        let (uploaded_seq, last_seq) = (self.st.lock().unwrap().audit_uploaded, self.audit.last_seq());
        let o = *self.clock.lock().unwrap();
        let st = self.st.lock().unwrap();
        let clock_v = json!({
            "state": clock_eval(now, st.roster_at, o.skew, self.opts.clock_warn, self.opts.clock_max),
            "skewSec": o.skew, "checkedAt": if o.at > 0 { Some(o.at) } else { None }, "now": now,
            "warnSec": self.opts.clock_warn, "maxSec": self.opts.clock_max });
        let claimed = !st.project.is_empty();
        let mode = if claimed {"token"} else if self.open {"open"} else if self.legacy_allow {"allowlist"} else {"locked"};
        json!({
            "mode": mode,
            "claimed": claimed,
            "openMode": self.open && !claimed,
            "project": st.project,
            "cloudUrl": st.cloud_url,
            "keys": st.keys.len(),
            "rosterSeq": st.roster_seq,
            "rosterAgeSec": if claimed { Some(now.saturating_sub(st.roster_at)) } else { None },
            "revokedDevices": st.revoked_dev.len(),
            "revokedUsers": st.revoked_sub.len(),
            "clock": clock_v,
            "auditSeq": last_seq,
            "auditUploadedSeq": uploaded_seq,
            "auditUpload": self.upload.lock().unwrap().clone(),
            "audit": self.audit.tail(50),
        })
    }
}

/// Background: pull the signed roster from the cloud every minute (only if claimed
/// with a cloud url). Failures are logged and simply let the roster age.
pub fn spawn_roster_sync(auth: Arc<Auth>) {
    tokio::spawn(async move {
        let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).build() {
            Ok(c) => c,
            Err(_) => return,
        };
        let mut backoff = 0u32;
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        loop {
            let url = auth.cloud_url();
            if auth.claimed() && !url.is_empty() {
                let path = format!("/v1/edges/{}/roster", auth.id_hex());
                let res = client
                    .get(format!("{url}{path}"))
                    .header("authorization", auth.edge_auth_header("GET", &path))
                    .send()
                    .await;
                match res {
                    Ok(r) if r.status().is_success() => match r.text().await {
                        Ok(t) => match auth.apply_roster(&t, now_unix()) {
                            Ok(kick) => {
                                backoff = 0;
                                auth.kick_devices(&kick);
                            }
                            Err(e) => {
                                tracing::warn!("roster: {e:#}");
                                backoff = (backoff + 1).min(5);
                            }
                        },
                        Err(e) => tracing::warn!("roster body: {e}"),
                    },
                    Ok(r) => {
                        tracing::warn!(status = %r.status(), "roster fetch");
                        backoff = (backoff + 1).min(5);
                    }
                    Err(e) => {
                        tracing::debug!("roster fetch: {e}");
                        backoff = (backoff + 1).min(5);
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(60 * (1 << backoff.min(3)) / 2)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tok(sk: &SecretKey, c: &Value) -> String {
        let p = B64.encode(c.to_string());
        let s = sk.sign(format!("h2z1.{p}").as_bytes());
        format!("h2z1.{p}.{}", B64.encode(s.to_bytes()))
    }
    fn claims(edge: &str, dev: &str, now: u64) -> Value {
        json!({"v":1,"aud":edge,"prj":"p1","sub":"u1","role":"customer_viewer","scope":"view","dev":dev,
               "cams":["200"],"st":"sub","iat":now,"exp":now+600,"jti":"j1"})
    }

    #[test]
    fn token_roundtrip_and_binding() {
        let cloud = SecretKey::generate();
        let keys = vec![cloud.public()];
        let now = 1_000_000;
        let t = tok(&cloud, &claims("EDGE", "dev", now));
        assert!(verify_token(&keys, &t, "EDGE", "p1", "dev", now + 10).is_ok());
        assert_eq!(verify_token(&keys, &t, "EDGE", "p1", "OTHER", now + 10).unwrap_err().1, "token-device");
        assert_eq!(verify_token(&keys, &t, "EDGE2", "p1", "dev", now + 10).unwrap_err().1, "token-audience");
        assert_eq!(verify_token(&keys, &t, "EDGE", "p2", "dev", now + 10).unwrap_err().1, "token-project");
        assert_eq!(verify_token(&keys, &t, "EDGE", "p1", "dev", now + 601).unwrap_err().1, "token-expired");
        assert_eq!(verify_token(&keys, &t, "EDGE", "p1", "dev", now - 500).unwrap_err().1, "token-time");
        let evil = SecretKey::generate();
        let t2 = tok(&evil, &claims("EDGE", "dev", now));
        assert_eq!(verify_token(&keys, &t2, "EDGE", "p1", "dev", now).unwrap_err().1, "token-signature");
        // tampered payload
        let mut parts: Vec<&str> = t.split('.').collect();
        let forged = B64.encode(claims("EDGE", "dev", now).to_string().replace("200", "201"));
        parts[1] = &forged;
        assert_eq!(verify_token(&keys, &parts.join("."), "EDGE", "p1", "dev", now).unwrap_err().1, "token-signature");
        assert_eq!(verify_token(&keys, "garbage", "EDGE", "p1", "dev", now).unwrap_err().1, "token-malformed");
    }

    #[test]
    fn token_life_capped() {
        let cloud = SecretKey::generate();
        let mut c = claims("E", "D", 1000);
        c["exp"] = json!(1000 + 3 * 24 * 3600);
        assert_eq!(
            verify_token(&[cloud.public()], &tok(&cloud, &c), "E", "p1", "D", 1001).unwrap_err().1,
            "token-time"
        );
    }

    fn view(cams: &[&str], st: &str) -> Claims {
        Claims {
            v: 1,
            aud: "E".into(),
            prj: "p1".into(),
            sub: "u".into(),
            role: "customer_viewer".into(),
            scope: "view".into(),
            dev: "D".into(),
            cams: cams.iter().map(|s| s.to_string()).collect(),
            st: st.into(),
            iat: 0,
            exp: 1,
            jti: String::new(),
        }
    }

    #[test]
    fn view_scope_paths() {
        let c = view(&["200"], "sub");
        let live = "/api/ioc/projects/local/network/devices/200/live?profile=sub&raw=1";
        assert!(path_allowed(&c, "GET", live).is_ok());
        assert_eq!(path_allowed(&c, "GET", "/api/ioc/projects/local/network/devices/194/live?profile=sub").unwrap_err().1, "camera-not-granted");
        assert_eq!(path_allowed(&c, "GET", "/api/ioc/projects/local/network/devices/200/live?profile=main&hevc=1").unwrap_err().1, "stream-type-not-granted");
        assert!(path_allowed(&c, "GET", "/media/cam/200_sub.live.mp4").is_ok());
        assert_eq!(path_allowed(&c, "GET", "/media/cam/200_main.live.mp4").unwrap_err().1, "stream-type-not-granted");
        assert_eq!(path_allowed(&c, "GET", "/media/cam/201_sub.live.mp4").unwrap_err().1, "camera-not-granted");
        assert_eq!(path_allowed(&c, "GET", "/api/ioc/projects/local/network/cameras/194").unwrap_err().1, "camera-not-granted");
        assert!(path_allowed(&c, "GET", "/api/ioc/projects/local/network/cameras").is_ok());
        assert!(path_allowed(&c, "POST", "/api/ioc/projects/local/network/live/release").is_ok());
        assert_eq!(path_allowed(&c, "POST", "/api/ioc/projects/local/network/cameras/200").unwrap_err().1, "scope-readonly");
        assert_eq!(path_allowed(&c, "GET", "/api/ioc/device/network/tunnel").unwrap_err().1, "scope-device-admin");
        assert_eq!(path_allowed(&c, "GET", "/api/ioc/projects/local/network/devices/200/../194/live").unwrap_err().1, "bad-path");
        assert_eq!(path_allowed(&c, "GET", "/media/cam/200_sub.live.mp4/%2e%2e/x").unwrap_err().1, "bad-path");
        let all = view(&["*"], "any");
        assert!(path_allowed(&all, "GET", "/media/cam/999_main.live.mp4").is_ok());
        // recording search / playback: read-only POSTs, only for all-camera tokens
        assert!(path_allowed(&all, "POST", "/api/ioc/projects/demo-office/recordings/query").is_ok());
        assert!(path_allowed(&all, "POST", "/api/ioc/projects/demo-office/recordings/play").is_ok());
        assert_eq!(path_allowed(&c, "POST", "/api/ioc/projects/local/recordings/query").unwrap_err().1, "scope-readonly");
        assert_eq!(path_allowed(&all, "POST", "/api/ioc/projects/local/recordings/delete").unwrap_err().1, "scope-readonly");
        assert_eq!(path_allowed(&all, "POST", "/api/other/recordings/play").unwrap_err().1, "scope-readonly");
        let mut adm = view(&[], "any");
        adm.scope = "admin".into();
        assert!(path_allowed(&adm, "POST", "/api/ioc/device/network/tunnel").is_ok());
    }

    #[test]
    fn recorder_playback_minimal_guard() {
        let pre = "/api/ioc/projects/x/recorder";
        let lim = view(&["1"], "any");
        let all = view(&["*"], "any");
        // camera-limited token: every recorder path refused (GET incl. WebSocket upgrade, HEAD, POST)
        for (m, tail) in [
            ("GET", "/mp4?camera=1&stream=sub"),
            ("GET", "/thumb?camera=1&at=1"),
            ("GET", "/ws?camera=1&stream=sub&from=1700000000000"),
            ("HEAD", "/mp4?camera=1"),
            ("POST", "/play"),
            ("GET", "/ws"),
        ] {
            assert_eq!(path_allowed(&lim, m, &format!("{pre}{tail}")).unwrap_err().1, "camera-not-granted", "{m} {tail}");
        }
        // hiding the segment by case / percent-encoding does not help
        assert_eq!(path_allowed(&lim, "GET", "/api/ioc/projects/x/Recorder/ws?camera=1").unwrap_err().1, "camera-not-granted");
        assert_eq!(path_allowed(&lim, "GET", "/api/ioc/projects/x/%72ecorder/ws?camera=1").unwrap_err().1, "camera-not-granted");
        // legacy search / play paths: GET by a limited token is refused too, POST keeps scope-readonly
        assert_eq!(path_allowed(&lim, "GET", "/api/ioc/projects/x/recordings/query").unwrap_err().1, "camera-not-granted");
        assert_eq!(path_allowed(&lim, "POST", "/api/ioc/projects/x/recordings/play").unwrap_err().1, "scope-readonly");
        // "*" token: allowed
        assert!(path_allowed(&all, "GET", &format!("{pre}/mp4?camera=1&stream=sub")).is_ok());
        assert!(path_allowed(&all, "GET", &format!("{pre}/thumb?camera=2")).is_ok());
        assert!(path_allowed(&all, "GET", &format!("{pre}/ws?camera=3&stream=main&from=1")).is_ok());
        assert!(path_allowed(&all, "POST", &format!("{pre}/play")).is_ok());
        // ...but only the play POST is read-only; other recorder POSTs stay scope-readonly
        assert_eq!(path_allowed(&all, "POST", &format!("{pre}/delete")).unwrap_err().1, "scope-readonly");
        assert_eq!(path_allowed(&all, "POST", "/api/other/recorder/play").unwrap_err().1, "scope-readonly");
        // admin unaffected
        let mut adm = view(&["1"], "sub");
        adm.scope = "admin".into();
        assert!(path_allowed(&adm, "GET", &format!("{pre}/ws?camera=9&stream=main")).is_ok());
        // stream type: stream= is checked against the token's `st`
        let all_sub = view(&["*"], "sub");
        assert!(path_allowed(&all_sub, "GET", &format!("{pre}/ws?camera=1&stream=sub")).is_ok());
        assert_eq!(path_allowed(&all_sub, "GET", &format!("{pre}/ws?camera=1&stream=main")).unwrap_err().1, "stream-type-not-granted");
        assert_eq!(path_allowed(&all_sub, "GET", &format!("{pre}/mp4?camera=1&stream=main")).unwrap_err().1, "stream-type-not-granted");
        let all_main = view(&["*"], "main");
        assert_eq!(path_allowed(&all_main, "GET", &format!("{pre}/ws?camera=1&stream=sub")).unwrap_err().1, "stream-type-not-granted");
        // path traversal is still bad-path (checked before anything else, for every token)
        for bad in [
            "/api/ioc/projects/x/recorder/../devices/1/live",
            "/api/ioc/projects/x/recorder/%2e%2e/x",
            "/api/ioc/projects/x/recorder%2fws?camera=1",
            "/api/ioc/projects/x/recorder/%2E%2e/x",
        ] {
            assert_eq!(path_allowed(&lim, "GET", bad).unwrap_err().1, "bad-path", "{bad}");
            assert_eq!(path_allowed(&all, "GET", bad).unwrap_err().1, "bad-path", "{bad}");
        }
    }

    #[test]
    fn stream_of_query_and_priority() {
        assert_eq!(stream_of("/recorder/ws?camera=1&stream=main"), Some("main"));
        assert_eq!(stream_of("/recorder/ws?camera=1&stream=sub"), Some("sub"));
        assert_eq!(stream_of("/recorder/ws?camera=1"), None);
        // existing sources keep priority over stream=
        assert_eq!(stream_of("/x?profile=sub&stream=main"), Some("sub"));
        assert_eq!(stream_of("/x?hevc=1&stream=sub"), Some("main"));
        assert_eq!(stream_of("/x?profile=main&stream=sub"), Some("main"));
        assert_eq!(stream_of("/media/cam/200_main.live.mp4?stream=sub"), Some("main"));
        // repeated parameter: main wins
        assert_eq!(stream_of("/recorder/ws?stream=sub&stream=main"), Some("main"));
        assert_eq!(stream_of("/recorder/ws?stream=mainx"), None);
    }

    fn mk(open: bool) -> (Arc<Auth>, std::path::PathBuf, SecretKey) {
        let dir = std::env::temp_dir().join(format!("h2z-auth-{}-{}", std::process::id(), SecretKey::generate().public()));
        std::fs::create_dir_all(&dir).unwrap();
        let sk = SecretKey::generate();
        (Auth::load(sk.clone(), &dir, open, false, None).unwrap(), dir, sk)
    }
    fn head(m: &str, p: &str, tok: Option<&str>) -> ReqHead {
        let mut h = std::collections::BTreeMap::new();
        if let Some(t) = tok {
            h.insert("X-H2Z-Token".into(), t.into());
        }
        ReqHead { m: m.into(), p: p.into(), h }
    }

    #[test]
    fn locked_until_claimed_then_token_only() {
        let (a, dir, sk) = mk(false);
        assert_eq!(a.mode(), "locked");
        assert!(a.pair_payload().unwrap().contains("&k="));
        assert_eq!(a.authorize_at(&head("GET", "/", None), "D", false, 100).unwrap_err().1, "edge-unclaimed");

        let cloud = SecretKey::generate();
        let cpub = B64.encode(cloud.public().as_bytes());
        let secret = a.st.lock().unwrap().pair_secret.clone();
        let mk_body = |k: &str, nonce: &str| {
            json!({"k":k,"cloudPub":cpub,"project":"p1","cloudUrl":"https://cloud.example","nonce":nonce,"claimId":"c1"})
                .to_string()
                .into_bytes()
        };
        assert_eq!(a.claim(&mk_body("wrong", "0123456789abcdef")).unwrap_err().1, "claim-secret");
        let r = a.claim(&mk_body(&secret, "0123456789abcdef")).unwrap();
        // the cloud can verify the edge signed our nonce
        let msg = format!("h2z-claim\n0123456789abcdef\np1\n{cpub}\nc1");
        let sig: [u8; 64] = B64.decode(r["sig"].as_str().unwrap()).unwrap().try_into().unwrap();
        assert!(sk.public().verify(msg.as_bytes(), &Signature::from_bytes(&sig)).is_ok());
        assert_eq!(a.claim(&mk_body(&secret, "0123456789abcdef")).unwrap_err().1, "already-claimed");
        assert_eq!(a.mode(), "token");
        assert!(a.pair_payload().is_none());

        let now = now_unix();
        let eid = a.id_hex().to_string();
        let t = tok(&cloud, &claims(&eid, "dev", now));
        assert!(a.authorize_at(&head("GET", "/media/cam/200_sub.live.mp4", Some(&t)), "dev", false, now).unwrap().is_some());
        assert_eq!(a.authorize_at(&head("GET", "/", None), "dev", false, now).unwrap_err().1, "token-missing");
        assert_eq!(a.authorize_at(&head("GET", "/", Some(&t)), "OTHER", false, now).unwrap_err().1, "token-device");

        // persisted: a restart stays claimed
        let a2 = Auth::load(sk.clone(), &dir, false, false, None).unwrap();
        assert!(a2.claimed());
        assert!(a2.authorize_at(&head("GET", "/", Some(&t)), "dev", false, now).is_ok());

        // roster: revoke device
        let roster = |seq: u64, rev: Value, add: Value, drop: Value| {
            let p = B64.encode(json!({"v":1,"edge":eid,"seq":seq,"revoked_dev":rev,"add_keys":add,"drop_keys":drop}).to_string());
            let s = cloud.sign(format!("h2z-roster1.{p}").as_bytes());
            json!({"p":p,"s":B64.encode(s.to_bytes())}).to_string()
        };
        let kick = a.apply_roster(&roster(1, json!(["dev"]), json!([]), json!([])), now).unwrap();
        assert_eq!(kick, vec!["dev".to_string()]);
        assert_eq!(a.authorize_at(&head("GET", "/", Some(&t)), "dev", false, now).unwrap_err().1, "device-revoked");
        // seq must not go backwards
        assert!(a.apply_roster(&roster(0, json!([]), json!([]), json!([])), now).is_err());
        // forged roster
        let evil = SecretKey::generate();
        let p = B64.encode(json!({"v":1,"edge":eid,"seq":9}).to_string());
        let forged = json!({"p":p,"s":B64.encode(evil.sign(format!("h2z-roster1.{p}").as_bytes()).to_bytes())}).to_string();
        assert!(a.apply_roster(&forged, now).is_err());
        // key rotation signed by the old key; old key dropped afterwards
        let newk = SecretKey::generate();
        let newpub = B64.encode(newk.public().as_bytes());
        a.apply_roster(&roster(2, json!([]), json!([newpub.clone()]), json!([])), now).unwrap();
        let t_new = tok(&newk, &claims(&eid, "dev2", now));
        assert!(a.authorize_at(&head("GET", "/", Some(&t_new)), "dev2", false, now).is_ok());
        a.apply_roster(&roster(3, json!([]), json!([]), json!([cpub.clone()])), now).unwrap();
        assert_eq!(a.authorize_at(&head("GET", "/", Some(&t)), "dev", false, now).unwrap_err().1, "token-signature");
        // roster would drop everything -> refused
        assert!(a.apply_roster(&roster(4, json!([]), json!([]), json!([newpub])), now).is_err()
            || a.keys().len() == 1);

        // staleness: >24h without the cloud => internet refused, LAN allowed
        let later = now + ROSTER_MAX_AGE + 100;
        let t_late = tok(&newk, &json!({"v":1,"aud":eid,"prj":"p1","sub":"u1","role":"x","scope":"view","dev":"dev2",
            "cams":["*"],"st":"any","iat":later,"exp":later+600,"jti":"z"}));
        assert_eq!(a.authorize_at(&head("GET", "/", Some(&t_late)), "dev2", false, later).unwrap_err().1, "roster-expired");
        assert!(a.authorize_at(&head("GET", "/", Some(&t_late)), "dev2", true, later).is_ok());

        // audit has sequenced events
        let tail = a.audit.tail(100);
        assert!(tail.iter().any(|e| e["ev"] == "claim_ok"));
        let seqs: Vec<u64> = tail.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn unknown_fields_admin_pub_and_grants_are_ignored_and_preserved() {
        // contract 13.3: auth.json `admin_pub` and roster `grants` are reserved (not implemented): never a reason to refuse,
        // never dropped when the edge rewrites its own state.
        let (a, dir, sk) = mk(false);
        let cloud = SecretKey::generate();
        let cpub = B64.encode(cloud.public().as_bytes());
        let secret = a.st.lock().unwrap().pair_secret.clone();
        a.claim(&json!({"k":secret,"cloudPub":cpub,"project":"p1","cloudUrl":"https://cloud.example","nonce":"0123456789abcdef","claimId":"c1"}).to_string().into_bytes()).unwrap();
        // someone (a later version / the future claim flow) adds admin_pub + another unknown field to auth.json
        let file = dir.join("auth.json");
        let mut doc: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        doc["admin_pub"] = json!(["aa".repeat(32), "bb".repeat(32)]);
        doc["future_field"] = json!({"x": 1});
        std::fs::write(&file, doc.to_string()).unwrap();
        let a2 = Auth::load(sk.clone(), &dir, false, false, None).unwrap();
        assert!(a2.claimed(), "unknown fields must not make auth.json 'damaged'");
        assert!(!std::fs::read_dir(&dir).unwrap().any(|f| f.unwrap().file_name().to_string_lossy().contains("corrupt")));
        // a roster carrying `grants` (and another unknown key) is accepted like any other
        let now = now_unix();
        let eid = a2.id_hex().to_string();
        let p = B64.encode(json!({"v":1,"edge":eid,"seq":1,"iat":now,"revoked_dev":[],"grants":[{"dev":"d","sig":"s"}],"future":true}).to_string());
        let doc = json!({"p":p,"s":B64.encode(cloud.sign(format!("h2z-roster1.{p}").as_bytes()).to_bytes())}).to_string();
        a2.apply_roster(&doc, now).unwrap();
        // tokens still work, and the rewritten auth.json still has the unknown fields
        let t = tok(&cloud, &claims(&eid, "dev", now));
        assert!(a2.authorize_at(&head("GET", "/media/cam/200_sub.live.mp4", Some(&t)), "dev", false, now).unwrap().is_some());
        let after: Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(after["admin_pub"], json!(["aa".repeat(32), "bb".repeat(32)]));
        assert_eq!(after["future_field"], json!({"x": 1}));
        assert_eq!(after["roster_seq"], json!(1));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn claim_bruteforce_locks() {
        let (a, dir, _) = mk(false);
        let cpub = B64.encode(SecretKey::generate().public().as_bytes());
        let body = json!({"k":"x","cloudPub":cpub,"project":"p","nonce":"0123456789abcdef"}).to_string().into_bytes();
        for _ in 0..5 {
            assert_eq!(a.claim(&body).unwrap_err().1, "claim-secret");
        }
        assert_eq!(a.claim(&body).unwrap_err().1, "claim-locked");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn clock_verdicts() {
        let ok = MIN_SANE_UNIX + 1000;
        assert_eq!(clock_eval(0, 0, None, 60, 300), "unset"); // 1970: no RTC
        assert_eq!(clock_eval(MIN_SANE_UNIX - 1, 0, Some(0), 60, 300), "unset");
        assert_eq!(clock_eval(ok, 0, None, 60, 300), "unverified");
        assert_eq!(clock_eval(ok, ok - 10, Some(5), 60, 300), "ok");
        assert_eq!(clock_eval(ok, ok - 10, Some(-61), 60, 300), "drift");
        assert_eq!(clock_eval(ok, ok - 10, Some(301), 60, 300), "skewed");
        assert_eq!(clock_eval(ok, ok + 61, None, 60, 300), "behind"); // earlier than our own last cloud contact
        assert_eq!(clock_eval(ok, ok + 59, None, 60, 300), "unverified");
        assert!(clock_refuses("unset") && clock_refuses("behind") && clock_refuses("skewed"));
        assert!(!clock_refuses("drift") && !clock_refuses("ok") && !clock_refuses("unverified"));
    }

    #[test]
    fn unset_clock_refuses_internet_but_not_lan() {
        let (a, dir, _) = mk(false);
        let cloud = SecretKey::generate();
        let cpub = B64.encode(cloud.public().as_bytes());
        let secret = a.st.lock().unwrap().pair_secret.clone();
        let body = json!({"k":secret,"cloudPub":cpub,"project":"p1","nonce":"0123456789abcdef"}).to_string();
        a.claim(body.as_bytes()).unwrap();
        let eid = a.id_hex().to_string();
        let t = tok(&cloud, &claims(&eid, "dev", 100)); // iat 100 = 1970
        // clock 1970 (no RTC): internet -> clock-invalid, LAN keeps the normal token decision
        assert_eq!(a.authorize_at(&head("GET", "/media/cam/200_sub.live.mp4", Some(&t)), "dev", false, 150).unwrap_err().1, "clock-invalid");
        assert!(a.authorize_at(&head("GET", "/media/cam/200_sub.live.mp4", Some(&t)), "dev", true, 150).is_ok());
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn open_mode_ends_with_the_claim() {
        let (a, dir, _) = mk(true);
        assert!(a.is_open_mode());
        assert_eq!(a.summary()["openMode"], true);
        let cpub = B64.encode(SecretKey::generate().public().as_bytes());
        let secret = a.st.lock().unwrap().pair_secret.clone();
        let body = json!({"k":secret,"cloudPub":cpub,"project":"p1","nonce":"0123456789abcdef"}).to_string();
        a.claim(body.as_bytes()).unwrap();
        assert!(!a.is_open_mode());
        assert_eq!(a.mode(), "token");
        assert_eq!(a.summary()["openMode"], false);
        assert_eq!(a.authorize_at(&head("GET", "/", None), "D", false, now_unix()).unwrap_err().1, "token-missing");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn identity_change_drops_the_old_claim() {
        let (a, dir, _sk) = mk(false);
        let cpub = B64.encode(SecretKey::generate().public().as_bytes());
        let secret = a.st.lock().unwrap().pair_secret.clone();
        a.claim(json!({"k":secret,"cloudPub":cpub,"project":"p1","nonce":"0123456789abcdef"}).to_string().as_bytes()).unwrap();
        assert!(a.claimed());
        // same auth.json, different key (key file lost): must NOT stay claimed to an id the cloud does not know
        let a2 = Auth::load(SecretKey::generate(), &dir, false, false, None).unwrap();
        assert!(!a2.claimed());
        assert!(a2.pair_payload().is_some(), "pairing QR is back so the box can be claimed again");
        assert!(a2.audit.tail(10).iter().any(|e| e["ev"] == "identity_changed"));
        assert!(std::fs::read_dir(&dir).unwrap().any(|f| f.unwrap().file_name().to_string_lossy().starts_with("auth.json.orphan-")));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn damaged_state_file_does_not_crash_or_claim() {
        let (a, dir, sk) = mk(false);
        drop(a);
        std::fs::write(dir.join("auth.json"), "{not json").unwrap();
        let a2 = Auth::load(sk, &dir, false, false, None).unwrap();
        assert!(!a2.claimed());
        assert_eq!(a2.mode(), "locked");
        assert!(a2.audit.tail(10).iter().any(|e| e["ev"] == "auth_corrupt"));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn audit_rotation_cursor_and_backlog() {
        let dir = std::env::temp_dir().join(format!("h2z-aud-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let sk = SecretKey::generate();
        // tiny files: rotate often, keep 2 copies
        let opts = Opts { audit_max_bytes: 400, audit_keep: 2, ..Opts::default() };
        let a = Auth::load_with(sk.clone(), &dir, false, false, None, opts.clone(), 1).unwrap();
        for i in 0..40 {
            a.audit("t", json!({"i": i, "pad": "xxxxxxxxxxxxxxxxxxxx"}));
        }
        // disk use is bounded: live file + 2 rotated copies, nothing else
        let names: Vec<String> = std::fs::read_dir(&dir).unwrap().map(|f| f.unwrap().file_name().to_string_lossy().to_string()).filter(|n| n.starts_with("audit.jsonl")).collect();
        assert!(names.len() <= 3, "{names:?}");
        let total: u64 = names.iter().map(|n| std::fs::metadata(dir.join(n)).unwrap().len()).sum();
        assert!(total <= 3 * (400 + 120), "{total}");
        // pending = what the files still hold, in order, no duplicates; cursor moves only on acknowledge
        let p = a.audit_pending(1000);
        let seqs: Vec<u64> = p.iter().map(|e| e["seq"].as_u64().unwrap()).collect();
        assert!(seqs.windows(2).all(|w| w[0] < w[1]) && *seqs.last().unwrap() == 40);
        assert_eq!(a.audit_pending(3).len(), 3);
        a.audit_mark_uploaded(seqs[2]).unwrap();
        assert_eq!(a.audit_pending(1000)[0]["seq"].as_u64().unwrap(), seqs[3]);
        assert_eq!(a.audit_counters(), (40, seqs[2]));
        // the cursor survives a restart, and a cursor ahead of a lost log is reset
        let a2 = Auth::load_with(sk.clone(), &dir, false, false, None, opts.clone(), 2).unwrap();
        assert_eq!(a2.audit_counters().1, seqs[2]);
        for n in &names {
            std::fs::remove_file(dir.join(n)).ok();
        }
        let a3 = Auth::load_with(sk, &dir, false, false, None, opts, 3).unwrap();
        assert_eq!(a3.audit_counters(), (0, 0));
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn open_mode_is_explicit() {
        let (a, dir, _) = mk(true);
        assert_eq!(a.mode(), "open");
        assert!(a.authorize_at(&head("GET", "/", None), "D", false, 1).unwrap().is_none());
        std::fs::remove_dir_all(dir).ok();
    }
}

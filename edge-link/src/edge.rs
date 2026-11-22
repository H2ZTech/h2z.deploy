//! Edge side: accepts iroh connections and proxies each stream to the local
//! HTTP upstream (the NVR web/API/media server).
//!
//! SECURITY: see `auth.rs`. Unclaimed edge = locked (only `/_h2z/claim` and
//! `/_h2z/info`); claimed edge = cloud-signed token on every request, bound to
//! the viewer's device key. `--open` (validation only) disables all checks
//! while unclaimed; `--allow` is the legacy unclaimed allowlist.
//!
//! LIMITS: see `limits.rs` (relay = sub streams only + rate limit, concurrency caps).
//! WEBSOCKET: a GET with `Upgrade: websocket` is authorized like any request, then the stream becomes a raw
//! byte pipe to the upstream after the `101` response head, cut at the token's expiry.
use std::{collections::HashSet, sync::Arc, time::Instant};

use anyhow::{anyhow, bail, Result};
use bytes::Bytes;
use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    Endpoint, EndpointId,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::{
    auth::{hex, now_unix, stream_of, Auth, Claims, TOKEN_HEADER},
    limits::{constrained, relay_gate, ConnCtx, Gate, PathKind},
    net::{path_kind, selected_path, spawn_path_logger},
    status::Status,
    wire::{encode_line, is_hop_by_hop, read_head, ReqHead, RespHead, ALPN},
};

const MAX_REQUEST_BODY: usize = 32 * 1024 * 1024;

struct Shared {
    client: reqwest::Client,
    base: String, // upstream origin without trailing slash, e.g. http://127.0.0.1:8080
    allow: HashSet<EndpointId>,
    status: Arc<Status>,
    auth: Arc<Auth>,
    gate: Arc<Gate>,
    iroh_port: u16, // the UDP port we are bound to (lanHints.iroh)
}

pub async fn run(
    endpoint: Endpoint,
    upstream: String,
    allow: HashSet<EndpointId>,
    status: Arc<Status>,
    auth: Arc<Auth>,
    gate: Arc<Gate>,
) -> Result<()> {
    let u = reqwest::Url::parse(&upstream).map_err(|e| anyhow!("bad --upstream: {e}"))?;
    if u.path() != "/" && !u.path().is_empty() {
        bail!("--upstream must be an origin without a path");
    }
    match auth.mode() {
        "open" => {
            tracing::warn!("OPEN MODE (--open / EDGE_OPEN): no access control while unclaimed (transition only; claim the box to switch to token mode)");
            auth.audit("open_mode", serde_json::json!({"note": "started in open mode"}));
        }
        "locked" => tracing::info!("edge is LOCKED until claimed (scan the pairing QR with the integrator app)"),
        m => tracing::info!(mode = m, "access control"),
    }
    let shared = Arc::new(Shared {
        client: reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .build()?,
        base: upstream.trim_end_matches('/').to_string(),
        allow,
        status,
        auth,
        gate,
        iroh_port: crate::net::bound_port(&endpoint),
    });

    while let Some(incoming) = endpoint.accept().await {
        let shared = shared.clone();
        tokio::spawn(async move {
            let conn = match incoming.await {
                Ok(c) => c,
                Err(e) => {
                    tracing::debug!("handshake failed: {e}");
                    return;
                }
            };
            let remote = conn.remote_id();
            if !shared.auth.pre_check(&remote, &shared.allow) {
                tracing::warn!(%remote, "rejected: not in allowlist");
                conn.close(1u32.into(), b"forbidden");
                return;
            }
            let Some(_slot) = shared.gate.conn_enter() else {
                shared.gate.busy_rejects.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                shared.auth.audit_coalesced(
                    "conn-limit".into(),
                    "busy",
                    serde_json::json!({"what":"connections","max":shared.gate.limits.max_conns}),
                );
                tracing::warn!(%remote, "rejected: too many viewer connections");
                conn.close(4u32.into(), b"busy");
                return;
            };
            // The app probes every ~20 s (connect, GET /_h2z/info, close): that must not flood the log. A connection is
            // announced at INFO ("viewer active") when its first authorized non-internal request arrives; until then
            // connect / disconnect / path events are debug.
            let ctx = Arc::new(ConnCtx::new(&shared.gate.limits));
            tracing::debug!(%remote, "viewer connected");
            spawn_path_logger(format!("viewer {remote}"), &conn, Some(ctx.active.clone()));
            let _guard = shared.status.viewer_connected(&conn);
            let _cguard = shared.auth.register(&conn);
            serve_conn(conn.clone(), shared, ctx.clone()).await;
            if ctx.active.load(std::sync::atomic::Ordering::Relaxed) {
                tracing::info!(%remote, "viewer disconnected");
            } else {
                tracing::debug!(%remote, "probe disconnected");
            }
        });
    }
    Ok(())
}

async fn serve_conn(conn: Connection, shared: Arc<Shared>, ctx: Arc<ConnCtx>) {
    let remote = conn.remote_id();
    loop {
        match conn.accept_bi().await {
            Ok((send, recv)) => {
                let shared = shared.clone();
                let conn2 = conn.clone();
                let ctx = ctx.clone();
                tokio::spawn(async move {
                    if let Err(e) = handle_stream(send, recv, &shared, &conn2, &ctx).await {
                        tracing::debug!(%remote, "stream error: {e:#}");
                    }
                });
            }
            Err(_) => break,
        }
    }
}

fn build_url(base: &str, p: &str) -> Result<reqwest::Url> {
    // Path must be origin-relative. "//host/x" would be parsed as a
    // network-path reference by Url::join, so build the string ourselves and
    // verify the origin did not change.
    if !p.starts_with('/') || p.starts_with("//") || p.contains('\\') {
        bail!("bad request path");
    }
    let full = reqwest::Url::parse(&format!("{base}{p}"))?;
    let b = reqwest::Url::parse(base)?;
    if full.origin() != b.origin() {
        bail!("request escaped upstream origin");
    }
    Ok(full)
}

/// `Upgrade: websocket` request (GET only).
pub fn is_ws_upgrade(head: &ReqHead) -> bool {
    head.m.eq_ignore_ascii_case("GET")
        && head.h.iter().any(|(k, v)| k.eq_ignore_ascii_case("upgrade") && v.to_ascii_lowercase().contains("websocket"))
}

/// Re-reads the selected path at most every 2 s (a path can change mid-stream: hole punching succeeds / fails).
struct PathWatch {
    at: Instant,
    kind: PathKind,
}
impl PathWatch {
    fn new(kind: PathKind) -> Self {
        Self { at: Instant::now(), kind }
    }
    fn kind(&mut self, conn: &Connection) -> PathKind {
        if self.at.elapsed().as_secs() >= 2 {
            self.kind = path_kind(conn);
            self.at = Instant::now();
        }
        self.kind
    }
}

async fn handle_stream(
    mut send: SendStream,
    mut recv: RecvStream,
    sh: &Shared,
    conn: &Connection,
    ctx: &ConnCtx,
) -> Result<()> {
    let t0 = Instant::now();
    let (hb, leftover) = read_head(&mut recv).await?;
    let head: ReqHead = serde_json::from_slice(&hb)?;
    let method = reqwest::Method::from_bytes(head.m.as_bytes())?;

    // Edge-internal endpoints (never proxied upstream).
    if head.p.starts_with("/_h2z/") {
        let mut body = leftover.to_vec();
        while let Some(chunk) = recv.read_chunk(16 * 1024).await? {
            body.extend_from_slice(&chunk);
            if body.len() > 16 * 1024 {
                bail!("internal request too large");
            }
        }
        let (code, v) = match (head.m.as_str(), head.p.as_str()) {
            ("GET", "/_h2z/info") => {
                let now = now_unix();
                let mut v = serde_json::json!({
                    "v":1,"edge":sh.auth.id_hex(),"claimed":sh.auth.claimed(),"mode":sh.auth.mode(),
                    "ver":env!("CARGO_PKG_VERSION"),"clock":sh.auth.clock_state(now),"time":now,
                    // LAN IPv4 addresses only (contract section 3): lets the app find the recorder on its LAN
                    "lan": sh.auth.lan_ips(),
                });
                // Detailed LAN hints (ports, interfaces, whether the web UI is exposed): token holders only.
                let remote = hex(conn.remote_id().as_bytes());
                if sh.auth.token_claims(&head, &remote, now).is_some() {
                    let lan = sh.auth.lan_hints(now);
                    if !lan.is_null() {
                        v["lanHints"] = lan;
                        if sh.iroh_port != 0 {
                            v["lanHints"]["iroh"] = sh.auth.iroh_hints(sh.iroh_port);
                        }
                    }
                }
                (200, v)
            }
            ("POST", "/_h2z/claim") => match sh.auth.claim(&body) {
                Ok(v) => (200, v),
                Err((c, e)) => (c, serde_json::json!({"error": e})),
            },
            _ => (404, serde_json::json!({"error":"not-found"})),
        };
        return reply_json(&mut send, code, &v, &[]).await;
    }

    let mut watch = PathWatch::new(path_kind(conn));
    let lan = watch.kind == PathKind::Lan;
    let grant: Option<Claims> = match sh.auth.authorize(&head, conn, lan) {
        Ok(g) => g,
        Err((code, e)) => return reply_json(&mut send, code, &serde_json::json!({"error": e}), &[]).await,
    };
    if let Some(c) = &grant {
        sh.auth.note_session(conn, c, &head.p);
    }
    if !ctx.active.swap(true, std::sync::atomic::Ordering::Relaxed) {
        tracing::info!(remote = %conn.remote_id(), selected = %selected_path(conn), "viewer active");
    }
    // Relay path: sub streams only (main waits for a direct path).
    if let Err((code, e)) = relay_gate(&sh.gate.limits, watch.kind, &head.p) {
        sh.auth.audit_coalesced(
            format!("{e}:{}", hex(conn.remote_id().as_bytes())),
            "deny",
            serde_json::json!({"code":e,"dev":hex(conn.remote_id().as_bytes()),"path":head.p,"selected":selected_path(conn)}),
        );
        return reply_json(&mut send, code, &serde_json::json!({"error": e}), &[("retry-after", "3")]).await;
    }
    // Concurrency caps (per connection, then total): answer quickly instead of queueing.
    let permits = (ctx.streams.clone().try_acquire_owned(), sh.gate.total.clone().try_acquire_owned());
    let (_p1, _p2) = match permits {
        (Ok(a), Ok(b)) => (a, b),
        _ => {
            sh.gate.busy_rejects.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            sh.auth.audit_coalesced(
                "streams-limit".into(),
                "busy",
                serde_json::json!({"what":"streams","perConn":sh.gate.limits.max_streams_conn,"total":sh.gate.limits.max_streams_total}),
            );
            return reply_json(&mut send, 429, &serde_json::json!({"error":"too-busy"}), &[("retry-after", "2")]).await;
        }
    };

    if is_ws_upgrade(&head) {
        return handle_ws(send, recv, sh, conn, ctx, &head, leftover, grant, watch).await;
    }
    let url = build_url(&sh.base, &head.p)?;
    let is_main = stream_of(&head.p) == Some("main");

    // Request body (only for methods that carry one).
    let mut body: Vec<u8> = Vec::new();
    let has_body = !matches!(method, reqwest::Method::GET | reqwest::Method::HEAD);
    if has_body {
        body.extend_from_slice(&leftover);
        while let Some(chunk) = recv.read_chunk(64 * 1024).await? {
            body.extend_from_slice(&chunk);
            if body.len() > MAX_REQUEST_BODY {
                bail!("request body too large");
            }
        }
    }

    let mut rb = sh.client.request(method, url);
    for (k, v) in &head.h {
        let lk = k.to_ascii_lowercase();
        if is_hop_by_hop(&lk) || lk == "host" || lk == "content-length" || lk == TOKEN_HEADER {
            continue;
        }
        rb = rb.header(k.as_str(), v.as_str());
    }
    if has_body {
        rb = rb.body(body);
    }

    let mut resp = match rb.send().await {
        Ok(r) => r,
        Err(e) => {
            let msg = format!("upstream error: {e}");
            send.write_chunk(encode_line(&RespHead { s: 502, h: Default::default() })?)
                .await?;
            send.write_chunk(Bytes::from(msg)).await?;
            send.finish()?;
            return Ok(());
        }
    };

    let mut h = std::collections::BTreeMap::new();
    for name in resp.headers().keys() {
        if is_hop_by_hop(name.as_str()) {
            continue;
        }
        let vals: Vec<&str> = resp
            .headers()
            .get_all(name)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .collect();
        h.insert(name.as_str().to_string(), vals.join(", "));
    }
    let status = resp.status().as_u16();
    send.write_chunk(encode_line(&RespHead { s: status, h })?).await?;
    let ttfb = t0.elapsed();

    let mut total: u64 = 0;
    loop {
        // A stream never outlives its token: cut it at `exp` (the client refreshes and reconnects).
        let next = match &grant {
            Some(c) => {
                let left = c.exp.saturating_sub(now_unix());
                match tokio::time::timeout(std::time::Duration::from_secs(left), resp.chunk()).await {
                    Ok(r) => r,
                    Err(_) => {
                        let _ = send.reset(3u32.into());
                        sh.auth.audit(
                            "stream_cut",
                            serde_json::json!({"sub":c.sub,"dev":c.dev,"path":head.p,"why":"token-expired","bytes":total}),
                        );
                        bail!("stream cut at token expiry after {total} bytes");
                    }
                }
            }
            None => resp.chunk().await,
        };
        match next {
            Ok(Some(chunk)) => {
                total += chunk.len() as u64;
                // Relay path now (it can change while the stream runs): no main stream, and the rate limit applies.
                if watch.kind(conn) == PathKind::Relay {
                    if is_main && !sh.gate.limits.relay_main_allowed {
                        let _ = send.reset(5u32.into());
                        sh.auth.audit(
                            "stream_cut",
                            serde_json::json!({"sub":grant.as_ref().map(|c| c.sub.as_str()),"dev":hex(conn.remote_id().as_bytes()),"path":head.p,"why":"relay-main","bytes":total}),
                        );
                        bail!("main stream cut: path fell back to relay after {total} bytes");
                    }
                    if let Some(p) = &ctx.pacer {
                        p.pace(chunk.len()).await;
                    }
                }
                send.write_chunk(chunk).await?;
            }
            Ok(None) => break,
            Err(e) => {
                let _ = send.reset(0u32.into());
                bail!("upstream body error after {total} bytes: {e}");
            }
        }
    }
    send.finish()?;
    sh.status.requests.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    sh.status.bytes_out.fetch_add(total, std::sync::atomic::Ordering::Relaxed);
    tracing::debug!(
        path = %head.p, status, ttfb_ms = ttfb.as_millis() as u64, bytes = total,
        selected = %selected_path(conn), "served"
    );
    Ok(())
}

/// WebSocket over the stream: raw HTTP/1.1 handshake to the upstream, then a byte pipe both ways.
/// The wire protocol stays "one JSON head line each way"; after a `101` response head the stream is opaque
/// WebSocket bytes until either side ends or the token expires.
#[allow(clippy::too_many_arguments)]
async fn handle_ws(
    mut send: SendStream,
    mut recv: RecvStream,
    sh: &Shared,
    conn: &Connection,
    ctx: &ConnCtx,
    head: &ReqHead,
    leftover: Bytes,
    grant: Option<Claims>,
    mut watch: PathWatch,
) -> Result<()> {
    build_url(&sh.base, &head.p)?; // same path hygiene as plain requests
    let u = reqwest::Url::parse(&sh.base)?;
    let host = u.host_str().ok_or_else(|| anyhow!("upstream has no host"))?.to_string();
    let port = u.port_or_known_default().unwrap_or(80);
    let mut tcp = match tokio::time::timeout(std::time::Duration::from_secs(5), tokio::net::TcpStream::connect((host.as_str(), port))).await {
        Ok(Ok(t)) => t,
        _ => {
            send.write_chunk(encode_line(&RespHead { s: 502, h: Default::default() })?).await?;
            send.write_chunk(Bytes::from("upstream error: connect")).await?;
            send.finish()?;
            return Ok(());
        }
    };
    let mut req = format!("GET {} HTTP/1.1\r\nHost: {host}:{port}\r\n", head.p);
    for (k, v) in &head.h {
        let lk = k.to_ascii_lowercase();
        if lk == "host" || lk == "content-length" || lk == TOKEN_HEADER || lk == "transfer-encoding" {
            continue;
        }
        if k.contains(['\r', '\n', ':']) || v.contains(['\r', '\n']) {
            bail!("bad header");
        }
        req.push_str(&format!("{k}: {v}\r\n"));
    }
    req.push_str("\r\n");
    tcp.write_all(req.as_bytes()).await?;

    // Response head (up to the blank line).
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    let end = loop {
        let mut tmp = [0u8; 4096];
        let n = tokio::time::timeout(std::time::Duration::from_secs(10), tcp.read(&mut tmp)).await??;
        if n == 0 {
            bail!("upstream closed during websocket handshake");
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > 64 * 1024 {
            bail!("upstream websocket response head too large");
        }
    };
    let text = String::from_utf8_lossy(&buf[..end]).to_string();
    let mut lines = text.split("\r\n");
    let status: u16 = lines.next().and_then(|l| l.split_whitespace().nth(1)).and_then(|c| c.parse().ok()).ok_or_else(|| anyhow!("bad upstream status line"))?;
    let mut h = std::collections::BTreeMap::new();
    for l in lines {
        if let Some((k, v)) = l.split_once(':') {
            let lk = k.trim().to_ascii_lowercase();
            // for a 101 the client needs `upgrade` / `connection`; for anything else they are hop-by-hop
            if status != 101 && is_hop_by_hop(&lk) {
                continue;
            }
            h.insert(lk, v.trim().to_string());
        }
    }
    send.write_chunk(encode_line(&RespHead { s: status, h })?).await?;
    let rest = Bytes::copy_from_slice(&buf[end..]);
    if status != 101 {
        // not upgraded: plain response, pass what we have and drain
        if !rest.is_empty() {
            send.write_chunk(rest).await?;
        }
        let mut tmp = vec![0u8; 16 * 1024];
        loop {
            let n = tokio::time::timeout(std::time::Duration::from_secs(10), tcp.read(&mut tmp)).await.unwrap_or(Ok(0))?;
            if n == 0 {
                break;
            }
            send.write_all(&tmp[..n]).await?;
        }
        send.finish()?;
        return Ok(());
    }
    if !rest.is_empty() {
        send.write_chunk(rest).await?;
    }
    sh.auth.audit_coalesced(
        format!("ws:{}", hex(conn.remote_id().as_bytes())),
        "ws_open",
        serde_json::json!({"sub":grant.as_ref().map(|c| c.sub.as_str()),"dev":hex(conn.remote_id().as_bytes()),"path":head.p}),
    );

    let (mut tr, mut tw) = tcp.into_split();
    let pre = leftover; // bytes the viewer sent right behind the head (normally none)
    let up = async {
        if !pre.is_empty() {
            tw.write_all(&pre).await?;
        }
        while let Some(c) = recv.read_chunk(16 * 1024).await? {
            tw.write_all(&c).await?;
        }
        let _ = tw.shutdown().await;
        Ok::<_, anyhow::Error>(())
    };
    let is_main = stream_of(&head.p) == Some("main");
    let down = async {
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let n = tr.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            if watch.kind(conn) == PathKind::Relay {
                if is_main && !sh.gate.limits.relay_main_allowed {
                    bail!("relay-main");
                }
                if let Some(p) = &ctx.pacer {
                    p.pace(n).await;
                }
            }
            send.write_all(&buf[..n]).await?;
        }
        Ok::<_, anyhow::Error>(())
    };
    let pipe = async {
        tokio::select! {
            r = up => r,
            r = down => r,
        }
    };
    let left = grant.as_ref().map(|c| c.exp.saturating_sub(now_unix()));
    let res = match left {
        Some(l) => match tokio::time::timeout(std::time::Duration::from_secs(l), pipe).await {
            Ok(r) => r,
            Err(_) => {
                sh.auth.audit(
                    "stream_cut",
                    serde_json::json!({"sub":grant.as_ref().map(|c| c.sub.as_str()),"dev":grant.as_ref().map(|c| c.dev.as_str()),"path":head.p,"why":"token-expired","ws":true}),
                );
                let _ = send.reset(3u32.into());
                bail!("websocket cut at token expiry");
            }
        },
        None => pipe.await,
    };
    match res {
        Ok(()) => {
            let _ = send.finish();
            Ok(())
        }
        Err(e) => {
            if e.to_string() == "relay-main" {
                sh.auth.audit(
                    "stream_cut",
                    serde_json::json!({"dev":hex(conn.remote_id().as_bytes()),"path":head.p,"why":"relay-main","ws":true}),
                );
            }
            let _ = send.reset(0u32.into());
            Err(e)
        }
    }
}

async fn reply_json(send: &mut SendStream, code: u16, v: &serde_json::Value, extra: &[(&str, &str)]) -> Result<()> {
    let mut h = std::collections::BTreeMap::new();
    h.insert("content-type".to_string(), "application/json".to_string());
    h.insert("cache-control".to_string(), "no-store".to_string());
    for (k, v) in extra {
        h.insert(k.to_string(), v.to_string());
    }
    send.write_chunk(encode_line(&RespHead { s: code, h })?).await?;
    send.write_chunk(Bytes::from(v.to_string())).await?;
    send.finish()?;
    Ok(())
}

pub fn alpns() -> Vec<Vec<u8>> {
    vec![ALPN.to_vec()]
}

#[allow(dead_code)]
fn _constrained_is_used(k: PathKind) -> bool {
    constrained(k)
}

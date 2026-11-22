mod audit_upload;
mod auth;
mod edge;
mod limits;
mod status;
mod net;
mod viewer;
mod wire;
#[cfg(test)]
mod contract_vectors;
#[cfg(test)]
mod e2e;

use std::{collections::HashSet, net::SocketAddr, path::PathBuf};

use anyhow::{anyhow, Result};
use clap::{Parser, Subcommand};
use iroh::{EndpointAddr, EndpointId, TransportAddr};
use net::NetMode;

#[derive(Parser)]
#[command(name = "edge-link", version, about = "HTTP over iroh: edge proxy and loopback viewer")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Run on the NVR box: accept viewers over iroh and proxy to the local web server.
    Edge {
        /// Local HTTP origin to proxy to, e.g. http://127.0.0.1:8080
        #[arg(long, default_value = "http://127.0.0.1:8080")]
        upstream: String,
        /// Where the edge identity key lives (created on first run, mode 0600).
        #[arg(long, default_value = "edge.key")]
        key_file: PathBuf,
        /// Legacy allowlist of viewer EndpointIds, honoured only while the edge is unclaimed.
        #[arg(long = "allow")]
        allow: Vec<String>,
        /// Validation only: no access control while unclaimed (otherwise an unclaimed edge is locked).
        #[arg(long, env = "EDGE_OPEN", value_parser = clap::builder::BoolishValueParser::new(), num_args = 0..=1, default_missing_value = "true", default_value = "false")]
        open: bool,
        /// Pre-provisioned cloud public keys (base64url, comma separated). Together with --project
        /// this marks the edge as claimed (factory provisioning); normally the claim flow sets it.
        #[arg(long, env = "H2Z_CLOUD_PUBKEY", value_delimiter = ',')]
        cloud_pubkey: Vec<String>,
        #[arg(long, env = "H2Z_PROJECT")]
        project: Option<String>,
        /// Cloud API origin used to pull the signed roster (set by the claim; this is a default).
        #[arg(long, env = "H2Z_CLOUD_URL", default_value = "")]
        cloud_url: String,
        #[arg(long, value_enum, default_value = "n0")]
        net: NetMode,
        /// Fixed iroh UDP port (the compose file publishes it; LAN phones dial it directly, contract 13.1). 0 = random.
        #[arg(long, env = "H2Z_IROH_PORT", default_value_t = 11204)]
        bind_port: u16,
        /// Custom relay URL (self-hosted relay), overrides the n0 default relays.
        #[arg(long)]
        relay_url: Option<String>,
        /// Do not publish/resolve via n0 DNS discovery.
        #[arg(long)]
        no_discovery: bool,
        /// Status HTTP server (/healthz, /status, /summary). Keep it inside the compose network.
        #[arg(long, default_value = "0.0.0.0:8099")]
        status_listen: std::net::SocketAddr,
        /// Allow main streams through a relay (default: relay carries sub streams only).
        #[arg(long, env = "H2Z_RELAY_MAIN", value_parser = clap::builder::BoolishValueParser::new(), num_args = 0..=1, default_missing_value = "true", default_value = "false")]
        relay_main: bool,
        /// Rate limit per viewer connection while on a relay, kbit/s (0 = unlimited).
        #[arg(long, env = "H2Z_RELAY_MAX_KBPS", default_value_t = 6000)]
        relay_max_kbps: u64,
        #[arg(long, env = "H2Z_MAX_STREAMS_CONN", default_value_t = 32)]
        max_streams_conn: usize,
        #[arg(long, env = "H2Z_MAX_STREAMS", default_value_t = 128)]
        max_streams: usize,
        #[arg(long, env = "H2Z_MAX_CONNS", default_value_t = 32)]
        max_conns: usize,
        /// Edge clock vs cloud time: warn above / refuse internet requests above (seconds).
        #[arg(long, env = "H2Z_CLOCK_WARN_SEC", default_value_t = 60)]
        clock_warn: i64,
        #[arg(long, env = "H2Z_CLOCK_MAX_SEC", default_value_t = 300)]
        clock_max: i64,
        /// audit.jsonl rotation: size per file and number of rotated copies (disk use <= (keep+1) * max).
        #[arg(long, env = "H2Z_AUDIT_MAX_BYTES", default_value_t = 5 * 1024 * 1024)]
        audit_max_bytes: u64,
        #[arg(long, env = "H2Z_AUDIT_KEEP", default_value_t = 1)]
        audit_keep: u32,
        /// Upload the audit to the cloud (needs the cloud endpoint from contract section 12; off = stays local).
        #[arg(long, env = "H2Z_AUDIT_UPLOAD", value_parser = clap::builder::BoolishValueParser::new(), num_args = 0..=1, default_missing_value = "true", default_value = "false")]
        audit_upload: bool,
        #[arg(long, env = "H2Z_AUDIT_UPLOAD_SEC", default_value_t = 300)]
        audit_upload_sec: u64,
    },
    /// Factory reset of the identity: delete key + claim + audit in the key file's directory. A new key means a
    /// new recorder id: it has to be claimed again (and the old one revoked in the cloud project).
    FactoryReset {
        #[arg(long, default_value = "edge.key")]
        key_file: PathBuf,
        /// Required: this cannot be undone.
        #[arg(long)]
        yes: bool,
    },
    /// Container healthcheck: exit 0 if the local status server answers /healthz.
    Health {
        #[arg(long, default_value = "127.0.0.1:8099")]
        addr: std::net::SocketAddr,
    },
    /// Loopback HTTP server that tunnels to an edge (desktop shell core).
    Viewer {
        /// Edge EndpointId.
        #[arg(long)]
        edge: String,
        /// Optional direct address hints for the edge (repeatable), e.g. 192.168.1.10:12345
        #[arg(long = "addr")]
        addrs: Vec<SocketAddr>,
        /// Relay URL hint for the edge (when using a self-hosted relay).
        #[arg(long)]
        edge_relay_url: Option<String>,
        #[arg(long, default_value = "127.0.0.1:0")]
        listen: SocketAddr,
        /// Viewer device key (created if missing). Omit for an ephemeral key.
        #[arg(long)]
        key_file: Option<PathBuf>,
        #[arg(long, value_enum, default_value = "n0")]
        net: NetMode,
        /// Our own relay URL (self-hosted relay).
        #[arg(long)]
        relay_url: Option<String>,
        #[arg(long)]
        no_discovery: bool,
        /// File with the current access token (x-h2z-token), re-read per request.
        #[arg(long)]
        token_file: Option<PathBuf>,
    },
}

/// 在终端（docker logs / SSH / 远程桌面）里画二维码。
/// 每个模块画成两个空格并用 ANSI 背景色上色（白底黑块、四周留白），不依赖字体的半块字符，
/// 行距再大也只是行间有细缝，比半块字符好认；深色终端也不会反色。
fn print_qr(payload: &str) {
    use qrcode::{Color, EcLevel, QrCode};
    let code = match QrCode::with_error_correction_level(payload.as_bytes(), EcLevel::M) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("qr: {e}");
            return;
        }
    };
    let w = code.width();
    let q = 4usize; // quiet zone
    let cell = |dark: bool| if dark { "\x1b[40m  \x1b[0m" } else { "\x1b[47m  \x1b[0m" };
    let mut out = String::new();
    for y in 0..(w + 2 * q) {
        for x in 0..(w + 2 * q) {
            let dark = x >= q && y >= q && x < w + q && y < w + q && code[(x - q, y - q)] == Color::Dark;
            out.push_str(cell(dark));
        }
        out.push('\n');
    }
    print!("{out}");
}

/// Wall clock vs monotonic clock every 10 s: a jump (NTP step, RTC fix, manual change) is written to the audit.
fn spawn_clock_watch(auth: std::sync::Arc<auth::Auth>) {
    tokio::spawn(async move {
        let mut mono = std::time::Instant::now();
        let mut wall = auth::now_unix() as i64;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
            let (m2, w2) = (std::time::Instant::now(), auth::now_unix() as i64);
            let d = (w2 - wall) - m2.duration_since(mono).as_secs() as i64;
            if d.abs() > 30 {
                tracing::warn!(delta_sec = d, "system clock jumped");
                auth.note_clock_jump(d);
            }
            mono = m2;
            wall = w2;
        }
    });
}

/// `<data dir>/status.json` (full snapshot, every 10 s, atomic, mode 0600): host-agent reads it for GET /v1/link.
fn spawn_status_file(st: std::sync::Arc<status::Status>, dir: PathBuf) {
    tokio::spawn(async move {
        loop {
            let mut v = st.snapshot(true);
            v["writtenAt"] = serde_json::json!(auth::now_unix());
            let tmp = dir.join("status.json.tmp");
            let ok = (|| -> std::io::Result<()> {
                use std::io::Write;
                #[cfg(unix)]
                let mut f = {
                    use std::os::unix::fs::OpenOptionsExt;
                    std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?
                };
                #[cfg(not(unix))]
                let mut f = std::fs::File::create(&tmp)?;
                f.write_all(v.to_string().as_bytes())?;
                std::fs::rename(&tmp, dir.join("status.json"))
            })();
            if ok.is_err() {
                tracing::debug!("status.json not written");
            }
            tokio::time::sleep(std::time::Duration::from_secs(10)).await;
        }
    });
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "edge_link=info,iroh=warn".into()),
        )
        .init();

    match Cli::parse().cmd {
        Cmd::Health { addr } => {
            use std::io::{Read, Write};
            let t = std::time::Duration::from_secs(3);
            let ok = (|| -> std::io::Result<bool> {
                let mut c = std::net::TcpStream::connect_timeout(&addr, t)?;
                c.set_read_timeout(Some(t))?;
                c.write_all(b"GET /healthz HTTP/1.0\r\nHost: x\r\n\r\n")?;
                let mut b = String::new();
                c.read_to_string(&mut b)?;
                Ok(b.starts_with("HTTP/1.1 200") || b.starts_with("HTTP/1.0 200"))
            })()
            .unwrap_or(false);
            std::process::exit(if ok { 0 } else { 1 });
        }
        Cmd::FactoryReset { key_file, yes } => {
            if !yes {
                eprintln!("refusing: this deletes the recorder identity ({}). Re-run with --yes (stop the edge-link service first).", key_file.display());
                std::process::exit(2);
            }
            let dir = key_file.parent().map(|p| p.to_path_buf()).filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| PathBuf::from("."));
            let mut gone = vec![];
            for f in [key_file.clone(), dir.join("auth.json"), dir.join("pair.txt"), dir.join("audit.jsonl"), dir.join("audit.jsonl.1"), dir.join("audit.jsonl.2"), dir.join("status.json"), dir.join("lan.json")] {
                if std::fs::remove_file(&f).is_ok() {
                    gone.push(f.display().to_string());
                }
            }
            println!("FACTORY_RESET removed: {}", if gone.is_empty() { "(nothing)".into() } else { gone.join(", ") });
            println!("The next start creates a NEW identity; claim it again and revoke the old recorder in the cloud project.");
        }
        Cmd::Edge { upstream, key_file, allow, open, cloud_pubkey, project, cloud_url, net, bind_port, relay_url, no_discovery, status_listen, relay_main, relay_max_kbps, max_streams_conn, max_streams, max_conns, clock_warn, clock_max, audit_max_bytes, audit_keep, audit_upload, audit_upload_sec } => {
            let key = net::load_or_create_key(&key_file)?;
            let allow: HashSet<EndpointId> = allow
                .iter()
                .map(|s| s.parse::<EndpointId>().map_err(|e| anyhow!("bad --allow {s}: {e}")))
                .collect::<Result<_>>()?;
            let dir = key_file.parent().map(|p| p.to_path_buf()).filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| PathBuf::from("."));
            let provision = match (project, cloud_pubkey.is_empty()) {
                (Some(p), false) if !p.is_empty() => Some(auth::Provision { keys: cloud_pubkey, project: p, cloud_url: cloud_url.trim_end_matches('/').to_string() }),
                _ => None,
            };
            let opts = auth::Opts { audit_max_bytes, audit_keep, clock_warn, clock_max };
            let auth = auth::Auth::load_with(key.clone(), &dir, open, !allow.is_empty(), provision, opts, auth::now_unix())?;
            auth.audit("boot", serde_json::json!({"ver": env!("CARGO_PKG_VERSION"), "mode": auth.mode(), "clock": auth.clock_state(auth::now_unix())}));
            let limits = limits::Limits { relay_main_allowed: relay_main, relay_max_kbps, max_streams_conn, max_streams_total: max_streams, max_conns };
            let gate = limits::Gate::new(limits);
            let ep = net::bind(key, net, relay_url, no_discovery, edge::alpns(), Some(max_streams_conn as u32 + 4), Some(bind_port)).await?;
            // Do not wait for the home relay here: the status server and the accept loop must
            // come up even when the box is offline (the status then says "connecting"/"offline").
            println!("EDGE_ID={}", ep.id());
            // 手机验证包（iroh_flutter）的输入框要 z32 格式
            println!("EDGE_ID_Z32={}", ep.id().to_z32());
            // 配对二维码：只在未认领时出现，带一次性配对码 k；认领后不再显示。
            let payload = auth.pair_payload();
            match &payload {
                Some(p) => {
                    println!("EDGE_PAIR={p}");
                    print_qr(p);
                    let _ = std::fs::write(dir.join("pair.txt"), format!("{p}\n"));
                }
                None => {
                    println!("EDGE_CLAIMED=1");
                    let _ = std::fs::remove_file(dir.join("pair.txt"));
                }
            }
            for a in ep.bound_sockets() {
                println!("EDGE_BOUND={a}");
            }
            println!("EDGE_ADDR={:?}", ep.addr());
            let st = status::Status::new(
                ep.clone(),
                format!("{net:?}").to_lowercase(),
                upstream.clone(),
                auth.clone(),
                allow.len(),
            );
            tokio::spawn({
                let st = st.clone();
                async move {
                    if let Err(e) = status::serve(st, status_listen).await {
                        tracing::error!("status server stopped: {e:#}");
                    }
                }
            });
            auth::spawn_roster_sync(auth.clone());
            if audit_upload {
                audit_upload::spawn(auth.clone(), std::time::Duration::from_secs(audit_upload_sec.max(30)));
            }
            spawn_clock_watch(auth.clone());
            spawn_status_file(st.clone(), dir.clone());
            tokio::select! {
                r = edge::run(ep.clone(), upstream, allow, st, auth.clone(), gate) => r?,
                _ = tokio::signal::ctrl_c() => {}
            }
            ep.close().await;
        }
        Cmd::Viewer { edge, addrs, edge_relay_url, listen, key_file, net, relay_url, no_discovery, token_file } => {
            if let Some(f) = token_file {
                let _ = viewer::TOKEN_FILE.set(f);
            }
            let key = match key_file {
                Some(p) => net::load_or_create_key(&p)?,
                None => iroh::SecretKey::generate(),
            };
            let ep = net::bind(key, net, relay_url, no_discovery, vec![], None, None).await?;
            println!("VIEWER_ID={}", ep.id());
            let id: EndpointId = edge.parse().map_err(|e| anyhow!("bad --edge: {e}"))?;
            let mut parts: Vec<TransportAddr> = addrs.into_iter().map(TransportAddr::Ip).collect();
            if let Some(u) = edge_relay_url {
                parts.push(TransportAddr::Relay(
                    u.parse().map_err(|e| anyhow!("bad --edge-relay-url: {e}"))?,
                ));
            }
            let target = EndpointAddr::from_parts(id, parts);
            tokio::select! {
                r = viewer::run(ep.clone(), target, listen) => r?,
                _ = tokio::signal::ctrl_c() => {}
            }
            ep.close().await;
        }
    }
    Ok(())
}

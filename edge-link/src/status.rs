//! Edge status for the admin UI / host tooling: is the iroh edge running, is it
//! reachable (home relay), who is connected and over which path (direct / relay).
//!
//! Served on `--status-listen` (default 0.0.0.0:8099, inside the compose
//! network only — never published on the host):
//!   GET /healthz   -> "ok"
//!   GET /status    -> full JSON (endpoint id, pairing payload, viewers with ids)
//!   GET /summary   -> reduced JSON that is safe to expose through nginx without
//!                     a login (no endpoint id, no viewer ids)
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use anyhow::Result;
use bytes::Bytes;
use http_body_util::Full;
use hyper::{body::Incoming, service::service_fn, Method, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use iroh::{endpoint::Connection, Endpoint, EndpointId, Watcher};
use serde_json::{json, Value};
use tokio::net::TcpListener;

struct Viewer {
    id: EndpointId,
    since_unix: u64,
    since: Instant,
    conn: Connection,
}

pub struct Status {
    endpoint: Endpoint,
    started: Instant,
    started_unix: u64,
    net: String,
    upstream: String,
    auth: Arc<crate::auth::Auth>,
    allow_count: usize,
    viewers: Mutex<HashMap<u64, Viewer>>,
    next: AtomicU64,
    pub requests: AtomicU64,
    pub bytes_out: AtomicU64,
    total_connections: AtomicU64,
}

/// ("direct" | "relay" | "none", rtt in ms, remote description)
fn path_info(conn: &Connection) -> (&'static str, Option<u64>, String) {
    for p in conn.paths().iter() {
        if p.is_selected() {
            let kind = if p.is_relay() { "relay" } else { "direct" };
            return (kind, Some(p.rtt().as_millis() as u64), format!("{:?}", p.remote_addr()));
        }
    }
    ("none", None, String::new())
}

fn now_unix() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

impl Status {
    pub fn new(endpoint: Endpoint, net: String, upstream: String, auth: Arc<crate::auth::Auth>, allow_count: usize) -> Arc<Self> {
        Arc::new(Self {
            endpoint,
            started: Instant::now(),
            started_unix: now_unix(),
            net,
            upstream,
            auth,
            allow_count,
            viewers: Mutex::new(HashMap::new()),
            next: AtomicU64::new(1),
            requests: AtomicU64::new(0),
            bytes_out: AtomicU64::new(0),
            total_connections: AtomicU64::new(0),
        })
    }

    /// Register a connected viewer; call the returned guard's `done()` (or drop it) on disconnect.
    pub fn viewer_connected(self: &Arc<Self>, conn: &Connection) -> ViewerGuard {
        let key = self.next.fetch_add(1, Ordering::Relaxed);
        self.total_connections.fetch_add(1, Ordering::Relaxed);
        self.viewers.lock().unwrap().insert(
            key,
            Viewer { id: conn.remote_id(), since_unix: now_unix(), since: Instant::now(), conn: conn.clone() },
        );
        ViewerGuard { st: self.clone(), key }
    }

    fn relays(&self) -> Vec<Value> {
        self.endpoint
            .home_relay_status()
            .get()
            .iter()
            .map(|r| {
                json!({
                    "url": r.url().to_string(),
                    "connected": r.is_connected(),
                    "lastError": r.last_error().map(|e| e.to_string()),
                    "authDenied": r.auth_denied_reason(),
                })
            })
            .collect()
    }

    /// running (always true if we answer) / reachable through a relay
    fn state(&self, relays: &[Value]) -> &'static str {
        if relays.iter().any(|r| r["connected"] == true) {
            "online"
        } else if self.net == "local" {
            "local-only"
        } else if self.started.elapsed().as_secs() < 30 {
            "connecting"
        } else {
            "offline"
        }
    }

    /// Machine-readable warnings for the admin UI (it decides the wording): open-mode, clock-*, roster-stale.
    fn warnings(&self) -> Vec<String> {
        let mut w = vec![];
        if self.auth.is_open_mode() {
            w.push("open-mode".to_string());
        }
        let c = self.auth.clock_state(now_unix());
        if c != "ok" && c != "unverified" {
            w.push(format!("clock-{c}"));
        }
        if self.auth.roster_age().map(|a| a > crate::auth::ROSTER_MAX_AGE).unwrap_or(false) {
            w.push("roster-expired".to_string());
        }
        w
    }

    pub fn snapshot(&self, full: bool) -> Value {
        let relays = self.relays();
        let state = self.state(&relays);
        let mut direct = 0;
        let mut relay = 0;
        let mut viewers = Vec::new();
        for v in self.viewers.lock().unwrap().values() {
            let (kind, rtt, remote) = path_info(&v.conn);
            match kind {
                "direct" => direct += 1,
                "relay" => relay += 1,
                _ => {}
            }
            let z32 = v.id.to_z32();
            viewers.push(json!({
                "id": z32,
                "idShort": &z32[..8.min(z32.len())],
                "connectedSec": v.since.elapsed().as_secs(),
                "connectedAt": v.since_unix,
                "path": kind,
                "rttMs": rtt,
                "remote": remote,
            }));
        }
        let mut out = json!({
            "service": "edge-link",
            "version": env!("CARGO_PKG_VERSION"),
            "running": true,
            "state": state,
            "net": self.net,
            "irohPort": crate::net::bound_port(&self.endpoint),
            "mode": self.auth.mode(),
            "claimed": self.auth.claimed(),
            "allowCount": self.allow_count,
            "uptimeSec": self.started.elapsed().as_secs(),
            "startedAt": self.started_unix,
            "relays": relays,
            "viewerCount": viewers.len(),
            "directCount": direct,
            "relayCount": relay,
            "totalConnections": self.total_connections.load(Ordering::Relaxed),
            "requests": self.requests.load(Ordering::Relaxed),
            "bytesOut": self.bytes_out.load(Ordering::Relaxed),
            "upstream": self.upstream,
            "openMode": self.auth.is_open_mode(),
            "clock": self.auth.clock_state(now_unix()),
            "warnings": self.warnings(),
        });
        let m = out.as_object_mut().unwrap();
        if full {
            m.insert("endpointId".into(), json!(self.endpoint.id().to_z32()));
            m.insert("pair".into(), json!(self.auth.pair_payload()));
            m.insert("access".into(), self.auth.full());
            m.insert("viewers".into(), json!(viewers));
        } else {
            // no id / pairing / viewer list on the unauthenticated summary
            m.remove("upstream");
            m.remove("relays");
        }
        out
    }
}

pub struct ViewerGuard {
    st: Arc<Status>,
    key: u64,
}
impl Drop for ViewerGuard {
    fn drop(&mut self) {
        self.st.viewers.lock().unwrap().remove(&self.key);
    }
}

fn reply(code: StatusCode, ctype: &str, body: String) -> Response<Full<Bytes>> {
    Response::builder()
        .status(code)
        .header("content-type", ctype)
        .header("cache-control", "no-store")
        .body(Full::new(Bytes::from(body)))
        .unwrap()
}

async fn handle(st: Arc<Status>, req: Request<Incoming>) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let r = match (req.method(), req.uri().path()) {
        (&Method::GET, "/healthz") => reply(StatusCode::OK, "text/plain", "ok".into()),
        (&Method::GET, "/status") => reply(StatusCode::OK, "application/json", st.snapshot(true).to_string()),
        (&Method::GET, "/summary") => reply(StatusCode::OK, "application/json", st.snapshot(false).to_string()),
        _ => reply(StatusCode::NOT_FOUND, "text/plain", "not found".into()),
    };
    Ok(r)
}

pub async fn serve(st: Arc<Status>, listen: SocketAddr) -> Result<()> {
    let l = TcpListener::bind(listen).await?;
    tracing::info!(%listen, "status server up");
    loop {
        let (s, _) = l.accept().await?;
        let st = st.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| handle(st.clone(), req));
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(s), svc).await;
        });
    }
}

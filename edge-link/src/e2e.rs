//! In-process end-to-end tests: a real iroh edge (local network mode, loopback) in front of a stub HTTP/WebSocket
//! upstream, a real iroh client, real tokens signed by a test cloud key. What this cannot cover: relay paths and
//! NAT traversal (no relay in local mode) — those rules are unit tested in limits.rs and are listed as unverified.
use std::{collections::BTreeMap, net::SocketAddr, sync::Arc, time::Duration};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use iroh::{endpoint::Connection, Endpoint, EndpointAddr, SecretKey, TransportAddr};
use serde_json::{json, Value};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};

use crate::{
    audit_upload,
    auth::{hex, now_unix, Auth, Provision},
    edge,
    limits::{Gate, Limits},
    net::{self, NetMode},
    status::Status,
    wire::{encode_line, read_head, ReqHead, RespHead, ALPN},
};

/// upstream stub: /media/cam/200_sub.live.mp4 -> 200 bytes; /slow -> endless chunks; /ws -> 101 + echo
async fn upstream() -> SocketAddr {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            tokio::spawn(async move {
                let mut buf = vec![0u8; 8192];
                let mut got = Vec::new();
                loop {
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    got.extend_from_slice(&buf[..n]);
                    if got.windows(4).any(|w| w == b"\r\n\r\n") {
                        break;
                    }
                }
                let req = String::from_utf8_lossy(&got).to_string();
                let first = req.lines().next().unwrap_or("").to_string();
                // the token must never reach the upstream
                assert!(!req.to_ascii_lowercase().contains("x-h2z-token"), "token leaked to upstream: {req}");
                if first.starts_with("GET /ws") {
                    let _ = s.write_all(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: stub\r\n\r\n").await;
                    loop {
                        let n = s.read(&mut buf).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        if s.write_all(&buf[..n]).await.is_err() {
                            return;
                        }
                    }
                } else if first.starts_with("GET /slow") || first.contains("_sub.slow") {
                    let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nConnection: close\r\n\r\n").await;
                    loop {
                        if s.write_all(&[7u8; 1000]).await.is_err() {
                            return;
                        }
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                } else {
                    let _ = s.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 200\r\nConnection: close\r\n\r\n").await;
                    let _ = s.write_all(&[1u8; 200]).await;
                }
            });
        }
    });
    addr
}

struct Rig {
    auth: Arc<Auth>,
    cloud: SecretKey,
    client: Endpoint,
    target: EndpointAddr,
    dir: std::path::PathBuf,
    _edge: Endpoint,
}

async fn rig(tag: &str, limits: Limits, claimed: bool) -> Rig {
    let up = upstream().await;
    let dir = std::env::temp_dir().join(format!("h2z-e2e-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let cloud = SecretKey::generate();
    let esk = SecretKey::generate();
    let prov = claimed.then(|| Provision {
        keys: vec![B64.encode(cloud.public().as_bytes())],
        project: "p_e2e".into(),
        cloud_url: String::new(),
    });
    let auth = Auth::load(esk.clone(), &dir, false, false, prov).unwrap();
    let ep = net::bind(esk, NetMode::Local, None, true, edge::alpns(), Some(limits.max_streams_conn as u32 + 4), None).await.unwrap();
    let st = Status::new(ep.clone(), "local".into(), format!("http://{up}"), auth.clone(), 0);
    let gate = Gate::new(limits);
    tokio::spawn(edge::run(ep.clone(), format!("http://{up}"), Default::default(), st, auth.clone(), gate));
    let port = ep.bound_sockets().first().unwrap().port();
    let target = EndpointAddr::from_parts(ep.id(), [TransportAddr::Ip(SocketAddr::from(([127, 0, 0, 1], port)))]);
    let client = net::bind(SecretKey::generate(), NetMode::Local, None, true, vec![], None, None).await.unwrap();
    Rig { auth, cloud, client, target, dir, _edge: ep }
}

impl Rig {
    fn token(&self, dev: &str, cams: &[&str], st: &str, scope: &str, life: u64) -> String {
        let now = now_unix();
        let c = json!({"v":1,"aud":self.auth.id_hex(),"prj":"p_e2e","sub":"u1","role":"customer_viewer","scope":scope,"dev":dev,
            "cams":cams,"st":st,"iat":now,"exp":now+life,"jti":"j"});
        let p = B64.encode(c.to_string());
        let s = self.cloud.sign(format!("h2z1.{p}").as_bytes());
        format!("h2z1.{p}.{}", B64.encode(s.to_bytes()))
    }
    fn dev(&self) -> String {
        hex(self.client.id().as_bytes())
    }
    async fn conn(&self) -> Connection {
        self.client.connect(self.target.clone(), ALPN).await.unwrap()
    }
}

fn head(m: &str, p: &str, tok: Option<&str>, extra: &[(&str, &str)]) -> ReqHead {
    let mut h = BTreeMap::new();
    if let Some(t) = tok {
        h.insert("x-h2z-token".to_string(), t.to_string());
    }
    for (k, v) in extra {
        h.insert(k.to_string(), v.to_string());
    }
    ReqHead { m: m.into(), p: p.into(), h }
}

/// One request; returns (status, body bytes read until the stream ends or `max` elapsed).
async fn call(conn: &Connection, h: &ReqHead, max: Duration) -> (u16, Vec<u8>, bool) {
    let (mut send, mut recv) = conn.open_bi().await.unwrap();
    send.write_all(&encode_line(h).unwrap()).await.unwrap();
    send.finish().unwrap();
    let (hb, left) = read_head(&mut recv).await.unwrap();
    let rh: RespHead = serde_json::from_slice(&hb).unwrap();
    let mut body = left.to_vec();
    let ended = tokio::time::timeout(max, async {
        loop {
            match recv.read_chunk(16 * 1024).await {
                Ok(Some(c)) => body.extend_from_slice(&c),
                Ok(None) => return true,
                Err(_) => return false, // reset = cut
            }
        }
    })
    .await
    .unwrap_or(false);
    (rh.s, body, ended)
}

fn err_of(b: &[u8]) -> String {
    serde_json::from_slice::<Value>(b).ok().and_then(|v| v["error"].as_str().map(|s| s.to_string())).unwrap_or_default()
}

#[tokio::test]
async fn unclaimed_is_locked_and_claimed_needs_a_token() {
    let r = rig("lock", Limits::default(), false).await;
    let c = r.conn().await;
    let (s, b, _) = call(&c, &head("GET", "/media/cam/200_sub.live.mp4", None, &[]), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (403, "edge-unclaimed"));
    let (s, b, _) = call(&c, &head("GET", "/_h2z/info", None, &[]), Duration::from_secs(3)).await;
    assert_eq!(s, 200);
    let v: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!((v["claimed"].clone(), v["mode"].as_str().unwrap()), (json!(false), "locked"));
    assert_eq!(v["lan"], json!([]), "no host-agent file yet: empty list, never missing");
    std::fs::remove_dir_all(&r.dir).ok();
}

#[tokio::test]
async fn token_flow_scope_and_token_header_never_reaches_upstream() {
    let r = rig("tok", Limits::default(), true).await;
    let c = r.conn().await;
    let p = "/media/cam/200_sub.live.mp4";
    let (s, b, _) = call(&c, &head("GET", p, None, &[]), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (401, "token-missing"));
    let t = r.token(&r.dev(), &["200"], "sub", "view", 300);
    let (s, b, ended) = call(&c, &head("GET", p, Some(&t), &[]), Duration::from_secs(3)).await;
    assert_eq!((s, b.len(), ended), (200, 200, true)); // upstream asserts the token header was stripped
    let (s, b, _) = call(&c, &head("GET", "/media/cam/201_sub.live.mp4", Some(&t), &[]), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (403, "camera-not-granted"));
    let (s, b, _) = call(&c, &head("GET", "/media/cam/200_main.live.mp4", Some(&t), &[]), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (403, "stream-type-not-granted"));
    let other = r.token("0000000000000000000000000000000000000000000000000000000000000000", &["200"], "sub", "view", 300);
    let (s, b, _) = call(&c, &head("GET", p, Some(&other), &[]), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (403, "token-device"));
    // info: LAN hints only for a token holder
    std::fs::write(r.dir.join("lan.json"), json!({"v":1,"at":now_unix(),"ips":["10.0.0.5","127.0.0.1","172.17.0.1","8.8.8.8","not-an-ip"],"addresses":[{"ip":"10.0.0.5","port":8096}]}).to_string()).unwrap();
    // unauthenticated info: only valid private LAN IPv4 strings (no loopback / docker bridge / public / junk), no ports
    let (_, b, _) = call(&c, &head("GET", "/_h2z/info", None, &[]), Duration::from_secs(3)).await;
    let v: Value = serde_json::from_slice(&b).unwrap();
    assert_eq!(v["lan"], json!(["10.0.0.5"]));
    assert!(v.get("lanHints").is_none(), "ports / interfaces only for token holders");
    let (_, b, _) = call(&c, &head("GET", "/_h2z/info", Some(&t), &[]), Duration::from_secs(3)).await;
    let hints = serde_json::from_slice::<Value>(&b).unwrap();
    assert_eq!(hints["lanHints"]["addresses"][0]["port"], 8096);
    // contract 13.1: lanHints.iroh = our own bound UDP port + the LAN IPv4 list (filtered like `lan`), whatever lan.json said
    let p = r._edge.bound_sockets().iter().find(|a| a.is_ipv4()).unwrap().port();
    assert_eq!(hints["lanHints"]["iroh"], json!({"port": p, "addrs": [{"ip": "10.0.0.5", "port": p}]}));
    std::fs::remove_dir_all(&r.dir).ok();
}

#[tokio::test]
async fn long_stream_is_cut_at_token_expiry_with_audit() {
    let r = rig("cut", Limits::default(), true).await;
    let c = r.conn().await;
    let t = r.token(&r.dev(), &["*"], "any", "view", 3);
    let t0 = std::time::Instant::now();
    let (s, body, ended) = call(&c, &head("GET", "/media/cam/200_sub.slow", Some(&t), &[]), Duration::from_secs(15)).await;
    assert_eq!(s, 200);
    assert!(!ended, "the stream must be reset, not finished");
    assert!(t0.elapsed() < Duration::from_secs(6), "cut near exp, took {:?}", t0.elapsed());
    assert!(!body.is_empty());
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(r.auth.audit_pending(100).iter().any(|e| e["ev"] == "stream_cut" && e["why"] == "token-expired"));
    std::fs::remove_dir_all(&r.dir).ok();
}

#[tokio::test]
async fn websocket_needs_a_token_echoes_and_is_cut_at_expiry() {
    let r = rig("ws", Limits::default(), true).await;
    let c = r.conn().await;
    let ws = [("upgrade", "websocket"), ("connection", "Upgrade"), ("sec-websocket-key", "x3JJHMbDL1EzLkh9GBhXDw=="), ("sec-websocket-version", "13")];
    // no token: refused like any request
    let (s, b, _) = call(&c, &head("GET", "/ws", None, &ws), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (401, "token-missing"));
    // camera scope applies to WS paths too
    let t = r.token(&r.dev(), &["200"], "sub", "view", 4);
    let (s, b, _) = call(&c, &head("GET", "/devices/201/ws", Some(&t), &ws), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (403, "camera-not-granted"));
    // with a token: 101, then raw bytes are echoed, then the pipe is cut at exp
    let (mut send, mut recv) = c.open_bi().await.unwrap();
    send.write_all(&encode_line(&head("GET", "/ws", Some(&t), &ws)).unwrap()).await.unwrap();
    let (hb, mut left) = read_head(&mut recv).await.unwrap();
    let rh: RespHead = serde_json::from_slice(&hb).unwrap();
    assert_eq!(rh.s, 101);
    assert_eq!(rh.h.get("upgrade").map(|s| s.as_str()), Some("websocket"));
    send.write_all(b"hello-ws").await.unwrap();
    while left.len() < 8 {
        let c = tokio::time::timeout(Duration::from_secs(3), recv.read_chunk(1024)).await.unwrap().unwrap().expect("echo");
        left = [left.to_vec(), c.to_vec()].concat().into();
    }
    assert_eq!(&left[..8], b"hello-ws");
    let t0 = std::time::Instant::now();
    let end = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            match recv.read_chunk(1024).await {
                Ok(Some(_)) => continue,
                Ok(None) | Err(_) => return,
            }
        }
    })
    .await;
    assert!(end.is_ok(), "websocket must end at token expiry");
    assert!(t0.elapsed() < Duration::from_secs(6));
    assert!(r.auth.audit_pending(100).iter().any(|e| e["ev"] == "stream_cut" && e["ws"] == true));
    std::fs::remove_dir_all(&r.dir).ok();
}

#[tokio::test]
async fn recorder_ws_upgrade_goes_through_path_allowed() {
    // FM-913: the WebSocket upgrade of the recorder playback is checked like any request.
    let r = rig("recws", Limits::default(), true).await;
    let c = r.conn().await;
    let ws = [("upgrade", "websocket"), ("connection", "Upgrade"), ("sec-websocket-key", "x3JJHMbDL1EzLkh9GBhXDw=="), ("sec-websocket-version", "13")];
    let p = "/api/ioc/projects/p_e2e/recorder/ws?camera=200&stream=sub&from=1700000000000";
    let lim = r.token(&r.dev(), &["200"], "sub", "view", 60);
    let (s, b, _) = call(&c, &head("GET", p, Some(&lim), &ws), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (403, "camera-not-granted"));
    let all_sub = r.token(&r.dev(), &["*"], "sub", "view", 60);
    let pm = "/api/ioc/projects/p_e2e/recorder/ws?camera=200&stream=main&from=1700000000000";
    let (s, b, _) = call(&c, &head("GET", pm, Some(&all_sub), &ws), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (403, "stream-type-not-granted"));
    std::fs::remove_dir_all(&r.dir).ok();
}

#[tokio::test]
async fn concurrent_stream_cap_answers_too_busy() {
    let l = Limits { max_streams_conn: 2, ..Limits::default() };
    let r = rig("busy", l, true).await;
    let c = r.conn().await;
    let t = r.token(&r.dev(), &["*"], "any", "view", 60);
    // two endless streams hold the two slots
    let mut held = vec![];
    for _ in 0..2 {
        let (mut send, mut recv) = c.open_bi().await.unwrap();
        send.write_all(&encode_line(&head("GET", "/media/cam/200_sub.slow", Some(&t), &[])).unwrap()).await.unwrap();
        send.finish().unwrap();
        let (hb, _) = read_head(&mut recv).await.unwrap();
        assert_eq!(serde_json::from_slice::<RespHead>(&hb).unwrap().s, 200);
        held.push((recv, send));
    }
    let (s, b, _) = call(&c, &head("GET", "/media/cam/200_sub.live.mp4", Some(&t), &[]), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (429, "too-busy"));
    // releasing one slot makes room again
    held.pop();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let (s, _, _) = call(&c, &head("GET", "/media/cam/200_sub.live.mp4", Some(&t), &[]), Duration::from_secs(3)).await;
    assert_eq!(s, 200);
    std::fs::remove_dir_all(&r.dir).ok();
}

#[tokio::test]
async fn roster_revocation_kicks_the_connection() {
    let r = rig("kick", Limits::default(), true).await;
    let c = r.conn().await;
    let dev = r.dev();
    let t = r.token(&dev, &["200"], "sub", "view", 300);
    assert_eq!(call(&c, &head("GET", "/media/cam/200_sub.live.mp4", Some(&t), &[]), Duration::from_secs(3)).await.0, 200);
    let p = B64.encode(json!({"v":1,"edge":r.auth.id_hex(),"seq":5,"iat":now_unix(),"revoked_dev":[dev]}).to_string());
    let sig = r.cloud.sign(format!("h2z-roster1.{p}").as_bytes());
    let doc = json!({"p":p,"s":B64.encode(sig.to_bytes())}).to_string();
    let kick = r.auth.apply_roster(&doc, now_unix()).unwrap();
    r.auth.kick_devices(&kick);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(c.close_reason().is_some(), "revoked device's connection is closed");
    // a fresh connection with the same device key is refused at the token check
    let c2 = r.conn().await;
    let (s, b, _) = call(&c2, &head("GET", "/media/cam/200_sub.live.mp4", Some(&t), &[]), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (403, "device-revoked"));
    assert!(r.auth.audit_pending(100).iter().any(|e| e["ev"] == "kick"));
    std::fs::remove_dir_all(&r.dir).ok();
}

// ---- audit upload against a stub cloud ----
async fn stub_cloud(status: u16, seen: Arc<std::sync::Mutex<Vec<(String, String, String)>>>) -> String {
    let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = l.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let Ok((mut s, _)) = l.accept().await else { return };
            let seen = seen.clone();
            tokio::spawn(async move {
                let mut got = Vec::new();
                let mut buf = vec![0u8; 65536];
                loop {
                    let n = s.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        break;
                    }
                    got.extend_from_slice(&buf[..n]);
                    let txt = String::from_utf8_lossy(&got).to_string();
                    if let Some(i) = txt.find("\r\n\r\n") {
                        let cl = txt[..i].to_ascii_lowercase().split("content-length:").nth(1).and_then(|x| x.split("\r\n").next()).and_then(|x| x.trim().parse::<usize>().ok()).unwrap_or(0);
                        if got.len() >= i + 4 + cl {
                            let line = txt.lines().next().unwrap_or("").to_string();
                            let auth = txt.lines().find(|l| l.to_ascii_lowercase().starts_with("authorization:")).unwrap_or("").to_string();
                            let body = txt[i + 4..].to_string();
                            let acked = serde_json::from_str::<Value>(&body).ok().and_then(|v| v["to"].as_u64()).unwrap_or(0);
                            seen.lock().unwrap().push((line, auth, body));
                            let resp = if status == 200 { format!("{{\"acked\":{acked}}}") } else { "{}".to_string() };
                            let _ = s.write_all(format!("HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{resp}", resp.len()).as_bytes()).await;
                            break;
                        }
                    }
                }
            });
        }
    });
    format!("http://{addr}")
}

#[tokio::test]
async fn audit_upload_batches_signs_and_only_advances_on_ack() {
    let r = rig("aud", Limits::default(), true).await;
    for i in 0..5 {
        r.auth.audit("t", json!({"i": i}));
    }
    let client = reqwest::Client::new();
    // cloud without the endpoint: stays local, nothing is marked uploaded
    let seen = Arc::new(std::sync::Mutex::new(vec![]));
    let url = stub_cloud(404, seen.clone()).await;
    let o = audit_upload::upload_once(&r.auth, &client, &url, Duration::from_secs(300)).await;
    assert_eq!(o.state, "unsupported");
    assert_eq!(r.auth.audit_counters().1, 0);
    // cloud that acknowledges
    let seen = Arc::new(std::sync::Mutex::new(vec![]));
    let url = stub_cloud(200, seen.clone()).await;
    let o = audit_upload::upload_once(&r.auth, &client, &url, Duration::from_secs(300)).await;
    assert_eq!(o.state, "ok");
    let (last, up) = r.auth.audit_counters();
    assert_eq!(up, last);
    let s = seen.lock().unwrap();
    let (line, auth, body) = &s[0];
    assert_eq!(line, &format!("POST /v1/edges/{}/audit HTTP/1.1", r.auth.id_hex()));
    assert!(auth.contains(&format!("H2Z-Edge {}.", r.auth.id_hex())));
    let b: Value = serde_json::from_str(body).unwrap();
    assert_eq!(b["edge"], r.auth.id_hex());
    assert!(b["events"].as_array().unwrap().len() >= 5);
    // nothing pending any more
    drop(s);
    assert_eq!(audit_upload::upload_once(&r.auth, &client, &url, Duration::from_secs(300)).await.state, "idle");
    std::fs::remove_dir_all(&r.dir).ok();
}

#[tokio::test]
async fn fixed_bind_port_is_honoured_and_reported() {
    // pick a free UDP port, release it, ask the edge to bind exactly that one
    let free = std::net::UdpSocket::bind("0.0.0.0:0").unwrap().local_addr().unwrap().port();
    let ep = net::bind(SecretKey::generate(), NetMode::Local, None, true, edge::alpns(), None, Some(free)).await.unwrap();
    assert_eq!(net::bound_port(&ep), free);
    assert!(ep.bound_sockets().iter().any(|a| a.is_ipv4() && a.port() == free));
    // a second endpoint on the same port must fail loudly instead of silently picking a random one
    let again = net::bind(SecretKey::generate(), NetMode::Local, None, true, edge::alpns(), None, Some(free)).await;
    assert!(again.is_err(), "port already taken must be an error");
    ep.close().await;
}

#[tokio::test]
async fn expired_roster_refuses_internet_but_a_private_peer_still_works_with_a_valid_token() {
    // The rig connects over loopback = a private address = "LAN". Contract 13.1: roster-expired / clock-invalid only refuse
    // internet peers; token signature, audience, exp, scope and the (last known) revocation list still apply on the LAN.
    let r = rig("stale", Limits::default(), true).await;
    r.auth.test_set_stale();
    let c = r.conn().await;
    let p = "/media/cam/200_sub.live.mp4";
    let t = r.token(&r.dev(), &["200"], "sub", "view", 300);
    let (s, b, _) = call(&c, &head("GET", p, Some(&t), &[]), Duration::from_secs(3)).await;
    assert_eq!((s, b.len()), (200, 200), "private peer + valid token passes with an expired roster");
    // the same expired roster for an internet peer is covered at the auth level (authorize_at lan=false -> roster-expired)
    let now = now_unix();
    let h = head("GET", p, Some(&t), &[]);
    assert_eq!(r.auth.authorize_at(&h, &r.dev(), false, now).unwrap_err().1, "roster-expired");
    assert!(r.auth.authorize_at(&h, &r.dev(), true, now).is_ok());
    // still verified on the LAN: wrong device / wrong camera / no token
    let other = r.token("0000000000000000000000000000000000000000000000000000000000000000", &["200"], "sub", "view", 300);
    let (s, b, _) = call(&c, &head("GET", p, Some(&other), &[]), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (403, "token-device"));
    let (s, b, _) = call(&c, &head("GET", "/media/cam/201_sub.live.mp4", Some(&t), &[]), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (403, "camera-not-granted"));
    let (s, b, _) = call(&c, &head("GET", p, None, &[]), Duration::from_secs(3)).await;
    assert_eq!((s, err_of(&b).as_str()), (401, "token-missing"));
    std::fs::remove_dir_all(&r.dir).ok();
}

#[derive(Clone, Default)]
struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
impl std::io::Write for LogBuf {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
    type Writer = LogBuf;
    fn make_writer(&'a self) -> LogBuf {
        self.clone()
    }
}

#[tokio::test]
async fn probe_connections_do_not_spam_info_but_a_real_session_is_announced() {
    let buf = LogBuf::default();
    let sub = tracing_subscriber::fmt().with_writer(buf.clone()).with_ansi(false).with_max_level(tracing::Level::INFO).finish();
    tracing::subscriber::set_global_default(sub).expect("only this test installs a global subscriber");
    let r = rig("logs", Limits::default(), true).await;
    let probe_id = r.client.id().to_string();
    // the app's 20 s probe: connect, GET /_h2z/info, close - five times
    for _ in 0..5 {
        let c = r.conn().await;
        let (s, _, _) = call(&c, &head("GET", "/_h2z/info", None, &[]), Duration::from_secs(3)).await;
        assert_eq!(s, 200);
        c.close(0u32.into(), b"bye");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // a denied request (no token) is not a session either
    let c = r.conn().await;
    let (s, _, _) = call(&c, &head("GET", "/media/cam/200_sub.live.mp4", None, &[]), Duration::from_secs(3)).await;
    assert_eq!(s, 401);
    c.close(0u32.into(), b"bye");
    tokio::time::sleep(Duration::from_millis(200)).await;
    let text = || String::from_utf8_lossy(&buf.0.lock().unwrap()).to_string();
    let noisy: Vec<String> = text().lines().filter(|l| l.contains(&probe_id) && (l.contains("viewer ") || l.contains("path event"))).map(|l| l.to_string()).collect();
    assert!(noisy.is_empty(), "probe connections must stay quiet at INFO: {noisy:?}");
    // a real stream with a valid token is announced exactly once
    let c = r.conn().await;
    let t = r.token(&r.dev(), &["200"], "sub", "view", 300);
    for _ in 0..2 {
        let (s, _, _) = call(&c, &head("GET", "/media/cam/200_sub.live.mp4", Some(&t), &[]), Duration::from_secs(3)).await;
        assert_eq!(s, 200);
    }
    let active: Vec<String> = text().lines().filter(|l| l.contains(&probe_id) && l.contains("viewer active")).map(|l| l.to_string()).collect();
    assert_eq!(active.len(), 1, "{active:?}");
    std::fs::remove_dir_all(&r.dir).ok();
}

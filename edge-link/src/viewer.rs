//! Viewer side: a loopback HTTP server that forwards every request over an
//! iroh bidirectional stream to the edge. This is the core of the desktop shell
//! (the embedded browser just opens `http://127.0.0.1:<port>`).
//!
//! The viewer does not parse or rewrite the page, so the existing web UI keeps
//! working as long as it uses origin-relative URLs.
use std::{
    convert::Infallible,
    io,
    net::SocketAddr,
    sync::Arc,
    time::Instant,
};

use anyhow::{anyhow, Result};
use bytes::Bytes;
use futures_util::stream;
use http_body_util::{combinators::UnsyncBoxBody, BodyExt, Full, StreamBody};
use hyper::{body::Frame, service::service_fn, Request, Response, StatusCode};
use hyper_util::rt::TokioIo;
use iroh::{
    endpoint::{Connection, RecvStream, SendStream},
    Endpoint, EndpointAddr,
};
use tokio::{net::TcpListener, sync::Mutex};

use crate::{
    net::{selected_path, spawn_path_logger},
    wire::{encode_line, is_hop_by_hop, read_head, ReqHead, RespHead, ALPN},
};

type Body = UnsyncBoxBody<Bytes, io::Error>;

struct Link {
    endpoint: Endpoint,
    target: EndpointAddr,
    conn: Mutex<Option<Connection>>,
}

impl Link {
    async fn connect(&self) -> Result<Connection> {
        let t = Instant::now();
        let c = self.endpoint.connect(self.target.clone(), ALPN).await?;
        tracing::info!(connect_ms = t.elapsed().as_millis() as u64, "connected to edge");
        spawn_path_logger("edge".into(), &c, None);
        Ok(c)
    }

    async fn open(&self) -> Result<(Connection, SendStream, RecvStream)> {
        // Try the cached connection first; on any failure reconnect once.
        let cached = self.conn.lock().await.clone();
        if let Some(c) = cached {
            if let Ok((s, r)) = c.open_bi().await {
                return Ok((c, s, r));
            }
        }
        let c = self.connect().await?;
        *self.conn.lock().await = Some(c.clone());
        let (s, r) = c.open_bi().await?;
        Ok((c, s, r))
    }
}

fn text(status: StatusCode, msg: String) -> Response<Body> {
    Response::builder()
        .status(status)
        .body(Full::new(Bytes::from(msg)).map_err(|e| match e {}).boxed_unsync())
        .unwrap()
}

/// File holding the current access token; re-read on every request so a refresher
/// (the app's token manager) can swap it without restarting the tunnel.
pub static TOKEN_FILE: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

async fn handle(link: Arc<Link>, req: Request<hyper::body::Incoming>) -> Response<Body> {
    match forward(link, req).await {
        Ok(r) => r,
        Err(e) => text(StatusCode::BAD_GATEWAY, format!("tunnel error: {e:#}")),
    }
}

async fn forward(link: Arc<Link>, req: Request<hyper::body::Incoming>) -> Result<Response<Body>> {
    let t0 = Instant::now();
    let (parts, mut body) = req.into_parts();
    let (conn, mut send, mut recv) = link.open().await?;

    let mut h = std::collections::BTreeMap::new();
    for (k, v) in parts.headers.iter() {
        let n = k.as_str();
        if is_hop_by_hop(n) || n.eq_ignore_ascii_case("host") {
            continue;
        }
        if let Ok(v) = v.to_str() {
            h.entry(n.to_string())
                .and_modify(|e: &mut String| {
                    e.push_str(", ");
                    e.push_str(v)
                })
                .or_insert_with(|| v.to_string());
        }
    }
    h.retain(|k, _| !k.eq_ignore_ascii_case(crate::auth::TOKEN_HEADER));
    if let Some(f) = TOKEN_FILE.get() {
        if let Ok(t) = std::fs::read_to_string(f) {
            h.insert(crate::auth::TOKEN_HEADER.to_string(), t.trim().to_string());
        }
    }
    let path = parts
        .uri
        .path_and_query()
        .map(|p| p.as_str().to_string())
        .unwrap_or_else(|| "/".into());
    let head = ReqHead { m: parts.method.to_string(), p: path.clone(), h };
    send.write_chunk(encode_line(&head)?).await?;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| anyhow!("request body: {e}"))?;
        if let Ok(data) = frame.into_data() {
            send.write_chunk(data).await?;
        }
    }
    send.finish()?;

    let (hb, rest) = read_head(&mut recv).await?;
    let rh: RespHead = serde_json::from_slice(&hb)?;
    tracing::debug!(
        %path, status = rh.s, first_byte_ms = t0.elapsed().as_millis() as u64,
        selected = %selected_path(&conn), "first byte"
    );

    let mut rb = Response::builder().status(rh.s);
    for (k, v) in &rh.h {
        let lk = k.to_ascii_lowercase();
        // Body is re-framed by hyper; keep content-length only if upstream gave one.
        if is_hop_by_hop(&lk) {
            continue;
        }
        rb = rb.header(k.as_str(), v.as_str());
    }

    let first = stream::iter(if rest.is_empty() {
        vec![]
    } else {
        vec![Ok::<_, io::Error>(Frame::data(rest))]
    });
    let tail = stream::unfold(recv, |mut r| async move {
        match r.read_chunk(256 * 1024).await {
            Ok(Some(b)) => Some((Ok(Frame::data(b)), r)),
            Ok(None) => None,
            Err(e) => Some((Err(io::Error::other(e)), r)),
        }
    });
    let body = StreamBody::new(futures_util::StreamExt::chain(first, tail)).boxed_unsync();
    Ok(rb.body(body)?)
}

pub async fn run(endpoint: Endpoint, target: EndpointAddr, listen: SocketAddr) -> Result<()> {
    let link = Arc::new(Link { endpoint, target, conn: Mutex::new(None) });
    // Fail fast and report timing before we start serving.
    let c = link.connect().await?;
    *link.conn.lock().await = Some(c);

    let listener = TcpListener::bind(listen).await?;
    println!("VIEWER_ORIGIN=http://{}", listener.local_addr()?);
    loop {
        let (tcp, _) = listener.accept().await?;
        let link = link.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| {
                let link = link.clone();
                async move { Ok::<_, Infallible>(handle(link, req).await) }
            });
            if let Err(e) = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(tcp), svc)
                .await
            {
                tracing::debug!("loopback conn: {e}");
            }
        });
    }
}

//! Wire format of "HTTP over iroh" (compatible with the Flutter spike in
//! `lib/link/iroh_http_tunnel.dart`).
//!
//! One iroh bidirectional stream carries exactly one HTTP exchange:
//!   viewer -> edge : one JSON line `{"m":method,"p":path+query,"h":{...}}\n`, then body bytes, then finish
//!   edge -> viewer : one JSON line `{"s":status,"h":{...}}\n`, then body bytes, then finish
//!
//! Multi-value response headers are joined with ", " (same as the spike).
use std::collections::BTreeMap;

use anyhow::{bail, Result};
use bytes::Bytes;
use iroh::endpoint::RecvStream;
use serde::{Deserialize, Serialize};

pub const ALPN: &[u8] = b"h2z/http/1";
pub const MAX_HEADER: usize = 64 * 1024;

#[derive(Serialize, Deserialize, Debug)]
pub struct ReqHead {
    pub m: String,
    pub p: String,
    #[serde(default)]
    pub h: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RespHead {
    pub s: u16,
    #[serde(default)]
    pub h: BTreeMap<String, String>,
}

/// Reads up to the first `\n`. Returns the header line and any body bytes that
/// arrived in the same chunk.
pub async fn read_head(recv: &mut RecvStream) -> Result<(Vec<u8>, Bytes)> {
    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    loop {
        let Some(chunk) = recv.read_chunk(64 * 1024).await? else {
            bail!("stream ended before header line");
        };
        if let Some(i) = chunk.iter().position(|b| *b == b'\n') {
            buf.extend_from_slice(&chunk[..i]);
            return Ok((buf, chunk.slice(i + 1..)));
        }
        buf.extend_from_slice(&chunk);
        if buf.len() > MAX_HEADER {
            bail!("header line too large");
        }
    }
}

pub fn encode_line<T: Serialize>(v: &T) -> Result<Bytes> {
    let mut s = serde_json::to_vec(v)?;
    s.push(b'\n');
    Ok(Bytes::from(s))
}

/// Hop-by-hop headers are never forwarded in either direction.
pub fn is_hop_by_hop(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "connection"
            | "keep-alive"
            | "proxy-authenticate"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

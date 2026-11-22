//! Endpoint construction and path diagnostics shared by `edge` and `viewer`.
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use iroh::{
    endpoint::{presets, Connection, QuicTransportConfig, VarInt},
    Endpoint, RelayMap, RelayMode, RelayUrl, SecretKey,
};

#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub enum NetMode {
    /// n0 default relays + n0 DNS/pkarr address lookup (what the phone spike uses).
    N0,
    /// No relay, no discovery: direct addresses only (loopback / LAN tests).
    Local,
}

/// Load (or create on first run) the identity key. The key file lives on the persistent data volume
/// and is the identity of this recorder: same file = same EndpointId = same claim (like a traditional NVR's
/// device identity). A damaged key file is an error — never silently replaced by a new identity.
pub fn load_or_create_key(path: &Path) -> Result<SecretKey> {
    if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
        std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
    }
    if path.exists() {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(path)?.permissions().mode() & 0o777;
            if mode & 0o077 != 0 {
                tracing::warn!("key file {} had mode {:o}; tightening to 600", path.display(), mode);
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
            }
        }
        let b = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
        let arr: [u8; 32] = b
            .try_into()
            .map_err(|_| anyhow!("key file {} is not 32 bytes (refusing to create a new identity over it; run `edge-link factory-reset --yes` to start over)", path.display()))?;
        return Ok(SecretKey::from_bytes(&arr));
    }
    let k = SecretKey::generate();
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .with_context(|| format!("create {}", path.display()))?;
        f.write_all(&k.to_bytes())?;
        f.sync_all()?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, k.to_bytes())?;
    Ok(k)
}

pub async fn bind(
    secret: SecretKey,
    mode: NetMode,
    relay_url: Option<String>,
    no_discovery: bool,
    alpns: Vec<Vec<u8>>,
    max_bidi_streams: Option<u32>,
    bind_port: Option<u16>,
) -> Result<Endpoint> {
    let mut b = match mode {
        NetMode::N0 => Endpoint::builder(presets::N0),
        NetMode::Local => Endpoint::builder(presets::Minimal).relay_mode(RelayMode::Disabled),
    };
    b = b.secret_key(secret).alpns(alpns);
    // Fixed UDP port (contract 13.1): the compose file publishes it, so a phone on the same LAN can dial
    // <recorder LAN ip>:<port> directly. None / 0 = random port (viewer, tests). IPv6 is optional (a docker
    // bridge often has none); IPv4 must bind or the start fails loudly (port taken = a clear error, not a random port).
    if let Some(port) = bind_port.filter(|p| *p != 0) {
        b = b
            .clear_ip_transports()
            .bind_addr(std::net::SocketAddr::from(([0, 0, 0, 0], port)))?
            .bind_addr_with_opts(
                std::net::SocketAddr::from((std::net::Ipv6Addr::UNSPECIFIED, port)),
                iroh::endpoint::BindOpts::default().set_is_required(false),
            )?;
    }
    if let Some(n) = max_bidi_streams {
        b = b.transport_config(QuicTransportConfig::builder().max_concurrent_bidi_streams(VarInt::from_u32(n)).build());
    }
    if let Some(u) = relay_url {
        let url: RelayUrl = u.parse().map_err(|e| anyhow!("bad --relay-url: {e}"))?;
        b = b.relay_mode(RelayMode::Custom(RelayMap::from(url)));
    }
    if no_discovery {
        b = b.clear_address_lookup();
    }
    Ok(b.bind().await?)
}

/// One-line description of the currently selected path ("relay" / "direct").
pub fn selected_path(conn: &Connection) -> String {
    for p in conn.paths().iter() {
        if p.is_selected() {
            let kind = if p.is_relay() { "relay" } else { "direct" };
            return format!("{kind} rtt={:?} via {:?}", p.rtt(), p.remote_addr());
        }
    }
    "none".to_string()
}

/// Logs every path change of `conn` until it closes. With `active` (edge side) the events are INFO only once the
/// connection has done real work; a probe connection logs them at debug.
pub fn spawn_path_logger(tag: String, conn: &Connection, active: Option<std::sync::Arc<std::sync::atomic::AtomicBool>>) {
    let mut ev = conn.path_events();
    let conn = conn.clone();
    tokio::spawn(async move {
        while let Some(e) = ev.next().await {
            if active.as_ref().map(|a| a.load(std::sync::atomic::Ordering::Relaxed)).unwrap_or(true) {
                tracing::info!(%tag, event = ?e, selected = %selected_path(&conn), "path event");
            } else {
                tracing::debug!(%tag, event = ?e, selected = %selected_path(&conn), "path event (probe)");
            }
        }
    });
}

/// Private / link-local / loopback peer address (RFC1918, 169.254/16, 127/8, fc00::/7, fe80::/10, and IPv4-mapped
/// IPv6 of those). Contract 13.1: only such peers keep working when the roster is expired or the clock is invalid.
/// Carrier-grade NAT (100.64/10) and everything public are NOT private.
pub fn is_private_ip(ip: std::net::IpAddr) -> bool {
    use std::net::IpAddr;
    match ip {
        IpAddr::V4(v) => v.is_private() || v.is_loopback() || v.is_link_local(),
        IpAddr::V6(v) => match v.to_ipv4_mapped() {
            Some(m) => is_private_ip(IpAddr::V4(m)),
            None => v.is_loopback() || (v.segments()[0] & 0xfe00) == 0xfc00 || (v.segments()[0] & 0xffc0) == 0xfe80,
        },
    }
}

/// True when the selected path is a direct path to a private/link-local/loopback address
/// (the viewer is on the same LAN as the edge).
pub fn selected_is_lan(conn: &Connection) -> bool {
    use iroh::TransportAddr;
    for p in conn.paths().iter() {
        if p.is_selected() {
            return match p.remote_addr() {
                TransportAddr::Ip(a) => is_private_ip(a.ip()),
                _ => false,
            };
        }
    }
    false
}

/// Kind of the currently selected path (limits.rs decides what each kind may do).
pub fn path_kind(conn: &Connection) -> crate::limits::PathKind {
    use crate::limits::PathKind;
    for p in conn.paths().iter() {
        if p.is_selected() {
            if p.is_relay() {
                return PathKind::Relay;
            }
            return if selected_is_lan(conn) { PathKind::Lan } else { PathKind::Direct };
        }
    }
    PathKind::None
}

/// The UDP port the endpoint listens on (first IPv4 socket, else the first socket); 0 if unknown.
pub fn bound_port(ep: &Endpoint) -> u16 {
    let socks = ep.bound_sockets();
    socks.iter().find(|a| a.is_ipv4()).or_else(|| socks.first()).map(|a| a.port()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::is_private_ip;
    fn p(s: &str) -> bool {
        is_private_ip(s.parse().unwrap())
    }
    #[test]
    fn private_peer_classification() {
        for ok in ["10.0.0.5", "172.16.0.1", "172.31.255.254", "192.168.1.20", "169.254.3.4", "127.0.0.1", "fd00::1", "fe80::1", "::1", "::ffff:192.168.1.20"] {
            assert!(p(ok), "{ok} is private");
        }
        for no in ["8.8.8.8", "172.15.0.1", "172.32.0.1", "100.64.0.1", "192.169.0.1", "2001:db8::1", "::ffff:8.8.8.8"] {
            assert!(!p(no), "{no} is not private");
        }
    }
}

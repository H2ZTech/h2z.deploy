//! Resource limits for traffic that comes through a relay and for the number of concurrent
//! connections / streams (docs/link/03-edge.md task 8).
//!
//! * Path kind decides the rules: LAN and direct (hole-punched) paths are not limited; a relay path
//!   (the relay forwards the encrypted packets and its uplink is the scarce resource) only carries
//!   sub streams, is rate limited, and main streams wait until a direct path exists.
//! * Concurrency: QUIC-level stream limit per connection (+ a few spare for info/claim), then an
//!   application-level limit per connection and in total that answers `429 too-busy` quickly
//!   instead of letting requests queue up silently.
use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use tokio::sync::Semaphore;

use crate::auth::{stream_of, Deny};

#[derive(Clone, Debug)]
pub struct Limits {
    /// Allow main streams over a relay (default false; debugging only).
    pub relay_main_allowed: bool,
    /// Rate limit per connection while the selected path is a relay, kilobit/s (0 = unlimited).
    pub relay_max_kbps: u64,
    /// Concurrent streams per viewer connection.
    pub max_streams_conn: usize,
    /// Concurrent streams over all connections.
    pub max_streams_total: usize,
    /// Concurrent viewer connections.
    pub max_conns: usize,
}

impl Default for Limits {
    fn default() -> Self {
        // 6 Mbit/s: a few sub streams (~0.5-1 Mbit/s each) with headroom; relay servers are shared and metered.
        Self { relay_main_allowed: false, relay_max_kbps: 6000, max_streams_conn: 32, max_streams_total: 128, max_conns: 32 }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PathKind {
    Lan,
    Direct,
    Relay,
    /// no selected path yet (connection just opened): treated like a relay for main streams
    None,
}

/// A relay (or not yet known) path is a "constrained" path.
pub fn constrained(k: PathKind) -> bool {
    matches!(k, PathKind::Relay | PathKind::None)
}

/// Gate a request on a constrained path: main streams are refused (the client retries when a direct path is up).
pub fn relay_gate(l: &Limits, kind: PathKind, path: &str) -> Result<(), Deny> {
    if constrained(kind) && !l.relay_main_allowed && stream_of(path) == Some("main") {
        return Err((403, "relay-main-denied"));
    }
    Ok(())
}

/// Token bucket (bytes). Debt is allowed: a chunk is sent, then the caller sleeps off the debt.
pub struct Pacer {
    rate: f64, // bytes per second
    burst: f64,
    st: Mutex<(f64, Instant)>,
}

impl Pacer {
    pub fn new(kbps: u64) -> Option<Arc<Self>> {
        if kbps == 0 {
            return None;
        }
        let rate = kbps as f64 * 1000.0 / 8.0;
        let burst = (rate / 4.0).max(64.0 * 1024.0);
        Some(Arc::new(Self { rate, burst, st: Mutex::new((burst, Instant::now())) }))
    }

    /// How long the caller must wait before sending `n` more bytes (and books them).
    pub fn take(&self, n: usize) -> Duration {
        let mut s = self.st.lock().unwrap();
        let now = Instant::now();
        let dt = now.duration_since(s.1).as_secs_f64();
        s.0 = (s.0 + dt * self.rate).min(self.burst);
        s.1 = now;
        s.0 -= n as f64;
        if s.0 >= 0.0 {
            Duration::ZERO
        } else {
            Duration::from_secs_f64(-s.0 / self.rate)
        }
    }

    pub async fn pace(&self, n: usize) {
        let w = self.take(n);
        if !w.is_zero() {
            tokio::time::sleep(w).await;
        }
    }
}

/// Edge-wide counters / semaphores.
pub struct Gate {
    pub total: Arc<Semaphore>,
    pub conns: AtomicUsize,
    pub busy_rejects: std::sync::atomic::AtomicU64,
    pub limits: Limits,
}

impl Gate {
    pub fn new(l: Limits) -> Arc<Self> {
        Arc::new(Self {
            total: Arc::new(Semaphore::new(l.max_streams_total)),
            conns: AtomicUsize::new(0),
            busy_rejects: Default::default(),
            limits: l,
        })
    }
    /// Count a new viewer connection; None = over the limit.
    pub fn conn_enter(self: &Arc<Self>) -> Option<ConnSlot> {
        let n = self.conns.fetch_add(1, Ordering::SeqCst) + 1;
        if n > self.limits.max_conns {
            self.conns.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(ConnSlot { g: self.clone() })
    }
}

pub struct ConnSlot {
    g: Arc<Gate>,
}
impl Drop for ConnSlot {
    fn drop(&mut self) {
        self.g.conns.fetch_sub(1, Ordering::SeqCst);
    }
}

/// Per-connection context (stream semaphore, relay pacer).
pub struct ConnCtx {
    pub streams: Arc<Semaphore>,
    pub pacer: Option<Arc<Pacer>>,
    /// Set by the first authorized non-internal request. A connection that never sets it is a probe (the app's
    /// 20-second reachability check = `/_h2z/info` only): its connect / disconnect / path events stay at debug level.
    pub active: Arc<std::sync::atomic::AtomicBool>,
}

impl ConnCtx {
    pub fn new(l: &Limits) -> Self {
        Self { streams: Arc::new(Semaphore::new(l.max_streams_conn)), pacer: Pacer::new(l.relay_max_kbps), active: Arc::new(std::sync::atomic::AtomicBool::new(false)) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_gate_rules() {
        let l = Limits::default();
        let main = "/media/cam/200_main.live.mp4";
        let sub = "/media/cam/200_sub.live.mp4";
        assert!(relay_gate(&l, PathKind::Lan, main).is_ok());
        assert!(relay_gate(&l, PathKind::Direct, main).is_ok());
        assert_eq!(relay_gate(&l, PathKind::Relay, main).unwrap_err().1, "relay-main-denied");
        assert_eq!(relay_gate(&l, PathKind::None, "/x?profile=main").unwrap_err().1, "relay-main-denied");
        assert_eq!(relay_gate(&l, PathKind::Relay, "/x?hevc=1").unwrap_err().1, "relay-main-denied");
        assert!(relay_gate(&l, PathKind::Relay, sub).is_ok());
        assert!(relay_gate(&l, PathKind::Relay, "/api/ioc/health").is_ok());
        // recorder playback: stream=main on a relay / unknown path is refused, stream=sub passes, direct passes
        let ws_main = "/api/ioc/projects/x/recorder/ws?camera=1&stream=main&from=1";
        let ws_sub = "/api/ioc/projects/x/recorder/ws?camera=1&stream=sub&from=1";
        assert_eq!(relay_gate(&l, PathKind::Relay, ws_main).unwrap_err().1, "relay-main-denied");
        assert_eq!(relay_gate(&l, PathKind::None, ws_main).unwrap_err().1, "relay-main-denied");
        assert!(relay_gate(&l, PathKind::Relay, ws_sub).is_ok());
        assert!(relay_gate(&l, PathKind::Lan, ws_main).is_ok());
        assert!(relay_gate(&l, PathKind::Direct, ws_main).is_ok());
        let allow = Limits { relay_main_allowed: true, ..Limits::default() };
        assert!(relay_gate(&allow, PathKind::Relay, main).is_ok());
    }

    #[test]
    fn pacer_limits_rate() {
        let p = Pacer::new(800).unwrap(); // 100 kB/s, burst 64 kB
        assert!(Pacer::new(0).is_none());
        // burst passes without waiting
        assert_eq!(p.take(60 * 1024), Duration::ZERO);
        // the next 100 kB must wait ~ (100k - 4k left) / 100k/s
        let w = p.take(100_000);
        assert!(w > Duration::from_millis(800) && w < Duration::from_millis(1100), "{w:?}");
    }

    #[test]
    fn connection_limit() {
        let g = Gate::new(Limits { max_conns: 2, ..Limits::default() });
        let a = g.conn_enter().unwrap();
        let _b = g.conn_enter().unwrap();
        assert!(g.conn_enter().is_none());
        drop(a);
        assert!(g.conn_enter().is_some());
    }
}

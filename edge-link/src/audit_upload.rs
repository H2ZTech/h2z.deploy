//! Audit upload, edge half (proposal in docs/link/00-contract.md section 12; the cloud endpoint is NOT
//! implemented yet, so this is off by default and the audit stays local).
//!
//! Every `interval` the events with seq > acknowledged cursor are POSTed in batches to
//! `{cloud}/v1/edges/{edge}/audit` with `Authorization: H2Z-Edge ...` (signature covers sha256(body)).
//! The cloud answers 2xx `{"acked": <seq>}`; only then the cursor advances. 404/405/501 = cloud does not
//! have the endpoint: stay local, retry hourly. Failures never block anything else.
use std::{sync::Arc, time::Duration};

use serde_json::{json, Value};

use crate::auth::{now_unix, Auth};

pub const BATCH: usize = 200;

pub struct Outcome {
    pub state: &'static str,
    pub acked: u64,
    pub next_sleep: Duration,
}

/// One upload round against `base` (cloud origin). Pure I/O wrapper, unit/e2e tested against a local stub.
pub async fn upload_once(auth: &Arc<Auth>, client: &reqwest::Client, base: &str, interval: Duration) -> Outcome {
    let events = auth.audit_pending(BATCH);
    if events.is_empty() {
        return Outcome { state: "idle", acked: 0, next_sleep: interval };
    }
    let from = events.first().and_then(|e| e["seq"].as_u64()).unwrap_or(0);
    let to = events.last().and_then(|e| e["seq"].as_u64()).unwrap_or(0);
    let body = json!({"v":1,"edge":auth.id_hex(),"from":from,"to":to,"events":events}).to_string();
    let path = format!("/v1/edges/{}/audit", auth.id_hex());
    let hdr = auth.edge_auth_header_body_at("POST", &path, now_unix(), body.as_bytes());
    let res = client
        .post(format!("{base}{path}"))
        .header("authorization", hdr)
        .header("content-type", "application/json")
        .body(body)
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => {
            let v: Value = r.text().await.ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
            let acked = v["acked"].as_u64().unwrap_or(to).min(to);
            if auth.audit_mark_uploaded(acked).is_err() {
                return Outcome { state: "error", acked: 0, next_sleep: interval };
            }
            // more backlog: continue soon
            let more = acked >= to && auth.audit_pending(1).len() == 1;
            Outcome { state: "ok", acked, next_sleep: if more { Duration::from_secs(2) } else { interval } }
        }
        Ok(r) if matches!(r.status().as_u16(), 404 | 405 | 501) => {
            Outcome { state: "unsupported", acked: 0, next_sleep: Duration::from_secs(3600) }
        }
        Ok(r) if matches!(r.status().as_u16(), 401 | 403) => {
            Outcome { state: "denied", acked: 0, next_sleep: Duration::from_secs(900) }
        }
        _ => Outcome { state: "error", acked: 0, next_sleep: interval.max(Duration::from_secs(60)) },
    }
}

pub fn spawn(auth: Arc<Auth>, interval: Duration) {
    tokio::spawn(async move {
        let Ok(client) = reqwest::Client::builder().timeout(Duration::from_secs(15)).build() else { return };
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let url = auth.cloud_url();
            let sleep = if auth.claimed() && !url.is_empty() {
                let o = upload_once(&auth, &client, &url, interval).await;
                auth.set_upload_state(o.state, None);
                o.next_sleep
            } else {
                auth.set_upload_state("waiting-claim", None);
                interval
            };
            tokio::time::sleep(sleep).await;
        }
    });
}

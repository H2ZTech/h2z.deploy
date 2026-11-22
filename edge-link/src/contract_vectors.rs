//! docs/link/00-contract.md section 9: cross-language test vectors. The cloud (TypeScript) and the app (Dart)
//! must produce / accept exactly the same bytes. If one of these fails, the contract is broken, not the test.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use iroh::SecretKey;

use crate::{
    auth::{hex, verify_token, Auth, Opts, Provision},
    wire::ReqHead,
};

const CLOUD_SEED: &str = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const CLOUD_PUB: &str = "iojj3XQJ8ZX9UtstPLpdcspnCb8dlBIb83SIAbQPb1w";
const EDGE_SEED: &str = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const EDGE_ID: &str = "8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394";
const DEV_SEED: &str = "AwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwM";
const DEV_ID: &str = "ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1";

const CLAIMS: &str = r#"{"v":1,"aud":"8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394","prj":"p_test","sub":"uid_test","role":"customer_viewer","scope":"view","dev":"ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d1","cams":["200"],"st":"sub","iat":1800000000,"exp":1800000600,"jti":"jti_test"}"#;
const TOKEN: &str = "h2z1.eyJ2IjoxLCJhdWQiOiI4MTM5NzcwZWE4N2QxNzVmNTZhMzU0NjZjMzRjN2VjY2NiOGQ4YTkxYjRlZTM3YTI1ZGY2MGY1YjhmYzliMzk0IiwicHJqIjoicF90ZXN0Iiwic3ViIjoidWlkX3Rlc3QiLCJyb2xlIjoiY3VzdG9tZXJfdmlld2VyIiwic2NvcGUiOiJ2aWV3IiwiZGV2IjoiZWQ0OTI4YzYyOGQxYzJjNmVhZTkwMzM4OTA1OTk1NjEyOTU5MjczYTVjNjNmOTM2MzZjMTQ2MTRhYzg3MzdkMSIsImNhbXMiOlsiMjAwIl0sInN0Ijoic3ViIiwiaWF0IjoxODAwMDAwMDAwLCJleHAiOjE4MDAwMDA2MDAsImp0aSI6Imp0aV90ZXN0In0.OExV8DPRvxYIxPzbFnhDmeMOBEV8Ttx8hcywFbn-eB6UbmN4CwLAyFWiQjks4R3pBVamjOJi3VHF-FyPGUPVBg";
const ROSTER: &str = r#"{"p":"eyJ2IjoxLCJlZGdlIjoiODEzOTc3MGVhODdkMTc1ZjU2YTM1NDY2YzM0YzdlY2NjYjhkOGE5MWI0ZWUzN2EyNWRmNjBmNWI4ZmM5YjM5NCIsInNlcSI6MTgwMDAwMDEwMCwiaWF0IjoxODAwMDAwMTAwLCJyZXZva2VkX2RldiI6WyJlZDQ5MjhjNjI4ZDFjMmM2ZWFlOTAzMzg5MDU5OTU2MTI5NTkyNzNhNWM2M2Y5MzYzNmMxNDYxNGFjODczN2QxIl0sInJldm9rZWRfc3ViIjpbXSwiYWRkX2tleXMiOltdLCJkcm9wX2tleXMiOltdfQ","s":"wlWbsXEBFCrp_EzQqQwog7kRpxBU8rBB7wGZlfLGVTcexl_Xahn5pFBgkth0ZlfVIc6KhXkPX3XyJjAeyPflBQ"}"#;
const CLAIM_SIG: &str = "gHdoSCPsD1AiQgwJLGpGQ3-YMysubNuoz2mc75jrNtOpNsXXc-sWA3_g4C2n2oOIbZHRJQD6ew5WiCsnqWEnCQ";
const EDGE_AUTH: &str = "H2Z-Edge 8139770ea87d175f56a35466c34c7ecccb8d8a91b4ee37a25df60f5b8fc9b394.1800000000.559iOSNGUfDGT-AZb4tez4ZWJx60t2M5fYU9DIjH1TjH9DSgswyXEOui0au7PrJk1VZbxpFfBxNRf3dTW-5eCw";

fn sk(seed: &str) -> SecretKey {
    let b: [u8; 32] = B64.decode(seed).unwrap().try_into().unwrap();
    SecretKey::from_bytes(&b)
}

/// Edge claimed to project p_test with the vector cloud key, at a fixed "now" (no dependence on the real clock).
fn edge(dir: &std::path::Path) -> std::sync::Arc<Auth> {
    Auth::load_with(
        sk(EDGE_SEED),
        dir,
        false,
        false,
        Some(Provision { keys: vec![CLOUD_PUB.into()], project: "p_test".into(), cloud_url: "https://cloud.test".into() }),
        Opts::default(),
        1_800_000_000,
    )
    .unwrap()
}
fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("h2z-vec-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn req(tok: &str) -> ReqHead {
    let mut h = std::collections::BTreeMap::new();
    h.insert("x-h2z-token".into(), tok.into());
    ReqHead { m: "GET".into(), p: "/media/cam/200_sub.live.mp4".into(), h }
}

#[test]
fn keys_match_the_vectors() {
    assert_eq!(B64.encode(sk(CLOUD_SEED).public().as_bytes()), CLOUD_PUB);
    assert_eq!(hex(sk(EDGE_SEED).public().as_bytes()), EDGE_ID);
    assert_eq!(hex(sk(DEV_SEED).public().as_bytes()), DEV_ID);
}

#[test]
fn token_vector_valid_then_expired() {
    // the claims JSON in the contract is exactly what the token carries, byte for byte
    let payload = TOKEN.split('.').nth(1).unwrap();
    assert_eq!(String::from_utf8(B64.decode(payload).unwrap()).unwrap(), CLAIMS);
    let keys = vec![crate::auth::parse_pubkey(CLOUD_PUB).unwrap()];
    let c = verify_token(&keys, TOKEN, EDGE_ID, "p_test", DEV_ID, 1_800_000_100).expect("valid at now=1800000100");
    assert_eq!((c.sub.as_str(), c.scope.as_str(), c.st.as_str()), ("uid_test", "view", "sub"));
    assert_eq!(verify_token(&keys, TOKEN, EDGE_ID, "p_test", DEV_ID, 1_800_000_700).unwrap_err().1, "token-expired");
    // wrong key / device / audience
    let other = vec![sk(EDGE_SEED).public()];
    assert_eq!(verify_token(&other, TOKEN, EDGE_ID, "p_test", DEV_ID, 1_800_000_100).unwrap_err().1, "token-signature");
    assert_eq!(verify_token(&keys, TOKEN, EDGE_ID, "p_test", EDGE_ID, 1_800_000_100).unwrap_err().1, "token-device");
}

#[test]
fn token_vector_through_the_edge_gate() {
    let d = tmp("gate");
    let a = edge(&d);
    assert_eq!(a.id_hex(), EDGE_ID);
    assert!(a.authorize_at(&req(TOKEN), DEV_ID, false, 1_800_000_100).unwrap().is_some());
    assert_eq!(a.authorize_at(&req(TOKEN), DEV_ID, false, 1_800_000_700).unwrap_err().1, "token-expired");
    // the token only allows camera 200 / sub stream
    let mut h = req(TOKEN);
    h.p = "/media/cam/201_sub.live.mp4".into();
    assert_eq!(a.authorize_at(&h, DEV_ID, false, 1_800_000_100).unwrap_err().1, "camera-not-granted");
    std::fs::remove_dir_all(d).ok();
}

#[test]
fn roster_vector_revokes_the_device() {
    let d = tmp("roster");
    let a = edge(&d);
    assert!(a.authorize_at(&req(TOKEN), DEV_ID, false, 1_800_000_100).is_ok());
    let kick = a.apply_roster(ROSTER, 1_800_000_100).expect("signed by the vector cloud key, for this edge");
    assert_eq!(kick, vec![DEV_ID.to_string()]);
    assert_eq!(a.authorize_at(&req(TOKEN), DEV_ID, false, 1_800_000_100).unwrap_err().1, "device-revoked");
    // replay of the same document is accepted idempotently (same seq), an older seq is not tested here (auth.rs)
    assert!(a.apply_roster(ROSTER, 1_800_000_101).is_ok());
    // a roster for another edge is refused
    let other = tmp("roster2");
    let b = Auth::load_with(sk(DEV_SEED), &other, false, false, Some(Provision { keys: vec![CLOUD_PUB.into()], project: "p_test".into(), cloud_url: "".into() }), Opts::default(), 1_800_000_000).unwrap();
    assert!(b.apply_roster(ROSTER, 1_800_000_100).is_err());
    // the roster carries the cloud time (iat 1800000100): an edge clock 1 h off is detected
    let c = tmp("roster3");
    let e3 = edge(&c);
    e3.apply_roster(ROSTER, 1_800_000_100 + 3600).unwrap();
    assert_eq!(e3.clock_state(1_800_000_100 + 3600), "skewed");
    assert_eq!(e3.authorize_at(&req(TOKEN), DEV_ID, false, 1_800_003_700).unwrap_err().1, "clock-invalid");
    for x in [d, other, c] {
        std::fs::remove_dir_all(x).ok();
    }
}

#[test]
fn claim_signature_vector() {
    let d = tmp("claim");
    let a = Auth::load_with(sk(EDGE_SEED), &d, false, false, None, Opts::default(), 1_800_000_000).unwrap();
    assert!(!a.claimed());
    let body = serde_json::json!({
        "k": a.test_pair_secret(), "cloudPub": CLOUD_PUB, "project": "p_test", "cloudUrl": "https://cloud.test",
        "nonce": "0123456789abcdef0123456789abcdef", "claimId": "c_test"
    })
    .to_string();
    let r = a.claim(body.as_bytes()).unwrap();
    assert_eq!(r["edge"], EDGE_ID);
    assert_eq!(r["sig"], CLAIM_SIG, "ed25519 is deterministic: every implementation must produce the vector signature");
    std::fs::remove_dir_all(d).ok();
}

#[test]
fn edge_auth_header_vector() {
    let d = tmp("hdr");
    let a = edge(&d);
    let path = format!("/v1/edges/{EDGE_ID}/roster");
    assert_eq!(a.edge_auth_header_at("GET", &path, 1_800_000_000), EDGE_AUTH);
    std::fs::remove_dir_all(d).ok();
}

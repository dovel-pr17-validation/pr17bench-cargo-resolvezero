use reqwest::Client;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

fn encode_query(name: &str, id: u16) -> Vec<u8> {
    let mut o = Vec::with_capacity(64);
    o.extend_from_slice(&id.to_be_bytes());
    o.extend_from_slice(&0x0100u16.to_be_bytes());
    o.extend_from_slice(&1u16.to_be_bytes());
    for _ in 0..3 {
        o.extend_from_slice(&0u16.to_be_bytes());
    }
    for l in name.trim_end_matches('.').split('.') {
        o.push(l.len() as u8);
        o.extend_from_slice(l.as_bytes());
    }
    o.push(0);
    o.extend_from_slice(&1u16.to_be_bytes());
    o.extend_from_slice(&1u16.to_be_bytes());
    o
}

#[tokio::main]
async fn main() {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(5))
        .pool_max_idle_per_host(64)
        .http2_adaptive_window(true);
    if std::env::var("H1").as_deref() == Ok("1") {
        builder = builder.http1_only();
    }
    let client = builder.build().unwrap();
    let c: usize = std::env::var("CONCURRENCY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(32);
    let secs = 5u64;
    let deadline = Instant::now() + Duration::from_secs(secs);
    let ok = Arc::new(AtomicU64::new(0));
    let mut hs = Vec::new();
    for w in 0..c {
        let client = client.clone();
        let ok = ok.clone();
        hs.push(tokio::spawn(async move {
            let mut i = w;
            while Instant::now() < deadline {
                let name = format!("u{}-{}.rzbench.example.com", std::process::id(), i);
                i += c;
                let r = client
                    .post("https://cloudflare-dns.com/dns-query")
                    .header("content-type", "application/dns-message")
                    .header("accept", "application/dns-message")
                    .body(encode_query(&name, 1))
                    .send()
                    .await;
                if let Ok(r) = r {
                    if r.status().is_success() {
                        let _ = r.bytes().await;
                        ok.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }));
    }
    for h in hs {
        let _ = h.await;
    }
    let n = ok.load(Ordering::Relaxed);
    println!(
        "direct upstream {} ok in {}s -> {:.0} qps",
        n,
        secs,
        n as f64 / secs as f64
    );
}

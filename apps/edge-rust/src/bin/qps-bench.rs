//! DoH throughput probe for comparing two edges on the same host.
//!
//!   qps-bench --url http://127.0.0.1:8088 --profile <id> --token <tok> \
//!             --domains /tmp/blocked.txt --concurrency 64 --seconds 10
//!
//! HTTP/1.1 keep-alive, fixed concurrency, per-request latency histogram.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use reqwest::Client;

struct Args {
    url: String,
    profile: String,
    token: String,
    domains: Vec<String>,
    concurrency: usize,
    seconds: u64,
    warmup: u64,
}

fn parse_args() -> Result<Args, String> {
    let mut url = "http://127.0.0.1:8088".to_string();
    let mut profile = None;
    let mut token = None;
    let mut domains_file = None;
    let mut concurrency = 64usize;
    let mut seconds = 10u64;
    let mut warmup = 2u64;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--url" => url = args.next().ok_or("--url value")?,
            "--profile" => profile = Some(args.next().ok_or("--profile value")?),
            "--token" => token = Some(args.next().ok_or("--token value")?),
            "--domains" => domains_file = Some(args.next().ok_or("--domains value")?),
            "--concurrency" => {
                concurrency = args
                    .next()
                    .ok_or("--concurrency value")?
                    .parse()
                    .map_err(|_| "bad concurrency")?
            }
            "--seconds" => {
                seconds = args
                    .next()
                    .ok_or("--seconds value")?
                    .parse()
                    .map_err(|_| "bad seconds")?
            }
            "--warmup" => {
                warmup = args
                    .next()
                    .ok_or("--warmup value")?
                    .parse()
                    .map_err(|_| "bad warmup")?
            }
            other => return Err(format!("unknown argument {other}")),
        }
    }
    let domains_file = domains_file.ok_or("--domains is required")?;
    let text = std::fs::read_to_string(domains_file).map_err(|err| err.to_string())?;
    let domains: Vec<String> = text
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_string)
        .collect();
    if domains.is_empty() {
        return Err("domain list is empty".into());
    }
    Ok(Args {
        url,
        profile: profile.ok_or("--profile is required")?,
        token: token.ok_or("--token is required")?,
        domains,
        concurrency: concurrency.max(1),
        seconds: seconds.max(1),
        warmup,
    })
}

fn encode_query(name: &str, id: u16) -> Vec<u8> {
    let mut out = Vec::with_capacity(64);
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&0x0100u16.to_be_bytes()); // RD
    out.extend_from_slice(&1u16.to_be_bytes()); // QDCOUNT
    out.extend_from_slice(&0u16.to_be_bytes()); // ANCOUNT
    out.extend_from_slice(&0u16.to_be_bytes()); // NSCOUNT
    out.extend_from_slice(&0u16.to_be_bytes()); // ARCOUNT
    for label in name.trim_end_matches('.').split('.') {
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    out.extend_from_slice(&1u16.to_be_bytes()); // A
    out.extend_from_slice(&1u16.to_be_bytes()); // IN
    out
}

async fn run(
    args: &Args,
    client: &Client,
    url: &str,
    duration: Duration,
    count_results: bool,
) -> (u64, u64, Vec<u64>) {
    let deadline = Instant::now() + duration;
    let ok = Arc::new(AtomicU64::new(0));
    let errors = Arc::new(AtomicU64::new(0));
    let concurrency = args.concurrency;
    let mut handles = Vec::new();
    for worker in 0..concurrency {
        let client = client.clone();
        let url = url.to_string();
        let domains = args.domains.clone();
        let ok = ok.clone();
        let errors = errors.clone();
        handles.push(tokio::spawn(async move {
            let mut latencies = Vec::new();
            let mut index = worker;
            let mut id = worker as u16;
            while Instant::now() < deadline {
                let domain = &domains[index % domains.len()];
                index += concurrency.max(1);
                id = id.wrapping_add(1);
                let started = Instant::now();
                let response = client
                    .post(&url)
                    .header("content-type", "application/dns-message")
                    .body(encode_query(domain, id))
                    .send()
                    .await;
                match response {
                    Ok(response) if response.status().is_success() => {
                        let _ = response.bytes().await;
                        ok.fetch_add(1, Ordering::Relaxed);
                        if count_results {
                            latencies.push(started.elapsed().as_micros() as u64);
                        }
                    }
                    _ => {
                        errors.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
            latencies
        }));
    }
    let mut latencies = Vec::new();
    for handle in handles {
        if let Ok(mut worker_latencies) = handle.await {
            latencies.append(&mut worker_latencies);
        }
    }
    (
        ok.load(Ordering::Relaxed),
        errors.load(Ordering::Relaxed),
        latencies,
    )
}

fn percentile(sorted: &[u64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let index = ((sorted.len() as f64 - 1.0) * q).round() as usize;
    sorted[index] as f64 / 1000.0
}

#[tokio::main]
async fn main() {
    let args = match parse_args() {
        Ok(args) => args,
        Err(err) => {
            eprintln!("qps-bench: {err}");
            std::process::exit(1);
        }
    };
    let url = format!(
        "{}/v1/{}/{}",
        args.url.trim_end_matches('/'),
        args.profile,
        args.token
    );
    let client = Client::builder()
        .pool_max_idle_per_host(args.concurrency)
        .timeout(Duration::from_secs(5))
        .build()
        .expect("client");

    if args.warmup > 0 {
        run(
            &args,
            &client,
            &url,
            Duration::from_secs(args.warmup),
            false,
        )
        .await;
    }

    let started = Instant::now();
    let (ok, errors, mut latencies) = run(
        &args,
        &client,
        &url,
        Duration::from_secs(args.seconds),
        true,
    )
    .await;
    let elapsed = started.elapsed().as_secs_f64();
    latencies.sort_unstable();
    println!(
        "{} ok, {} errors, {:.1}s -> {:.0} qps | p50 {:.1} ms p95 {:.1} ms p99 {:.1} ms",
        ok,
        errors,
        elapsed,
        ok as f64 / elapsed,
        percentile(&latencies, 0.50),
        percentile(&latencies, 0.95),
        percentile(&latencies, 0.99),
    );
}

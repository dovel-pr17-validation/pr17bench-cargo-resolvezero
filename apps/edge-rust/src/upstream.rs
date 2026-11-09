use std::collections::HashMap;
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::Client;
use tokio::sync::Mutex;

use crate::dns;
use crate::netguard::SafeFetcher;

/// Node caps upstream DoH bodies at 65,535 bytes (a DNS message maximum).
pub const MAX_UPSTREAM_BYTES: usize = 65_535;

const PRESETS: [&str; 3] = [
    "https://cloudflare-dns.com/dns-query",
    "https://dns.google/dns-query",
    "https://dns.quad9.net/dns-query",
];

/// DoH upstream client. Preset endpoints are hard-coded and trusted; custom
/// per-profile URLs go through the SSRF guard, are pinned to a validated
/// address, and are cached per URL so the hot path never re-resolves.
pub struct Upstream {
    h1: Client,
    h2: Client,
    default_url: String,
    safe: SafeFetcher,
    custom: Mutex<HashMap<String, Client>>,
}

impl Upstream {
    pub fn new(default_url: String) -> Result<Self, String> {
        let h1 = Client::builder()
            .timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(64)
            .http1_only()
            .build()
            .map_err(|err| err.to_string())?;
        let h2 = Client::builder()
            .timeout(Duration::from_secs(5))
            .pool_max_idle_per_host(64)
            .http2_adaptive_window(true)
            .build()
            .map_err(|err| err.to_string())?;
        Ok(Self {
            h1,
            h2,
            default_url,
            safe: SafeFetcher::new(MAX_UPSTREAM_BYTES, true),
            custom: Mutex::new(HashMap::new()),
        })
    }

    /// Preset selector or a custom DoH URL wins over the edge default.
    pub fn url_for(&self, selector: Option<&str>) -> String {
        match selector {
            Some("cloudflare") => "https://cloudflare-dns.com/dns-query".to_string(),
            Some("google") => "https://dns.google/dns-query".to_string(),
            Some("quad9") => "https://dns.quad9.net/dns-query".to_string(),
            Some(url) if url.starts_with("https://") || url.starts_with("http://") => {
                url.to_string()
            }
            _ => self.default_url.clone(),
        }
    }

    pub async fn resolve(&self, wire: &[u8], selector: Option<&str>) -> Result<Vec<u8>, String> {
        let url = self.url_for(selector);
        let client = if is_preset(&url) {
            if needs_h2(selector, &url) {
                self.h2.clone()
            } else {
                self.h1.clone()
            }
        } else {
            self.custom_client(&url).await?
        };

        let response = client
            .post(&url)
            .header("content-type", "application/dns-message")
            .header("accept", "application/dns-message")
            .body(wire.to_vec())
            .send()
            .await
            .map_err(|err| format!("upstream: {}", err.without_url()))?;
        if !response.status().is_success() {
            return Err(format!("upstream HTTP {}", response.status()));
        }
        let bytes = read_capped(response).await?;
        let question = dns::parse_query(wire).ok_or("invalid query")?;
        dns::validate_upstream(&question, &bytes)?;
        Ok(bytes)
    }

    async fn custom_client(&self, url: &str) -> Result<Client, String> {
        let mut clients = self.custom.lock().await;
        if let Some(client) = clients.get(url) {
            return Ok(client.clone());
        }
        let client = self.safe.pinned_client(url).await?;
        clients.insert(url.to_string(), client.clone());
        Ok(client)
    }
}

fn is_preset(url: &str) -> bool {
    PRESETS.contains(&url)
}

fn needs_h2(selector: Option<&str>, url: &str) -> bool {
    selector == Some("quad9") || url.contains("dns.quad9.net")
}

async fn read_capped(response: reqwest::Response) -> Result<Vec<u8>, String> {
    if let Some(length) = response.content_length() {
        if length as usize > MAX_UPSTREAM_BYTES {
            return Err(format!(
                "upstream body {length} exceeds {MAX_UPSTREAM_BYTES}"
            ));
        }
    }
    let mut stream = response.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("upstream body: {}", err.without_url()))?;
        if out.len() + chunk.len() > MAX_UPSTREAM_BYTES {
            return Err("upstream body exceeds 64 KiB".into());
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selector_precedence() {
        let upstream = Upstream::new("https://default.example/dns-query".into()).unwrap();
        assert_eq!(
            upstream.url_for(Some("google")),
            "https://dns.google/dns-query"
        );
        assert_eq!(
            upstream.url_for(Some("https://custom.example/dns-query")),
            "https://custom.example/dns-query"
        );
        assert_eq!(upstream.url_for(None), "https://default.example/dns-query");
    }

    #[test]
    fn presets_and_h2_selection() {
        assert!(is_preset("https://dns.google/dns-query"));
        assert!(!is_preset("https://custom.example/dns-query"));
        assert!(needs_h2(Some("quad9"), "https://dns.quad9.net/dns-query"));
        assert!(!needs_h2(None, "https://dns.google/dns-query"));
    }
}

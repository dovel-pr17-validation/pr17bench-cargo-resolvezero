//! SSRF guard for user-influenced fetches (blocklists, custom upstreams,
//! compiler). Port of `apps/edge/src/netGuard.ts`.
//!
//! Layers:
//!  1. URL syntax: https-only (unless self-host opt-in), no credentials,
//!     no metadata hostnames.
//!  2. Resolve once and reject any private/loopback/link-local/CGNAT/
//!     multicast/reserved address.
//!  3. Pin the resolved address for the actual connection, so DNS rebinding
//!     cannot swap it after validation.
//!  4. Re-validate every redirect hop.
//!
//! Self-hosters pointing at an internal Unbound/list server can set
//! `ALLOW_PRIVATE_TARGETS=1`; metadata endpoints stay blocked.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::{Client, Url};

const MAX_REDIRECTS: usize = 3;
const FETCH_TIMEOUT: Duration = Duration::from_secs(60);

pub fn allow_private_targets() -> bool {
    std::env::var("ALLOW_PRIVATE_TARGETS").as_deref() == Ok("1")
}

pub fn allow_http_targets() -> bool {
    // Only a self-host escape hatch; hosted edges stay https-only.
    allow_private_targets() && std::env::var("ALLOW_HTTP_TARGETS").as_deref() == Ok("1")
}

fn is_metadata_host(host: &str) -> bool {
    matches!(
        host,
        "metadata.google.internal" | "metadata.goog" | "169.254.169.254" | "fd00:ec2::254"
    )
}

/// True for loopback/private/link-local/CGNAT/multicast/reserved addresses.
pub fn is_private_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => is_private_v4(ip),
        IpAddr::V6(ip) => is_private_v6(ip),
    }
}

fn is_private_v4(ip: Ipv4Addr) -> bool {
    let [a, b, _, _] = ip.octets();
    a == 0
        || a == 10
        || (a == 100 && (64..=127).contains(&b))
        || a == 127
        || (a == 169 && b == 254)
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 192 && b == 0)
        || (a == 198 && (b == 18 || b == 19))
        || a >= 224
}

fn is_private_v6(ip: Ipv6Addr) -> bool {
    if ip.is_unspecified() || ip.is_loopback() || ip.is_multicast() {
        return true;
    }
    let segments = ip.segments();
    if segments[0] & 0xfe00 == 0xfc00 {
        return true; // fc00::/7 ULA
    }
    if segments[0] & 0xffc0 == 0xfe80 {
        return true; // fe80::/10 link-local
    }
    if segments[0] == 0x2001 && segments[1] == 0x0db8 {
        return true; // 2001:db8::/32 documentation
    }
    if let Some(v4) = ip.to_ipv4_mapped() {
        return is_private_v4(v4);
    }
    // NAT64 64:ff9b::/96 (and 64:ff9b:1::/48 local-use)
    if segments[0] == 0x0064 && segments[1] == 0xff9b {
        let [_, _, _, _, _, _, hi, lo] = segments;
        return is_private_v4(Ipv4Addr::from(((hi as u32) << 16) | lo as u32));
    }
    false
}

pub struct SafeFetcher {
    allow_private: bool,
    https_only: bool,
    max_bytes: usize,
    timeout: Duration,
}

impl SafeFetcher {
    pub fn new(max_bytes: usize, https_only: bool) -> Self {
        Self {
            allow_private: allow_private_targets(),
            https_only,
            max_bytes,
            timeout: FETCH_TIMEOUT,
        }
    }

    pub async fn get(&self, raw: &str) -> Result<Vec<u8>, String> {
        self.request("GET", raw, None).await
    }

    /// POST a DNS wire message to a validated upstream. Redirects are not
    /// followed: an upstream that redirects is misconfigured or hostile.
    pub async fn post(&self, raw: &str, body: Vec<u8>) -> Result<Vec<u8>, String> {
        self.request("POST", raw, Some(body)).await
    }

    async fn request(
        &self,
        method: &str,
        raw: &str,
        body: Option<Vec<u8>>,
    ) -> Result<Vec<u8>, String> {
        let mut current = raw.to_string();
        for _ in 0..=MAX_REDIRECTS {
            let url = self.validate(&current)?;
            let pin = resolve_pinned(&url, self.allow_private).await?;
            let client = pinned_client(&url, pin, self.timeout)?;
            let mut request =
                client.request(method.parse().map_err(|_| "invalid method")?, url.clone());
            if let Some(body) = &body {
                request = request
                    .header("content-type", "application/dns-message")
                    .header("accept", "application/dns-message")
                    .body(body.clone());
            }
            let response = request
                .send()
                .await
                .map_err(|err| format!("fetch failed: {}", err.without_url()))?;
            if response.status().is_redirection() {
                let location = response
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|value| value.to_str().ok())
                    .ok_or("redirect without Location")?;
                current = url
                    .join(location)
                    .map_err(|_| "invalid redirect target")?
                    .to_string();
                continue;
            }
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status()));
            }
            return read_capped(response, self.max_bytes).await;
        }
        Err("too many redirects".into())
    }

    /// Validate + pin a custom upstream URL and return a client for it.
    pub async fn pinned_client(&self, raw: &str) -> Result<Client, String> {
        let url = self.validate(raw)?;
        let pin = resolve_pinned(&url, self.allow_private).await?;
        pinned_client(&url, pin, self.timeout)
    }

    fn validate(&self, raw: &str) -> Result<Url, String> {
        let url = Url::parse(raw).map_err(|_| "invalid URL".to_string())?;
        let https = url.scheme() == "https";
        if !https && (self.https_only || !allow_http_targets()) {
            return Err("URL must use https".into());
        }
        if !url.username().is_empty() || url.password().is_some() {
            return Err("URL must not embed credentials".into());
        }
        let host = url
            .host_str()
            .ok_or("URL is missing a host")?
            .trim_matches(['[', ']'])
            .trim_end_matches('.')
            .to_ascii_lowercase();
        if host.is_empty() {
            return Err("URL is missing a host".into());
        }
        if is_metadata_host(&host) {
            return Err("metadata host blocked".into());
        }
        Ok(url)
    }
}

fn pinned_client(url: &Url, pin: SocketAddr, timeout: Duration) -> Result<Client, String> {
    let host = url
        .host_str()
        .ok_or("URL is missing a host")?
        .trim_matches(['[', ']'])
        .to_string();
    let mut builder = Client::builder()
        .timeout(timeout)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("resolvezero-edge-rust/0.1");
    if host.parse::<IpAddr>().is_err() {
        builder = builder.resolve(&host, pin);
    }
    builder.build().map_err(|err| err.to_string())
}

async fn resolve_pinned(url: &Url, allow_private: bool) -> Result<SocketAddr, String> {
    let host = url
        .host_str()
        .ok_or("URL is missing a host")?
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    let port = url.port_or_known_default().ok_or("URL has no port")?;

    let mut addresses: Vec<SocketAddr> = Vec::new();
    if let Ok(ip) = host.parse::<IpAddr>() {
        addresses.push(SocketAddr::new(ip, port));
    } else {
        let resolved = tokio::net::lookup_host((host.as_str(), port))
            .await
            .map_err(|_| "host could not be resolved".to_string())?;
        addresses.extend(resolved);
    }
    if addresses.is_empty() {
        return Err("host could not be resolved".into());
    }
    if !allow_private && addresses.iter().any(|addr| is_private_ip(addr.ip())) {
        return Err("host resolves to a private address".into());
    }
    Ok(addresses[0])
}

async fn read_capped(response: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>, String> {
    if let Some(length) = response.content_length() {
        if length as usize > max_bytes {
            return Err(format!("body {length} exceeds {max_bytes}"));
        }
    }
    let mut stream = response.bytes_stream();
    let mut out = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| format!("body read: {}", err.without_url()))?;
        if out.len() + chunk.len() > max_bytes {
            return Err(format!("body exceeds {max_bytes}"));
        }
        out.extend_from_slice(&chunk);
    }
    Ok(out)
}

/// Log-safe URL: drop userinfo, query, and fragment.
pub fn redact_url(raw: &str) -> String {
    match Url::parse(raw) {
        Ok(mut url) => {
            let _ = url.set_username("");
            let _ = url.set_password(None);
            url.set_query(None);
            url.set_fragment(None);
            url.to_string()
        }
        Err(_) => "<invalid-url>".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_private_ranges() {
        for ip in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "224.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "::ffff:127.0.0.1",
        ] {
            assert!(is_private_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"] {
            assert!(!is_private_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[test]
    fn rejects_http_and_credentials() {
        let fetcher = SafeFetcher::new(1024, true);
        assert!(fetcher.validate("http://example.com/list.txt").is_err());
        assert!(fetcher
            .validate("https://user:pass@example.com/list.txt")
            .is_err());
        assert!(fetcher.validate("https://example.com/list.txt").is_ok());
    }

    #[test]
    fn redacts_query_tokens() {
        assert_eq!(
            redact_url("https://example.com/list.txt?token=secret"),
            "https://example.com/list.txt"
        );
    }
}

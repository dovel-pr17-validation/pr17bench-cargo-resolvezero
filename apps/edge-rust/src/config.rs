use std::env;
use std::str::FromStr;
use std::time::Duration;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnknownSource {
    Refused,
    Silent,
}

/// Runtime configuration. Mirrors apps/edge/src/index.ts env usage.
#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub doh_port: u16,
    pub dns_port: u16,
    pub metrics_port: u16,
    pub region: String,
    pub upstream_url: Option<String>,
    pub upstream_preset: Option<String>,
    pub unknown_source: UnknownSource,
    pub max_total_entries: usize,
    pub max_list_bytes: usize,
    pub max_lists_per_profile: usize,
    pub list_interval: Duration,
    pub poll_interval: Duration,
    pub allow_tokenless: bool,
    pub drop_privileges: bool,
    pub doh_rate_limit_per_min: u32,
    pub udp_rate_limit_per_min: u32,
    pub doh_max_inflight: usize,
    pub udp_max_inflight: usize,
    pub tcp_max_connections: usize,
    pub tcp_max_per_source: usize,
    pub dot_max_per_source: usize,
    pub tcp_idle_timeout: Duration,
    pub tcp_lifetime: Duration,
    pub doh_timeout: Duration,
    pub max_doh_body: usize,
    pub max_doh_get: usize,
    pub max_unique_lists: usize,
    pub list_cycle_deadline: Duration,
    pub udp_bind: String,
    pub hosted: bool,
    pub probe_domain: Option<String>,
    pub dot_port: u16,
    pub dot_enabled: bool,
    pub dot_suffix: String,
    pub dot_idle_timeout: Duration,
    pub dot_lifetime: Duration,
    pub drop_uid: u32,
    pub drop_gid: u32,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let database_url =
            env::var("DATABASE_URL").map_err(|_| "DATABASE_URL is not set".to_string())?;
        Ok(Self {
            database_url,
            doh_port: number("PORT", 8080),
            dns_port: number("DNS_PORT", 53),
            metrics_port: number("METRICS_PORT", 9091),
            region: env::var("FLY_REGION").unwrap_or_else(|_| "local".to_string()),
            upstream_url: env::var("UPSTREAM_DOH_URL").ok().filter(|v| !v.is_empty()),
            upstream_preset: env::var("UPSTREAM_PRESET").ok().filter(|v| !v.is_empty()),
            unknown_source: match env::var("UDP_UNKNOWN_SOURCE").as_deref() {
                Ok("silent") => UnknownSource::Silent,
                _ => UnknownSource::Refused,
            },
            max_total_entries: number("BLOCKLIST_MAX_TOTAL_ENTRIES", 5_000_000),
            max_list_bytes: number("BLOCKLIST_MAX_LIST_BYTES", 30 * 1024 * 1024),
            max_lists_per_profile: number("BLOCKLIST_MAX_LISTS_PER_PROFILE", 64),
            list_interval: Duration::from_secs(
                number::<u64>("LIST_SYNC_INTERVAL_SECONDS", 6 * 3600).max(60),
            ),
            poll_interval: Duration::from_millis(number::<u64>("CONFIG_POLL_MS", 5_000).max(500)),
            allow_tokenless: env::var("ALLOW_TOKENLESS_PROFILES").as_deref() == Ok("1"),
            drop_privileges: env::var("DROP_PRIVILEGES").as_deref() != Ok("0"),
            doh_rate_limit_per_min: number("DOH_RATE_LIMIT_PER_MIN", 600),
            udp_rate_limit_per_min: number("UDP_RATE_LIMIT_PER_MIN", 600),
            doh_max_inflight: number("DOH_MAX_INFLIGHT", 256),
            udp_max_inflight: number("UDP_MAX_INFLIGHT", 1024),
            tcp_max_connections: number("TCP_MAX_CONNECTIONS", 512),
            tcp_max_per_source: number("TCP_MAX_PER_SOURCE", 32),
            dot_max_per_source: number("DOT_MAX_PER_SOURCE", 16),
            tcp_idle_timeout: Duration::from_secs(
                number::<u64>("TCP_IDLE_TIMEOUT_SECONDS", 30).max(1),
            ),
            tcp_lifetime: Duration::from_secs(number::<u64>("TCP_LIFETIME_SECONDS", 300).max(1)),
            doh_timeout: Duration::from_secs(number::<u64>("DOH_TIMEOUT_SECONDS", 5).max(1)),
            max_doh_body: number("MAX_DOH_BODY_BYTES", 65_535),
            max_doh_get: number("MAX_DOH_GET_BYTES", 4_096),
            max_unique_lists: number("BLOCKLIST_MAX_UNIQUE_LISTS", 256),
            list_cycle_deadline: Duration::from_secs(
                number::<u64>("BLOCKLIST_CYCLE_DEADLINE_SECONDS", 180).max(10),
            ),
            udp_bind: env::var("UDP_BIND").unwrap_or_else(|_| {
                if env::var("FLY_REGION").is_ok() {
                    "fly-global-services".into()
                } else {
                    "0.0.0.0".into()
                }
            }),
            hosted: env::var("FLY_REGION").is_ok()
                && env::var("ALLOW_TOKENLESS_PROFILES").as_deref() != Ok("1"),
            probe_domain: Some(
                env::var("PROBE_DOMAIN")
                    .unwrap_or_else(|_| "probe.resolvezero.com".into())
                    .trim()
                    .to_lowercase()
                    .trim_matches('.')
                    .to_string(),
            )
            .filter(|value| !value.is_empty()),
            dot_port: number("DOT_PORT", 853),
            dot_enabled: env::var("DOT_ENABLED").as_deref() != Ok("0"),
            dot_suffix: env::var("DOT_SUFFIX")
                .unwrap_or_else(|_| ".dot.resolvezero.com".into())
                .to_lowercase(),
            dot_idle_timeout: Duration::from_secs(
                number::<u64>("DOT_IDLE_TIMEOUT_SECONDS", 120).max(1),
            ),
            dot_lifetime: Duration::from_secs(number::<u64>("DOT_LIFETIME_SECONDS", 600).max(1)),
            drop_uid: number("DROP_UID", 1000),
            drop_gid: number("DROP_GID", 1000),
        })
    }

    pub fn default_upstream(&self) -> String {
        if let Some(url) = &self.upstream_url {
            return url.clone();
        }
        match self.upstream_preset.as_deref() {
            Some("google") => "https://dns.google/dns-query".to_string(),
            Some("quad9") => "https://dns.quad9.net/dns-query".to_string(),
            _ => "https://cloudflare-dns.com/dns-query".to_string(),
        }
    }
}

fn number<T>(key: &str, default: T) -> T
where
    T: FromStr + Copy,
{
    env::var(key)
        .ok()
        .and_then(|value| value.parse::<T>().ok())
        .unwrap_or(default)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_are_conservative() {
        let cfg = Config {
            database_url: "postgres://example".into(),
            doh_port: 8080,
            dns_port: 53,
            metrics_port: 9091,
            region: "local".into(),
            upstream_url: None,
            upstream_preset: None,
            unknown_source: UnknownSource::Refused,
            max_total_entries: 5_000_000,
            max_list_bytes: 30 * 1024 * 1024,
            max_lists_per_profile: 64,
            list_interval: Duration::from_secs(60),
            poll_interval: Duration::from_millis(500),
            allow_tokenless: false,
            drop_privileges: false,
            doh_rate_limit_per_min: 600,
            udp_rate_limit_per_min: 600,
            doh_max_inflight: 256,
            udp_max_inflight: 1024,
            tcp_max_connections: 512,
            tcp_max_per_source: 32,
            dot_max_per_source: 16,
            tcp_idle_timeout: Duration::from_secs(30),
            tcp_lifetime: Duration::from_secs(300),
            doh_timeout: Duration::from_secs(5),
            max_doh_body: 65_535,
            max_doh_get: 4_096,
            max_unique_lists: 256,
            list_cycle_deadline: Duration::from_secs(180),
            udp_bind: "0.0.0.0".into(),
            hosted: false,
            probe_domain: None,
            dot_port: 853,
            dot_enabled: true,
            dot_suffix: ".dot.resolvezero.com".into(),
            dot_idle_timeout: Duration::from_secs(120),
            dot_lifetime: Duration::from_secs(600),
            drop_uid: 1000,
            drop_gid: 1000,
        };
        assert_eq!(
            cfg.default_upstream(),
            "https://cloudflare-dns.com/dns-query"
        );
    }
}

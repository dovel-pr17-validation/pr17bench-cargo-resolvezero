use std::collections::HashMap;

/// Resolved agent configuration. Mirrors `AgentConfig` in `apps/agent/src/config.ts`.
#[derive(Debug, Clone)]
pub struct AgentConfig {
    pub profile_id: String,
    pub token: String,
    pub doh_url: String,
    pub bind_host: String,
    pub dns_port: u16,
    pub timeout_ms: u64,
    pub health_port: u16,
    pub health_host: String,
    /// `DEVICE_MAP` entries keyed by the source IP as written by the operator.
    pub devices: HashMap<String, String>,
}

impl AgentConfig {
    /// Reads configuration from the process environment.
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    /// Testable loader: `lookup` returns the raw env value for a key.
    pub fn from_lookup(lookup: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let profile_id = first_non_empty(&lookup, &["PROFILE_ID", "RESOLVEZERO_PROFILE_ID"])
            .ok_or_else(|| "PROFILE_ID is required".to_string())?;
        let token = first_non_empty(&lookup, &["DOH_TOKEN", "RESOLVEZERO_DOH_TOKEN"])
            .ok_or_else(|| "DOH_TOKEN is required".to_string())?;

        let doh_url = lookup("DOH_URL")
            .unwrap_or_else(|| "https://resolvezero-edge.fly.dev".to_string())
            .trim()
            .trim_end_matches('/')
            .to_string();
        if !(doh_url.starts_with("http://") || doh_url.starts_with("https://")) {
            return Err("DOH_URL must start with http:// or https://".to_string());
        }

        let dns_port = number_env(lookup("DNS_PORT").as_deref(), 53)?;
        let health_port = number_env(lookup("HEALTH_PORT").as_deref(), 0)?;
        let timeout_ms = number_env(lookup("DOH_TIMEOUT_MS").as_deref(), 5_000)? as u64;

        Ok(Self {
            profile_id,
            token,
            doh_url,
            bind_host: text_env(lookup("BIND_HOST").as_deref(), "0.0.0.0"),
            dns_port,
            timeout_ms,
            health_port,
            health_host: text_env(lookup("HEALTH_HOST").as_deref(), "127.0.0.1"),
            devices: parse_device_map(&lookup("DEVICE_MAP").unwrap_or_default()),
        })
    }
}

fn first_non_empty(lookup: &impl Fn(&str) -> Option<String>, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| lookup(key).map(|value| value.trim().to_string()))
        .filter(|value| !value.is_empty())
}

fn text_env(raw: Option<&str>, fallback: &str) -> String {
    match raw.map(str::trim) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => fallback.to_string(),
    }
}

/// Port/timeout parser with the same bounds as the TypeScript agent: a whole
/// number between 0 and 65535 (yes, it also applies to the timeout).
fn number_env(raw: Option<&str>, fallback: u16) -> Result<u16, String> {
    let Some(raw) = raw.filter(|value| !value.is_empty()) else {
        return Ok(fallback);
    };
    let trimmed = raw.trim();
    let parsed: i64 = trimmed
        .parse()
        .map_err(|_| format!("invalid port/timeout value: {raw}"))?;
    if !(0..=65_535).contains(&parsed) {
        return Err(format!("invalid port/timeout value: {raw}"));
    }
    Ok(parsed as u16)
}

/// `DEVICE_MAP` format: `192.168.1.20=macbook,192.168.1.21=iphone`.
/// Newlines and semicolons are accepted too; later duplicates win.
pub fn parse_device_map(raw: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for entry in raw.split(['\n', ',', ';']) {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Some(eq) = trimmed.find('=') else {
            continue;
        };
        if eq == 0 {
            continue;
        }
        let ip = trimmed[..eq].trim();
        let label = trimmed[eq + 1..].trim();
        if !ip.is_empty() && !label.is_empty() {
            out.insert(ip.to_string(), label.to_string());
        }
    }
    out
}

/// URL-safe stable device slug. Falls back to the source IP.
pub fn device_slug(ip: &str, label: Option<&str>) -> String {
    let source = match label.map(str::trim) {
        Some(value) if !value.is_empty() => value.to_string(),
        _ => format!("ip-{ip}"),
    };
    let slug = sanitize_slug(&source);
    let slug: String = slug.chars().take(32).collect();
    if !slug.is_empty() {
        return slug;
    }

    // The label sanitised to nothing (e.g. "!!!"): derive a slug from the IP.
    // Runs of non-alphanumerics collapse to one dash, like `replace(/[^a-z0-9]+/gi, "-")`.
    let mut fallback = String::new();
    let mut in_run = false;
    for ch in ip.chars() {
        if ch.is_ascii_alphanumeric() {
            fallback.push(ch);
            in_run = false;
        } else if !in_run {
            fallback.push('-');
            in_run = true;
        }
    }
    let fallback: String = fallback.chars().take(32).collect();
    format!("ip-{fallback}")
}

/// Lowercase, collapse runs of anything outside `[a-z0-9_-]` to `-`, trim dashes.
fn sanitize_slug(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut in_run = false;
    for ch in value.chars() {
        let lower = ch.to_ascii_lowercase();
        if lower.is_ascii_alphanumeric() || lower == '_' || lower == '-' {
            out.push(lower);
            in_run = false;
        } else if !in_run {
            out.push('-');
            in_run = true;
        }
    }
    out.trim_matches('-').to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config_with(devices: &str) -> AgentConfig {
        AgentConfig {
            profile_id: "profile-id".into(),
            token: "secret-token".into(),
            doh_url: "https://edge.example".into(),
            bind_host: "127.0.0.1".into(),
            dns_port: 0,
            timeout_ms: 5_000,
            health_port: 0,
            health_host: "127.0.0.1".into(),
            devices: parse_device_map(devices),
        }
    }

    #[test]
    fn parses_device_maps_from_comma_newline_semicolon() {
        let map = parse_device_map("192.168.1.20=macbook, 192.168.1.21=iphone\n192.168.1.22=tv");
        assert_eq!(map.get("192.168.1.20").map(String::as_str), Some("macbook"));
        assert_eq!(map.get("192.168.1.21").map(String::as_str), Some("iphone"));
        assert_eq!(map.get("192.168.1.22").map(String::as_str), Some("tv"));
        assert_eq!(map.len(), 3);
    }

    #[test]
    fn sanitizes_device_labels_and_falls_back_to_the_ip() {
        assert_eq!(
            device_slug("192.168.1.20", Some("MacBook Pro")),
            "macbook-pro"
        );
        assert_eq!(device_slug("192.168.1.20", None), "ip-192-168-1-20");
        assert_eq!(device_slug("192.168.1.20", Some("!!!")), "ip-192-168-1-20");
        assert_eq!(device_slug("2001:db8::1", Some("!!!")), "ip-2001-db8-1");
    }

    #[test]
    fn truncates_slugs_to_32_chars() {
        let slug = device_slug("10.0.0.1", Some(&"a".repeat(64)));
        assert_eq!(slug.len(), 32);
    }

    #[test]
    fn requires_profile_and_token() {
        assert!(AgentConfig::from_lookup(|_| None)
            .unwrap_err()
            .contains("PROFILE_ID"));
        let err = AgentConfig::from_lookup(|key| match key {
            "PROFILE_ID" => Some("p".into()),
            _ => None,
        })
        .unwrap_err();
        assert!(err.contains("DOH_TOKEN"));
    }

    #[test]
    fn applies_defaults_and_trims_the_edge_url() {
        let config = AgentConfig::from_lookup(|key| match key {
            "PROFILE_ID" => Some(" p ".into()),
            "DOH_TOKEN" => Some(" t ".into()),
            "DOH_URL" => Some("https://edge.example///".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(config.profile_id, "p");
        assert_eq!(config.token, "t");
        assert_eq!(config.doh_url, "https://edge.example");
        assert_eq!(config.dns_port, 53);
        assert_eq!(config.health_port, 0);
        assert_eq!(config.health_host, "127.0.0.1");
        assert_eq!(config.bind_host, "0.0.0.0");
        assert_eq!(config.timeout_ms, 5_000);
        assert_eq!(config.devices.len(), 0);
    }

    #[test]
    fn rejects_bad_urls_and_numbers() {
        let base = |key: &str| match key {
            "PROFILE_ID" => Some("p".into()),
            "DOH_TOKEN" => Some("t".into()),
            _ => None,
        };
        let with = |extra: &'static str, value: &'static str| {
            move |key: &str| {
                if key == extra {
                    Some(value.to_string())
                } else {
                    base(key)
                }
            }
        };
        assert!(AgentConfig::from_lookup(with("DOH_URL", "dns.example.com")).is_err());
        assert!(AgentConfig::from_lookup(with("DNS_PORT", "70000")).is_err());
        assert!(AgentConfig::from_lookup(with("DNS_PORT", "53.5")).is_err());
    }

    #[test]
    fn keeps_device_lookup_by_raw_ip() {
        let config = config_with("192.168.1.20=macbook");
        assert_eq!(
            config.devices.get("192.168.1.20").map(String::as_str),
            Some("macbook")
        );
    }
}

use std::collections::{HashMap, HashSet};

use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::fingerprint::{Action, FingerprintTable};
use crate::services::blocked_service_domains;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum BlockMode {
    #[default]
    Null,
    Nxdomain,
    Refused,
    Custom,
}

#[derive(Clone, Debug)]
pub struct BlockAnswer {
    pub mode: BlockMode,
    pub ipv4: Option<String>,
    pub ipv6: Option<String>,
    pub ttl: u32,
}

impl Default for BlockAnswer {
    fn default() -> Self {
        Self {
            mode: BlockMode::Null,
            ipv4: None,
            ipv6: None,
            ttl: 300,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct SafeSearch {
    pub google: bool,
    pub bing: bool,
    pub duckduckgo: bool,
    pub youtube: bool,
}

impl SafeSearch {
    pub fn from_json(raw: Option<&str>) -> Self {
        let value: serde_json::Value = raw
            .and_then(|raw| serde_json::from_str(raw).ok())
            .unwrap_or(serde_json::Value::Null);
        let flag = |key: &str| value.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
        Self {
            google: flag("google"),
            bing: flag("bing"),
            duckduckgo: flag("duckduckgo"),
            youtube: flag("youtube"),
        }
    }

    pub fn any(&self) -> bool {
        self.google || self.bing || self.duckduckgo || self.youtube
    }
}

#[derive(Clone, Default)]
pub struct ProfileMeta {
    pub token: Option<String>,
    /// Per-profile query-log opt-out (defaults to true).
    pub log_queries: Option<bool>,
    pub dot_id: Option<String>,
    pub upstream: Option<String>,
    pub upstream_url: Option<String>,
    pub block: BlockAnswer,
    pub safe_search: SafeSearch,
}

impl ProfileMeta {
    /// Null token = id-only auth (dev only); Some = token required.
    pub fn has_token(&self) -> bool {
        self.token.is_some()
    }

    /// Custom URL wins over the preset selector, as in the TS store.
    pub fn upstream_selector(&self) -> Option<&str> {
        self.upstream_url.as_deref().or(self.upstream.as_deref())
    }
}

#[derive(Clone, Debug)]
pub struct ZoneEntry {
    pub values: Vec<String>,
    pub ttl: u32,
}

#[derive(Clone, Debug)]
pub struct Subscription {
    pub url: String,
    pub list_id: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ProfileRow {
    pub id: String,
    pub dot_id: Option<String>,
    pub doh_token: Option<String>,
    pub log_queries: bool,
    pub safe_search: Option<String>,
    pub upstream: Option<String>,
    pub upstream_url: Option<String>,
    pub block_mode: Option<String>,
    pub block_ipv4: Option<String>,
    pub block_ipv6: Option<String>,
    pub block_ttl: Option<i32>,
}

#[derive(Clone, Debug)]
pub struct RuleRow {
    pub profile_id: String,
    pub domain: String,
    pub action: Action,
}

#[derive(Clone, Debug)]
pub struct SourceIpRow {
    pub ip_address: String,
    pub profile_id: String,
}

#[derive(Clone, Debug)]
pub struct ZoneRow {
    pub profile_id: String,
    pub domain: String,
    pub record_type: String,
    pub values: Vec<String>,
    pub ttl: i32,
}

#[derive(Clone, Debug)]
pub struct BlockedServiceRow {
    pub profile_id: String,
    pub service: String,
}

pub struct BlocklistRow {
    pub id: String,
    pub profile_id: String,
    pub url: String,
    pub format: String,
    pub artifact_hash: Option<String>,
}

#[derive(Default)]
pub struct RuleStore {
    /// profile_id -> (domain -> action). Custom rules only.
    pub rules: HashMap<String, HashMap<String, Action>>,
    pub profiles: HashMap<String, ProfileMeta>,
    /// source ip -> profile_id (UDP/TCP auth).
    pub ips: HashMap<String, String>,
    /// dot id label -> profile_id.
    pub dot_ids: HashMap<String, String>,
    /// "profile|domain|type" -> entry
    zones: HashMap<String, ZoneEntry>,
    /// "profile|suffix|type" -> entry (from "*.suffix")
    wildcard_zones: HashMap<String, ZoneEntry>,
    /// profile -> exact zone names (any type), for O(labels) NODATA checks.
    zone_names: HashMap<String, HashSet<String>>,
    /// profile -> wildcard zone suffixes (any type).
    wildcard_names: HashMap<String, HashSet<String>>,
    /// url -> shared table (one copy per machine).
    pub catalog: HashMap<String, FingerprintTable>,
    pub subscriptions: HashMap<String, Vec<Subscription>>,
    /// Lists loaded from a compiled artifact / parsed from raw text this cycle.
    pub artifact_lists: usize,
    pub raw_lists: usize,
}

impl RuleStore {
    pub fn replace_config(
        &mut self,
        profiles: Vec<ProfileRow>,
        rules: Vec<RuleRow>,
        ips: Vec<SourceIpRow>,
        zones: Vec<ZoneRow>,
        services: Vec<BlockedServiceRow>,
    ) {
        let mut rule_map: HashMap<String, HashMap<String, Action>> = HashMap::new();
        for row in rules {
            let Some(domain) = normalize_rule_domain(&row.domain) else {
                continue;
            };
            rule_map
                .entry(row.profile_id)
                .or_default()
                .insert(domain, row.action);
        }
        // Blocked services expand into synthetic suffix rules. Existing custom
        // rules win, so an explicit allow can carve a host out of a service.
        let mut services_by_profile: HashMap<String, Vec<String>> = HashMap::new();
        for row in services {
            services_by_profile
                .entry(row.profile_id)
                .or_default()
                .push(row.service);
        }
        for (profile_id, ids) in services_by_profile {
            let profile = rule_map.entry(profile_id).or_default();
            for domain in blocked_service_domains(&ids) {
                profile.entry(domain.to_string()).or_insert(Action::Block);
            }
        }
        self.rules = rule_map;

        self.profiles = profiles
            .into_iter()
            .map(|row| {
                let block = BlockAnswer {
                    mode: match row.block_mode.as_deref() {
                        Some("nxdomain") => BlockMode::Nxdomain,
                        Some("refused") => BlockMode::Refused,
                        Some("custom") => BlockMode::Custom,
                        _ => BlockMode::Null,
                    },
                    ipv4: row.block_ipv4,
                    ipv6: row.block_ipv6,
                    ttl: row.block_ttl.unwrap_or(300).max(1) as u32,
                };
                (
                    row.id,
                    ProfileMeta {
                        token: row.doh_token,
                        log_queries: Some(row.log_queries),
                        dot_id: row.dot_id,
                        upstream: row.upstream,
                        upstream_url: row.upstream_url,
                        block,
                        safe_search: SafeSearch::from_json(row.safe_search.as_deref()),
                    },
                )
            })
            .collect();

        self.dot_ids = self
            .profiles
            .iter()
            .filter_map(|(id, meta)| meta.dot_id.as_ref().map(|dot| (dot.clone(), id.clone())))
            .collect();

        self.ips = ips
            .into_iter()
            .map(|row| (row.ip_address, row.profile_id))
            .collect();

        self.zones.clear();
        self.wildcard_zones.clear();
        self.zone_names.clear();
        self.wildcard_names.clear();
        for row in zones {
            let domain = row.domain.trim_end_matches('.').to_ascii_lowercase();
            if domain.is_empty() || row.values.is_empty() {
                continue;
            }
            let wildcard = domain.starts_with("*.");
            let name = domain.trim_start_matches("*.").to_string();
            let key = format!("{}|{}|{}", row.profile_id, name, row.record_type);
            let entry = ZoneEntry {
                values: row.values,
                ttl: row.ttl.max(1) as u32,
            };
            if wildcard {
                self.wildcard_names
                    .entry(row.profile_id.clone())
                    .or_default()
                    .insert(name.clone());
                self.wildcard_zones.insert(key, entry);
            } else {
                self.zone_names
                    .entry(row.profile_id.clone())
                    .or_default()
                    .insert(name.clone());
                self.zones.insert(key, entry);
            }
        }

        // Drop subscriptions for deleted profiles; the catalog is pruned by
        // the blocklist sync after re-wiring.
        let alive: HashSet<&String> = self.profiles.keys().collect();
        self.subscriptions
            .retain(|profile_id, _| alive.contains(profile_id));
    }

    pub fn should_log(&self, profile_id: &str) -> bool {
        self.profiles
            .get(profile_id)
            .and_then(|meta| meta.log_queries)
            .unwrap_or(true)
    }

    pub fn tokenless_profiles(&self) -> Vec<String> {
        self.profiles
            .iter()
            .filter(|(_, meta)| meta.token.is_none())
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn has_profile(&self, profile_id: &str, token: Option<&str>) -> bool {
        if profile_id.is_empty()
            || profile_id.len() > 64
            || !profile_id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
        {
            return false;
        }
        let Some(meta) = self.profiles.get(profile_id) else {
            return false;
        };
        match meta.token.as_deref() {
            None => true,
            Some(stored) => token.is_some_and(|supplied| constant_time_eq(supplied, stored)),
        }
    }

    pub fn authorize_ip(&self, ip: &str) -> Option<&String> {
        self.ips.get(ip)
    }

    pub fn authorize_dot_id(&self, dot_id: &str) -> Option<&String> {
        self.dot_ids.get(dot_id)
    }

    pub fn profile_meta(&self, profile_id: &str) -> Option<&ProfileMeta> {
        self.profiles.get(profile_id)
    }

    /// Exact match first, then longest suffix (custom rules: block subtree).
    pub fn resolve_custom(&self, profile_id: &str, domain: &str) -> Option<Action> {
        let rules = self.rules.get(profile_id)?;
        let normalized = normalize_rule_domain(domain)?;
        if let Some(action) = rules.get(&normalized) {
            return Some(*action);
        }
        let labels: Vec<&str> = normalized.split('.').collect();
        for index in 1..labels.len() {
            if let Some(action) = rules.get(&labels[index..].join(".")) {
                return Some(*action);
            }
        }
        None
    }

    /// All allow tables first, then all block tables (cross-list precedence).
    pub fn resolve_remote(&self, profile_id: &str, domain: &str) -> Option<Action> {
        self.resolve_remote_detailed(profile_id, domain)
            .map(|(action, _)| action)
    }

    /// Same decision, plus the `profile_blocklists.id` that produced it for
    /// query-log attribution (never the URL).
    pub fn resolve_remote_detailed(
        &self,
        profile_id: &str,
        domain: &str,
    ) -> Option<(Action, Option<String>)> {
        let subscriptions = self.subscriptions.get(profile_id)?;
        for subscription in subscriptions {
            if let Some(table) = self.catalog.get(&subscription.url) {
                if table.check_allow(domain) {
                    return Some((Action::Allow, subscription.list_id.clone()));
                }
            }
        }
        for subscription in subscriptions {
            if let Some(table) = self.catalog.get(&subscription.url) {
                if table.check_block(domain) {
                    return Some((Action::Block, subscription.list_id.clone()));
                }
            }
        }
        None
    }

    pub fn zone_lookup(
        &self,
        profile_id: &str,
        domain: &str,
        record_type: &str,
    ) -> Option<ZoneEntry> {
        let domain = domain.trim_end_matches('.').to_ascii_lowercase();
        let key = format!("{}|{}|{}", profile_id, domain, record_type);
        if let Some(entry) = self.zones.get(&key) {
            return Some(entry.clone());
        }
        let labels: Vec<&str> = domain.split('.').collect();
        for index in 1..labels.len() {
            let suffix = labels[index..].join(".");
            let key = format!("{}|{}|{}", profile_id, suffix, record_type);
            if let Some(entry) = self.wildcard_zones.get(&key) {
                return Some(entry.clone());
            }
        }
        None
    }

    pub fn has_zone_name(&self, profile_id: &str, domain: &str) -> bool {
        let domain = domain.trim_end_matches('.').to_ascii_lowercase();
        self.zones
            .keys()
            .any(|key| key.starts_with(&format!("{}|{}|", profile_id, domain)))
            || self.wildcard_zones.keys().any(|key| {
                key.starts_with(&format!("{}|", profile_id))
                    && key.split('|').nth(1).is_some_and(|suffix| {
                        domain == suffix || domain.ends_with(&format!(".{suffix}"))
                    })
            })
    }

    pub fn wire_subscriptions(&mut self, profile_id: &str, urls: Vec<Subscription>) {
        if urls.is_empty() {
            self.subscriptions.remove(profile_id);
        } else {
            self.subscriptions.insert(profile_id.to_string(), urls);
        }
    }

    pub fn upsert_list(&mut self, url: &str, table: FingerprintTable) -> bool {
        let changed = self
            .catalog
            .get(url)
            .is_none_or(|previous| previous.fingerprint != table.fingerprint);
        self.catalog.insert(url.to_string(), table);
        changed
    }

    pub fn prune_catalog(&mut self) {
        let referenced: HashSet<&str> = self
            .subscriptions
            .values()
            .flatten()
            .map(|subscription| subscription.url.as_str())
            .collect();
        self.catalog
            .retain(|url, _| referenced.contains(url.as_str()));
    }

    pub fn remote_rules(&self) -> usize {
        self.catalog.values().map(|table| table.entries).sum()
    }
}

pub fn normalize_rule_domain(domain: &str) -> Option<String> {
    let normalized = domain.trim().trim_end_matches('.').to_ascii_lowercase();
    if normalized.len() < 3 || !normalized.contains('.') {
        return None;
    }
    Some(normalized)
}

/// Hash both values first so the comparison is independent of length (tokens
/// are fixed-length hex today, but this removes the length oracle entirely).
fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = Sha256::digest(left.as_bytes());
    let right = Sha256::digest(right.as_bytes());
    left.ct_eq(&right).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile(id: &str, token: Option<&str>) -> ProfileRow {
        ProfileRow {
            id: id.to_string(),
            dot_id: None,
            doh_token: token.map(str::to_string),
            log_queries: true,
            safe_search: None,
            upstream: None,
            upstream_url: None,
            block_mode: None,
            block_ipv4: None,
            block_ipv6: None,
            block_ttl: None,
        }
    }

    fn rule(profile_id: &str, domain: &str, action: Action) -> RuleRow {
        RuleRow {
            profile_id: profile_id.to_string(),
            domain: domain.to_string(),
            action,
        }
    }

    fn zone(profile_id: &str, domain: &str, record_type: &str) -> ZoneRow {
        ZoneRow {
            profile_id: profile_id.to_string(),
            domain: domain.to_string(),
            record_type: record_type.to_string(),
            values: vec!["192.0.2.10".to_string()],
            ttl: 60,
        }
    }

    #[test]
    fn auth_requires_the_configured_token() {
        let mut store = RuleStore::default();
        store.replace_config(
            vec![profile("home", Some("secret"))],
            vec![],
            vec![],
            vec![],
            vec![],
        );
        assert!(store.has_profile("home", Some("secret")));
        assert!(!store.has_profile("home", Some("wrong")));
        assert!(!store.has_profile("home", None));
        assert!(!store.has_profile("missing", Some("secret")));
    }

    #[test]
    fn custom_rules_match_subtrees() {
        let mut store = RuleStore::default();
        store.replace_config(
            vec![profile("home", None)],
            vec![rule("home", "corp.example.com", Action::Block)],
            vec![],
            vec![],
            vec![],
        );
        assert_eq!(
            store.resolve_custom("home", "a.corp.example.com"),
            Some(Action::Block)
        );
        assert_eq!(store.resolve_custom("home", "example.com"), None);
    }

    #[test]
    fn zones_match_exact_and_wildcard() {
        let mut store = RuleStore::default();
        store.replace_config(
            vec![profile("home", None)],
            vec![],
            vec![],
            vec![
                zone("home", "nas.lan", "A"),
                zone("home", "*.home.lan", "A"),
            ],
            vec![],
        );
        assert!(store.zone_lookup("home", "nas.lan", "A").is_some());
        assert!(store.zone_lookup("home", "tv.home.lan", "A").is_some());
        assert!(store.zone_lookup("home", "home.lan", "A").is_none());
    }

    #[test]
    fn blocked_services_expand_but_explicit_rules_win() {
        let mut store = RuleStore::default();
        store.replace_config(
            vec![profile("home", None)],
            vec![rule("home", "youtube.com", Action::Allow)],
            vec![],
            vec![],
            vec![
                BlockedServiceRow {
                    profile_id: "home".into(),
                    service: "youtube".into(),
                },
                BlockedServiceRow {
                    profile_id: "home".into(),
                    service: "tiktok".into(),
                },
            ],
        );
        assert_eq!(
            store.resolve_custom("home", "youtube.com"),
            Some(Action::Allow)
        );
        assert_eq!(
            store.resolve_custom("home", "www.youtube.com"),
            Some(Action::Allow)
        );
        assert_eq!(
            store.resolve_custom("home", "tiktok.com"),
            Some(Action::Block)
        );
    }

    #[test]
    fn remote_allow_wins_across_lists() {
        use crate::fingerprint::FingerprintTable;
        let mut store = RuleStore::default();
        store.replace_config(vec![profile("home", None)], vec![], vec![], vec![], vec![]);
        let block: HashSet<String> = ["ads.example".to_string()].into_iter().collect();
        let allow: HashSet<String> = ["good.ads.example".to_string()].into_iter().collect();
        store.upsert_list("block", FingerprintTable::build(&block, &HashSet::new()));
        store.upsert_list("allow", FingerprintTable::build(&HashSet::new(), &allow));
        store.wire_subscriptions(
            "home",
            vec![
                Subscription {
                    url: "block".into(),
                    list_id: None,
                },
                Subscription {
                    url: "allow".into(),
                    list_id: None,
                },
            ],
        );
        assert_eq!(
            store.resolve_remote("home", "good.ads.example"),
            Some(Action::Allow)
        );
        assert_eq!(
            store.resolve_remote("home", "ads.example"),
            Some(Action::Block)
        );
    }
}

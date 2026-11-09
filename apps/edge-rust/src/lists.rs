use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use tokio::sync::RwLock;
use tracing::{info, warn};

use crate::artifact::{sha256_hex, Artifact, S3Config};
use crate::cache::DnsCache;
use crate::config::Config;
use crate::db::Db;
use crate::fingerprint::FingerprintTable;
use crate::netguard::{redact_url, SafeFetcher};
use crate::parse::{parse_list, ListFormat};
use crate::store::{RuleStore, Subscription};

/// Fetch + parse every enabled list, rebuild the shared catalog, then re-wire
/// per-profile subscriptions. Returns whether the effective state changed (the
/// caller flushes the DNS cache only then).
#[derive(Clone, Copy, Debug, Default)]
pub struct SyncReport {
    pub changed: bool,
    pub failed: usize,
}

pub async fn sync_once(
    db: &Db,
    store: &Arc<RwLock<RuleStore>>,
    cache: &Arc<Mutex<DnsCache>>,
    cfg: &Config,
) -> Result<SyncReport, String> {
    let rows = db.blocklists().await.map_err(|err| err.to_string())?;

    struct UniqueList {
        format: String,
        artifact_hash: Option<String>,
    }
    let mut unique: HashMap<String, UniqueList> = HashMap::new();
    let mut by_profile: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for row in rows {
        let entry = unique.entry(row.url.clone()).or_insert(UniqueList {
            format: row.format.clone(),
            artifact_hash: row.artifact_hash.clone(),
        });
        if entry.artifact_hash.is_none() {
            entry.artifact_hash = row.artifact_hash;
        }
        by_profile
            .entry(row.profile_id.clone())
            .or_default()
            .push((row.url, row.id));
    }
    let s3 = S3Config::from_env();

    let fetcher = SafeFetcher::new(cfg.max_list_bytes, true);

    let mut changed = false;
    let mut failed = 0usize;
    let mut total = 0usize;
    let deadline = Instant::now() + cfg.list_cycle_deadline;
    let mut artifact_lists = 0usize;
    let mut raw_lists = 0usize;
    let mut fetched: Vec<(String, FingerprintTable)> = Vec::new();

    // Sequential on purpose: a 500k-rule parse is the memory high-water mark,
    // and parallel parses multiplied the transient enough to OOM 256 MB VMs.
    for (index, (url, list)) in unique.iter().enumerate() {
        if index >= cfg.max_unique_lists {
            warn!(url = %redact_url(url), cap = cfg.max_unique_lists, "unique-list cap reached; list skipped");
            failed += 1;
            continue;
        }
        if Instant::now() >= deadline {
            warn!(url = %redact_url(url), "blocklist cycle deadline reached; list skipped");
            failed += 1;
            continue;
        }
        let mut table = None;
        if let (Some(s3), Some(hash)) = (&s3, list.artifact_hash.as_deref()) {
            match load_artifact(s3, hash).await {
                Ok(value) => {
                    artifact_lists += 1;
                    table = Some(value);
                }
                Err(err) => {
                    warn!(url = %redact_url(url), %err, "artifact load failed; falling back to text")
                }
            }
        }

        let table = match table {
            Some(table) => table,
            None => match fetch_text(&fetcher, url, cfg.max_list_bytes).await {
                Ok(text) => {
                    raw_lists += 1;
                    // Parsing is CPU-bound (~0.2 s per 500k rules). Keep it off
                    // the async workers so DNS queries keep flowing during a
                    // 6-hour resync; the text is moved into the blocking task.
                    let list_format = ListFormat::parse(&list.format);
                    match tokio::task::spawn_blocking(move || {
                        let parsed = parse_list(&text, list_format);
                        FingerprintTable::build(&parsed.blocks, &parsed.allows)
                    })
                    .await
                    {
                        Ok(table) => table,
                        Err(err) => {
                            warn!(url = %redact_url(url), %err, "list parse task failed");
                            failed += 1;
                            let status = format!(
                                "error: {}",
                                err.to_string().chars().take(42).collect::<String>()
                            );
                            let _ = db.write_blocklist_status(url, &status, 0, None).await;
                            continue;
                        }
                    }
                }
                Err(err) => {
                    warn!(url = %redact_url(url), %err, "list fetch failed; keeping previous table");
                    failed += 1;
                    let status = format!("error: {}", err.chars().take(42).collect::<String>());
                    let _ = db.write_blocklist_status(url, &status, 0, None).await;
                    continue;
                }
            },
        };

        if total + table.entries > cfg.max_total_entries {
            warn!(
                url,
                entries = table.entries,
                total,
                cap = cfg.max_total_entries,
                "global rule budget exceeded; list skipped"
            );
            continue;
        }
        total += table.entries;
        info!(url = %redact_url(url), entries = table.entries, "list loaded");
        let _ = db
            .write_blocklist_status(url, "ok", table.entries as i32, Some(&list.format))
            .await;
        fetched.push((url.clone(), table));
    }

    if !fetched.is_empty() {
        let mut guard = store.write().await;
        for (url, table) in fetched {
            changed |= guard.upsert_list(&url, table);
        }
    }

    let catalog_urls: HashSet<String> = {
        let guard = store.read().await;
        guard.catalog.keys().cloned().collect()
    };

    let mut guard = store.write().await;
    guard.artifact_lists = artifact_lists;
    guard.raw_lists = raw_lists;
    for (profile_id, rows) in &by_profile {
        let mut seen = HashSet::new();
        let mut subscriptions = Vec::new();
        for (url, list_id) in rows {
            if !catalog_urls.contains(url) || !seen.insert(url.clone()) {
                continue;
            }
            if subscriptions.len() >= cfg.max_lists_per_profile {
                warn!(profile_id, "per-profile list cap reached");
                break;
            }
            subscriptions.push(Subscription {
                url: url.clone(),
                list_id: Some(list_id.clone()),
            });
        }
        guard.wire_subscriptions(profile_id, subscriptions);
    }
    let stale: Vec<String> = guard
        .subscriptions
        .keys()
        .filter(|profile_id| !by_profile.contains_key(*profile_id))
        .cloned()
        .collect();
    for profile_id in stale {
        guard.wire_subscriptions(&profile_id, Vec::new());
    }
    guard.prune_catalog();
    drop(guard);

    if changed {
        cache.lock().expect("cache lock").clear();
        info!("blocklist state changed; dns cache flushed");
    }
    Ok(SyncReport { changed, failed })
}

async fn fetch_text(fetcher: &SafeFetcher, url: &str, _max_bytes: usize) -> Result<String, String> {
    let bytes = fetcher.get(url).await?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

async fn load_artifact(s3: &S3Config, hash: &str) -> Result<FingerprintTable, String> {
    let bytes = s3.get(hash).await?;
    let actual = sha256_hex(&bytes);
    if actual != hash {
        return Err(format!("artifact hash mismatch ({actual})"));
    }
    Ok(Artifact::decode(&bytes)?.into_table())
}

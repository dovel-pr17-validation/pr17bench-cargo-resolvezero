//! Query logging: Postgres rollups + gzipped S3 archive.
//!
//! Mirrors the Node pipeline: a bounded in-memory batcher writes
//! `stats_minute` / `stats_hourly` (+ per-device variants) and appends each
//! event to a one-minute S3 window. DNS never waits on either sink.

use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Map, Value};
use sqlx::{Postgres, Row, Transaction};
use time::macros::format_description;
use time::OffsetDateTime;
use tokio::sync::mpsc;
use tracing::{info, warn};

use crate::artifact::S3Config;
use crate::config::Config;
use crate::db::Db;
use crate::metrics::Metrics;

const BATCH_SIZE: usize = 500;
const FLUSH_EVERY: Duration = Duration::from_secs(1);
const ARCHIVE_EVERY: Duration = Duration::from_secs(30);
const ARCHIVE_WINDOW_SECONDS: i64 = 60;
const MAX_PENDING: usize = 50_000;
const MAX_STAGED_LINES: usize = 200_000;

const MAX_TOP_DOMAINS: usize = 200;
const MAX_TOP_BLOCKED: usize = 100;
const MAX_TOP_CLIENTS: usize = 50;
const MAX_TOP_DEVICES: usize = 50;
const MAX_DEVICE_TOP: usize = 50;

#[derive(Clone, Debug)]
pub struct QueryEvent {
    pub at: i64,
    pub at_ms: i64,
    pub profile: String,
    pub domain: String,
    pub action: &'static str,
    pub reason: Option<&'static str>,
    pub list_id: Option<String>,
    pub transport: &'static str,
    pub upstream: Option<String>,
    pub client_ip: Option<String>,
    pub device: Option<String>,
    pub rtt_ms: Option<i64>,
}

#[allow(clippy::large_enum_variant)] // boxing every query event would allocate on the hot path
enum LogMessage {
    Event(QueryEvent),
    Shutdown(tokio::sync::oneshot::Sender<()>),
}

pub struct QueryLogger {
    tx: mpsc::Sender<LogMessage>,
    metrics: Arc<Metrics>,
}

impl QueryLogger {
    pub fn log(&self, event: QueryEvent) {
        if self.tx.try_send(LogMessage::Event(event)).is_err() {
            Metrics::inc(&self.metrics.log_dropped);
        }
    }

    /// Flush pending stats/archive rows before process exit. SIGTERM callers
    /// await this; a 10 s cap keeps a wedged S3/database from blocking shutdown.
    pub async fn shutdown(&self) {
        let (tx, rx) = tokio::sync::oneshot::channel();
        if self.tx.send(LogMessage::Shutdown(tx)).await.is_ok() {
            let _ = tokio::time::timeout(Duration::from_secs(10), rx).await;
        }
    }
}

/// Spawn the flush task. The channel is bounded; DNS never blocks on it.
pub fn start(db: Db, cfg: Arc<Config>, metrics: Arc<Metrics>) -> QueryLogger {
    let (tx, mut rx) = mpsc::channel::<LogMessage>(20_000);
    let logger_metrics = metrics.clone();
    tokio::spawn(async move {
        let mut archive = Archive::new(&cfg, metrics.clone());
        let mut batch: Vec<QueryEvent> = Vec::new();
        let mut pending: Vec<QueryEvent> = Vec::new();
        let mut flush_tick = tokio::time::interval(FLUSH_EVERY);
        let mut archive_tick = tokio::time::interval(ARCHIVE_EVERY);

        loop {
            tokio::select! {
                maybe = rx.recv() => match maybe {
                    Some(LogMessage::Event(event)) => {
                        batch.push(event);
                        if batch.len() >= BATCH_SIZE {
                            flush(&db, &mut archive, &mut batch, &mut pending, &metrics).await;
                        }
                    }
                    Some(LogMessage::Shutdown(done)) => {
                        flush(&db, &mut archive, &mut batch, &mut pending, &metrics).await;
                        archive.flush_all(now()).await;
                        let _ = done.send(());
                        break;
                    }
                    None => break,
                },
                _ = flush_tick.tick() => {
                    flush(&db, &mut archive, &mut batch, &mut pending, &metrics).await;
                }
                _ = archive_tick.tick() => {
                    archive.flush_completed(now()).await;
                }
            }
        }

        flush(&db, &mut archive, &mut batch, &mut pending, &metrics).await;
        if !pending.is_empty() {
            warn!(
                rows = pending.len(),
                "query-log rows still pending at shutdown"
            );
        }
        archive.flush_all(now()).await;
        info!("query logger stopped");
    });

    QueryLogger {
        tx,
        metrics: logger_metrics,
    }
}

async fn flush(
    db: &Db,
    archive: &mut Archive,
    batch: &mut Vec<QueryEvent>,
    pending: &mut Vec<QueryEvent>,
    metrics: &Metrics,
) {
    if batch.is_empty() && pending.is_empty() {
        return;
    }
    pending.append(batch);
    while pending.len() > MAX_PENDING {
        pending.remove(0);
    }
    match apply_rollups(db, pending).await {
        Ok(()) => {
            for event in pending.iter() {
                archive.add(event);
            }
            pending.clear();
        }
        Err(err) => {
            warn!(%err, rows = pending.len(), "query rollup failed; will retry");
            Metrics::inc(&metrics.rollup_errors);
        }
    }
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

// ---- Rollups ----

#[derive(Default)]
struct HourBucket {
    profile: String,
    hour: i64,
    total: i64,
    blocked: i64,
    rtt_sum: i64,
    rtt_count: i64,
    domains: HashMap<String, i64>,
    blocked_domains: HashMap<String, i64>,
    clients: HashMap<String, i64>,
    devices: HashMap<String, i64>,
}

#[derive(Default)]
struct MinuteBucket {
    profile: String,
    minute: i64,
    total: i64,
    blocked: i64,
}

#[derive(Default)]
struct DeviceHourBucket {
    profile: String,
    device: String,
    hour: i64,
    total: i64,
    blocked: i64,
    rtt_sum: i64,
    rtt_count: i64,
    domains: HashMap<String, i64>,
    blocked_domains: HashMap<String, i64>,
}

async fn apply_rollups(db: &Db, rows: &[QueryEvent]) -> Result<(), sqlx::Error> {
    if rows.is_empty() {
        return Ok(());
    }
    let ids: Vec<String> = {
        let mut set = std::collections::HashSet::new();
        rows.iter()
            .filter(|row| set.insert(row.profile.clone()))
            .map(|row| row.profile.clone())
            .collect()
    };
    let known: std::collections::HashSet<String> =
        sqlx::query("select id from profiles where id = any($1)")
            .bind(&ids)
            .fetch_all(db.pool())
            .await?
            .into_iter()
            .map(|row| row.get::<String, _>("id"))
            .collect();
    let valid: Vec<&QueryEvent> = rows
        .iter()
        .filter(|row| known.contains(&row.profile))
        .collect();
    if valid.is_empty() {
        return Ok(());
    }

    let mut hour_buckets: HashMap<(String, i64), HourBucket> = HashMap::new();
    let mut minute_buckets: HashMap<(String, i64), MinuteBucket> = HashMap::new();
    let mut device_hours: HashMap<(String, String, i64), DeviceHourBucket> = HashMap::new();

    for event in valid.iter() {
        let hour = floor(event.at, 3_600);
        let minute = floor(event.at, 60);
        let bucket = hour_buckets
            .entry((event.profile.clone(), hour))
            .or_insert_with(|| HourBucket {
                profile: event.profile.clone(),
                hour,
                ..Default::default()
            });
        bucket.total += 1;
        if event.action == "block" {
            bucket.blocked += 1;
            *bucket
                .blocked_domains
                .entry(event.domain.clone())
                .or_insert(0) += 1;
        }
        if let Some(rtt) = event.rtt_ms {
            bucket.rtt_sum += rtt;
            bucket.rtt_count += 1;
        }
        *bucket.domains.entry(event.domain.clone()).or_insert(0) += 1;
        if let Some(client) = &event.client_ip {
            *bucket.clients.entry(client.clone()).or_insert(0) += 1;
        }
        if let Some(device) = &event.device {
            *bucket.devices.entry(device.clone()).or_insert(0) += 1;
        }

        let minute_bucket = minute_buckets
            .entry((event.profile.clone(), minute))
            .or_insert_with(|| MinuteBucket {
                profile: event.profile.clone(),
                minute,
                ..Default::default()
            });
        minute_bucket.total += 1;
        if event.action == "block" {
            minute_bucket.blocked += 1;
        }

        if let Some(device) = &event.device {
            let bucket = device_hours
                .entry((event.profile.clone(), device.clone(), hour))
                .or_insert_with(|| DeviceHourBucket {
                    profile: event.profile.clone(),
                    device: device.clone(),
                    hour,
                    ..Default::default()
                });
            bucket.total += 1;
            if event.action == "block" {
                bucket.blocked += 1;
                *bucket
                    .blocked_domains
                    .entry(event.domain.clone())
                    .or_insert(0) += 1;
            }
            if let Some(rtt) = event.rtt_ms {
                bucket.rtt_sum += rtt;
                bucket.rtt_count += 1;
            }
            *bucket.domains.entry(event.domain.clone()).or_insert(0) += 1;
        }
    }

    let mut tx = db.pool().begin().await?;
    for bucket in hour_buckets.values() {
        apply_hour_bucket(&mut tx, bucket).await?;
    }
    for bucket in minute_buckets.values() {
        apply_minute_bucket(&mut tx, bucket).await?;
    }
    for bucket in device_hours.values() {
        apply_device_hour_bucket(&mut tx, bucket).await?;
    }
    apply_device_minutes(&mut tx, &valid).await?;
    tx.commit().await
}

fn floor(value: i64, width: i64) -> i64 {
    value - value.rem_euclid(width)
}

async fn apply_hour_bucket(
    tx: &mut Transaction<'_, Postgres>,
    bucket: &HourBucket,
) -> Result<(), sqlx::Error> {
    let lock = format!("{}:{}", bucket.profile, bucket.hour);
    sqlx::query("select pg_advisory_xact_lock(hashtext($1))")
        .bind(&lock)
        .execute(&mut **tx)
        .await?;

    let existing = sqlx::query(
        "select total_queries, blocked, rtt_sum_ms, rtt_count,
                top_domains::text as top_domains, top_blocked::text as top_blocked,
                top_clients::text as top_clients, top_devices::text as top_devices
           from stats_hourly
          where profile_id = $1 and hour = to_timestamp($2)
          for update",
    )
    .bind(&bucket.profile)
    .bind(bucket.hour)
    .fetch_optional(&mut **tx)
    .await?;

    let (mut domains, mut blocked_domains, mut clients, mut devices) = (
        HashMap::new(),
        HashMap::new(),
        HashMap::new(),
        HashMap::new(),
    );
    let (total, blocked, rtt_sum, rtt_count) = if let Some(row) = &existing {
        merge_json(
            &mut domains,
            row.try_get::<String, _>("top_domains")?,
            "domain",
        );
        merge_json(
            &mut blocked_domains,
            row.try_get::<String, _>("top_blocked")?,
            "domain",
        );
        merge_json(
            &mut clients,
            row.try_get::<String, _>("top_clients")?,
            "clientIp",
        );
        merge_json(
            &mut devices,
            row.try_get::<String, _>("top_devices")?,
            "device",
        );
        (
            row.try_get::<i32, _>("total_queries")? as i64 + bucket.total,
            row.try_get::<i32, _>("blocked")? as i64 + bucket.blocked,
            row.try_get::<i64, _>("rtt_sum_ms")? + bucket.rtt_sum,
            row.try_get::<i32, _>("rtt_count")? as i64 + bucket.rtt_count,
        )
    } else {
        (
            bucket.total,
            bucket.blocked,
            bucket.rtt_sum,
            bucket.rtt_count,
        )
    };
    merge(&mut domains, &bucket.domains);
    merge(&mut blocked_domains, &bucket.blocked_domains);
    merge(&mut clients, &bucket.clients);
    merge(&mut devices, &bucket.devices);

    sqlx::query(
        "insert into stats_hourly
           (profile_id, hour, total_queries, blocked, rtt_sum_ms, rtt_count,
            top_domains, top_blocked, top_clients, top_devices)
         values ($1, to_timestamp($2), $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)
         on conflict (profile_id, hour) do update set
           total_queries = excluded.total_queries,
           blocked = excluded.blocked,
           rtt_sum_ms = excluded.rtt_sum_ms,
           rtt_count = excluded.rtt_count,
           top_domains = excluded.top_domains,
           top_blocked = excluded.top_blocked,
           top_clients = excluded.top_clients,
           top_devices = excluded.top_devices",
    )
    .bind(&bucket.profile)
    .bind(bucket.hour)
    .bind(total as i32)
    .bind(blocked as i32)
    .bind(rtt_sum)
    .bind(rtt_count as i32)
    .bind(top_json(&domains, "domain", MAX_TOP_DOMAINS))
    .bind(top_json(&blocked_domains, "domain", MAX_TOP_BLOCKED))
    .bind(top_json(&clients, "clientIp", MAX_TOP_CLIENTS))
    .bind(top_json(&devices, "device", MAX_TOP_DEVICES))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn apply_minute_bucket(
    tx: &mut Transaction<'_, Postgres>,
    bucket: &MinuteBucket,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "insert into stats_minute (profile_id, minute, total_queries, blocked)
         values ($1, to_timestamp($2), $3, $4)
         on conflict (profile_id, minute) do update set
           total_queries = stats_minute.total_queries + excluded.total_queries,
           blocked = stats_minute.blocked + excluded.blocked",
    )
    .bind(&bucket.profile)
    .bind(bucket.minute)
    .bind(bucket.total as i32)
    .bind(bucket.blocked as i32)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

async fn apply_device_minutes(
    tx: &mut Transaction<'_, Postgres>,
    rows: &[&QueryEvent],
) -> Result<(), sqlx::Error> {
    let mut buckets: HashMap<(String, String, i64), (i64, i64)> = HashMap::new();
    for event in rows {
        let Some(device) = &event.device else {
            continue;
        };
        let minute = floor(event.at, 60);
        let entry = buckets
            .entry((event.profile.clone(), device.clone(), minute))
            .or_insert((0, 0));
        entry.0 += 1;
        if event.action == "block" {
            entry.1 += 1;
        }
    }
    for ((profile, device, minute), (total, blocked)) in buckets {
        sqlx::query(
            "insert into stats_minute_device (profile_id, device, minute, total_queries, blocked)
             values ($1, $2, to_timestamp($3), $4, $5)
             on conflict (profile_id, device, minute) do update set
               total_queries = stats_minute_device.total_queries + excluded.total_queries,
               blocked = stats_minute_device.blocked + excluded.blocked",
        )
        .bind(profile)
        .bind(device)
        .bind(minute)
        .bind(total as i32)
        .bind(blocked as i32)
        .execute(&mut **tx)
        .await?;
    }
    Ok(())
}

async fn apply_device_hour_bucket(
    tx: &mut Transaction<'_, Postgres>,
    bucket: &DeviceHourBucket,
) -> Result<(), sqlx::Error> {
    let lock = format!(
        "device:{}:{}:{}",
        bucket.profile, bucket.device, bucket.hour
    );
    sqlx::query("select pg_advisory_xact_lock(hashtext($1))")
        .bind(&lock)
        .execute(&mut **tx)
        .await?;

    let existing = sqlx::query(
        "select total_queries, blocked, rtt_sum_ms, rtt_count,
                top_domains::text as top_domains, top_blocked::text as top_blocked
           from stats_hourly_device
          where profile_id = $1 and device = $2 and hour = to_timestamp($3)
          for update",
    )
    .bind(&bucket.profile)
    .bind(&bucket.device)
    .bind(bucket.hour)
    .fetch_optional(&mut **tx)
    .await?;

    let mut domains = HashMap::new();
    let mut blocked_domains = HashMap::new();
    let (total, blocked, rtt_sum, rtt_count) = if let Some(row) = &existing {
        merge_json(
            &mut domains,
            row.try_get::<String, _>("top_domains")?,
            "domain",
        );
        merge_json(
            &mut blocked_domains,
            row.try_get::<String, _>("top_blocked")?,
            "domain",
        );
        (
            row.try_get::<i32, _>("total_queries")? as i64 + bucket.total,
            row.try_get::<i32, _>("blocked")? as i64 + bucket.blocked,
            row.try_get::<i64, _>("rtt_sum_ms")? + bucket.rtt_sum,
            row.try_get::<i32, _>("rtt_count")? as i64 + bucket.rtt_count,
        )
    } else {
        (
            bucket.total,
            bucket.blocked,
            bucket.rtt_sum,
            bucket.rtt_count,
        )
    };
    merge(&mut domains, &bucket.domains);
    merge(&mut blocked_domains, &bucket.blocked_domains);

    sqlx::query(
        "insert into stats_hourly_device
           (profile_id, device, hour, total_queries, blocked, rtt_sum_ms, rtt_count,
            top_domains, top_blocked)
         values ($1, $2, to_timestamp($3), $4, $5, $6, $7, $8::jsonb, $9::jsonb)
         on conflict (profile_id, device, hour) do update set
           total_queries = excluded.total_queries,
           blocked = excluded.blocked,
           rtt_sum_ms = excluded.rtt_sum_ms,
           rtt_count = excluded.rtt_count,
           top_domains = excluded.top_domains,
           top_blocked = excluded.top_blocked",
    )
    .bind(&bucket.profile)
    .bind(&bucket.device)
    .bind(bucket.hour)
    .bind(total as i32)
    .bind(blocked as i32)
    .bind(rtt_sum)
    .bind(rtt_count as i32)
    .bind(top_json(&domains, "domain", MAX_DEVICE_TOP))
    .bind(top_json(&blocked_domains, "domain", MAX_DEVICE_TOP))
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn merge(target: &mut HashMap<String, i64>, source: &HashMap<String, i64>) {
    for (key, count) in source {
        *target.entry(key.clone()).or_insert(0) += count;
    }
}

fn merge_json(target: &mut HashMap<String, i64>, json: String, key: &str) {
    if let Ok(Value::Array(entries)) = serde_json::from_str::<Value>(&json) {
        for entry in entries {
            if let (Some(name), Some(count)) = (
                entry.get(key).and_then(Value::as_str),
                entry.get("count").and_then(Value::as_i64),
            ) {
                *target.entry(name.to_string()).or_insert(0) += count;
            }
        }
    }
}

fn top_json(map: &HashMap<String, i64>, key: &str, cap: usize) -> String {
    let mut entries: Vec<(&String, &i64)> = map.iter().collect();
    entries.sort_by(|a, b| b.1.cmp(a.1).then_with(|| a.0.cmp(b.0)));
    let values: Vec<Value> = entries
        .into_iter()
        .take(cap)
        .map(|(name, count)| json!({ key: name, "count": count }))
        .collect();
    Value::Array(values).to_string()
}

// ---- Raw archive ----

struct Archive {
    s3: Option<S3Config>,
    metrics: Arc<Metrics>,
    prefix: String,
    instance: String,
    region: String,
    machine: String,
    staging: HashMap<(i64, String), Vec<String>>,
    staged_lines: usize,
    seq: u64,
}

impl Archive {
    fn new(cfg: &Config, metrics: Arc<Metrics>) -> Self {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let region = cfg.region.clone();
        let machine = std::env::var("FLY_MACHINE_ID")
            .or_else(|_| std::env::var("FLY_ALLOC_ID"))
            .unwrap_or_else(|_| "local".into());
        let instance = format!("{region}-{machine}-{nonce}")
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        Self {
            s3: S3Config::from_env(),
            metrics,
            prefix: std::env::var("S3_LOG_PREFIX").unwrap_or_else(|_| "logs".into()),
            instance,
            region,
            machine,
            staging: HashMap::new(),
            staged_lines: 0,
            seq: 0,
        }
    }

    fn add(&mut self, event: &QueryEvent) {
        if self.s3.is_none() {
            return;
        }
        if self.staged_lines >= MAX_STAGED_LINES {
            Metrics::inc(&self.metrics.log_dropped);
            return;
        }
        let window = floor(event.at, ARCHIVE_WINDOW_SECONDS);
        let line = self.line(event);
        self.staging
            .entry((window, event.profile.clone()))
            .or_default()
            .push(line);
        self.staged_lines += 1;
    }

    fn line(&self, event: &QueryEvent) -> String {
        let mut map = Map::new();
        map.insert("kind".into(), json!("query"));
        map.insert("time".into(), json!(format_time(event.at_ms)));
        map.insert("profile".into(), json!(event.profile));
        map.insert("domain".into(), json!(event.domain));
        map.insert("action".into(), json!(event.action));
        map.insert("rttMs".into(), json!(event.rtt_ms));
        map.insert("clientIp".into(), json!(event.client_ip));
        if let Some(device) = &event.device {
            map.insert("device".into(), json!(device));
        }
        if let Some(reason) = event.reason {
            map.insert("reason".into(), json!(reason));
        }
        if let Some(list_id) = &event.list_id {
            map.insert("listId".into(), json!(list_id));
        }
        map.insert("transport".into(), json!(event.transport));
        if let Some(upstream) = &event.upstream {
            map.insert("upstream".into(), json!(upstream));
        }
        map.insert("region".into(), json!(self.region));
        map.insert("machine".into(), json!(self.machine));
        Value::Object(map).to_string()
    }

    async fn flush_completed(&mut self, now: i64) {
        let ready: Vec<(i64, String)> = self
            .staging
            .keys()
            .filter(|(window, _)| window + ARCHIVE_WINDOW_SECONDS <= now)
            .cloned()
            .collect();
        for key in ready {
            if let Some(lines) = self.staging.remove(&key) {
                self.staged_lines = self.staged_lines.saturating_sub(lines.len());
                self.put(key.0, &key.1, lines).await;
            }
        }
    }

    async fn flush_all(&mut self, _now: i64) {
        let keys: Vec<(i64, String)> = self.staging.keys().cloned().collect();
        for key in keys {
            if let Some(lines) = self.staging.remove(&key) {
                self.staged_lines = self.staged_lines.saturating_sub(lines.len());
                self.put(key.0, &key.1, lines).await;
            }
        }
    }

    async fn put(&mut self, window: i64, profile: &str, lines: Vec<String>) {
        let Some(s3) = &self.s3 else {
            return;
        };
        if lines.is_empty() {
            return;
        }
        let Ok(stamp) = OffsetDateTime::from_unix_timestamp(window) else {
            return;
        };
        let day = stamp
            .format(&format_description!("[year]-[month]-[day]"))
            .unwrap_or_else(|_| "1970-01-01".into());
        let hhmm = stamp
            .format(&format_description!("[hour][minute]"))
            .unwrap_or_else(|_| "0000".into());
        let key = format!(
            "{}/{}/{}/{}.{}.{}.jsonl.gz",
            self.prefix.trim_matches('/'),
            profile,
            day,
            hhmm,
            self.instance,
            self.seq
        );
        self.seq += 1;

        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        if encoder.write_all(lines.join("\n").as_bytes()).is_err() {
            return;
        }
        let Ok(payload) = encoder.finish() else {
            return;
        };
        if let Err(err) = s3.put(&key, &payload, "application/gzip").await {
            warn!(%err, key, "raw-log upload failed");
            Metrics::inc(&self.metrics.log_dropped);
        }
    }
}

fn format_time(at_ms: i64) -> String {
    OffsetDateTime::from_unix_timestamp_nanos((at_ms as i128) * 1_000_000)
        .ok()
        .and_then(|time| {
            time.format(&format_description!(
                "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z"
            ))
            .ok()
        })
        .unwrap_or_default()
}

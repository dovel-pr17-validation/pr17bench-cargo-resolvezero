use std::collections::{HashMap, HashSet};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, Path, State};
use axum::http::{header, HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use base64::Engine as _;
use hickory_proto::rr::RecordType;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{RwLock, Semaphore};
use tracing::{error, info, warn};

use flate2::read::GzDecoder;
use std::io::Read;

use crate::artifact::S3Config;
use crate::cache::DnsCache;
use crate::config::{Config, UnknownSource};
use crate::db::Db;
use crate::dns;
use crate::fingerprint::Action;
use crate::limits::FixedWindow;
use crate::lists;
use crate::metrics::Metrics;
use crate::stats::{self, QueryEvent, QueryLogger};
use crate::store::RuleStore;
use crate::upstream::Upstream;

pub struct AppState {
    pub cfg: Arc<Config>,
    pub store: Arc<RwLock<RuleStore>>,
    pub cache: Arc<Mutex<DnsCache>>,
    pub upstream: Arc<Upstream>,
    pub metrics: Arc<Metrics>,
    pub logger: Arc<QueryLogger>,
    pub db: Db,
    pub ready: AtomicBool,
    pub seen_devices: Mutex<HashSet<(String, String)>>,
    inflight: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    pub blocklist_ok: AtomicBool,
    pub blocklist_failed: AtomicUsize,
    pub blocklist_error: Mutex<Option<String>>,
    pub last_sync_at: AtomicI64,
    pub last_config_poll_at: AtomicI64,
    pub config_poll_error: AtomicBool,
    pub purge_since: AtomicI64,
    doh_rate: FixedWindow,
    udp_rate: FixedWindow,
    doh_gate: Semaphore,
    udp_gate: Arc<Semaphore>,
    tcp_gate: Arc<Semaphore>,
    conn_sources: Arc<Mutex<HashMap<String, usize>>>,
    admin_rate: FixedWindow,
    purge_rate: FixedWindow,
    sync_lock: tokio::sync::Mutex<()>,
}

#[derive(Clone, Debug)]
struct QueryContext {
    client_ip: Option<String>,
    device: Option<String>,
    transport: &'static str,
    log_enabled: bool,
}

pub async fn run(cfg: Config) -> Result<(), String> {
    let cfg = Arc::new(cfg);
    let db = Db::connect(&cfg.database_url)
        .await
        .map_err(|err| format!("database connect failed: {err}"))?;

    let (versions, snapshot) = initial_snapshot(&db).await?;

    let store = Arc::new(RwLock::new(RuleStore::default()));
    {
        let mut guard = store.write().await;
        guard.replace_config(
            snapshot.profiles,
            snapshot.rules,
            snapshot.ips,
            snapshot.zones,
            snapshot.services,
        );
    }

    if std::env::var("FLY_REGION").is_ok() && !cfg.allow_tokenless {
        let tokenless = store.read().await.tokenless_profiles();
        if !tokenless.is_empty() {
            return Err(format!(
                "hosted edge refuses token-free profiles: {tokenless:?}"
            ));
        }
    }

    let cache = Arc::new(Mutex::new(DnsCache::default()));
    let metrics = Arc::new(Metrics::default());
    let logger = Arc::new(stats::start(db.clone(), cfg.clone(), metrics.clone()));
    let state = Arc::new(AppState {
        cfg: cfg.clone(),
        store: store.clone(),
        cache: cache.clone(),
        upstream: Arc::new(Upstream::new(cfg.default_upstream())?),
        metrics,
        logger,
        db: db.clone(),
        ready: AtomicBool::new(false),
        seen_devices: Mutex::new(HashSet::new()),
        inflight: Mutex::new(HashMap::new()),
        blocklist_ok: AtomicBool::new(false),
        blocklist_failed: AtomicUsize::new(0),
        blocklist_error: Mutex::new(None),
        last_sync_at: AtomicI64::new(0),
        last_config_poll_at: AtomicI64::new(now_seconds()),
        config_poll_error: AtomicBool::new(false),
        purge_since: AtomicI64::new(now_seconds() - 60),
        doh_rate: FixedWindow::new(cfg.doh_rate_limit_per_min, Duration::from_secs(60)),
        udp_rate: FixedWindow::new(cfg.udp_rate_limit_per_min, Duration::from_secs(60)),
        doh_gate: Semaphore::new(cfg.doh_max_inflight.max(1)),
        udp_gate: Arc::new(Semaphore::new(cfg.udp_max_inflight.max(1))),
        tcp_gate: Arc::new(Semaphore::new(cfg.tcp_max_connections.max(1))),
        conn_sources: Arc::new(Mutex::new(HashMap::new())),
        admin_rate: FixedWindow::new(60, Duration::from_secs(60)),
        purge_rate: FixedWindow::new(10, Duration::from_secs(60)),
        sync_lock: tokio::sync::Mutex::new(()),
    });

    match lists::sync_once(&db, &store, &cache, &cfg).await {
        Ok(report) => {
            state
                .blocklist_ok
                .store(report.failed == 0, Ordering::Relaxed);
            state
                .blocklist_failed
                .store(report.failed, Ordering::Relaxed);
            state.last_sync_at.store(now_seconds(), Ordering::Relaxed);
            info!(
                changed = report.changed,
                failed = report.failed,
                "initial blocklist sync complete"
            );
        }
        Err(err) => {
            state.blocklist_ok.store(false, Ordering::Relaxed);
            *state.blocklist_error.lock().expect("blocklist error") = Some(err.clone());
            warn!(%err, "initial blocklist sync failed; serving explicit rules only");
        }
    }
    if cfg.hosted {
        let tokenless = state.store.read().await.tokenless_profiles();
        if !tokenless.is_empty() {
            error!(
                ?tokenless,
                "hosted edge loaded tokenless profiles; requests will be rejected"
            );
        }
    }

    // Bind privileged ports before dropping privileges, like the Node edge.
    let udp = UdpSocket::bind((cfg.udp_bind.as_str(), cfg.dns_port))
        .await
        .map_err(|err| format!("udp {}:{} bind failed: {err}", cfg.udp_bind, cfg.dns_port))?;
    let tcp = TcpListener::bind(("0.0.0.0", cfg.dns_port))
        .await
        .map_err(|err| format!("tcp {} bind failed: {err}", cfg.dns_port))?;
    let dot_listener = if cfg.dot_enabled {
        match TcpListener::bind(("0.0.0.0", cfg.dot_port)).await {
            Ok(listener) => Some(listener),
            Err(err) => {
                warn!(%err, port = cfg.dot_port, "dot listener unavailable");
                None
            }
        }
    } else {
        None
    };
    let doh_listener = TcpListener::bind(("0.0.0.0", cfg.doh_port))
        .await
        .map_err(|err| format!("doh {} bind failed: {err}", cfg.doh_port))?;
    let metrics_listener = TcpListener::bind(("0.0.0.0", cfg.metrics_port))
        .await
        .map_err(|err| format!("metrics {} bind failed: {err}", cfg.metrics_port))?;

    if unsafe { libc::geteuid() } == 0 {
        if cfg.drop_privileges {
            drop_privileges(cfg.drop_gid, cfg.drop_uid)?;
            info!(uid = cfg.drop_uid, gid = cfg.drop_gid, "dropped privileges");
        } else {
            warn!("running as root with DROP_PRIVILEGES=0");
        }
    }

    state.ready.store(true, Ordering::Relaxed);
    info!(
        region = %cfg.region,
        dns_port = cfg.dns_port,
        doh_port = cfg.doh_port,
        "edge ready"
    );

    tokio::spawn(udp_loop(Arc::new(udp), state.clone()));
    tokio::spawn(tcp_loop(tcp, state.clone()));
    if let Some(listener) = dot_listener {
        tokio::spawn(dot_loop(listener, state.clone()));
    }

    let doh_app = Router::new()
        .route("/healthz", get(healthz))
        .route("/readyz", get(readyz))
        .route(
            "/v1/*rest",
            get(doh_handler).post(doh_handler).options(doh_handler),
        )
        .layer(DefaultBodyLimit::max(cfg.max_doh_body))
        .with_state(state.clone());
    tokio::spawn(async move {
        if let Err(err) = axum::serve(doh_listener, doh_app).await {
            error!(%err, "doh server stopped");
        }
    });

    let metrics_app = Router::new()
        .route("/metrics", get(metrics_handler))
        .with_state(state.clone());
    tokio::spawn(async move {
        if let Err(err) = axum::serve(metrics_listener, metrics_app).await {
            error!(%err, "metrics server stopped");
        }
    });

    tokio::spawn(poll_loop(
        db,
        state.clone(),
        versions.config,
        versions.blocklist,
    ));

    wait_for_shutdown().await;
    state.logger.shutdown().await;
    info!("shutting down");
    Ok(())
}

async fn initial_snapshot(db: &Db) -> Result<(crate::db::Versions, crate::db::Snapshot), String> {
    let mut attempt = 0u32;
    loop {
        match async {
            let versions = db.versions().await?;
            let snapshot = db.snapshot().await?;
            Ok::<_, sqlx::Error>((versions, snapshot))
        }
        .await
        {
            Ok(value) => return Ok(value),
            Err(err) => {
                attempt += 1;
                if attempt >= 10 {
                    return Err(format!("initial snapshot failed: {err}"));
                }
                let delay = Duration::from_secs(2u64.pow(attempt.min(5)));
                warn!(%err, attempt, ?delay, "initial snapshot failed; retrying");
                tokio::time::sleep(delay).await;
            }
        }
    }
}

async fn wait_for_shutdown() {
    #[cfg(unix)]
    {
        let mut term =
            match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
                Ok(signal) => signal,
                Err(_) => {
                    let _ = tokio::signal::ctrl_c().await;
                    return;
                }
            };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = term.recv() => {},
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

async fn poll_loop(db: Db, state: Arc<AppState>, mut last_config: i32, mut last_blocklist: i32) {
    let mut last_sync = Instant::now();
    let mut next_retry = Instant::now();
    let mut last_purge = Instant::now() - Duration::from_secs(60);
    loop {
        tokio::time::sleep(state.cfg.poll_interval).await;
        if last_purge.elapsed() >= Duration::from_secs(5) {
            last_purge = Instant::now();
            let since = state.purge_since.load(Ordering::Relaxed);
            if let Ok(purges) = db.pending_purges(since).await {
                if !purges.is_empty() {
                    let mut cache = state.cache.lock().expect("cache lock");
                    for (domain, record_type) in purges {
                        cache.purge(&domain, record_type.as_deref());
                    }
                }
                state.purge_since.store(now_seconds(), Ordering::Relaxed);
            }
        }
        let versions = match db.versions().await {
            Ok(versions) => {
                state
                    .last_config_poll_at
                    .store(now_seconds(), Ordering::Relaxed);
                state.config_poll_error.store(false, Ordering::Relaxed);
                versions
            }
            Err(err) => {
                state.config_poll_error.store(true, Ordering::Relaxed);
                warn!(%err, "config poll failed");
                continue;
            }
        };

        if versions.config != last_config {
            match db.snapshot().await {
                Ok(snapshot) => {
                    let mut guard = state.store.write().await;
                    guard.replace_config(
                        snapshot.profiles,
                        snapshot.rules,
                        snapshot.ips,
                        snapshot.zones,
                        snapshot.services,
                    );
                    if state.cfg.hosted {
                        let tokenless = guard.tokenless_profiles();
                        if !tokenless.is_empty() {
                            error!(
                                ?tokenless,
                                "hosted edge loaded tokenless profiles; requests will be rejected"
                            );
                        }
                    }
                    drop(guard);
                    last_config = versions.config;
                    info!(version = versions.config, "config snapshot loaded");
                }
                Err(err) => warn!(%err, "config snapshot failed"),
            }
        }

        let due =
            versions.blocklist != last_blocklist || last_sync.elapsed() >= state.cfg.list_interval;
        if due && Instant::now() >= next_retry {
            let _guard = state.sync_lock.lock().await;
            match lists::sync_once(&db, &state.store, &state.cache, &state.cfg).await {
                Ok(report) => {
                    last_blocklist = versions.blocklist;
                    last_sync = Instant::now();
                    state
                        .blocklist_ok
                        .store(report.failed == 0, Ordering::Relaxed);
                    state
                        .blocklist_failed
                        .store(report.failed, Ordering::Relaxed);
                    state.last_sync_at.store(now_seconds(), Ordering::Relaxed);
                    *state.blocklist_error.lock().expect("blocklist error") = None;
                    info!(
                        changed = report.changed,
                        failed = report.failed,
                        "blocklist sync complete"
                    );
                }
                Err(err) => {
                    state.blocklist_ok.store(false, Ordering::Relaxed);
                    *state.blocklist_error.lock().expect("blocklist error") = Some(err.clone());
                    next_retry = Instant::now() + Duration::from_secs(30);
                    warn!(%err, "blocklist sync failed; retrying");
                }
            }
        }
    }
}

async fn resolve_wire(
    state: &AppState,
    wire: &[u8],
    profile: &str,
    context: &QueryContext,
) -> Option<Vec<u8>> {
    let question = match dns::parse_query(wire) {
        Some(question) => question,
        None => {
            Metrics::inc(&state.metrics.drops);
            return None;
        }
    };
    Metrics::inc(&state.metrics.queries);

    if let Some(probe_domain) = &state.cfg.probe_domain {
        if let Some(nonce) = match_probe_nonce(&question.name, probe_domain) {
            let db = state.db.clone();
            let region = state.cfg.region.clone();
            let transport = context.transport.to_string();
            tokio::spawn(async move {
                let _ = db.record_probe(&nonce, &region, &transport).await;
            });
            return Some(dns::nxdomain_response(&question));
        }
    }

    let type_name = record_type_name(question.qtype);
    let (zone, nodata, custom, remote, block, selector, safe_search) = {
        let store = state.store.read().await;
        let meta = match store.profile_meta(profile) {
            Some(meta) => meta,
            None => return None,
        };
        let mut zone = None;
        if let Some(entry) = store.zone_lookup(profile, &question.name, type_name) {
            zone = Some((entry, type_name.to_string()));
        } else if question.qtype != RecordType::CNAME {
            if let Some(entry) = store.zone_lookup(profile, &question.name, "CNAME") {
                zone = Some((entry, "CNAME".to_string()));
            }
        }
        let nodata = zone.is_none() && store.has_zone_name(profile, &question.name);
        let custom = store.resolve_custom(profile, &question.name);
        let remote = if custom == Some(Action::Allow) {
            None
        } else {
            store.resolve_remote_detailed(profile, &question.name)
        };
        (
            zone,
            nodata,
            custom,
            remote,
            meta.block.clone(),
            meta.upstream_selector().map(str::to_string),
            meta.safe_search,
        )
    };

    if let Some((entry, record_type)) = zone {
        record(
            state,
            &question,
            profile,
            context,
            "override",
            Some("zone"),
            None,
            None,
            None,
        );
        return Some(dns::zone_response(&question, &entry, &record_type));
    }
    if nodata {
        record(
            state,
            &question,
            profile,
            context,
            "override",
            Some("zone"),
            None,
            None,
            None,
        );
        return Some(dns::empty_response(&question));
    }

    let (decision, reason, list_id) = match (custom, remote) {
        (Some(Action::Block), _) => (Some(Action::Block), Some("manual"), None),
        (Some(Action::Allow), _) => (Some(Action::Allow), Some("manual"), None),
        (None, Some((action, list_id))) => (Some(action), Some("blocklist"), list_id),
        _ => (None, None, None),
    };

    if decision == Some(Action::Block) {
        Metrics::inc(&state.metrics.blocked);
        record(
            state, &question, profile, context, "block", reason, list_id, None, None,
        );
        return Some(dns::sinkhole_response(&question, &block));
    }

    if safe_search.any() {
        if let Some(target) = dns::safe_search_target(&safe_search, &question.name) {
            record(
                state,
                &question,
                profile,
                context,
                "override",
                Some("safesearch"),
                None,
                None,
                None,
            );
            Metrics::inc(&state.metrics.forwarded);
            return Some(dns::cname_response(&question, target, 600));
        }
    }

    let mut prelogged = false;
    if decision == Some(Action::Allow) {
        record(
            state, &question, profile, context, "allow", reason, list_id, None, None,
        );
        prelogged = true;
    }

    let label = upstream_label(selector.as_deref());
    let url = state.upstream.url_for(selector.as_deref());
    let key = dns::cache_key(&question, &url);
    if let Some((bytes, age)) = state.cache.lock().expect("cache lock").get(&key) {
        Metrics::inc(&state.metrics.cache_hits);
        if !prelogged {
            record(
                state,
                &question,
                profile,
                context,
                "forward",
                None,
                None,
                Some(label.clone()),
                None,
            );
        }
        // Strip OPT, rewrite the question case, count TTLs down, patch id.
        return Some(dns::normalize_for_client(&bytes, &question, age).unwrap_or(bytes));
    }
    Metrics::inc(&state.metrics.cache_misses);

    // Single-flight: coalesce identical cache misses. The first request does
    // the upstream call; waiters re-check the cache and share the result.
    let gate = {
        let mut map = state.inflight.lock().expect("inflight");
        map.entry(key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    };
    let guard = gate.lock().await;
    if let Some((bytes, age)) = state.cache.lock().expect("cache lock").get(&key) {
        if !prelogged {
            record(
                state,
                &question,
                profile,
                context,
                "forward",
                None,
                None,
                Some(label.clone()),
                None,
            );
        }
        drop(guard);
        let mut map = state.inflight.lock().expect("inflight");
        if Arc::strong_count(&gate) <= 2 {
            map.remove(&key);
        }
        return Some(dns::normalize_for_client(&bytes, &question, age).unwrap_or(bytes));
    }

    let started = Instant::now();
    let result = match state.upstream.resolve(wire, selector.as_deref()).await {
        Ok(response) => {
            let rtt = started.elapsed().as_millis() as i64;
            // Normalize before returning and caching: no OPT/ECS replay.
            let normalized =
                dns::normalize_for_client(&response, &question, Duration::ZERO).unwrap_or(response);
            let ttl = dns::cache_ttl(&normalized);
            if !ttl.is_zero() {
                state
                    .cache
                    .lock()
                    .expect("cache lock")
                    .put(key.clone(), normalized.clone(), ttl);
            }
            Metrics::inc(&state.metrics.forwarded);
            if !prelogged {
                record(
                    state,
                    &question,
                    profile,
                    context,
                    "forward",
                    None,
                    None,
                    Some(label),
                    Some(rtt),
                );
            }
            Some(normalized)
        }
        Err(err) => {
            warn!(%err, "upstream failed");
            Metrics::inc(&state.metrics.servfail);
            if !prelogged {
                record(
                    state,
                    &question,
                    profile,
                    context,
                    "forward",
                    None,
                    None,
                    Some(label),
                    None,
                );
            }
            Some(dns::servfail_response(&question))
        }
    };
    drop(guard);
    {
        let mut map = state.inflight.lock().expect("inflight");
        if Arc::strong_count(&gate) <= 2 {
            map.remove(&key);
        }
    }
    result
}

#[allow(clippy::too_many_arguments)] // one call site per decision; a struct hides the shape
fn record(
    state: &AppState,
    question: &dns::Question,
    profile: &str,
    context: &QueryContext,
    action: &'static str,
    reason: Option<&'static str>,
    list_id: Option<String>,
    upstream: Option<String>,
    rtt_ms: Option<i64>,
) {
    if !context.log_enabled {
        return;
    }
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    state.logger.log(QueryEvent {
        at: now_ms / 1000,
        at_ms: now_ms,
        profile: profile.to_string(),
        domain: question.name.clone(),
        action,
        reason,
        list_id,
        transport: context.transport,
        upstream,
        client_ip: context.client_ip.clone(),
        device: context.device.clone(),
        rtt_ms,
    });
}

fn upstream_label(selector: Option<&str>) -> String {
    match selector {
        Some("cloudflare") => "cloudflare".into(),
        Some("google") => "google".into(),
        Some("quad9") => "quad9".into(),
        Some(url) if url.starts_with("http") => "custom".into(),
        _ => "edge-default".into(),
    }
}

fn match_probe_nonce(name: &str, probe_domain: &str) -> Option<String> {
    let lower = name.trim_end_matches('.').to_ascii_lowercase();
    let suffix = format!(".{}", probe_domain.to_ascii_lowercase());
    let nonce = lower.strip_suffix(&suffix)?;
    if nonce.is_empty()
        || nonce.contains('.')
        || !(16..=64).contains(&nonce.len())
        || !nonce.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return None;
    }
    Some(nonce.to_string())
}

fn record_type_name(record_type: RecordType) -> &'static str {
    match record_type {
        RecordType::A => "A",
        RecordType::AAAA => "AAAA",
        RecordType::CNAME => "CNAME",
        RecordType::TXT => "TXT",
        _ => "OTHER",
    }
}

const PROXY_V2_MAGIC: [u8; 12] = [
    0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
];
const TLV_AUTHORITY: u8 = 0x02;

struct ConnGuard {
    map: Arc<Mutex<HashMap<String, usize>>>,
    key: String,
}

impl Drop for ConnGuard {
    fn drop(&mut self) {
        let mut map = self.map.lock().expect("connection sources");
        if let Some(count) = map.get_mut(&self.key) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                map.remove(&self.key);
            }
        }
    }
}

fn acquire_conn(
    map: &Arc<Mutex<HashMap<String, usize>>>,
    key: String,
    cap: usize,
) -> Option<ConnGuard> {
    let mut sources = map.lock().expect("connection sources");
    let count = sources.entry(key.clone()).or_insert(0);
    if *count >= cap {
        return None;
    }
    *count += 1;
    Some(ConnGuard {
        map: map.clone(),
        key,
    })
}

/// `<label>.dot.resolvezero.com` -> `label`.
fn dot_label(hostname: &str, suffix: &str) -> Option<String> {
    let host = hostname.trim().to_ascii_lowercase();
    let host = host.trim_end_matches('.');
    let label = host.strip_suffix(suffix)?;
    if label.is_empty()
        || label.contains('.')
        || label.len() > 32
        || !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return None;
    }
    Some(label.to_string())
}

async fn read_proxy_v2_header(stream: &mut TcpStream) -> Option<(Option<String>, Option<String>)> {
    let mut fixed = [0u8; 16];
    stream.read_exact(&mut fixed).await.ok()?;
    if fixed[..12] != PROXY_V2_MAGIC {
        return None;
    }
    let payload_len = u16::from_be_bytes([fixed[14], fixed[15]]) as usize;
    if payload_len > 65_535 {
        return None;
    }
    let mut payload = vec![0u8; payload_len];
    stream.read_exact(&mut payload).await.ok()?;
    let family = fixed[13] >> 4;
    let command = fixed[12] & 0x0f;
    let mut offset = 0usize;
    let mut source = None;
    if command == 1 {
        match family {
            1 if payload.len() >= 12 => {
                source =
                    Some(Ipv4Addr::new(payload[0], payload[1], payload[2], payload[3]).to_string());
                offset = 12;
            }
            2 if payload.len() >= 36 => {
                let mut octets = [0u8; 16];
                octets.copy_from_slice(&payload[0..16]);
                source = Some(Ipv6Addr::from(octets).to_string());
                offset = 36;
            }
            _ => {}
        }
    }
    let mut authority = None;
    while offset + 3 <= payload.len() {
        let kind = payload[offset];
        let length = u16::from_be_bytes([payload[offset + 1], payload[offset + 2]]) as usize;
        offset += 3;
        if offset + length > payload.len() {
            break;
        }
        if kind == TLV_AUTHORITY {
            authority =
                Some(String::from_utf8_lossy(&payload[offset..offset + length]).to_lowercase());
        }
        offset += length;
    }
    Some((source, authority))
}

async fn dot_loop(listener: TcpListener, state: Arc<AppState>) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let permit = match state.tcp_gate.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => continue,
                };
                let state = state.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(err) = handle_dot(stream, peer, state).await {
                        warn!(%err, %peer, "dot connection ended");
                    }
                });
            }
            Err(err) => {
                warn!(%err, "dot accept failed");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
}

async fn handle_dot(
    mut stream: TcpStream,
    _peer: SocketAddr,
    state: Arc<AppState>,
) -> std::io::Result<()> {
    let parsed = tokio::time::timeout(Duration::from_secs(5), read_proxy_v2_header(&mut stream))
        .await
        .ok()
        .flatten();
    let Some((source, authority)) = parsed else {
        return Ok(());
    };
    let Some(authority) = authority else {
        return Ok(());
    };
    let Some(label) = dot_label(&authority, &state.cfg.dot_suffix) else {
        return Ok(());
    };
    let source_key = source.clone().unwrap_or_else(|| _peer.ip().to_string());
    let _source_guard = acquire_conn(
        &state.conn_sources,
        format!("dot:{source_key}"),
        state.cfg.dot_max_per_source,
    );
    if _source_guard.is_none() {
        return Ok(());
    }
    let Some(profile_id) = state.store.read().await.authorize_dot_id(&label).cloned() else {
        return Ok(());
    };
    let log_enabled = state.store.read().await.should_log(&profile_id);
    let context = QueryContext {
        client_ip: source,
        device: None,
        transport: "dot",
        log_enabled,
    };
    let deadline = Instant::now() + state.cfg.dot_lifetime;

    loop {
        if Instant::now() >= deadline {
            return Ok(());
        }
        let mut length = [0u8; 2];
        match tokio::time::timeout(state.cfg.dot_idle_timeout, stream.read_exact(&mut length)).await
        {
            Ok(Ok(_)) => {}
            _ => return Ok(()),
        }
        let length = u16::from_be_bytes(length) as usize;
        if length == 0 {
            return Ok(());
        }
        let mut wire = vec![0u8; length];
        match tokio::time::timeout(state.cfg.dot_idle_timeout, stream.read_exact(&mut wire)).await {
            Ok(Ok(_)) => {}
            _ => return Ok(()),
        }
        match resolve_wire(&state, &wire, &profile_id, &context).await {
            Some(bytes) if bytes.len() <= 65_535 => {
                let len = (bytes.len() as u16).to_be_bytes();
                stream.write_all(&len).await?;
                stream.write_all(&bytes).await?;
            }
            Some(_) => {
                Metrics::inc(&state.metrics.drops);
                return Ok(());
            }
            None => {
                Metrics::inc(&state.metrics.drops);
                return Ok(());
            }
        }
    }
}

async fn udp_loop(socket: Arc<UdpSocket>, state: Arc<AppState>) {
    let mut buffer = [0u8; 4096];
    loop {
        match socket.recv_from(&mut buffer).await {
            Ok((len, peer)) => {
                let source = peer.ip().to_string();
                if !state.udp_rate.allow(&source) {
                    if state.cfg.unknown_source == UnknownSource::Refused {
                        if let Some(question) = dns::parse_query(&buffer[..len]) {
                            let _ = socket
                                .send_to(&dns::refused_response(&question), peer)
                                .await;
                        }
                    }
                    Metrics::inc(&state.metrics.drops);
                    continue;
                }
                let permit = match state.udp_gate.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        Metrics::inc(&state.metrics.drops);
                        continue;
                    }
                };
                let wire = buffer[..len].to_vec();
                let socket = socket.clone();
                let state = state.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    let profile = state.store.read().await.authorize_ip(&source).cloned();
                    let profile = match profile {
                        Some(profile) => {
                            let tokenless = state.cfg.hosted
                                && state
                                    .store
                                    .read()
                                    .await
                                    .profile_meta(&profile)
                                    .is_some_and(|meta| meta.token.is_none());
                            if tokenless {
                                None
                            } else {
                                Some(profile)
                            }
                        }
                        None => None,
                    };
                    let response = match profile {
                        Some(profile) => {
                            let log_enabled = state.store.read().await.should_log(&profile);
                            let context = QueryContext {
                                client_ip: Some(source),
                                device: None,
                                transport: "udp",
                                log_enabled,
                            };
                            resolve_wire(&state, &wire, &profile, &context).await
                        }
                        None => {
                            if state.cfg.unknown_source == UnknownSource::Refused {
                                dns::parse_query(&wire).map(|q| dns::refused_response(&q))
                            } else {
                                None
                            }
                        }
                    };
                    match response {
                        Some(bytes) => {
                            // UDP clients advertise their buffer via EDNS; never
                            // send a datagram they cannot receive. Signal TC so
                            // they retry over TCP instead.
                            let max_payload = dns::parse_query(&wire)
                                .map(|q| {
                                    q.query
                                        .edns
                                        .as_ref()
                                        .map(|edns| edns.max_payload())
                                        .unwrap_or(512)
                                        .clamp(512, 4096)
                                })
                                .unwrap_or(512);
                            let out = if bytes.len() > max_payload as usize {
                                dns::parse_query(&wire)
                                    .map(|q| dns::truncated_response(&q))
                                    .unwrap_or(bytes)
                            } else {
                                bytes
                            };
                            if let Err(err) = socket.send_to(&out, peer).await {
                                warn!(%err, %peer, "udp send failed");
                            }
                        }
                        None => Metrics::inc(&state.metrics.drops),
                    }
                });
            }
            Err(err) => {
                warn!(%err, "udp recv failed");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
    }
}

async fn tcp_loop(listener: TcpListener, state: Arc<AppState>) {
    loop {
        match listener.accept().await {
            Ok((stream, peer)) => {
                let permit = match state.tcp_gate.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        Metrics::inc(&state.metrics.drops);
                        continue;
                    }
                };
                let state = state.clone();
                tokio::spawn(async move {
                    let _permit = permit;
                    if let Err(err) = handle_tcp(stream, peer, state).await {
                        warn!(%err, %peer, "tcp connection ended");
                    }
                });
            }
            Err(err) => {
                warn!(%err, "tcp accept failed");
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
    }
}

async fn handle_tcp(
    mut stream: TcpStream,
    peer: SocketAddr,
    state: Arc<AppState>,
) -> std::io::Result<()> {
    let source =
        match tokio::time::timeout(Duration::from_secs(5), read_proxy_source(&mut stream)).await {
            Ok(Some(source)) => source,
            _ => peer.ip().to_string(),
        };

    let _source_guard = acquire_conn(
        &state.conn_sources,
        format!("tcp:{source}"),
        state.cfg.tcp_max_per_source,
    );
    if _source_guard.is_none() {
        return Ok(());
    }
    let profile = state.store.read().await.authorize_ip(&source).cloned();
    let profile = match profile {
        Some(profile) => {
            let tokenless = state.cfg.hosted
                && state
                    .store
                    .read()
                    .await
                    .profile_meta(&profile)
                    .is_some_and(|meta| meta.token.is_none());
            if tokenless {
                None
            } else {
                Some(profile)
            }
        }
        None => None,
    };
    let log_enabled = match &profile {
        Some(profile) => state.store.read().await.should_log(profile),
        None => false,
    };
    let context = QueryContext {
        client_ip: Some(source.clone()),
        device: None,
        transport: "tcp",
        log_enabled,
    };
    let deadline = Instant::now() + state.cfg.tcp_lifetime;

    loop {
        if Instant::now() >= deadline {
            return Ok(());
        }
        let mut length = [0u8; 2];
        match tokio::time::timeout(state.cfg.tcp_idle_timeout, stream.read_exact(&mut length)).await
        {
            Ok(Ok(_)) => {}
            _ => return Ok(()),
        }
        let length = u16::from_be_bytes(length) as usize;
        if length == 0 {
            return Ok(());
        }
        let mut wire = vec![0u8; length];
        match tokio::time::timeout(state.cfg.tcp_idle_timeout, stream.read_exact(&mut wire)).await {
            Ok(Ok(_)) => {}
            _ => return Ok(()),
        }

        let response = match &profile {
            Some(profile) => resolve_wire(&state, &wire, profile, &context).await,
            None => {
                if state.cfg.unknown_source == UnknownSource::Refused {
                    dns::parse_query(&wire).map(|q| dns::refused_response(&q))
                } else {
                    None
                }
            }
        };
        match response {
            Some(bytes) => {
                if bytes.len() > 65_535 {
                    Metrics::inc(&state.metrics.drops);
                    if let Some(question) = dns::parse_query(&wire) {
                        let fallback = dns::servfail_response(&question);
                        let len = (fallback.len() as u16).to_be_bytes();
                        stream.write_all(&len).await?;
                        stream.write_all(&fallback).await?;
                    }
                    continue;
                }
                let len = (bytes.len() as u16).to_be_bytes();
                stream.write_all(&len).await?;
                stream.write_all(&bytes).await?;
            }
            None => {
                Metrics::inc(&state.metrics.drops);
                return Ok(());
            }
        }
    }
}

/// Fly's TCP ingress prepends PROXY v1 (port 53) or v2 (DoT). Return the real
/// client IP; leave the stream untouched when no header is present.
async fn read_proxy_source(stream: &mut TcpStream) -> Option<String> {
    let mut head = [0u8; 12];
    let peeked = stream.peek(&mut head).await.ok()?;
    if peeked >= 6 && &head[..6] == b"PROXY " {
        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            stream.read_exact(&mut byte).await.ok()?;
            line.push(byte[0]);
            if byte[0] == b'\n' || line.len() > 108 {
                break;
            }
        }
        let text = String::from_utf8_lossy(&line);
        let parts: Vec<&str> = text.split_whitespace().collect();
        if parts.len() >= 3 && (parts[1] == "TCP4" || parts[1] == "TCP6") {
            return Some(parts[2].to_string());
        }
        return None;
    }
    if peeked >= 12 && &head[..12] == b"\r\n\r\n\0\r\nQUIT\n" {
        let mut fixed = [0u8; 16];
        stream.read_exact(&mut fixed).await.ok()?;
        let len = u16::from_be_bytes([fixed[14], fixed[15]]) as usize;
        let mut payload = vec![0u8; len];
        stream.read_exact(&mut payload).await.ok()?;
        let family = fixed[13] >> 4;
        match family {
            1 if payload.len() >= 12 => {
                return Some(
                    Ipv4Addr::new(payload[0], payload[1], payload[2], payload[3]).to_string(),
                );
            }
            2 if payload.len() >= 36 => {
                let mut octets = [0u8; 16];
                octets.copy_from_slice(&payload[0..16]);
                return Some(Ipv6Addr::from(octets).to_string());
            }
            _ => {}
        }
    }
    None
}

async fn doh_handler(
    State(state): State<Arc<AppState>>,
    Path(rest): Path<String>,
    method: Method,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    let client_ip = headers
        .get("fly-client-ip")
        .and_then(|value| value.to_str().ok())
        .map(str::to_string)
        .or_else(|| {
            headers
                .get("x-forwarded-for")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.split(',').next())
                .map(|value| value.trim().to_string())
        });
    let client_key = client_ip.clone().unwrap_or_else(|| "unknown".into());
    if !state.doh_rate.allow(&client_key) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let _permit = match state.doh_gate.try_acquire() {
        Ok(permit) => permit,
        Err(_) => return StatusCode::TOO_MANY_REQUESTS.into_response(),
    };

    let parts: Vec<&str> = rest.split('/').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() || parts.len() > 3 {
        return StatusCode::NOT_FOUND.into_response();
    }
    match (
        method.as_str(),
        parts.get(1).copied(),
        parts.get(2).copied(),
    ) {
        ("GET", Some("logs"), None) if parts.len() == 2 => {
            return handle_logs(state.clone(), parts[0].to_string(), headers, uri).await;
        }
        ("GET", Some("whoami"), None) if parts.len() == 2 => {
            return handle_whoami(state.clone(), parts[0].to_string(), headers, uri).await;
        }
        ("POST", Some("update-ip"), None) if parts.len() == 2 => {
            return handle_update_ip(state.clone(), parts[0].to_string(), headers, uri).await;
        }
        ("POST", Some("cache"), Some("purge")) if parts.len() == 3 => {
            return handle_purge(state.clone(), parts[0].to_string(), headers, uri, body).await;
        }
        ("OPTIONS", Some("whoami" | "update-ip"), _) => {
            return cors_preflight(headers).await;
        }
        _ => {}
    }
    let profile_id = parts[0];

    let (device, token) = match (parts.get(1), parts.get(2)) {
        (Some(seg), Some(token)) => {
            if !valid_device(seg) {
                return StatusCode::NOT_FOUND.into_response();
            }
            (Some(*seg), Some(*token))
        }
        (Some(seg), None) => {
            let has_token = state
                .store
                .read()
                .await
                .profile_meta(profile_id)
                .is_some_and(|meta| meta.has_token());
            if has_token {
                (None, Some(*seg))
            } else if valid_device(seg) {
                (Some(*seg), None)
            } else {
                return StatusCode::NOT_FOUND.into_response();
            }
        }
        (None, _) => (None, None),
    };
    if !state.store.read().await.has_profile(profile_id, token) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if state.cfg.hosted {
        let tokenless = state
            .store
            .read()
            .await
            .profile_meta(profile_id)
            .is_some_and(|meta| meta.token.is_none());
        if tokenless {
            return StatusCode::NOT_FOUND.into_response();
        }
    }

    let wire = if method == Method::GET {
        let Some(query) = uri.query() else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        let value = query.split('&').find_map(|pair| pair.strip_prefix("dns="));
        let Some(value) = value else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        match base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value) {
            Ok(wire) if wire.len() <= state.cfg.max_doh_get => wire,
            _ => return StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        }
    } else if method == Method::POST {
        if let Some(content_type) = headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
        {
            if !content_type.starts_with("application/dns-message") {
                return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
            }
        }
        if body.len() > state.cfg.max_doh_body {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
        body.to_vec()
    } else {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    };

    if wire.len() < 12 {
        return StatusCode::BAD_REQUEST.into_response();
    }

    let log_enabled = state.store.read().await.should_log(profile_id);
    let context = QueryContext {
        client_ip,
        device: device.map(str::to_string),
        transport: "doh",
        log_enabled,
    };

    if let Some(device) = &context.device {
        let key = (profile_id.to_string(), device.clone());
        let is_new = {
            let mut seen = state.seen_devices.lock().expect("device seen");
            seen.insert(key)
        };
        if is_new {
            let db = state.db.clone();
            let profile = profile_id.to_string();
            let device = device.clone();
            tokio::spawn(async move {
                let _ = db.touch_device(&profile, &device).await;
            });
        }
    }

    match tokio::time::timeout(
        state.cfg.doh_timeout,
        resolve_wire(&state, &wire, profile_id, &context),
    )
    .await
    {
        Ok(Some(response)) => (
            [
                (header::CONTENT_TYPE, "application/dns-message"),
                (header::CACHE_CONTROL, "no-store"),
            ],
            response,
        )
            .into_response(),
        Ok(None) => StatusCode::BAD_REQUEST.into_response(),
        Err(_) => StatusCode::GATEWAY_TIMEOUT.into_response(),
    }
}

fn token_from(headers: &HeaderMap, uri: &Uri) -> Option<String> {
    if let Some(token) = query_param(uri, "token") {
        return Some(token);
    }
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn query_param(uri: &Uri, key: &str) -> Option<String> {
    uri.query()?.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        if name == key {
            Some(value.to_string())
        } else {
            None
        }
    })
}

fn caller_ip(headers: &HeaderMap) -> Option<String> {
    if let Some(value) = headers
        .get("fly-client-ip")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        return Some(value.to_string());
    }
    if std::env::var("ALLOW_UNTRUSTED_IP_HEADERS").as_deref() == Ok("1") {
        return headers
            .get("x-forwarded-for")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(',').next())
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty());
    }
    None
}

async fn authorized(state: &AppState, profile: &str, token: Option<String>) -> bool {
    let store = state.store.read().await;
    if !store.has_profile(profile, token.as_deref()) {
        return false;
    }
    !(state.cfg.hosted
        && store
            .profile_meta(profile)
            .is_some_and(|meta| meta.token.is_none()))
}

fn console_origin(headers: &HeaderMap) -> Option<String> {
    let origin = headers.get(header::ORIGIN)?.to_str().ok()?;
    let allowed = std::env::var("CONSOLE_ORIGINS").unwrap_or_else(|_| {
        "https://my.resolvezero.com,http://localhost:3000,http://localhost:3100".into()
    });
    allowed
        .split(',')
        .map(str::trim)
        .any(|candidate| candidate == origin)
        .then(|| origin.to_string())
}

fn with_cors(mut response: Response, headers: &HeaderMap) -> Response {
    if let Some(origin) = console_origin(headers) {
        if let Ok(value) = origin.parse() {
            response
                .headers_mut()
                .insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, value);
        }
        response
            .headers_mut()
            .insert(header::VARY, "Origin".parse().expect("static header"));
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            "GET,POST,OPTIONS".parse().expect("static header"),
        );
        response.headers_mut().insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "authorization,content-type".parse().expect("static header"),
        );
    }
    response
}

async fn cors_preflight(headers: HeaderMap) -> Response {
    with_cors(StatusCode::NO_CONTENT.into_response(), &headers)
}

async fn handle_whoami(
    state: Arc<AppState>,
    profile: String,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !authorized(&state, &profile, token_from(&headers, &uri)).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(ip) = caller_ip(&headers) else {
        return with_cors(
            (StatusCode::BAD_REQUEST, "caller IP unavailable").into_response(),
            &headers,
        );
    };
    if ip.parse::<IpAddr>().is_err() {
        return with_cors(
            (StatusCode::BAD_REQUEST, "invalid caller IP").into_response(),
            &headers,
        );
    }
    let key = format!("{ip}:{profile}");
    if !state.admin_rate.allow(&key) {
        return with_cors(StatusCode::TOO_MANY_REQUESTS.into_response(), &headers);
    }
    let linked = state.store.read().await.authorize_ip(&ip) == Some(&profile);
    with_cors(
        axum::Json(serde_json::json!({
            "ip": ip,
            "profileId": profile,
            "linked": linked,
        }))
        .into_response(),
        &headers,
    )
}

async fn handle_update_ip(
    state: Arc<AppState>,
    profile: String,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !authorized(&state, &profile, token_from(&headers, &uri)).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    let explicit = query_param(&uri, "ip");
    if explicit.is_some() && std::env::var("ALLOW_EXPLICIT_IP_LINK").as_deref() != Ok("1") {
        return with_cors(
            (
                StatusCode::BAD_REQUEST,
                axum::Json(serde_json::json!({ "error": "explicit IP linking is disabled" })),
            )
                .into_response(),
            &headers,
        );
    }
    let Some(raw) = explicit.or_else(|| caller_ip(&headers)) else {
        return with_cors(
            (StatusCode::BAD_REQUEST, "caller IP unavailable").into_response(),
            &headers,
        );
    };
    let Ok(ip) = raw.trim_matches(['[', ']']).parse::<IpAddr>() else {
        return with_cors(
            (StatusCode::BAD_REQUEST, "invalid IP").into_response(),
            &headers,
        );
    };
    let key = format!("{ip}:{profile}");
    if !state.admin_rate.allow(&key) {
        return with_cors(StatusCode::TOO_MANY_REQUESTS.into_response(), &headers);
    }
    match state.db.link_source_ip(&profile, &ip.to_string()).await {
        Ok(true) => with_cors(
            axum::Json(
                serde_json::json!({ "ok": true, "ip": ip.to_string(), "profileId": profile }),
            )
            .into_response(),
            &headers,
        ),
        Ok(false) => with_cors(
            (
                StatusCode::CONFLICT,
                axum::Json(serde_json::json!({ "error": "IP is linked to another profile" })),
            )
                .into_response(),
            &headers,
        ),
        Err(_) => with_cors(StatusCode::INTERNAL_SERVER_ERROR.into_response(), &headers),
    }
}

fn valid_purge_domain(value: &str) -> Option<String> {
    let domain = value
        .trim()
        .to_ascii_lowercase()
        .trim_end_matches('.')
        .to_string();
    if domain.is_empty() || domain.len() > 253 || domain.contains("..") {
        return None;
    }
    let ok = domain.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    });
    ok.then_some(domain)
}

fn valid_purge_type(value: &str) -> Option<String> {
    const TYPES: [&str; 11] = [
        "A", "AAAA", "CNAME", "TXT", "MX", "NS", "SOA", "SRV", "CAA", "HTTPS", "SVCB",
    ];
    let value = value.trim().to_ascii_uppercase();
    if value.is_empty() {
        return None;
    }
    TYPES.contains(&value.as_str()).then_some(value)
}

async fn handle_purge(
    state: Arc<AppState>,
    profile: String,
    headers: HeaderMap,
    uri: Uri,
    body: Bytes,
) -> Response {
    if !authorized(&state, &profile, token_from(&headers, &uri)).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    let caller = caller_ip(&headers).unwrap_or_else(|| "unknown".into());
    if !state.purge_rate.allow(&format!("{caller}:{profile}")) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let mut name = query_param(&uri, "name").unwrap_or_default();
    let mut record_type = query_param(&uri, "type").unwrap_or_default();
    if name.is_empty() && !body.is_empty() {
        if body.len() > 4096 {
            return StatusCode::PAYLOAD_TOO_LARGE.into_response();
        }
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&body) else {
            return StatusCode::BAD_REQUEST.into_response();
        };
        name = value
            .get("name")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
        record_type = value
            .get("type")
            .and_then(|value| value.as_str())
            .unwrap_or("")
            .to_string();
    }
    let Some(domain) = valid_purge_domain(&name) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let record_type = valid_purge_type(&record_type);
    match state
        .db
        .insert_purge(&profile, &domain, record_type.as_deref())
        .await
    {
        Ok(()) => axum::Json(serde_json::json!({
            "ok": true,
            "domain": domain,
            "type": record_type,
        }))
        .into_response(),
        Err(_) => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
    }
}

async fn handle_logs(
    state: Arc<AppState>,
    profile: String,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if !authorized(&state, &profile, token_from(&headers, &uri)).await {
        return StatusCode::NOT_FOUND.into_response();
    }
    let caller = caller_ip(&headers).unwrap_or_else(|| "unknown".into());
    if !state.admin_rate.allow(&format!("logs:{caller}:{profile}")) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let Some(s3) = S3Config::from_env() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({ "error": "raw log archive not configured" })),
        )
            .into_response();
    };
    let prefix = std::env::var("S3_LOG_PREFIX").unwrap_or_else(|_| "logs".into());
    let date = query_param(&uri, "date")
        .filter(|value| value.len() == 10 && value.chars().all(|c| c.is_ascii_digit() || c == '-'));
    let mut object_prefix = format!("{prefix}/{profile}/");
    if let Some(date) = &date {
        object_prefix.push_str(date);
        object_prefix.push('/');
    }

    let mut keys = Vec::new();
    let mut token: Option<String> = None;
    for _ in 0..50 {
        match s3.list(&object_prefix, token.as_deref()).await {
            Ok((page, next)) => {
                keys.extend(page);
                token = next;
                if token.is_none() {
                    break;
                }
            }
            Err(_) => return StatusCode::BAD_GATEWAY.into_response(),
        }
    }
    keys.sort();
    const MAX_OBJECTS: usize = 200;
    let capped = keys.len() > MAX_OBJECTS;
    if capped {
        keys = keys.split_off(keys.len() - MAX_OBJECTS);
    }
    let newest_first = query_param(&uri, "order").as_deref() == Some("desc");
    if newest_first {
        keys.reverse();
    }
    let limit = query_param(&uri, "limit")
        .and_then(|value| value.parse::<usize>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(100)
        .min(10_000);

    let mut out = String::new();
    if capped {
        out.push_str("{\"warning\":\"truncated at 200 objects\"}\n");
    }
    let mut emitted = 0usize;
    for key in keys {
        if emitted >= limit {
            break;
        }
        let Ok(bytes) = s3.get_key(&key).await else {
            continue;
        };
        if bytes.len() > 8 * 1024 * 1024 {
            continue;
        }
        let mut decoder = GzDecoder::new(bytes.as_slice());
        let mut text = String::new();
        if decoder.read_to_string(&mut text).is_err() {
            continue;
        }
        let mut lines: Vec<&str> = text.lines().filter(|line| !line.is_empty()).collect();
        if newest_first {
            lines.reverse();
        }
        for line in lines {
            out.push_str(line);
            out.push('\n');
            emitted += 1;
            if emitted >= limit {
                break;
            }
        }
    }

    let disposition = format!(
        "attachment; filename=\"rz-logs-{profile}{}.jsonl\"",
        date.map(|date| format!("-{date}")).unwrap_or_default()
    );
    (
        [
            (header::CONTENT_TYPE, "application/x-ndjson"),
            (header::CONTENT_DISPOSITION, disposition.as_str()),
        ],
        out,
    )
        .into_response()
}

fn valid_device(value: &str) -> bool {
    (1..=32).contains(&value.len())
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

async fn healthz() -> StatusCode {
    StatusCode::NO_CONTENT
}

async fn readyz(State(state): State<Arc<AppState>>) -> Response {
    let store = state.store.read().await;
    let ready = state.ready.load(Ordering::Relaxed);
    let blocklist_ok = state.blocklist_ok.load(Ordering::Relaxed);
    let failed = state.blocklist_failed.load(Ordering::Relaxed);
    let error = state
        .blocklist_error
        .lock()
        .expect("blocklist error")
        .clone();
    let last_sync = state.last_sync_at.load(Ordering::Relaxed);
    let last_sync_age = if last_sync == 0 {
        None
    } else {
        Some((now_seconds() - last_sync).max(0) * 1000)
    };
    let last_poll = state.last_config_poll_at.load(Ordering::Relaxed);
    let config_poll_age = if last_poll == 0 {
        None
    } else {
        Some((now_seconds() - last_poll).max(0) * 1000)
    };
    // Stay healthy for DoH as long as the catalog loaded at least once.
    // Partial/failed refreshes are exposed via `blocklistOk`/`failedBlocklists`
    // and the sentinel, but must not take the whole app out of HTTP routing.
    let ok = ready && (blocklist_ok || !store.catalog.is_empty());
    let body = serde_json::json!({
        "ok": ok,
        "region": state.cfg.region,
        "rulesLoaded": true,
        "blocklistsLoaded": blocklist_ok,
        "dns53Bound": true,
        "blocklistOk": blocklist_ok,
        "blocklistError": error.is_some(),
        "failedBlocklists": failed,
        "blocklistLastSyncAgeMs": last_sync_age,
        "configPollAgeMs": config_poll_age,
        "configPollError": state.config_poll_error.load(Ordering::Relaxed),
        "remoteLists": store.remote_rules(),
        "remoteListTables": store.catalog.len(),
        "artifactLists": store.artifact_lists,
        "rawLists": store.raw_lists,
        "profiles": store.profiles.len(),
        "rssMb": crate::metrics::rss_bytes() / 1024 / 1024,
        "memoryLimitMb": memory_limit_mb(),
    });
    let status = if ok {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };
    (status, axum::Json(body)).into_response()
}

fn memory_limit_mb() -> u64 {
    std::env::var("FLY_VM_MEMORY_MB")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(1024)
}

async fn metrics_handler(State(state): State<Arc<AppState>>) -> Response {
    let store = state.store.read().await;
    let cache = state.cache.lock().expect("cache lock");
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        state.metrics.render(
            &store,
            &cache,
            state.blocklist_failed.load(Ordering::Relaxed),
        ),
    )
        .into_response()
}

fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64
}

/// Drop root after binding privileged ports. Every step is checked: a silent
/// failure would leave the data plane running as root.
fn drop_privileges(gid: u32, uid: u32) -> Result<(), String> {
    unsafe {
        if libc::setgroups(0, std::ptr::null()) != 0 {
            return Err(format!(
                "setgroups failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        if libc::setgid(gid) != 0 {
            return Err(format!(
                "setgid({gid}) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        if libc::setuid(uid) != 0 {
            return Err(format!(
                "setuid({uid}) failed: {}",
                std::io::Error::last_os_error()
            ));
        }
        #[cfg(target_os = "linux")]
        {
            if libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                return Err(format!(
                    "PR_SET_NO_NEW_PRIVS failed: {}",
                    std::io::Error::last_os_error()
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{dot_label, match_probe_nonce};

    #[test]
    fn matches_probe_nonces() {
        assert_eq!(
            match_probe_nonce(
                "abc123def456abc123.probe.resolvezero.com",
                "probe.resolvezero.com"
            ),
            Some("abc123def456abc123".into())
        );
        assert_eq!(
            match_probe_nonce("a.b.probe.resolvezero.com", "probe.resolvezero.com"),
            None
        );
        assert_eq!(
            match_probe_nonce("short.probe.resolvezero.com", "probe.resolvezero.com"),
            None
        );
    }

    #[test]
    fn maps_dot_hostnames() {
        assert_eq!(
            dot_label("abc123.dot.resolvezero.com.", ".dot.resolvezero.com"),
            Some("abc123".into())
        );
        assert_eq!(dot_label("abc.dot.other.com", ".dot.resolvezero.com"), None);
        assert_eq!(
            dot_label("a.b.dot.resolvezero.com", ".dot.resolvezero.com"),
            None
        );
    }
}

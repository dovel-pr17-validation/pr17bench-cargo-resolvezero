use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use crate::cache::DnsCache;
use crate::store::RuleStore;

#[derive(Debug)]
pub struct Metrics {
    pub queries: AtomicU64,
    pub blocked: AtomicU64,
    pub forwarded: AtomicU64,
    pub cache_hits: AtomicU64,
    pub cache_misses: AtomicU64,
    pub drops: AtomicU64,
    pub servfail: AtomicU64,
    pub log_dropped: AtomicU64,
    pub rollup_errors: AtomicU64,
    started: Instant,
}

impl Default for Metrics {
    fn default() -> Self {
        Self {
            queries: AtomicU64::new(0),
            blocked: AtomicU64::new(0),
            forwarded: AtomicU64::new(0),
            cache_hits: AtomicU64::new(0),
            cache_misses: AtomicU64::new(0),
            drops: AtomicU64::new(0),
            servfail: AtomicU64::new(0),
            log_dropped: AtomicU64::new(0),
            rollup_errors: AtomicU64::new(0),
            started: Instant::now(),
        }
    }
}

impl Metrics {
    pub fn inc(counter: &AtomicU64) {
        counter.fetch_add(1, Ordering::Relaxed);
    }

    /// Prometheus text. Shaped like the Node edge's metrics so existing
    /// dashboards can be pointed at a Rust machine.
    pub fn render(&self, store: &RuleStore, cache: &DnsCache, blocklist_failed: usize) -> String {
        let mut out = String::with_capacity(1024);
        out.push_str("# HELP rz_queries_total DNS queries handled\n");
        out.push_str("# TYPE rz_queries_total counter\n");
        out.push_str(&format!(
            "rz_queries_total {}\n",
            self.queries.load(Ordering::Relaxed)
        ));
        out.push_str("# TYPE rz_blocked_total counter\n");
        out.push_str(&format!(
            "rz_blocked_total {}\n",
            self.blocked.load(Ordering::Relaxed)
        ));
        out.push_str("# TYPE rz_forwarded_total counter\n");
        out.push_str(&format!(
            "rz_forwarded_total {}\n",
            self.forwarded.load(Ordering::Relaxed)
        ));
        out.push_str("# TYPE rz_cache_hits_total counter\n");
        out.push_str(&format!(
            "rz_cache_hits_total {}\n",
            self.cache_hits.load(Ordering::Relaxed)
        ));
        out.push_str("# TYPE rz_cache_misses_total counter\n");
        out.push_str(&format!(
            "rz_cache_misses_total {}\n",
            self.cache_misses.load(Ordering::Relaxed)
        ));
        out.push_str("# TYPE rz_dropped_total counter\n");
        out.push_str(&format!(
            "rz_dropped_total {}\n",
            self.drops.load(Ordering::Relaxed)
        ));
        out.push_str("# TYPE rz_log_dropped_total counter\n");
        out.push_str(&format!(
            "rz_log_dropped_total {}\n",
            self.log_dropped.load(Ordering::Relaxed)
        ));
        out.push_str("# TYPE rz_rollup_errors_total counter\n");
        out.push_str(&format!(
            "rz_rollup_errors_total {}\n",
            self.rollup_errors.load(Ordering::Relaxed)
        ));
        out.push_str("# TYPE rz_servfail_total counter\n");
        out.push_str(&format!(
            "rz_servfail_total {}\n",
            self.servfail.load(Ordering::Relaxed)
        ));
        out.push_str("# TYPE rz_remote_list_tables gauge\n");
        out.push_str(&format!("rz_remote_list_tables {}\n", store.catalog.len()));
        out.push_str("# TYPE rz_remote_list_rules gauge\n");
        out.push_str(&format!("rz_remote_list_rules {}\n", store.remote_rules()));
        out.push_str("# TYPE rz_artifact_lists gauge\n");
        out.push_str(&format!("rz_artifact_lists {}\n", store.artifact_lists));
        out.push_str("# TYPE rz_raw_lists gauge\n");
        out.push_str(&format!("rz_raw_lists {}\n", store.raw_lists));
        out.push_str("# TYPE rz_blocklist_failed gauge\n");
        out.push_str(&format!("rz_blocklist_failed {}\n", blocklist_failed));
        out.push_str("# TYPE rz_dns_cache_entries gauge\n");
        out.push_str(&format!("rz_dns_cache_entries {}\n", cache.len()));
        out.push_str("# TYPE rz_uptime_seconds gauge\n");
        out.push_str(&format!(
            "rz_uptime_seconds {}\n",
            self.started.elapsed().as_secs()
        ));
        out.push_str("# TYPE process_resident_memory_bytes gauge\n");
        out.push_str(&format!("process_resident_memory_bytes {}\n", rss_bytes()));
        out
    }
}

pub fn rss_bytes() -> u64 {
    // Linux prod path uses the current RSS; macOS has no /proc, so fall back to
    // getrusage (peak RSS on that platform) for local development.
    #[cfg(target_os = "linux")]
    {
        if let Ok(statm) = std::fs::read_to_string("/proc/self/statm") {
            if let Some(pages) = statm.split_whitespace().nth(1) {
                if let Ok(pages) = pages.parse::<u64>() {
                    return pages * 4096;
                }
            }
        }
    }
    #[cfg(unix)]
    unsafe {
        let mut usage: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut usage) == 0 {
            #[cfg(target_os = "macos")]
            {
                return usage.ru_maxrss as u64;
            }
            #[cfg(not(target_os = "macos"))]
            {
                return usage.ru_maxrss as u64 * 1024;
            }
        }
    }
    0
}

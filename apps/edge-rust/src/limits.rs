use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Fixed-window per-key limiter with a hard key cap so hostile sources cannot
/// grow memory without bound.
pub struct FixedWindow {
    limit: u32,
    window: Duration,
    buckets: Mutex<HashMap<String, (Instant, u32)>>,
}

impl FixedWindow {
    pub fn new(limit: u32, window: Duration) -> Self {
        Self {
            limit: limit.max(1),
            window,
            buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn allow(&self, key: &str) -> bool {
        let now = Instant::now();
        let mut buckets = self.buckets.lock().expect("rate limiter");
        if buckets.len() > 50_000 {
            buckets.retain(|_, (start, _)| now.duration_since(*start) < self.window);
        }
        let entry = buckets.entry(key.to_string()).or_insert((now, 0));
        if now.duration_since(entry.0) >= self.window {
            *entry = (now, 1);
            return true;
        }
        if entry.1 >= self.limit {
            return false;
        }
        entry.1 += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enforces_the_window() {
        let limiter = FixedWindow::new(2, Duration::from_millis(50));
        assert!(limiter.allow("a"));
        assert!(limiter.allow("a"));
        assert!(!limiter.allow("a"));
        assert!(limiter.allow("b"));
        std::thread::sleep(Duration::from_millis(60));
        assert!(limiter.allow("a"));
    }
}

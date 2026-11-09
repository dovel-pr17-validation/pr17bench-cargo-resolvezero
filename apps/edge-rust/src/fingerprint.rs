use std::collections::HashSet;
use xxhash_rust::xxh64::xxh64;

/// Same hash function and seed as `apps/edge/src/fingerprint.ts` (xxhash-wasm
/// h64, seed 0). An artifact compiled by either runtime is valid for both.
pub fn hash_domain(domain: &str) -> u64 {
    xxh64(domain.as_bytes(), 0)
}

pub fn canonical(domain: &str) -> String {
    domain.trim_end_matches('.').to_ascii_lowercase()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Block,
    Allow,
}

/// Sorted xxhash64 fingerprints for one list. Rules are stored exactly as
/// written; suffix matching happens on the query side, which preserves ABP
/// subtree semantics without expanding parent labels.
#[derive(Clone, Debug, Default)]
pub struct FingerprintTable {
    allow: Vec<u64>,
    block: Vec<u64>,
    /// Cheap identity for change detection (XOR fold of both arrays).
    pub fingerprint: u64,
    pub entries: usize,
}

impl FingerprintTable {
    pub fn build(blocks: &HashSet<String>, allows: &HashSet<String>) -> Self {
        let allow: Vec<u64> = allows
            .iter()
            .map(|d| canonical(d))
            .filter(|d| d.contains('.') && !d.starts_with('.') && !d.starts_with('*'))
            .map(|d| hash_domain(&d))
            .collect();
        let block: Vec<u64> = blocks
            .iter()
            .map(|d| canonical(d))
            .filter(|d| d.contains('.') && !d.starts_with('.') && !d.starts_with('*'))
            .map(|d| hash_domain(&d))
            .collect();
        Self::from_sorted(allow, block)
    }

    pub fn from_sorted(mut allow: Vec<u64>, mut block: Vec<u64>) -> Self {
        allow.sort_unstable();
        allow.dedup();
        block.sort_unstable();
        block.dedup();
        let entries = allow.len() + block.len();
        let fingerprint = allow
            .iter()
            .chain(block.iter())
            .fold(0u64, |acc, value| acc ^ value.rotate_left(17));
        Self {
            allow,
            block,
            fingerprint,
            entries,
        }
    }

    /// Consume the table and return the raw sorted arrays (artifact compiler).
    pub fn into_parts(self) -> (Vec<u64>, Vec<u64>) {
        (self.allow, self.block)
    }

    pub fn is_empty(&self) -> bool {
        self.allow.is_empty() && self.block.is_empty()
    }

    pub fn allow_len(&self) -> usize {
        self.allow.len()
    }

    pub fn block_len(&self) -> usize {
        self.block.len()
    }

    /// ABP `@@` semantics: allow wins across every subscribed list.
    pub fn resolve(&self, domain: &str) -> Option<Action> {
        if self.check_allow(domain) {
            return Some(Action::Allow);
        }
        if self.check_block(domain) {
            return Some(Action::Block);
        }
        None
    }

    pub fn check_allow(&self, domain: &str) -> bool {
        probe(&self.allow, domain)
    }

    pub fn check_block(&self, domain: &str) -> bool {
        probe(&self.block, domain)
    }
}

fn probe(sorted: &[u64], domain: &str) -> bool {
    if sorted.is_empty() {
        return false;
    }
    let canonical = canonical(domain);
    if sorted.binary_search(&hash_domain(&canonical)).is_ok() {
        return true;
    }
    let labels: Vec<&str> = canonical.split('.').collect();
    for index in 1..labels.len() {
        let suffix = labels[index..].join(".");
        if sorted.binary_search(&hash_domain(&suffix)).is_ok() {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> HashSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn rule_matches_itself_and_children_only() {
        let table = FingerprintTable::build(&set(&["doubleclick.net"]), &HashSet::new());
        assert!(table.check_block("doubleclick.net"));
        assert!(table.check_block("ads.doubleclick.net"));
        assert!(!table.check_block("notdoubleclick.net"));
        assert!(!table.check_block("example.com"));
    }

    #[test]
    fn child_rule_does_not_match_its_parent() {
        let table = FingerprintTable::build(&set(&["collector.github.com"]), &HashSet::new());
        assert!(table.check_block("collector.github.com"));
        assert!(!table.check_block("github.com"));
    }

    #[test]
    fn allow_wins_over_block() {
        let table = FingerprintTable::build(&set(&["example.com"]), &set(&["cdn.example.com"]));
        assert_eq!(table.resolve("cdn.example.com"), Some(Action::Allow));
        assert_eq!(table.resolve("www.example.com"), Some(Action::Block));
    }

    #[test]
    fn fingerprint_is_stable() {
        let a = FingerprintTable::build(&set(&["a.example", "b.example"]), &HashSet::new());
        let b = FingerprintTable::build(&set(&["b.example", "a.example"]), &HashSet::new());
        assert_eq!(a.fingerprint, b.fingerprint);
    }
}

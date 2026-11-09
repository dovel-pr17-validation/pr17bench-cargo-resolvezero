//! Measures the resident cost of N unique 500k-rule lists with the real
//! parser and fingerprint builder. Run release:
//!   cargo run --release --example memory_probe -- 64
use std::process::Command;
use std::time::Instant;

use resolvezero_edge::fingerprint::FingerprintTable;
use resolvezero_edge::parse::{parse_list, ListFormat};

fn current_rss_mb() -> f64 {
    let pid = std::process::id().to_string();
    let output = Command::new("ps").args(["-o", "rss=", "-p", &pid]).output();
    match output {
        Ok(out) => {
            let kb: f64 = String::from_utf8_lossy(&out.stdout)
                .trim()
                .parse()
                .unwrap_or(0.0);
            kb / 1024.0
        }
        Err(_) => 0.0,
    }
}

fn peak_rss_mb() -> f64 {
    resolvezero_edge::metrics::rss_bytes() as f64 / 1048576.0
}

fn generate(list: usize, count: usize) -> String {
    let mut out = String::with_capacity(count * 36);
    for index in 0..count {
        out.push_str(&format!(
            "a{list}-{index}.t{}.example{list}.com\n",
            index % 100_000
        ));
    }
    out
}

fn main() {
    let lists: usize = std::env::args()
        .nth(1)
        .and_then(|value| value.parse().ok())
        .unwrap_or(10);
    let per_list: usize = std::env::args()
        .nth(2)
        .and_then(|value| value.parse().ok())
        .unwrap_or(500_000);

    println!(
        "baseline: current {:.1} MB, peak {:.1} MB",
        current_rss_mb(),
        peak_rss_mb()
    );

    let mut tables: Vec<FingerprintTable> = Vec::with_capacity(lists);
    let mut total_rules = 0usize;
    let mut slowest = 0.0f64;

    for list in 0..lists {
        let start = Instant::now();
        let text = generate(list, per_list);
        let text_mb = text.len() as f64 / 1048576.0;
        let generated = start.elapsed().as_secs_f64();
        let parse_start = Instant::now();
        let parsed = parse_list(&text, ListFormat::Domains);
        let parsed_at = parse_start.elapsed().as_secs_f64();
        drop(text);
        let after_parse = current_rss_mb();
        let build_start = Instant::now();
        let table = FingerprintTable::build(&parsed.blocks, &parsed.allows);
        let built_at = build_start.elapsed().as_secs_f64();
        let entries = table.entries;
        drop(parsed);
        tables.push(table);
        total_rules += entries;
        let elapsed = start.elapsed().as_secs_f64();
        slowest = slowest.max(elapsed);

        if list < 3 || (list + 1) % 10 == 0 || list + 1 == lists {
            println!(
                "list {:>3}: {:>7} rules, text {:.1} MB, after-parse {:.1} MB, after-build {:.1} MB, peak {:.1} MB | gen {:.2}s parse {:.2}s build {:.2}s",
                list + 1,
                entries,
                text_mb,
                after_parse,
                current_rss_mb(),
                peak_rss_mb(),
                generated,
                parsed_at,
                built_at
            );
        }
    }

    let table_bytes: usize = tables
        .iter()
        .map(|t| (t.allow_len() + t.block_len()) * 8)
        .sum();
    println!(
        "final: {} lists, {} rules, table bytes {:.1} MB, current {:.1} MB, peak {:.1} MB, slowest {:.2}s",
        lists,
        total_rules,
        table_bytes as f64 / 1048576.0,
        current_rss_mb(),
        peak_rss_mb(),
        slowest
    );
    if lists > 0 {
        println!(
            "per list: {:.2} MB resident, {:.1} bytes/rule including overhead",
            current_rss_mb() / lists as f64,
            (current_rss_mb() * 1048576.0) / total_rules as f64
        );
    }
}

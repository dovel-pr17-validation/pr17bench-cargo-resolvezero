use std::collections::HashSet;

#[derive(Debug, Default, Clone)]
pub struct ParsedList {
    pub blocks: HashSet<String>,
    pub allows: HashSet<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ListFormat {
    Auto,
    Abp,
    Hosts,
    Domains,
}

impl ListFormat {
    pub fn parse(value: &str) -> Self {
        match value {
            "abp" => Self::Abp,
            "hosts" => Self::Hosts,
            "domains" => Self::Domains,
            _ => Self::Auto,
        }
    }
}

/// Sniff the list syntax from the content, matching `detectFormat` in TS.
pub fn detect_format(text: &str) -> ListFormat {
    let mut abp = 0usize;
    let mut hosts = 0usize;
    let mut domains = 0usize;
    let mut sampled = 0usize;

    for raw in text.lines() {
        if sampled >= 2_000 {
            break;
        }
        let line = raw.trim().to_ascii_lowercase();
        if line.is_empty()
            || line.starts_with('#')
            || line.starts_with('!')
            || line.starts_with("//")
        {
            continue;
        }
        sampled += 1;

        if is_abp_rule(&line) {
            abp += 1;
            continue;
        }
        let tokens: Vec<&str> = line
            .split('#')
            .next()
            .unwrap_or("")
            .split_whitespace()
            .collect();
        if tokens.len() > 1 && is_ip_literal(tokens[0]) {
            hosts += 1;
            continue;
        }
        if tokens.len() == 1 && valid_domain(tokens[0]) {
            domains += 1;
        }
    }

    if abp > 0 && abp >= hosts && abp >= domains {
        ListFormat::Abp
    } else if hosts > domains {
        ListFormat::Hosts
    } else {
        ListFormat::Domains
    }
}

pub fn parse_list(text: &str, format: ListFormat) -> ParsedList {
    let resolved = if format == ListFormat::Auto {
        detect_format(text)
    } else {
        format
    };
    let mut parsed = ParsedList::default();

    for raw in text.lines() {
        let line = raw.trim().to_ascii_lowercase();
        if line.is_empty()
            || line.starts_with('#')
            || line.starts_with('!')
            || line.starts_with("//")
        {
            continue;
        }
        if resolved == ListFormat::Abp {
            if let Some(domain) = extract_abp_domain(&line) {
                if line.starts_with("@@||") {
                    parsed.allows.insert(domain);
                } else {
                    parsed.blocks.insert(domain);
                }
            }
            continue;
        }

        let no_comment = line.split('#').next().unwrap_or("").trim();
        for token in no_comment.split_whitespace() {
            let domain = token.trim_end_matches('.');
            if domain.is_empty()
                || domain == "localhost"
                || domain.len() < 3
                || is_ip_literal(domain)
                || !valid_domain(domain)
            {
                continue;
            }
            parsed.blocks.insert(domain.to_string());
        }
    }

    parsed
}

fn is_abp_rule(line: &str) -> bool {
    (line.starts_with("@@||") || line.starts_with("||")) && line.contains('^')
}

fn extract_abp_domain(line: &str) -> Option<String> {
    let rest = line
        .strip_prefix("@@||")
        .or_else(|| line.strip_prefix("||"))?;
    let host = rest.split('^').next().unwrap_or("").trim_end_matches('.');
    if host.is_empty() || !valid_domain(host) {
        return None;
    }
    Some(host.to_string())
}

pub fn valid_domain(domain: &str) -> bool {
    if domain.len() < 3 || domain.len() > 253 || !domain.contains('.') {
        return false;
    }
    if domain.starts_with('.') || domain.starts_with('-') || domain.ends_with('-') {
        return false;
    }
    for label in domain.split('.') {
        if label.is_empty() || label.len() > 63 || label.starts_with('-') || label.ends_with('-') {
            return false;
        }
        if !label.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
            return false;
        }
    }
    true
}

pub fn is_ip_literal(value: &str) -> bool {
    if value.contains(':') {
        return value
            .chars()
            .all(|c| c.is_ascii_hexdigit() || c == ':' || c == '.');
    }
    let parts: Vec<&str> = value.split('.').collect();
    parts.len() == 4 && parts.iter().all(|p| p.parse::<u8>().is_ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hosts_lines_with_aliases_and_comments() {
        let parsed = parse_list(
            "# comment\n0.0.0.0 ads.example.com tracker.example.com # inline\n127.0.0.1 localhost\n",
            ListFormat::Auto,
        );
        assert!(parsed.blocks.contains("ads.example.com"));
        assert!(parsed.blocks.contains("tracker.example.com"));
        assert!(!parsed.blocks.contains("localhost"));
    }

    #[test]
    fn parses_abp_allow_and_block() {
        let parsed = parse_list(
            "||ads.example.com^\n@@||good.example.com^\n||other.example^$third-party\n",
            ListFormat::Auto,
        );
        assert!(parsed.blocks.contains("ads.example.com"));
        assert!(parsed.blocks.contains("other.example"));
        assert!(parsed.allows.contains("good.example.com"));
    }

    #[test]
    fn parses_bare_domains() {
        let parsed = parse_list("Example.COM.\n# nope\nnot_a_domain\n", ListFormat::Domains);
        assert!(parsed.blocks.contains("example.com"));
        assert!(!parsed.blocks.contains("not_a_domain"));
    }

    #[test]
    fn detects_formats() {
        assert_eq!(
            detect_format("||ads.example.com^\n||track.example.com^\n"),
            ListFormat::Abp
        );
        assert_eq!(
            detect_format("0.0.0.0 ads.example.com\n0.0.0.0 tracker.example.com\n"),
            ListFormat::Hosts
        );
        assert_eq!(
            detect_format("ads.example.com\ntracker.example.com\n"),
            ListFormat::Domains
        );
    }

    #[test]
    fn rejects_ip_literals() {
        assert!(is_ip_literal("0.0.0.0"));
        assert!(is_ip_literal("::1"));
        assert!(!is_ip_literal("example.com"));
    }
}

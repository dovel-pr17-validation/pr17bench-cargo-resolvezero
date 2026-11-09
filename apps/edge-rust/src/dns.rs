use std::net::{Ipv4Addr, Ipv6Addr};
use std::str::FromStr;
use std::time::Duration;

use hickory_proto::op::{Message, MessageType, OpCode, ResponseCode};
use hickory_proto::rr::rdata::{A, AAAA, CNAME, TXT};
use hickory_proto::rr::{DNSClass, Name, RData, Record, RecordType};

use crate::artifact::sha256_hex;
use crate::store::{BlockAnswer, BlockMode, SafeSearch, ZoneEntry};

#[derive(Clone, Debug)]
pub struct Question {
    pub id: u16,
    pub name: String,
    pub qtype: RecordType,
    pub qclass: DNSClass,
    /// Hash of the EDNS OPT payload (ECS/DO/cookies). Part of the cache key so
    /// an answer tailored to one client subnet is not served to another.
    pub opt_key: String,
    pub query: Message,
}

pub fn parse_query(wire: &[u8]) -> Option<Question> {
    let message = Message::from_vec(wire).ok()?;
    // Only standard queries with exactly one question are accepted. This also
    // bounds response encoding: we echo exactly one question, never the whole
    // attacker-supplied question section.
    if message.metadata.message_type != MessageType::Query {
        return None;
    }
    if message.metadata.op_code != OpCode::Query {
        return None;
    }
    if message.queries.len() != 1 {
        return None;
    }
    let query = message.queries.first()?.clone();
    let name = query
        .name()
        .to_string()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if name.is_empty() {
        return None;
    }
    let opt_key = message
        .edns
        .as_ref()
        .map(|edns| {
            let mut only_opt = Message::new(0, MessageType::Query, OpCode::Query);
            only_opt.edns = Some(edns.clone());
            sha256_hex(&only_opt.to_vec().unwrap_or_default())
        })
        .unwrap_or_else(|| "none".into());
    Some(Question {
        id: message.metadata.id,
        name,
        qtype: query.query_type(),
        qclass: query.query_class(),
        opt_key,
        query: message,
    })
}

fn base_response(question: &Question) -> Message {
    let mut response = Message::new(
        question.id,
        MessageType::Response,
        question.query.metadata.op_code,
    );
    response.metadata.recursion_desired = question.query.metadata.recursion_desired;
    response.metadata.recursion_available = true;
    if let Some(query) = question.query.queries.first() {
        response.add_query(query.clone());
    }
    response
}

pub fn sinkhole_response(question: &Question, answer: &BlockAnswer) -> Vec<u8> {
    match answer.mode {
        BlockMode::Nxdomain => nxdomain_response(question),
        BlockMode::Refused => refused_response(question),
        _ => {
            let mut response = base_response(question);
            response.metadata.authoritative = true;
            let name = question
                .query
                .queries
                .first()
                .map(|query| query.name().clone())
                .unwrap_or_else(Name::root);
            match question.qtype {
                RecordType::A => {
                    let ip = answer
                        .ipv4
                        .as_deref()
                        .and_then(|value| Ipv4Addr::from_str(value).ok())
                        .unwrap_or(Ipv4Addr::UNSPECIFIED);
                    response.add_answer(Record::from_rdata(name, answer.ttl, RData::A(A(ip))));
                }
                RecordType::AAAA => {
                    let ip = answer
                        .ipv6
                        .as_deref()
                        .and_then(|value| Ipv6Addr::from_str(value).ok())
                        .unwrap_or(Ipv6Addr::UNSPECIFIED);
                    response.add_answer(Record::from_rdata(
                        name,
                        answer.ttl,
                        RData::AAAA(AAAA(ip)),
                    ));
                }
                _ => {}
            }
            response.to_vec().unwrap_or_default()
        }
    }
}

pub fn nxdomain_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.response_code = ResponseCode::NXDomain;
    response.to_vec().unwrap_or_default()
}

pub fn refused_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.response_code = ResponseCode::Refused;
    response.to_vec().unwrap_or_default()
}

pub fn servfail_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.response_code = ResponseCode::ServFail;
    response.to_vec().unwrap_or_default()
}

pub fn truncated_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.truncation = true;
    response.to_vec().unwrap_or_default()
}

pub fn empty_response(question: &Question) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.authoritative = true;
    response.to_vec().unwrap_or_default()
}

/// Encode a zone entry for the question's name. `record_type` is the stored
/// type, which may be CNAME even when the question asked for A/AAAA.
pub fn zone_response(question: &Question, entry: &ZoneEntry, record_type: &str) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.authoritative = true;
    let owner = match question.query.queries.first() {
        Some(query) => query.name().clone(),
        None => Name::root(),
    };

    for value in &entry.values {
        let rdata = match record_type {
            "A" => value.parse::<Ipv4Addr>().ok().map(|ip| RData::A(A(ip))),
            "AAAA" => value
                .parse::<Ipv6Addr>()
                .ok()
                .map(|ip| RData::AAAA(AAAA(ip))),
            "CNAME" => Name::from_str(value)
                .ok()
                .map(|name| RData::CNAME(CNAME(name))),
            "TXT" => Some(RData::TXT(TXT::new(vec![value.clone()]))),
            _ => None,
        };
        if let Some(rdata) = rdata {
            response.add_answer(Record::from_rdata(owner.clone(), entry.ttl, rdata));
        }
    }

    response.to_vec().unwrap_or_default()
}

const GOOGLE_TLDS: [&str; 40] = [
    "com", "co.uk", "de", "fr", "es", "it", "nl", "pl", "be", "ch", "at", "se", "no", "dk", "fi",
    "ie", "pt", "cz", "sk", "hu", "ro", "bg", "gr", "tr", "ru", "ua", "ca", "com.au", "co.nz",
    "co.jp", "co.kr", "co.in", "com.br", "com.mx", "com.ar", "co.za", "com.sg", "com.hk", "com.tw",
    "ae",
];

/// Exact-match SafeSearch rewrite; a wildcard would rewrite search assets too.
pub fn safe_search_target(settings: &SafeSearch, name: &str) -> Option<&'static str> {
    let name = name.trim_end_matches('.').to_ascii_lowercase();
    if settings.google
        && GOOGLE_TLDS
            .iter()
            .any(|tld| name == format!("google.{tld}") || name == format!("www.google.{tld}"))
    {
        return Some("forcesafesearch.google.com");
    }
    if settings.bing && matches!(name.as_str(), "bing.com" | "www.bing.com") {
        return Some("strict.bing.com");
    }
    if settings.duckduckgo
        && matches!(
            name.as_str(),
            "duckduckgo.com"
                | "www.duckduckgo.com"
                | "start.duckduckgo.com"
                | "html.duckduckgo.com"
                | "lite.duckduckgo.com"
        )
    {
        return Some("safe.duckduckgo.com");
    }
    if settings.youtube
        && matches!(
            name.as_str(),
            "youtube.com" | "www.youtube.com" | "m.youtube.com"
        )
    {
        return Some("restrict.youtube.com");
    }
    None
}

/// CNAME rewrite used by SafeSearch (provider addresses rotate).
pub fn cname_response(question: &Question, target: &str, ttl: u32) -> Vec<u8> {
    let mut response = base_response(question);
    response.metadata.authoritative = true;
    let owner = question
        .query
        .queries
        .first()
        .map(|query| query.name().clone())
        .unwrap_or_else(Name::root);
    if let Ok(target) = Name::from_str(target) {
        response.add_answer(Record::from_rdata(owner, ttl, RData::CNAME(CNAME(target))));
    }
    response.to_vec().unwrap_or_default()
}

/// Cache key: question + DNSSEC intent + full EDNS options + upstream.
pub fn cache_key(question: &Question, upstream: &str) -> String {
    format!(
        "{}|{:?}|{:?}|{}|{}|{}",
        question.name,
        question.qtype,
        question.qclass,
        question.query.metadata.checking_disabled,
        question.opt_key,
        upstream
    )
}

/// TTL to hold a response. Only NOERROR/NXDOMAIN are cacheable; everything
/// else (SERVFAIL/REFUSED/FORMERR/BADVERS) must never pin a broken answer for
/// other clients.
pub fn cache_ttl(wire: &[u8]) -> Duration {
    let Ok(response) = Message::from_vec(wire) else {
        return Duration::ZERO;
    };
    let rcode = response.metadata.response_code;
    if rcode != ResponseCode::NoError && rcode != ResponseCode::NXDomain {
        return Duration::ZERO;
    }
    let negative = rcode == ResponseCode::NXDomain || response.answers.is_empty();
    let mut ttl = u32::MAX;
    for record in response.answers.iter().chain(response.authorities.iter()) {
        ttl = ttl.min(record.ttl);
    }
    if negative {
        let soa_min = response
            .authorities
            .iter()
            .find_map(|record| match &record.data {
                RData::SOA(soa) => Some(soa.minimum),
                _ => None,
            });
        return Duration::from_secs(soa_min.unwrap_or(60).clamp(1, 60) as u64);
    }
    if ttl == u32::MAX {
        return Duration::ZERO;
    }
    Duration::from_secs(ttl.clamp(1, 300) as u64)
}

/// Validate an upstream response before it is returned or cached.
pub fn validate_upstream(query: &Question, wire: &[u8]) -> Result<(), String> {
    if wire.len() > 65_535 {
        return Err("upstream response exceeds 64 KiB".into());
    }
    let response = Message::from_vec(wire).map_err(|err| format!("upstream parse: {err}"))?;
    if response.metadata.message_type != MessageType::Response {
        return Err("upstream response is not a response".into());
    }
    if response.metadata.id != query.id {
        return Err("upstream response id mismatch".into());
    }
    let Some(answer) = response.queries.first() else {
        return Err("upstream response has no question".into());
    };
    let name = answer
        .name()
        .to_string()
        .trim_end_matches('.')
        .to_ascii_lowercase();
    if name != query.name
        || answer.query_type() != query.qtype
        || answer.query_class() != query.qclass
    {
        return Err("upstream response question mismatch".into());
    }
    Ok(())
}

/// Cache-normalize a response: strip OPT (ECS/cookies must not be replayed),
/// rewrite the question to the requested case, count TTLs down, and patch ID.
pub fn normalize_for_client(
    wire: &[u8],
    question: &Question,
    elapsed: Duration,
) -> Option<Vec<u8>> {
    let mut response = Message::from_vec(wire).ok()?;
    response.edns = None;
    response.metadata.id = question.id;
    if let (Some(original), Some(cached)) =
        (question.query.queries.first(), response.queries.first_mut())
    {
        *cached = original.clone();
    }
    let elapsed_secs = elapsed.as_secs().min(u32::MAX as u64) as u32;
    for record in response
        .answers
        .iter_mut()
        .chain(response.authorities.iter_mut())
        .chain(response.additionals.iter_mut())
    {
        record.ttl = record.ttl.saturating_sub(elapsed_secs).max(1);
    }
    response.to_vec().ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use hickory_proto::op::Query;

    fn query(name: &str, qtype: RecordType) -> Vec<u8> {
        let mut message = Message::new(0x1234, MessageType::Query, OpCode::Query);
        message.metadata.recursion_desired = true;
        message.add_query(Query::query(Name::from_str(name).unwrap(), qtype));
        message.to_vec().unwrap()
    }

    #[test]
    fn parses_canonical_question() {
        let question = parse_query(&query("Example.COM.", RecordType::A)).unwrap();
        assert_eq!(question.name, "example.com");
        assert_eq!(question.qtype, RecordType::A);
    }

    #[test]
    fn rejects_responses_and_multi_question() {
        let mut response = Message::from_vec(&query("example.com.", RecordType::A)).unwrap();
        response.metadata.message_type = MessageType::Response;
        assert!(parse_query(&response.to_vec().unwrap()).is_none());

        let mut multi = Message::new(1, MessageType::Query, OpCode::Query);
        multi.add_query(Query::query(
            Name::from_str("a.example.").unwrap(),
            RecordType::A,
        ));
        multi.add_query(Query::query(
            Name::from_str("b.example.").unwrap(),
            RecordType::A,
        ));
        assert!(parse_query(&multi.to_vec().unwrap()).is_none());
    }

    #[test]
    fn sinkholes_a_and_aaaa() {
        let q = parse_query(&query("ads.example.com.", RecordType::A)).unwrap();
        let wire = sinkhole_response(&q, &BlockAnswer::default());
        let response = Message::from_vec(&wire).unwrap();
        assert_eq!(response.metadata.response_code, ResponseCode::NoError);
        assert_eq!(response.answers.len(), 1);
        assert_eq!(response.answers[0].data, RData::A(A(Ipv4Addr::UNSPECIFIED)));
    }

    #[test]
    fn block_modes_change_the_rcode() {
        let q = parse_query(&query("ads.example.com.", RecordType::A)).unwrap();
        let nx = Message::from_vec(&nxdomain_response(&q)).unwrap();
        assert_eq!(nx.metadata.response_code, ResponseCode::NXDomain);
        let refused = Message::from_vec(&refused_response(&q)).unwrap();
        assert_eq!(refused.metadata.response_code, ResponseCode::Refused);
    }

    #[test]
    fn zone_encodes_a_and_txt() {
        let q = parse_query(&query("nas.lan.", RecordType::A)).unwrap();
        let entry = ZoneEntry {
            values: vec!["192.0.2.10".into()],
            ttl: 60,
        };
        let response = Message::from_vec(&zone_response(&q, &entry, "A")).unwrap();
        assert_eq!(response.answers.len(), 1);
        assert_eq!(response.answers[0].ttl, 60);

        let q = parse_query(&query("note.lan.", RecordType::TXT)).unwrap();
        let entry = ZoneEntry {
            values: vec!["hello".into()],
            ttl: 60,
        };
        let response = Message::from_vec(&zone_response(&q, &entry, "TXT")).unwrap();
        assert_eq!(response.answers.len(), 1);
    }

    #[test]
    fn safesearch_matches_known_engines() {
        let settings = SafeSearch {
            google: true,
            ..Default::default()
        };
        assert_eq!(
            safe_search_target(&settings, "google.com"),
            Some("forcesafesearch.google.com")
        );
        assert_eq!(
            safe_search_target(&settings, "www.google.co.uk"),
            Some("forcesafesearch.google.com")
        );
        assert_eq!(safe_search_target(&settings, "youtube.com"), None);
        let youtube = SafeSearch {
            youtube: true,
            ..Default::default()
        };
        assert_eq!(
            safe_search_target(&youtube, "m.youtube.com"),
            Some("restrict.youtube.com")
        );
    }

    #[test]
    fn error_responses_are_never_cached() {
        let q = parse_query(&query("missing.example.", RecordType::A)).unwrap();
        let mut response = Message::new(0x1234, MessageType::Response, OpCode::Query);
        response.add_query(q.query.queries[0].clone());
        response.metadata.response_code = ResponseCode::ServFail;
        assert_eq!(cache_ttl(&response.to_vec().unwrap()), Duration::ZERO);
        assert_eq!(cache_ttl(&nxdomain_response(&q)), Duration::from_secs(60));
    }

    #[test]
    fn normalization_strips_opt_and_patches_question_case() {
        let q = parse_query(&query("MiXeD.Example.", RecordType::A)).unwrap();
        let mut response = Message::new(q.id, MessageType::Response, OpCode::Query);
        response.add_query(Query::query(
            Name::from_str("mixed.example.").unwrap(),
            RecordType::A,
        ));
        response.add_answer(Record::from_rdata(
            Name::from_str("mixed.example.").unwrap(),
            300,
            RData::A(A(Ipv4Addr::new(192, 0, 2, 1))),
        ));
        response.edns = Some(hickory_proto::op::Edns::new());
        let wire = response.to_vec().unwrap();
        let normalized = normalize_for_client(&wire, &q, Duration::from_secs(30)).unwrap();
        let parsed = Message::from_vec(&normalized).unwrap();
        assert!(parsed.edns.is_none());
        assert_eq!(parsed.answers[0].ttl, 270);
    }
}

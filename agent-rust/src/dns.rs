//! DNS wire helpers. Mirrors `apps/agent/src/dns.ts`.

use hickory_proto::op::{Message, MessageType, ResponseCode};

pub const DEFAULT_UDP_PAYLOAD: u16 = 512;
pub const MAX_UDP_PAYLOAD: u16 = 4096;

/// Client-advertised EDNS buffer size, clamped to what we are willing to send.
pub fn max_udp_payload(query: &[u8]) -> u16 {
    let Ok(msg) = Message::from_vec(query) else {
        return DEFAULT_UDP_PAYLOAD;
    };
    let advertised = msg
        .extensions()
        .as_ref()
        .map(|edns| edns.max_payload())
        .unwrap_or(DEFAULT_UDP_PAYLOAD);
    advertised.clamp(DEFAULT_UDP_PAYLOAD, MAX_UDP_PAYLOAD)
}

/// Minimal SERVFAIL for a parseable query; `None` when the packet is unusable.
pub fn servfail_response(query: &[u8]) -> Option<Vec<u8>> {
    let msg = Message::from_vec(query).ok()?;
    if msg.queries().is_empty() {
        return None;
    }
    let mut response = Message::new();
    response.set_id(msg.id());
    response.set_message_type(MessageType::Response);
    response.set_response_code(ResponseCode::ServFail);
    // The reference agent forces RD/RA on its synthetic answers.
    response.set_recursion_desired(true);
    response.set_recursion_available(true);
    for question in msg.queries() {
        response.add_query(question.clone());
    }
    response.to_vec().ok()
}

/// Truncated-cue response so the client retries over TCP through the agent.
pub fn truncated_response(query: &[u8]) -> Option<Vec<u8>> {
    let msg = Message::from_vec(query).ok()?;
    if msg.queries().is_empty() {
        return None;
    }
    let mut response = Message::new();
    response.set_id(msg.id());
    response.set_message_type(MessageType::Response);
    response.set_truncated(true);
    response.set_recursion_desired(true);
    response.set_recursion_available(true);
    for question in msg.queries() {
        response.add_query(question.clone());
    }
    response.to_vec().ok()
}

/// DNS transaction IDs live in the first two bytes; no parsing required.
pub fn same_transaction_id(query: &[u8], response: &[u8]) -> bool {
    query.len() >= 2 && response.len() >= 2 && query[0] == response[0] && query[1] == response[1]
}

#[cfg(test)]
mod tests {
    use super::*;
    use hickory_proto::op::{Message, MessageType, Query};
    use hickory_proto::rr::{Name, RData, Record, RecordType};
    use std::str::FromStr;

    fn query(name: &str) -> Vec<u8> {
        let mut msg = Message::new();
        msg.set_id(0x4242);
        msg.set_message_type(MessageType::Query);
        msg.set_recursion_desired(true);
        msg.add_query(Query::query(Name::from_str(name).unwrap(), RecordType::A));
        msg.to_vec().unwrap()
    }

    #[test]
    fn defaults_to_512_without_edns() {
        assert_eq!(max_udp_payload(&query("example.com")), 512);
    }

    #[test]
    fn clamps_advertised_edns_payload() {
        let mut msg = Message::from_vec(&query("example.com")).unwrap();
        msg.extensions_mut()
            .get_or_insert_default()
            .set_max_payload(1400);
        assert_eq!(max_udp_payload(&msg.to_vec().unwrap()), 1400);

        msg.extensions_mut()
            .get_or_insert_default()
            .set_max_payload(9000);
        assert_eq!(max_udp_payload(&msg.to_vec().unwrap()), MAX_UDP_PAYLOAD);

        msg.extensions_mut()
            .get_or_insert_default()
            .set_max_payload(64);
        assert_eq!(max_udp_payload(&msg.to_vec().unwrap()), DEFAULT_UDP_PAYLOAD);
    }

    #[test]
    fn malformed_queries_fall_back_or_return_none() {
        assert_eq!(max_udp_payload(&[0, 1, 2]), DEFAULT_UDP_PAYLOAD);
        assert!(servfail_response(&[0, 1, 2]).is_none());
        assert!(truncated_response(&[0, 1, 2]).is_none());
    }

    #[test]
    fn servfail_preserves_id_and_questions() {
        let wire = query("example.com");
        let response = servfail_response(&wire).unwrap();
        let msg = Message::from_vec(&response).unwrap();
        assert_eq!(msg.id(), 0x4242);
        assert_eq!(msg.response_code(), ResponseCode::ServFail);
        assert!(msg.recursion_available());
        assert!(msg.recursion_desired());
        assert_eq!(msg.queries().len(), 1);
        assert_eq!(msg.queries()[0].name().to_string(), "example.com.");
    }

    #[test]
    fn truncated_sets_tc_and_ra() {
        let response = truncated_response(&query("example.com")).unwrap();
        let msg = Message::from_vec(&response).unwrap();
        assert!(msg.truncated());
        assert!(msg.recursion_available());
        assert_eq!(msg.queries().len(), 1);
    }

    #[test]
    fn transaction_id_comparison() {
        let query = query("example.com");
        let mut response = Message::from_vec(&query).unwrap();
        response.set_message_type(MessageType::Response);
        assert!(same_transaction_id(&query, &response.to_vec().unwrap()));

        response.set_id(0x1111);
        assert!(!same_transaction_id(&query, &response.to_vec().unwrap()));
        assert!(!same_transaction_id(&[0x42], &response.to_vec().unwrap()));
    }

    #[test]
    fn answers_are_irrelevant_for_servfail() {
        let mut msg = Message::from_vec(&query("example.com")).unwrap();
        msg.add_answer(Record::from_rdata(
            Name::from_str("example.com").unwrap(),
            60,
            RData::A("1.2.3.4".parse().unwrap()),
        ));
        let response = servfail_response(&msg.to_vec().unwrap()).unwrap();
        let msg = Message::from_vec(&response).unwrap();
        assert!(msg.answers().is_empty());
    }
}

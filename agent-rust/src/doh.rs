//! DoH forwarding. Mirrors `apps/agent/src/doh.ts`.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{ACCEPT, CONTENT_TYPE};
use reqwest::Client;

use crate::config::{device_slug, AgentConfig};

#[derive(Debug, Clone)]
pub struct DohError {
    pub message: String,
    pub status: Option<u16>,
}

impl DohError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
        }
    }

    pub fn with_status(message: impl Into<String>, status: u16) -> Self {
        Self {
            message: message.into(),
            status: Some(status),
        }
    }
}

impl fmt::Display for DohError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for DohError {}

/// Reusable DoH client. One instance is shared by every resolver task.
#[derive(Clone)]
pub struct DohForwarder {
    client: Client,
    config: Arc<AgentConfig>,
}

impl DohForwarder {
    pub fn new(config: Arc<AgentConfig>) -> Result<Self, DohError> {
        let client = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_millis(config.timeout_ms))
            .build()
            .map_err(|err| DohError::new(err.to_string()))?;
        Ok(Self { client, config })
    }

    /// Forward a DNS wire query to the edge and return the raw DNS response.
    pub async fn resolve(&self, query: &[u8], source_ip: &str) -> Result<Vec<u8>, DohError> {
        let device = device_slug(
            source_ip,
            self.config.devices.get(source_ip).map(String::as_str),
        );
        let url = format!(
            "{}/v1/{}/{}/{}",
            self.config.doh_url,
            encode_uri_component(&self.config.profile_id),
            encode_uri_component(&device),
            encode_uri_component(&self.config.token),
        );

        let response = self
            .client
            .post(&url)
            .header(CONTENT_TYPE, "application/dns-message")
            .header(ACCEPT, "application/dns-message")
            .header("user-agent", "resolvezero-agent/0.1")
            .body(query.to_vec())
            .send()
            .await
            .map_err(|err| DohError::new(err.to_string()))?;

        let status = response.status();
        if !status.is_success() {
            return Err(DohError::with_status(
                format!("edge returned HTTP {}", status.as_u16()),
                status.as_u16(),
            ));
        }

        let body = response
            .bytes()
            .await
            .map_err(|err| DohError::new(err.to_string()))?;
        if body.len() < 12 {
            return Err(DohError::new("edge returned an empty/invalid DNS response"));
        }
        Ok(body.to_vec())
    }
}

/// `encodeURIComponent` semantics: keep `A-Za-z0-9-_.!~*'()`, percent-encode
/// everything else.
pub fn encode_uri_component(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::parse_device_map;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn config(doh_url: String) -> Arc<AgentConfig> {
        Arc::new(AgentConfig {
            profile_id: "profile-id".into(),
            token: "secret-token".into(),
            doh_url,
            bind_host: "127.0.0.1".into(),
            dns_port: 0,
            timeout_ms: 5_000,
            health_port: 0,
            health_host: "127.0.0.1".into(),
            devices: parse_device_map("192.168.1.20=MacBook Pro"),
        })
    }

    fn query() -> Vec<u8> {
        use hickory_proto::op::{Message, MessageType, Query};
        use hickory_proto::rr::{Name, RecordType};
        use std::str::FromStr;
        let mut msg = Message::new();
        msg.set_id(0x1234);
        msg.set_message_type(MessageType::Query);
        msg.add_query(Query::query(
            Name::from_str("example.com").unwrap(),
            RecordType::A,
        ));
        msg.to_vec().unwrap()
    }

    async fn serve_once(body: Vec<u8>, status: &str) -> (u16, tokio::task::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let status = status.to_string();
        let handle = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 1024];
            let header_end = loop {
                let n = socket.read(&mut chunk).await.unwrap();
                if n == 0 {
                    return String::new();
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = find_header_end(&buf) {
                    break pos;
                }
            };
            let request = String::from_utf8_lossy(&buf[..header_end]).to_string();
            let content_length = request
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    if key.eq_ignore_ascii_case("content-length") {
                        value.trim().parse::<usize>().ok()
                    } else {
                        None
                    }
                })
                .unwrap_or(0);
            while buf.len() < header_end + 4 + content_length {
                let n = socket.read(&mut chunk).await.unwrap();
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/dns-message\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
            socket.write_all(&body).await.unwrap();
            request
        });
        (port, handle)
    }

    fn find_header_end(buf: &[u8]) -> Option<usize> {
        buf.windows(4).position(|w| w == b"\r\n\r\n")
    }

    #[tokio::test]
    async fn posts_wire_query_to_the_device_tagged_edge_path() {
        let body = query();
        let (port, server) = serve_once(body.clone(), "200 OK").await;
        let forwarder = DohForwarder::new(config(format!("http://127.0.0.1:{port}"))).unwrap();
        let out = forwarder.resolve(&query(), "192.168.1.20").await.unwrap();
        assert_eq!(out, body);

        let request = server.await.unwrap();
        assert!(request.starts_with("POST /v1/profile-id/macbook-pro/secret-token HTTP/1.1"));
        assert!(request
            .to_lowercase()
            .contains("content-type: application/dns-message"));
        assert!(request
            .to_lowercase()
            .contains("user-agent: resolvezero-agent/0.1"));
    }

    #[tokio::test]
    async fn rejects_http_errors() {
        let (port, server) = serve_once(b"no".to_vec(), "502 Bad Gateway").await;
        let forwarder = DohForwarder::new(config(format!("http://127.0.0.1:{port}"))).unwrap();
        let err = forwarder
            .resolve(&query(), "192.168.1.20")
            .await
            .unwrap_err();
        assert!(err.message.contains("502"));
        assert_eq!(err.status, Some(502));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn rejects_short_responses() {
        let (port, server) = serve_once(vec![0u8; 5], "200 OK").await;
        let forwarder = DohForwarder::new(config(format!("http://127.0.0.1:{port}"))).unwrap();
        let err = forwarder
            .resolve(&query(), "192.168.1.20")
            .await
            .unwrap_err();
        assert!(err.message.contains("empty/invalid"));
        server.await.unwrap();
    }

    #[test]
    fn encodes_url_components_like_encode_uri_component() {
        assert_eq!(encode_uri_component("a-b_c.d!~*'()"), "a-b_c.d!~*'()");
        assert_eq!(encode_uri_component("a b/é"), "a%20b%2F%C3%A9");
    }
}

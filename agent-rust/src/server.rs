//! UDP/TCP DNS listeners plus the optional health endpoint.
//! Mirrors `apps/agent/src/server.ts`.

use std::future::Future;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UdpSocket};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::config::AgentConfig;
use crate::dns::{max_udp_payload, same_transaction_id, servfail_response, truncated_response};
use crate::log;

pub type ResolverFuture = Pin<Box<dyn Future<Output = Result<Vec<u8>, String>> + Send>>;
pub type Resolver = Arc<dyn Fn(Vec<u8>, IpAddr) -> ResolverFuture + Send + Sync>;

pub struct AgentHandle {
    pub udp_port: u16,
    pub tcp_port: u16,
    /// 0 when the health endpoint is disabled.
    pub health_port: u16,
    shutdown: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
}

impl AgentHandle {
    /// Stops the listeners and waits (briefly) for their tasks to finish.
    pub async fn close(mut self) {
        let _ = self.shutdown.send(true);
        for task in self.tasks.drain(..) {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
    }
}

pub async fn start_agent(config: AgentConfig, resolver: Resolver) -> std::io::Result<AgentHandle> {
    let config = Arc::new(config);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    let udp = Arc::new(UdpSocket::bind((config.bind_host.as_str(), config.dns_port)).await?);
    let udp_port = udp.local_addr()?.port();

    let tcp = TcpListener::bind((config.bind_host.as_str(), config.dns_port)).await?;
    let tcp_port = tcp.local_addr()?.port();

    let mut tasks = Vec::new();
    tasks.push(tokio::spawn(udp_loop(
        udp,
        resolver.clone(),
        shutdown_rx.clone(),
    )));
    tasks.push(tokio::spawn(tcp_loop(
        tcp,
        resolver.clone(),
        shutdown_rx.clone(),
    )));

    let mut health_port = 0;
    if config.health_port > 0 {
        let health = TcpListener::bind((config.health_host.as_str(), config.health_port)).await?;
        health_port = health.local_addr()?.port();
        tasks.push(tokio::spawn(health_loop(
            health,
            config.clone(),
            shutdown_rx.clone(),
        )));
    }

    log::info(
        "agent listening",
        json!({
            "udpPort": udp_port,
            "tcpPort": tcp_port,
            "healthPort": if config.health_port > 0 { json!(config.health_port) } else { json!(null) },
            "profileId": config.profile_id,
            "dohUrl": config.doh_url,
            "devices": config.devices.len(),
        }),
    );

    Ok(AgentHandle {
        udp_port,
        tcp_port,
        health_port,
        shutdown: shutdown_tx,
        tasks,
    })
}

async fn udp_loop(socket: Arc<UdpSocket>, resolver: Resolver, mut shutdown: watch::Receiver<bool>) {
    let mut buf = vec![0u8; 65_535];
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            received = socket.recv_from(&mut buf) => {
                let Ok((len, peer)) = received else {
                    log::warn("UDP socket error", json!({ "err": "recv_from failed" }));
                    continue;
                };
                let wire = buf[..len].to_vec();
                let socket = socket.clone();
                let resolver = resolver.clone();
                tokio::spawn(async move {
                    udp_answer(socket, wire, peer, resolver).await;
                });
            }
        }
    }
}

async fn udp_answer(socket: Arc<UdpSocket>, wire: Vec<u8>, peer: SocketAddr, resolver: Resolver) {
    let Some(reply) = handle_query(&wire, peer.ip(), resolver).await else {
        return;
    };
    let max = max_udp_payload(&wire) as usize;
    let out = if reply.len() > max {
        truncated_response(&wire).unwrap_or(reply)
    } else {
        reply
    };
    if let Err(err) = socket.send_to(&out, peer).await {
        log::warn("UDP send failed", json!({ "err": err.to_string() }));
    }
}

async fn tcp_loop(listener: TcpListener, resolver: Resolver, mut shutdown: watch::Receiver<bool>) {
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                let Ok((socket, _)) = accepted else {
                    log::warn("TCP listener error", json!({ "err": "accept failed" }));
                    continue;
                };
                tokio::spawn(tcp_connection(socket, resolver.clone(), shutdown.clone()));
            }
        }
    }
}

async fn tcp_connection(
    socket: TcpStream,
    resolver: Resolver,
    mut shutdown: watch::Receiver<bool>,
) {
    let source_ip = socket
        .peer_addr()
        .map(|addr| addr.ip())
        .unwrap_or(IpAddr::V4(Ipv4Addr::UNSPECIFIED));
    let (mut reader, mut writer) = socket.into_split();
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(16);

    let writer_task = tokio::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if writer.write_all(&frame).await.is_err() {
                break;
            }
        }
    });

    loop {
        let mut len_buf = [0u8; 2];
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            read = reader.read_exact(&mut len_buf) => {
                if read.is_err() {
                    break;
                }
                let len = u16::from_be_bytes(len_buf) as usize;
                let mut payload = vec![0u8; len];
                if reader.read_exact(&mut payload).await.is_err() {
                    break;
                }
                let tx = tx.clone();
                let resolver = resolver.clone();
                tokio::spawn(async move {
                    let Some(reply) = handle_query(&payload, source_ip, resolver).await else {
                        return;
                    };
                    let mut frame = Vec::with_capacity(reply.len() + 2);
                    frame.extend_from_slice(&(reply.len() as u16).to_be_bytes());
                    frame.extend_from_slice(&reply);
                    let _ = tx.send(frame).await;
                });
            }
        }
    }

    drop(tx);
    let _ = writer_task.await;
}

async fn handle_query(wire: &[u8], source_ip: IpAddr, resolver: Resolver) -> Option<Vec<u8>> {
    if wire.len() < 12 {
        return None;
    }
    match resolver(wire.to_vec(), source_ip).await {
        Ok(response) => {
            if same_transaction_id(wire, &response) {
                Some(response)
            } else {
                log::warn(
                    "upstream transaction ID mismatch",
                    json!({ "sourceIp": source_ip.to_string() }),
                );
                servfail_response(wire)
            }
        }
        Err(err) => {
            log::warn(
                "upstream resolution failed",
                json!({ "sourceIp": source_ip.to_string(), "err": err }),
            );
            servfail_response(wire)
        }
    }
}

async fn health_loop(
    listener: TcpListener,
    config: Arc<AgentConfig>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
            }
            accepted = listener.accept() => {
                let Ok((socket, _)) = accepted else { continue; };
                let config = config.clone();
                tokio::spawn(async move { health_connection(socket, config).await });
            }
        }
    }
}

async fn health_connection(mut socket: TcpStream, config: Arc<AgentConfig>) {
    let mut buf = vec![0u8; 4096];
    let read = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buf))
        .await
        .ok()
        .and_then(Result::ok)
        .unwrap_or(0);
    let request = String::from_utf8_lossy(&buf[..read]);
    let path = request
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .unwrap_or("");

    if path == "/healthz" || path == "/readyz" {
        let body = json!({
            "ok": true,
            "profileId": config.profile_id,
            "dohUrl": config.doh_url,
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = socket.write_all(response.as_bytes()).await;
    } else {
        let response = "HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n";
        let _ = socket.write_all(response.as_bytes()).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hickory_proto::op::{Message, MessageType, Query};
    use hickory_proto::rr::{Name, RData, Record, RecordType};
    use std::str::FromStr;

    fn config() -> AgentConfig {
        AgentConfig {
            profile_id: "profile-id".into(),
            token: "secret-token".into(),
            doh_url: "https://edge.example".into(),
            bind_host: "127.0.0.1".into(),
            dns_port: 0,
            timeout_ms: 5_000,
            health_port: 0,
            health_host: "127.0.0.1".into(),
            devices: Default::default(),
        }
    }

    fn query(name: &str) -> Vec<u8> {
        let mut msg = Message::new();
        msg.set_id(0x4242);
        msg.set_message_type(MessageType::Query);
        msg.set_recursion_desired(true);
        msg.add_query(Query::query(Name::from_str(name).unwrap(), RecordType::A));
        msg.to_vec().unwrap()
    }

    fn answer(name: &str) -> Vec<u8> {
        let mut msg = Message::new();
        msg.set_id(0x4242);
        msg.set_message_type(MessageType::Response);
        msg.set_recursion_available(true);
        msg.add_query(Query::query(Name::from_str(name).unwrap(), RecordType::A));
        msg.add_answer(Record::from_rdata(
            Name::from_str(name).unwrap(),
            60,
            RData::A("1.2.3.4".parse().unwrap()),
        ));
        msg.to_vec().unwrap()
    }

    async fn udp_query(port: u16, wire: Vec<u8>) -> Vec<u8> {
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        socket.send_to(&wire, ("127.0.0.1", port)).await.unwrap();
        let mut buf = vec![0u8; 65_535];
        let (len, _) = tokio::time::timeout(Duration::from_secs(2), socket.recv_from(&mut buf))
            .await
            .expect("udp timeout")
            .unwrap();
        buf[..len].to_vec()
    }

    async fn tcp_query(port: u16, wire: Vec<u8>) -> Vec<u8> {
        let mut socket = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let mut frame = Vec::with_capacity(wire.len() + 2);
        frame.extend_from_slice(&(wire.len() as u16).to_be_bytes());
        frame.extend_from_slice(&wire);
        socket.write_all(&frame).await.unwrap();
        let mut len_buf = [0u8; 2];
        tokio::time::timeout(Duration::from_secs(2), socket.read_exact(&mut len_buf))
            .await
            .expect("tcp timeout")
            .unwrap();
        let len = u16::from_be_bytes(len_buf) as usize;
        let mut payload = vec![0u8; len];
        socket.read_exact(&mut payload).await.unwrap();
        payload
    }

    #[tokio::test]
    async fn serves_udp_and_tcp_through_the_injected_resolver() {
        let seen = Arc::new(std::sync::Mutex::new(Vec::<IpAddr>::new()));
        let seen_handler = seen.clone();
        let resolver: Resolver = Arc::new(move |_query, ip| {
            seen_handler.lock().unwrap().push(ip);
            Box::pin(async { Ok(answer("example.com")) })
        });
        let agent = start_agent(config(), resolver).await.unwrap();

        let udp = udp_query(agent.udp_port, query("example.com")).await;
        let msg = Message::from_vec(&udp).unwrap();
        assert_eq!(msg.id(), 0x4242);
        match msg.answers()[0].data() {
            Some(RData::A(addr)) => assert_eq!(addr.to_string(), "1.2.3.4"),
            other => panic!("unexpected answer {other:?}"),
        }

        let tcp = tcp_query(agent.tcp_port, query("example.com")).await;
        let msg = Message::from_vec(&tcp).unwrap();
        assert_eq!(msg.id(), 0x4242);

        assert_eq!(seen.lock().unwrap().len(), 2);
        agent.close().await;
    }

    #[tokio::test]
    async fn returns_servfail_when_the_resolver_throws() {
        let resolver: Resolver =
            Arc::new(|_query, _ip| Box::pin(async { Err("edge down".to_string()) }));
        let agent = start_agent(config(), resolver).await.unwrap();
        let reply = udp_query(agent.udp_port, query("example.com")).await;
        let msg = Message::from_vec(&reply).unwrap();
        assert_eq!(
            msg.response_code(),
            hickory_proto::op::ResponseCode::ServFail
        );
        agent.close().await;
    }

    #[tokio::test]
    async fn returns_servfail_on_transaction_id_mismatch() {
        let resolver: Resolver = Arc::new(|_query, _ip| {
            Box::pin(async {
                let mut msg = Message::from_vec(&answer("example.com")).unwrap();
                msg.set_id(0x1111);
                Ok(msg.to_vec().unwrap())
            })
        });
        let agent = start_agent(config(), resolver).await.unwrap();
        let reply = udp_query(agent.udp_port, query("example.com")).await;
        let msg = Message::from_vec(&reply).unwrap();
        assert_eq!(
            msg.response_code(),
            hickory_proto::op::ResponseCode::ServFail
        );
        agent.close().await;
    }

    #[tokio::test]
    async fn truncates_oversized_udp_answers() {
        // 300 answers make the response far larger than the 512-byte default.
        let resolver: Resolver = Arc::new(|_query, _ip| {
            Box::pin(async {
                let mut msg = Message::from_vec(&query("example.com")).unwrap();
                msg.set_message_type(MessageType::Response);
                msg.set_recursion_available(true);
                for i in 0..300u16 {
                    msg.add_answer(Record::from_rdata(
                        Name::from_str("example.com").unwrap(),
                        60,
                        RData::A(format!("10.0.{}.{}", i / 256, i % 256).parse().unwrap()),
                    ));
                }
                Ok(msg.to_vec().unwrap())
            })
        });
        let agent = start_agent(config(), resolver).await.unwrap();
        let reply = udp_query(agent.udp_port, query("example.com")).await;
        let msg = Message::from_vec(&reply).unwrap();
        assert!(msg.truncated());
        agent.close().await;
    }

    #[tokio::test]
    async fn health_endpoint_reports_ready() {
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);

        let mut config = config();
        config.health_port = port;
        let resolver: Resolver =
            Arc::new(|_query, _ip| Box::pin(async { Ok(answer("example.com")) }));
        let agent = start_agent(config, resolver).await.unwrap();
        assert_eq!(agent.health_port, port);

        let mut socket = TcpStream::connect(("127.0.0.1", agent.health_port))
            .await
            .unwrap();
        socket
            .write_all(b"GET /healthz HTTP/1.1\r\nhost: localhost\r\n\r\n")
            .await
            .unwrap();
        let mut response = Vec::new();
        socket.read_to_end(&mut response).await.unwrap();
        let text = String::from_utf8_lossy(&response);
        assert!(text.starts_with("HTTP/1.1 200 OK"), "{text}");
        assert!(text.contains("\"ok\":true"), "{text}");
        assert!(text.contains("profile-id"), "{text}");

        agent.close().await;
    }
}

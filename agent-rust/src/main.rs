#![forbid(unsafe_code)]
//! ResolveZero agent entrypoint. Mirrors `apps/agent/src/index.ts`.

use std::net::IpAddr;
use std::sync::Arc;

use serde_json::json;

use resolvezero_agent::config::AgentConfig;
use resolvezero_agent::doh::DohForwarder;
use resolvezero_agent::log;
use resolvezero_agent::server::{start_agent, Resolver};

#[tokio::main]
async fn main() {
    let config = match AgentConfig::from_env() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("configuration error: {err}");
            eprintln!("required: PROFILE_ID, DOH_TOKEN; optional: DOH_URL, BIND_HOST, DNS_PORT, DEVICE_MAP");
            std::process::exit(1);
        }
    };

    let shared = Arc::new(config.clone());
    let forwarder = match DohForwarder::new(shared) {
        Ok(forwarder) => forwarder,
        Err(err) => {
            eprintln!("configuration error: {err}");
            std::process::exit(1);
        }
    };

    let resolver: Resolver = Arc::new(move |query, source_ip: IpAddr| {
        let forwarder = forwarder.clone();
        Box::pin(async move {
            forwarder
                .resolve(&query, &source_ip.to_string())
                .await
                .map_err(|err| err.message)
        })
    });

    let agent = match start_agent(config, resolver).await {
        Ok(agent) => agent,
        Err(err) => {
            log::error(
                "failed to bind DNS listener",
                json!({ "err": err.to_string() }),
            );
            if err.kind() == std::io::ErrorKind::PermissionDenied {
                eprintln!("Port 53 requires root or CAP_NET_BIND_SERVICE.");
            }
            std::process::exit(1);
        }
    };

    let signal = shutdown_signal().await;
    log::info("shutting down", json!({ "signal": signal }));
    agent.close().await;
}

async fn shutdown_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut terminate = match signal(SignalKind::terminate()) {
            Ok(handle) => handle,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return "SIGINT";
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => "SIGINT",
            _ = terminate.recv() => "SIGTERM",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        "SIGINT"
    }
}

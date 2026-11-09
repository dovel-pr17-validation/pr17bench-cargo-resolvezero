use resolvezero_edge::config::Config;
use resolvezero_edge::server;
use tracing_subscriber::EnvFilter;

fn main() {
    let filter = EnvFilter::try_from_env("LOG_LEVEL").unwrap_or_else(|_| EnvFilter::new("info"));
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let config = match Config::from_env() {
        Ok(config) => config,
        Err(err) => {
            eprintln!("configuration error: {err}");
            std::process::exit(1);
        }
    };

    // Fly's shared-cpu-1x is effectively one vCPU. Allow pinning the runtime to
    // one worker for a per-core benchmark, matching the Node event loop.
    let workers = std::env::var("TOKIO_WORKER_THREADS")
        .ok()
        .and_then(|value| value.parse::<usize>().ok());
    let mut builder = tokio::runtime::Builder::new_multi_thread();
    builder.enable_all();
    if let Some(workers) = workers {
        builder.worker_threads(workers.max(1));
    }
    let runtime = match builder.build() {
        Ok(runtime) => runtime,
        Err(err) => {
            eprintln!("runtime: {err}");
            std::process::exit(1);
        }
    };

    let result = runtime.block_on(server::run(config));
    if let Err(err) = result {
        eprintln!("fatal: {err}");
        std::process::exit(1);
    }
}

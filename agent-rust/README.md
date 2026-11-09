# ResolveZero Agent (Rust)

A 1:1 rewrite of [`apps/agent`](../apps/agent) in Rust. Same behaviour, same
environment variables, same wire protocol — just a single static binary with no
JavaScript runtime.

```text
LAN devices → UDP/TCP 53 → resolvezero-agent → DoH → ResolveZero edge
```

> Kept aside on purpose: this crate is **not** part of the pnpm workspace, the
> deploy workflow, or CI yet. `apps/agent` (TypeScript) is still the shipped
> agent. Build and test it with Cargo while we decide.

## Parity with the TypeScript agent

| Behaviour | TypeScript | Rust |
|---|---|---|
| UDP + TCP listeners on `DNS_PORT` | ✅ | ✅ |
| RFC 1035 TCP framing (2-byte length) | ✅ | ✅ |
| DoH `POST /v1/:profile/:device/:token` | ✅ | ✅ |
| `DEVICE_MAP` label → device slug | ✅ | ✅ |
| IP-derived slug fallback | ✅ | ✅ |
| EDNS UDP payload clamp (512–4096) | ✅ | ✅ |
| TC response when the answer is too big | ✅ | ✅ |
| SERVFAIL on upstream error | ✅ | ✅ |
| SERVFAIL on transaction-ID mismatch | ✅ | ✅ |
| Optional `/healthz` + `/readyz` | ✅ | ✅ |
| Stateless (no cache, no filtering) | ✅ | ✅ |
| `.lan` / `.home.arpa` forwarded to the edge | ✅ | ✅ |
| JSON-line logs | ✅ | ✅ |
| SIGINT/SIGTERM shutdown | ✅ | ✅ |

Non-parity notes:

- The Rust agent uses `hickory-proto` for the DNS header/question handling
  instead of `dns-packet`. SERVFAIL/TC answers are semantically identical.
- TCP responses are written through a per-connection channel; ordering can be
  out-of-order under pipelining, same as the TypeScript agent.
- Log timestamps are RFC 3339 with nanoseconds; field names match.

## Build

```sh
cargo build --release
# target/release/resolvezero-agent
```

Static-ish Linux builds (musl) if you want a single file without glibc:

```sh
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl
```

## Run

```sh
PROFILE_ID=... DOH_TOKEN=... DNS_PORT=5353 cargo run
```

Port 53 is privileged. On Linux either run as root, grant
`CAP_NET_BIND_SERVICE`, or use Docker with host networking. Do not expose the
agent directly to the internet.

## Configuration

Identical to `apps/agent`:

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROFILE_ID` (or `RESOLVEZERO_PROFILE_ID`) | yes | — | ResolveZero profile id |
| `DOH_TOKEN` (or `RESOLVEZERO_DOH_TOKEN`) | yes | — | DoH token for that profile |
| `DOH_URL` | no | `https://resolvezero-edge.fly.dev` | Edge base URL |
| `BIND_HOST` | no | `0.0.0.0` | DNS listen address |
| `DNS_PORT` | no | `53` | DNS port |
| `DOH_TIMEOUT_MS` | no | `5000` | Upstream timeout |
| `DEVICE_MAP` | no | empty | `ip=label` entries, comma/`;`/newline separated |
| `HEALTH_PORT` | no | `0` (off) | Localhost health/readiness port |
| `HEALTH_HOST` | no | `127.0.0.1` | Health listen address |

`DEVICE_MAP="192.168.1.20=macbook,192.168.1.21=iphone"` — labels are slugified
(`MacBook Pro` → `macbook-pro`), falling back to `ip-<addr>`.

## Test

```sh
cargo test
```

23 tests cover config parsing/slugging, EDNS clamp, SERVFAIL/TC construction,
transaction-ID checks, DoH request shaping (against a local HTTP server), UDP +
TCP end-to-end with an injected resolver, truncation, and the health endpoint.

## Docker

```sh
docker build -t resolvezero-agent .
docker run -d --name resolvezero-agent \
  --network host \
  --cap-add NET_BIND_SERVICE \
  --env-file .env \
  --restart unless-stopped \
  resolvezero-agent
```

## systemd

See `deploy/resolvezero-agent.service`, same as the TypeScript agent:

```sh
sudo install -m 0755 target/release/resolvezero-agent /usr/local/bin/resolvezero-agent
sudo install -m 0600 .env /etc/resolvezero-agent.env
sudo install -m 0644 deploy/resolvezero-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now resolvezero-agent
```

## Not in this MVP (same as the TypeScript agent)

- DHCP
- local filtering
- local cache
- mDNS/PTR hostname discovery
- DoT/DoQ listener
- auto-update
- Windows service packaging
- router packages

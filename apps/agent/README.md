# ResolveZero Agent

A small local DNS forwarder that sends queries to the ResolveZero edge over DoH.

```text
LAN devices → UDP/TCP 53 → resolvezero-agent → DoH → ResolveZero edge
```

Use it when you want:

- one DNS entry point for every device on your LAN
- per-device labels in ResolveZero
- encrypted DNS to the edge
- no local blocklist or cache maintenance
- a router that can point its DNS at a single small agent

The agent is intentionally stateless. Policy, blocklists, logs, and analytics stay on the edge.

## MVP behaviour

- UDP 53 and TCP 53 listeners
- RFC 1035 TCP framing
- forwards DNS wire messages to `/v1/:profile/:device/:token` over DoH
- resolves the LAN source IP to a static device label
- falls back to an IP-based device slug
- returns SERVFAIL if the edge is unreachable or the transaction ID is invalid
- returns TC and lets the client retry over TCP when a response is too large
- optional localhost health endpoint
- no DNS cache by default, so the edge sees every query
- forwards `.lan`/`.home.arpa` queries to the edge; IP-encoded names are answered there

Device hostnames are not discovered automatically in this MVP. They can be supplied
with `DEVICE_MAP`:

```bash
DEVICE_MAP="192.168.1.20=macbook,192.168.1.21=iphone,192.168.1.22=apple-tv"
```

mDNS/PTR/DHCP-lease enrichment can be added later.

## Build

The agent is TypeScript and can be compiled to a single executable with Bun:

```bash
pnpm --filter @resolvezero/agent build
```

Cross-compile:

```bash
pnpm --filter @resolvezero/agent build:linux-x64
pnpm --filter @resolvezero/agent build:linux-arm64
pnpm --filter @resolvezero/agent build:darwin-arm64
```

For development:

```bash
PROFILE_ID=... DOH_TOKEN=... DNS_PORT=5353 pnpm --filter @resolvezero/agent dev
```

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `PROFILE_ID` | yes | — | ResolveZero profile id |
| `DOH_TOKEN` | yes | — | DoH token for that profile |
| `DOH_URL` | no | `https://resolvezero-edge.fly.dev` | Edge base URL |
| `BIND_HOST` | no | `0.0.0.0` | DNS listen address |
| `DNS_PORT` | no | `53` | DNS port |
| `DOH_TIMEOUT_MS` | no | `5000` | Upstream timeout |
| `DEVICE_MAP` | no | empty | `ip=label` entries, comma/`;`/newline separated |
| `HEALTH_PORT` | no | `0` (off) | Localhost health/readiness port |
| `HEALTH_HOST` | no | `127.0.0.1` | Health listen address |

## Router setup

1. Give the agent host a static LAN IP or DHCP reservation.
2. Run the agent as a service.
3. Set the router’s primary DNS server to that IP.
4. Use a second agent or a trusted fallback as secondary DNS if you need redundancy.

Port 53 is privileged. On Linux:

- run as root and drop privileges after binding, or
- grant `CAP_NET_BIND_SERVICE`, or
- run in Docker with host networking and the capability.

Do not expose the agent directly to the internet.

## systemd

See `deploy/resolvezero-agent.service`.

```bash
sudo install -m 0755 resolvezero-agent-linux-x64 /usr/local/bin/resolvezero-agent
sudo install -m 0600 .env /etc/resolvezero-agent.env
sudo install -m 0644 deploy/resolvezero-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now resolvezero-agent
```

## Docker

```bash
docker build -t resolvezero-agent .
docker run -d --name resolvezero-agent \
  --network host \
  --cap-add NET_BIND_SERVICE \
  --env-file .env \
  --restart unless-stopped \
  resolvezero-agent
```

Host networking is used because DNS must receive UDP/TCP on the LAN interface.

## Test

```bash
pnpm --filter @resolvezero/agent test
pnpm --filter @resolvezero/agent typecheck
```

## Not in this MVP

- DHCP
- local filtering
- local cache
- mDNS/PTR hostname discovery
- DoT/DoQ listener
- auto-update
- Windows service packaging
- router packages

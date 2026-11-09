# resolvezero-edge (Rust)

A Rust rewrite of the DNS data plane in `apps/edge`. **Deployed to production
as the `resolvezero-edge` data plane on 2026-11-07** (fra + lhr, 1 GB); the Node
implementation remains in-tree as a parity reference and rollback target.

The point is the memory profile: the Node edge carries a ~156 MB baseline and a
100–165 MB parse transient per 500k-rule list. Rust runs the same rule set in
**~52 MB RSS** with no GC headroom, and boots the whole catalog in ~1 second.

## Throughput (DoH, local Mac, 435k rules, logging disabled)

`qps-bench` drives one HTTP/1.1 keep-alive connection per worker against
`/v1/:profile/:token`. Blocked/cached paths never touch the upstream.

| Path | Rust, multi-worker | Rust, 1 worker | Node |
|---|---:|---:|---:|
| blocked policy, 64c | **121k qps**, p50 0.5 ms | **63k qps**, p50 1.0 ms | 19k qps, p50 3.2 ms |
| cached forward, 64c | **118k qps** | **70k qps** | 19k qps |
| cold upstream miss, 64c | 2.2k qps | 1.5k qps | **2.3k qps** |

Both used ~1.2 CPU cores in the blocked 1-worker vs Node run. Fly's
`shared-cpu-1x` is effectively one vCPU, so use the middle column for capacity
planning: **~3.3–3.8× Node per core** on the policy/cache path. Upstream misses
are the exception — Node's HTTP/2 multiplexing beats reqwest's h1 pool there
(reqwest h2 measured *worse*: 170 qps at 32c, which is why the edge uses h1 for
Cloudflare/Google and h2 only for Quad9).

Caveats: the load generator shares the host, and the numbers are relative, not
a Fly benchmark. `TOKIO_WORKER_THREADS=1` pins the runtime for per-core runs.

## Production shape

`resolvezero-edge` runs **2 shared cores / 512 MB** on Fly. The Rust edge sits
at ~14-20 MB RSS with artifacts loaded, so 512 MB leaves ample room for the
50 MB DNS cache, log buffers, and a raw-text parse fallback; the second core
keeps the async workers free during list syncs and upstream misses. The old
Node edge needed 1 GB for the same rule set.

## Security

The SSRF guard, upstream validation, ingress limits, cache normalization,
privilege drop, and readiness semantics are documented (with the still-open
gaps) in [`docs/rust-edge-security.md`](../../docs/rust-edge-security.md).

## Artifacts

Rule lists are compiled into content-addressed artifacts (see
[`docs/artifact-format.md`](../../docs/artifact-format.md)). With the four live
lists published as artifacts, the Rust edge loads **4/4 lists from artifacts,
0 from text** and serves 435,691 rules from **13 MB RSS** on Fly (Node edge at
the same rules: 164 MB). The compiler is `rz-compile` in this crate.

## Measured (local, release build, real database)

| | Node edge | Rust edge |
|---|---:|---:|
| Rules loaded | 397k | **406,707** |
| Unique list tables | 4 | 4 |
| RSS after boot | ~156 MB | **51.6 MB** |
| Boot / initial list sync | tens of seconds (deploy grace is 120 s) | **~1 s** |
| Release binary | ~104 MB image | **5.3 MB binary** |

Parser parity was checked against the TypeScript implementation on the four
live lists: both produce **406,707** entries (171,417 Hagezi, 189,625 AdGuard,
44,523 KADhosts, 1,142 Polish Pi-hole).

## Capacity probe

`cargo run --release --example memory_probe -- <lists> [rules-per-list]` builds
real fingerprint tables (no DB, no network) and reports table bytes and RSS.

Measured on this Mac, 500k unique rules per list:

| Lists | Rules | Table bytes | Peak RSS |
|---:|---:|---:|---:|
| 10 | 5M | 38 MB | 143 MB |
| 64 | 32M | 244 MB | 345 MB |
| 128 | 64M | 488 MB | 413 MB |

Parse cost per 500k-rule list (release): **0.16 s parse + 0.05 s build**. The
first parse adds ~80 MB RSS; later lists reuse the allocator and add ~25 MB,
plus the 4 MB table. A 64-list run peaked at 345 MB with 244 MB of tables.

Tables are exactly **8 B/rule** (4 MB per 500k list); the process baseline is
~6 MB for the probe and ~50 MB for the full edge (tokio/sqlx/reqwest/axum).
macOS compresses idle pages, so `current RSS` can read *below* the table size;
use table bytes plus baseline for sizing on Linux.

## What works

- Content-addressed rule artifacts: fetch + sha256 verify + zero-parse load,
  with raw-text fallback; `/readyz` reports `artifactLists` / `rawLists`.
- Query-log archive: gzipped NDJSON per profile per minute under the shared
  `logs/{profile}/{date}/{HHmm}.{instance}.{seq}.jsonl.gz` contract, so the
  existing Logs API reads Rust-written objects.
- Stats rollups: `stats_minute`, `stats_hourly`, `stats_hourly_device`,
  `stats_minute_device`, including top domains/blocked/clients/devices with
  advisory-lock read-merge-write (same tables the console reads).
- Postgres config snapshot + 5 s `edge_config_state` version polling.
- Shared per-URL blocklist catalog, ABP/hosts/bare-domain parsing, allow-first
  precedence across lists, 5M global entry budget, 64 lists/profile.
- Custom rules with subtree semantics, local zones (exact + `*.` wildcard,
  A/AAAA/CNAME/TXT), block modes (`null` / `nxdomain` / `refused` / custom IP).
- DNS cache keyed by name/type/class/CD/full EDNS OPT/upstream, with OPT
  stripped on store/serve, question-case rewrite, TTL countdown, and the Node
  edge's caps (positive 300 s, negative 60 s).
- DoH GET (`?dns=`) and POST, path shapes `/v1/:id`, `/v1/:id/:token`,
  `/v1/:id/:device`, `/v1/:id/:device/:token`, constant-time token compare.
- UDP 53 with source-IP auth and `UDP_UNKNOWN_SOURCE=refused|silent`.
- TCP 53 with PROXY protocol v1/v2 (Fly's `proxy_proto` ingress).
- **DoT 853** with PROXY v2 authority-TLV → profile mapping (`<dot_id>.dot…`).
- SafeSearch CNAME rewrites, DNS-presence probe recording, blocklist status
  write-back, and per-device `profile_devices` write-behind.
- Management endpoints on the same origin: `GET /v1/:profile/logs`,
  `POST /v1/:profile/cache/purge`, `GET /v1/:profile/whoami`,
  `POST /v1/:profile/update-ip` (with console CORS).
- Cache purges are queued in `dns_cache_purges` and applied by a 5 s poll.
- Upstream presets (Cloudflare/Google/Quad9) and custom DoH URLs.
- `/healthz`, `/readyz` (rules, tables, RSS), `/metrics` on a private port.
- Privilege drop after binding 53 (UID/GID 1000 by default).
- xxhash64 fingerprints identical to the TS runtime (seed 0).

## Not ported yet (required before cutover)

- `DELETE /v1/:profile/logs` and the optional edge stats/admin endpoints that
  the console does not call (stats are read from Postgres directly).
- Exact TTL rewriting on forwarded upstream answers (the cache TTL is capped
  and counted down; the returned wire TTL is upstream's).
- Non-root container/capability-only bind and `/metrics` + `/readyz` auth.
- PROXY-header trust: safe only when port 53 is reachable exclusively through
  Fly's `proxy_proto` ingress.

## Run locally

```sh
cd apps/edge-rust
DATABASE_URL='postgresql://…' \
PORT=8088 DNS_PORT=5354 METRICS_PORT=9191 \
DROP_PRIVILEGES=0 LOG_LEVEL=info \
cargo run --release
```

Then:

```sh
curl -s localhost:8088/readyz
# DoH POST with a wire query against /v1/<profile>/<token>
```

Tests: `cargo test` (25 tests). Lint: `cargo clippy --all-targets`.

## Environment

Same names as the Node edge where possible: `DATABASE_URL`, `PORT` (DoH),
`DNS_PORT`, `METRICS_PORT`, `FLY_REGION`, `UPSTREAM_DOH_URL`,
`UPSTREAM_PRESET`, `UDP_UNKNOWN_SOURCE`, `BLOCKLIST_MAX_TOTAL_ENTRIES`,
`BLOCKLIST_MAX_LISTS_PER_PROFILE`, `LIST_SYNC_INTERVAL_SECONDS`,
`CONFIG_POLL_MS`, `DROP_PRIVILEGES`, `DROP_UID`, `DROP_GID`, `LOG_LEVEL`.

`sslrootcert=system` in the PlanetScale URL is stripped because sqlx treats it
as a file path; rustls then uses its bundled roots.

# ResolveZero — Code Review v3 (2026-10-19)

Scope: `apps/edge`, `apps/control`, `apps/control-plane`, `packages/db`, `packages/shared`, `Dockerfile`, `fly*.toml`, `.github/workflows`, vs `readme.md` + `progress.md`.

Method: re-read of the v1 findings against the current working tree, full diff review, hot-path verification, plus:

- `cd apps/edge && bun test` → **127 pass, 0 fail**
- `cd apps/control && bun test` → **6 pass, 0 fail**
- `cd apps/edge && bunx tsc --noEmit` → clean
- `cd apps/control && bunx tsc --noEmit` → clean

> ⚠️ Everything below is in the **uncommitted working tree**, not on `main`. Run the usual CI/deploy path before treating it as live.

---

## 0. Verdict

The v1 report was accurate. The v2 remediation pass closed the functional/data-correctness bugs and most security blockers. Remaining work is smaller and mostly operational:

1. **Rate limiting is deliberately deferred** (decision 2026-10-19, see §2). Do not treat the hosted edge as abuse-resistant yet.
2. Tokens are no longer sent in dashboard→edge URLs, but tokens are still **plaintext at rest**.
3. Zone overrides are still counted as `forward` in Prometheus/rollups (no `override` series).
4. MVP hardening: CI now probes UDP/TCP 53 + DoH forward/sinkhole/zone; sentinel probes `/readyz` + DNS every 10 min.
5. Some docs still describe the pre-fix behavior (Quad9 default, uncapped TTL, silent-drop).

### 0.1 Incident (2026-10-20): UDP/TCP DNS outage after the hardening deploy

**Symptom:** `dig google.com @37.16.24.24` timed out; Fly proxy logged `instance refused connection ... 0.0.0.0:53`; DoH kept working.

**Root cause:** the hardening commit added `USER 1000:1000` to the shared Dockerfile. Port 53 is privileged, so `createDns53Service()` caught `EACCES` and returned `null`; the edge continued serving DoH only. The failure was logged at `warn` and the health check (8080) stayed green.

**Fix (deployed, versions 44–46):**
- Replaced the image-level `USER 1000:1000` with a **runtime privilege drop**: the process binds 53 as root, then calls `dropPrivileges()` (shared) and runs as UID/GID 1000. Bound sockets survive `setuid`.
- `createDns53Service` failure is now fatal when `FLY_REGION` is set (or `DNS53_REQUIRED=1`), so Fly cannot silently keep a DoH-only machine.
- TCP now binds `0.0.0.0` (Fly’s TCP proxy cannot reach a `fly-global-services` TCP listener) and parses PROXY protocol v1 (`handlers = ["proxy_proto"]`) so source-IP auth sees the real client.
- Added TCP framing + PROXY-header tests; added partial-frame buffering.

**Verified:** `dig` over UDP and TCP to `37.16.24.24`/`.46` → `NOERROR`, 6 answers; logs show `uid:1000,gid:1000` after bind; both fra/lhr machines healthy.

---

## 1. What landed in this pass

### Security

| Area | Change | Where |
|---|---|---|
| SSRF | Shared guard: protocol/credential checks, metadata hostnames, private/loopback/link-local/CGNAT/ULA/reserved IP rejection (v4+v6), DNS resolution check, **manual redirect following with per-hop revalidation**, fail-closed on unresolvable hosts. Self-host private targets require `ALLOW_PRIVATE_TARGETS=1`. | `apps/edge/src/netGuard.ts`; wired in `blocklists.ts` (`fetchListText`) and `upstream.ts` (`resolveWire`) |
| Dashboard tokens | Control→edge stats/logs/sync/update-ip now use `Authorization: Bearer`; browser log downloads go through a session/ownership-checked control route that streams with a Bearer header. No DoH token in HTML URLs. | `apps/control/src/dash.ts` (`edgeFetch`, `/dash/logs/download`) |
| CSRF | Origin/Referer gate on `/dash/*` POSTs (no token yet). | `dash.ts:268-294` |
| Headers/CORS | CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, HSTS, `nosniff`. CORS is same-origin unless `CORS_ORIGINS` is set (no more default `*`). | `apps/control/src/index.ts` |
| Metrics | Served on a **private port 9091** (`fly.toml [metrics]`); public `/metrics` is 404. Optional `METRICS_TOKEN` remains for direct scrapes. | `apps/edge/src/metrics.ts`, `fly.toml` |
| Update-IP | Real `isIP` validation, bounded rate limit, upsert-move semantics. Token-free profiles remain unauthenticated by design. | `apps/edge/src/admin.ts` |
| Container | Exec-form entrypoint + `HEALTHCHECK`; binds 53 as root then **drops to UID/GID 1000** (`dropPrivileges()`), so the runtime is unprivileged. | `Dockerfile`, `packages/shared/src/index.ts`, `apps/edge/src/index.ts` |

### Correctness / data

| Area | Change | Where |
|---|---|---|
| UDP/DoH parity | Explicit `allow` now short-circuits remote blocks on UDP too (same rule as DoH). | `apps/edge/src/dns53.ts:174-188` |
| DNS cache | Key includes upstream + class + DO/CD; responses are normalized (OPT stripped), the question name is rewritten to the request’s 0x20 case, and **TTLs count down on cache hits**; TTL 0 floored to 1 s; NODATA/NXDOMAIN use SOA MINIMUM. | `apps/edge/src/dnsCache.ts` |
| Cache-hit logging | Cache hits emit a `forward` query log row, so stats/rollups match “all queries are logged”. | `doh.ts`, `dns53.ts` |
| Zone safety | Malformed zone values answer SERVFAIL instead of throwing out of the resolver; dashboard validates A/AAAA/CNAME at write time. | `doh.ts`, `dns53.ts`, `dash.ts` |
| Rollups | Hourly RMW is serialized with a transaction-scoped `pg_advisory_xact_lock` per (profile, hour) — safe across fra/lhr. | `apps/edge/src/rollup.ts` |
| Reconcile retry | Replaced unbounded async recursion with a loop + exponential backoff (2 s → 30 s) and buffer clamps. | `apps/edge/src/ruleSync.ts` |
| Blocklist sync | A `blocklist_version` bump during a running sync sets `needsResync` instead of being dropped; periodic refresh gets ±10% jitter. | `apps/edge/src/blocklists.ts` |
| S3 logs | Real continuation-token pagination, bounded-concurrency deletes, streamed bounded gunzip (zip-bomb safe), `limit`/`order=desc` for dashboard tailing. | `sinks/s3.ts`, `logs.ts` |
| Retention | `log_retention_days = 0` cannot delete the current hour (`GREATEST(..., 1)`). | `packages/db/src/prune.ts` |
| Docker drain | `batcher.stop()` fully drains before `archive.flushAll()`; backoff is honored; stop loops over all full batches. | `index.ts`, `batcher.ts` |

### Tests added

- `netGuard.test.ts` — private v4/v6 ranges, metadata/loopback literals, protocol/credential rejection, `ALLOW_PRIVATE_TARGETS`.
- `dnsCache.test.ts` — upstream/class/DO partitioning, OPT stripping, 0x20 case rewrite, TTL-0 floor.
- `dns53.test.ts` — explicit-allow-vs-remote-block parity.
- `sinks/s3.test.ts` — continuation-token paging, missing-cursor truncation, bounded delete concurrency.

---

## 2. Deliberately deferred: rate limiting

**Decision (2026-10-19): rate limiting is out of scope for now.** This project is still under heavy development; limiting will be added before/at hosted launch rather than during the current iteration.

What this means concretely:

- DoH, UDP 53, log download/delete, and blocklist fetches remain unthrottled.
- The token-holder threat model (cache-busting, log/DB growth, 30 MB list fetches, archive wipe) is **accepted for now**.
- UDP unauthorized sources still receive `REFUSED` by default (`UDP_UNKNOWN_SOURCE=silent` available); no penalty box.
- The small admin limiter (`update-ip` 30/min, `sync` 10/min) stays as-is.

Revisit this section when work shifts to hosted onboarding. Do not remove it from the launch checklist — move it, don’t lose it.

---

## 3. Still open

### 3.1 Token storage [Medium-High]

DoH tokens are stored plaintext (`profiles.doh_token`) and compared timing-safely (`ruleStore.ts`). A DB/backup leak exposes every profile’s DNS + logs + management auth.

**Next step:** add `doh_token_hash`, migrate/backfill (hash existing values), switch `hasProfile` to hash-compare, and regenerate tokens on rotation. Until then, keep the readme warning and restrict DB access.

### 3.2 Zone overrides still counted as `forward` [Medium]

Both ingresses log `action: "override"` but call `recorder.recordQuery("forward")`; `Recorder` only accepts `block | forward`, and rollups count them as resolved traffic. The dashboard therefore conflates rewrites with upstream forwards.

**Next step:** extend `recordQuery` to `override`, add the Prometheus series, and add a rollup/stat field (or document the conflation).

### 3.3 CSRF is origin-only [Low-Medium]

Cross-site POSTs are blocked by Origin/Referer, but there is no per-session CSRF token and requests with neither header are allowed (CLI convenience). Verify Better Auth’s session cookie is `SameSite=Lax` in the deployed config.

**Next step:** double-submit cookie or per-form token; render it into the shared form helper.

### 3.4 Blocklist parse memory [Low]

Parsing still holds the raw string + line splits + Sets before building the fingerprint table. Sequential processing avoids the original OOM, but a 30 MB list still creates large transients on a 256 MB VM.

**Next step (only if RSS regresses):** stream-parse lines / cap per-line length / reuse buffers.

### 3.5 Docs drift [Low]

- `readme.md` §1/§6.3 still says Quad9 is the default; code defaults to Cloudflare.
- §6.3 still says “cache by upstream TTL incl. NXDOMAIN” (now capped: positives ≤5 min, negatives ≤60 s).
- §6.4 still says “silent-drop unauthenticated; rate-limit permitted sources” (code: REFUSED by default; rate limiting deferred).
- Single `DATABASE_URL` + `max: 1` serializes all queries per POP; at N POPs consider a small pool. Version polling works through PgBouncer, so no direct/LISTEN URL is needed.
- `S3_FLUSH_MINUTES`, `CONFIG_POLL_MS`, `ALLOW_PRIVATE_TARGETS`, `TRUSTED_ORIGINS` need to be in the deploy docs/secrets list. Metrics are private on 9091 (no token required).

### 3.6 CI / ops [Medium]

- Smoke gate still only checks `/healthz` / `/api/healthz`. Add: DoH forward (NXDOMAIN/known name), sinkhole for a blocked rule, zone override answer.
- `sentinel.yml` has its own concurrency group and can race `deploy.yml`.
- No integration job for reconcile, rollups, or the S3 download/delete round-trip.
- `HEALTHCHECK` is now in the image, but Fly’s `http_service.checks` remain the primary gate.

### 3.7 Residual SSRF notes [Informational]

The guard resolves the hostname immediately before each hop and rejects private answers. The 60 s DNS cache means a rebinding attack has a ≤60 s window in which a previously-public name flips private; closing that fully requires pinning the dial IP or a custom dispatcher. For the hosted deployment, leave `ALLOW_PRIVATE_TARGETS` unset; for self-host Unbound, set it explicitly (metadata IPs stay blocked).

### 3.8 Distroless + compiled Bun (evaluated, deferred)

Evaluated 2026-10-20. Bun does publish `oven/bun:1-distroless` (based on `gcr.io/distroless/base-nossl-debian13`, ~90 MB uncompressed, no shell/apt, CA certs + `/tmp` included), and `bun build --compile --target=bun-linux-x64` works (edge: 331 modules, ~100 MB ELF; control starts).

Decision: **stay on `oven/bun:1-slim` + runtime privilege drop for now.**
- No size win (distroless ≈ slim; compiled binary + base ≈ 120 MB).
- Removes the shell/apt, but also loses `fly ssh console` — the main incident-debugging tool.
- The biggest win (non-root) is already obtained by `dropPrivileges()` after binding 53.
- Revisit at hosted/multi-tenant launch, or if a debugging workflow no longer depends on SSH. If adopted, use a `Dockerfile.distroless` variant with `edge`/`control` build targets, keep runtime drop, and smoke-test DoH + UDP/TCP 53 + S3/DB TLS + SIGTERM.

### 3.9 Why TTLs can jump between queries [Informational]

`37.16.24.x` is anycast, and fra/lhr each run an independent LRU. Consecutive `dig`s can therefore hit different machines and different upstream (Cloudflare/etc.) cache entries, so both the TTL and the returned A-record subset can differ. Example: `227` then `68` is two upstream cache ages, not the edge changing a TTL.

Within one edge cache entry, TTLs now count down correctly (`187 → 186` across a 1 s repeat). Entries are also capped (positives ≤5 min, negatives ≤60 s) and hard-expire when their TTL elapses. Cross-region consistency would require a shared cache or sticky routing — not planned.

### 3.10 DDoS protection / L4 anycast options (evaluated 2026-10-20)

Goal: absorb UDP/TCP 53 floods **while preserving the real client IP**, which `profile_source_ips` auth depends on.

| Option | Verdict |
|---|---|
| **Gcore Edge Proxy** | **Most promising non-Enterprise option.** L4 anycast TCP/UDP, no ASN/BGP/GRE required, dedicated proxy IP per protected server, ~€17/mo per Proxy Mapping (rules 2–5 €10, 6–10 €8, 11+ €6), attack traffic not billed. **Client IP: PROXY v2 supports both TCP and UDP** (v1 is TCP-only), so `profile_source_ips` can keep working — but the edge must parse the v2 binary header for UDP (first datagram of a flow) and we must PoC the exact header/flow behavior. DNS would use the **General UDP Countermeasure** profile for UDP/53 and **Generic TCP Server** for TCP/53; one protected server/proxy IP can hold both port mappings (~€27/mo). |
| **Cloudflare Spectrum** | Technically the safest fit: UDP 53, SPP/PROXY v2 for client IP, static IP only with **BYOIP** (/24 IPv4 minimum). Requires Enterprise + Spectrum add-on — expensive for this stage. |
| **Bunny Shield** | **Not a fit.** Website/API WAF + HTTP DDoS/CDN; no raw UDP/TCP 53 proxy. Bunny DNS is authoritative DNS, not a resolver front. |
| **Psychz / Path.net / OVH** | L3/L4 mitigation, often cheaper at scale, but needs own IP space/ASN + BGP/GRE (or hosting on their network). Source IP preserved because traffic is routed, not proxied. |
| **AWS Shield Standard (with GA)** | Free automatic L3/L4 protection on AWS; Advanced is ~$3k/mo and unnecessary here. |

**Decision:** stay on Fly for now. Before paying anyone, implement the free first line: UDP per-source penalty box / rate limit, `silent` mode for unknown sources under attack (REFUSED amplifies), and alerts on `rz_dropped_total` / QPS / network rate. If actual abuse appears, PoC **Gcore Edge Proxy** first: enable PROXY v2 on the UDP/53 mapping, verify the origin sees the real client IP (and how the first-datagram header/flow mapping behaves), and allowlist Gcore’s CDN edge IPs on the origin. Cloudflare Spectrum is the fallback if Enterprise/BYOIP is acceptable. Gcore setup notes: use “General UDP Countermeasure” + “Generic TCP Server”, block direct origin access, and exclude Gcore edge IPs from per-IP rate limits/auto-bans.

### 3.11 Multi-PoP readiness checklist

Adding PoPs multiplies shared-state and startup assumptions. Gate on these before scaling out.

**Implemented and live 2026-10-20:** S3 keys now include region+machine+boot nonce; blocklist `initialSync()` completes before port 53 binds; prune runs only in the primary region; runtime DDL removed (triggers are migrate-only, and the app role has no DDL rights); `/readyz` + TCP-53 health check added; deploy defaults to rolling with `kill_timeout=30` and listener-first drain. Config propagation is now **Postgres watermark polling** (`edge_config_state` + statement-level bump triggers, edge poll every 5s) — `pg-listen`/NOTIFY removed. Migrations 0004/0005 applied by CI; a live `log_queries` update bumped `config_version` 0→1 and both fra+lhr logged `config snapshot loaded` within ~5s. Migration 0006 drops the now-unused `notify_*` functions (bump functions stay); `migrate.ts` asserts both. Also fixed a multi-profile blocklist pruning bug: a profile with a subset of lists could delete tables another profile needed (`remote_list_tables` 4→2); wiring now defers pruning until every profile is wired.

**P0 — fix before adding POPs**

| Item | Why | Fix / acceptance |
|---|---|---|
| **S3 log key collisions** | `sinks/s3.ts` keys are `{HHmm}.{seq}` with a per-process `seq` starting at 0. fra+lhr (or a restart) flushing the same profile/window overwrite each other → silent raw-log loss. | Include `FLY_REGION` + `FLY_MACHINE_ID` + a boot nonce in the key (or a UUID). Update the Log Shipper/Vector contract + tests. Acceptance: two sinks with different regions/restarts never produce the same key. |
| **Cold-start filtering gap** | `blocklists.ts` starts a 5 s boot timer; `index.ts` binds 53 after the DB snapshot but does not wait for remote lists. A new POP can serve unfiltered for seconds/minutes. | Load a shared prebuilt list snapshot (S3) before binding, or `await` the first sync and fail closed. Add readiness so Fly doesn’t route until lists are loaded. Acceptance: a fresh POP never answers a remote-blocked domain before its lists load. |
| **Single-owner jobs** | `ensureRuleNotifyTrigger()` (DDL) and `startPruneLoop()` run on every POP. N× DDL/prune is redundant and can lock/contend. | Run triggers in migrate only (or gate to `FLY_REGION === PRIMARY_REGION`); run prune from one region/cron. |
| **Deploy/drain** | `scripts/deploy.sh` uses `--strategy immediate`; SIGTERM drains logs but doesn’t stop accepting DNS; default `kill_timeout` is 5 s. | Use rolling/canary with `max_unavailable=1`; set `kill_timeout` ≥ drain (e.g., 30 s); close UDP/TCP/HTTP listeners first, then flush. |
| **Readiness/health** | `/healthz` is unconditional 204 despite the “deep-readiness” comment; no TCP 53 check; a dead UDP/TCP listener after boot stays green. | Add `/readyz` (DB snapshot loaded, blocklist age, dns53 bound, last upstream success); add `tcp_checks` for TCP 53; alert per POP. |

**P1 — before hosted/many POPs**

- **DB connection architecture:** `packages/db/src/client.ts` uses `max: 1`, so every query in a POP serializes. At N POPs that is N query connections (plus no listener now). Consider a small pool / pooled URL budget; version polling is PgBouncer-safe.
- **Rate limiting / abuse:** the deferred UDP penalty box and DoH per-IP/token limits become more important with every public POP. Global quotas need a shared store; per-PoP limits are a start.
- **Upstream validation:** done — QR/ID/question validated before caching, singleflight coalesces concurrent misses per question. Add upstream-error metrics if needed.
- **Token hashing at rest:** plaintext `doh_token` remains; do before hosted.
- **Observability:** metrics are private on 9091; sentinel now alerts on `/readyz`, UDP/TCP 53, config-poll age, and failed blocklists. Add per-region Grafana panels/upstream-error counters as needed.
- **CI smoke per POP:** done — deploy job installs `dig`, runs UDP+TCP 53, DoH forward/sinkhole/zone (`apps/edge/scripts/smoke-edge.ts`).
- **Blocklist fetch amplification:** N POPs × every list every 6 h (30 MB each). Add a shared artifact or randomized phase; monitor source 429s.

**P2 — as scale grows**

- Rollup lock contention: the per-(profile,hour) advisory lock prevents lost increments but serializes N writers; consider region-keyed rows or batched flush if lock waits grow.
- Resource sizing: 256 MB works now (52–84 MB RSS at 384k rules), but list parsing transients + more rules may warrant 512 MB for new POPs.
- Cache/TTL variance across PoPs is expected (independent LRUs); keep per-region stats rather than trying to make them identical.

---

## 4. Fixed v1 findings (status board)

| v1 | Status |
|---|---|
| S1 SSRF | Fixed (redirect-aware + DNS check; see 3.7) |
| S2 CSRF | Partial (origin gate; token open) |
| S3 tokens in URLs | Fixed for dashboard; at-rest hashing open (§3.1) |
| S4 update-ip open/spoofable | Partial (validated; token-free profiles still open by design) |
| S5 rate limiting | **Deferred by decision (§2)** |
| S6 UDP source spoofing | Open, accepted for now |
| S7 device slugs | Fixed (200/profile cap) |
| S8 CSV injection | Fixed |
| S9 DoH body caps | Fixed |
| S10 gzip bomb | Fixed (streaming bounded inflate) |
| S11 zone values | Fixed (write-time validation + SERVFAIL fallback) |
| S12 auth oracles | Low, unchanged |
| S13 dash timeouts/link-ip | Fixed |
| S14 CORS/headers | Fixed |
| S15 container/signals | Fixed — exec-form + healthcheck; runtime drops to UID/GID 1000 after binding 53. TCP bind/PROXY protocol fixed (§0.1). |
| S16 metrics/list regex | Metrics fixed; regex CPU unchanged |
| B1 UDP remote lists | Fixed + explicit-allow parity |
| B2 `mergeTop(clientIp)` | Fixed |
| B3 `canonical()`/TLD probe | Fixed |
| B4 cache key | Fixed (upstream/class/DO/CD, OPT/case normalization) |
| B5 rule normalization | Fixed |
| B6 prototype check | Fixed |
| B7 reconcile race | Fixed (mutex + loop retry) |
| B8 rollup race | Fixed (advisory lock) |
| B9 drain/backoff/coalescing | Fixed |
| B10 hosts multi-name | Fixed |
| B11 IP move | Fixed (upsert-move) |
| B12 seenDevices | Fixed (cap) |
| B13 TTL 0 / SOA minimum | Fixed |
| B14 prune retention=0 | Fixed |
| B15 S3 seq/retry/pagination | Fixed |
| Drift a `upstream_url` | Fixed |
| Drift b UDP rate limit | **Deferred (§2)** |
| Drift c `S3_FLUSH_MINUTES` | Fixed |
| Drift d pooled/direct DB | Open (docs/config) |
| Drift e cache-hit logging | Fixed |
| Drift f zone counter | Open (§3.2) |
| Drift g stale comment | Fixed; docs remain (§3.5) |

---

## 5. Suggested next steps

1. **Commit + CI**: review/push the incident fix, run `bun test` + `tsc` in CI, and add a post-deploy `dig` check over UDP *and* TCP (healthz alone did not catch this). Privilege drop is in place; `DROP_PRIVILEGES=0` is the escape hatch if a future base image breaks `setuid`.
2. **Token hashing** (§3.1) — the largest remaining security item.
3. **Zone `override` metric/rollup** (§3.2) — small, improves dashboard truthfulness.
4. **CI DoH smoke probe** (§3.6) — forward + sinkhole + zone, so a broken edge can’t pass on `/healthz` alone.
5. **Docs/secrets pass** (§3.5) — align readme with actual defaults and list the new env vars.
6. **Rate limiting** — when the hosted-launch phase starts; use the deferred plan in §2 (per-token/IP bucket, UDP penalty box, bounded limiter state, per-profile quotas).

---

## Appendix — verification commands

```bash
cd apps/edge && bun test && bunx tsc --noEmit
cd apps/control && bun test && bunx tsc --noEmit
```

Current result: edge 127/127, control 6/6, both typechecks clean.

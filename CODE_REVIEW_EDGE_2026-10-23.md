# Edge Code Review — `apps/edge` (2026-10-23)

**Scope:** `apps/edge/src/**`, `apps/edge/scripts/**`, `fly.toml`, plus shared helpers in the request path (`packages/shared/src/localNames.ts`, `dropPrivileges`). Method: full manual read + `pnpm audit --prod`.

**Verdict:** The hot path is well-built — the v3 remediations (SSRF guard, private metrics port, privilege drop, upstream-response validation) are real and correctly wired. **No SQL injection, no auth bypass on tokened profiles, no production dependency CVEs** found. Remaining risk concentrates on **port-53 availability** and **the deliberate "token-free profile" mechanic**, plus a few unbounded-resource spots. Two findings chain into the most serious one (§1).

---

## Remediation status (2026-10-23)

Implemented on `control-v2`, merged to `main` (`58d212c`), and deployed to staging + production on 2026-10-23.

- **§1 update-ip ownership:** callers can link only their `fly-client-ip` by default. Explicit `?ip=` is disabled unless `ALLOW_EXPLICIT_IP_LINK=1` for self-host/dev. Cross-profile IP moves now return `409` instead of silently transferring ownership. Hosted profiles must have a token.
- **§2 TCP 53:** 64 KB receive-buffer cap, zero-length frame closes the socket, 30s idle timeout, 512-connection cap, and write-backpressure guard. Configurable via `TCP_MAX_BUFFER_BYTES`, `TCP_IDLE_TIMEOUT_MS`, `TCP_MAX_CONNECTIONS`.
- **§3 token-free profiles:** hosted edge exits at boot if any profile has `dohToken = null`, unless `ALLOW_TOKENLESS_PROFILES=1` is explicitly set.
- **§4 bounded reads:** blocklist and upstream bodies are streamed into memory with a hard cap; DoH POST bodies are also bounded before allocation.
- **§6 SSRF TOCTOU:** list/upstream fetches now resolve once, validate the address, and connect to the pinned IP through a Node http/https transport while preserving TLS SNI and Host. Redirects are revalidated and repinned. No global `fetch()` re-resolution on the request path.
- **§5 device amplification:** hard cap of 200 device slugs per profile; new slugs are ignored after the cap rather than evicting old rows.
- **§7 readiness leakage:** `/readyz` now exposes `failedBlocklists` as a count and `configPollError`/`blocklistError` as booleans. Smoke script updated.
- **§8 log export:** export/delete rate limits; object cap of 500 without `date`, 2,000 with `date`; `x-rz-objects` header.
- **§13 DoH body cap:** request body is streamed through `readBytesBounded`.
- **§14 dev scripts:** `apps/edge/scripts` excluded from the production Docker image.

Verification:

- `pnpm typecheck` clean
- `pnpm test` **152 passing**
- New bounded-body tests
- Device-cap regression test
- Token-free list helper test
- Pinned HTTP/HTTPS transport + redirect test
- Live HTTPS + Cloudflare DoH check

Intentionally deferred:

- **§9 query-string tokens:** still accepted for NextDNS parity. Prefer Bearer-only in hosted docs.
- **§10 PROXY v1 trust:** still trusts the Fly proxy invariant; documented, not peer-pinned.
- **§11 0x20 question-case on single-flight:** only txid is patched; clients self-heal.
- **§12 XFF/limiter trust:** `fly-client-ip` preferred; `ALLOW_UNTRUSTED_IP_HEADERS=1` is required for XFF fallback.
- **§15 REFUSED behavior:** default remains configurable; silent mode available.
- **§16 S3 staging line cap:** not yet added.
- **§17/§18:** accepted xxhash risk; dev-only audit advisories.

Deployment verification:

- Staging `resolvezero-edge-node`: both fra/lhr machines healthy; smoke passed.
- Production `resolvezero-edge`: image `deployment-01M5M6JB12DCK8ZV4FA8GSYS2Z`, machine version 60, both regions 3/3 checks passing.
- Production `/readyz`: 405,079 rules, 4 tables, `configPollError:false`, `failedBlocklists:0`.
- Production UDP `.24` and edge-served `.lan` verified.
- CI run `39942630834` green.

Residual risk: the hot path is meaningfully hardened. §16 (archive staging memory) is the next substantive item; §9–§12 are documented compatibility/hardening tradeoffs.

---

## High

### 1. ~~Source-IP auth chain: arbitrary IP linking × UDP spoofing → reflection/amplification + cross-account hijack~~ ✅ FIXED
`admin.ts:55-82` — `POST /v1/:id/update-ip` accepts `?ip=` with **no proof of ownership**, and the upsert **moves an IP globally** (`onConflictDoUpdate` reassigns `profileId`; comment: "Allow moves between profiles"). Consequences:

- Any user (or *anyone at all*, for token-free profiles) can re-link a **victim's IP** to their own profile → victim's router queries are resolved under attacker policy **and logged into the attacker's logs/stats** (privacy breach), while the victim silently loses their config.
- Combined with UDP source spoofing (`dns53.ts` trusts `rinfo.address`, which is inherent to UDP): an attacker links victim-IP → spoofs packets "from" victim-IP → the edge sends full answers (up to 1232 B for ~50 B queries) to the victim. The whitelist is the *only* open-resolver defense (readme §4), and it's soft on both ends.

**Fix:** require proof of possession — only link `fly-client-ip` (drop `?ip=`, or gate it behind an email/verification flow); reject moves of IPs owned by another profile without re-validation; require tokens for `update-ip` unconditionally.

### 2. ~~TCP 53: unbounded buffer + no idle/connection limits → memory-exhaustion DoS~~ ✅ FIXED
`dns53.ts:187-237`:

- `state.buffer = concatBytes(state.buffer, chunk)` — **no size cap**, and each append is an O(n) copy → dribbled bytes cost O(n²) CPU.
- A `0x0000` length prefix makes the frame loop `return` early **without consuming** — the connection stalls forever while the buffer can keep growing.
- No socket timeout, no `server.maxConnections`, no per-IP connection cap. On a 512 MB VM, a few hundred slow connections is enough.
- Related: a client can send its own fake `PROXY …\r\n` line *after* Fly's real header; it gets parsed as DNS frame data with a huge length prefix → another stall amplifier.

**Fix:** cap `state.buffer` (e.g. 64 KB) and close on overflow; treat zero length as protocol error and close; `socket.setTimeout()`; consider `maxConnections`.

---

## Medium

### 3. ~~Token-free profiles → anonymous read **and delete** of DNS history~~ ✅ FIXED
`hasProfile` returns `true` with no token when `dohToken IS NULL` (`ruleStore.ts:208-215`). That gates everything: `GET /logs` (full query history, `logs.ts:49`), `DELETE /logs` (destructive, `logs.ts:151`), `/stats` (`stats.ts:98`), `update-ip` and `blocklists/sync` (`admin.ts`). DNS logs are among the most sensitive data held. The code comments admit it's dev-mode, but nothing **enforces** it: if a production profile ever lacks a token, its logs are public to anyone who knows the profile id.

**Fix:** at boot (and on each snapshot), `log.error`/refuse-ready when `FLY_REGION` is set and any profile has `dohToken = null`; require a token at minimum for `DELETE /logs` and `update-ip` regardless.

### 4. ~~Unbounded response reads on user-controlled URLs~~ ✅ FIXED
- `blocklists.ts:223-238` — the 30 MB cap checks `content-length` (attacker-controlled) and then `res.text()` **after it's fully read**. Any user who adds a custom list URL can point the edge at a server streaming gigabytes → OOM on a shared multi-tenant machine. (The sequential-parse comment shows this machine already OOM'd once at boot.)
- `upstream.ts:93-95` — same pattern: `arrayBuffer()` completes before the 65 535-byte check. Lower impact (per-profile upstream), but still shared-machine memory pressure.

**Fix:** stream the body and abort at the cap (pattern already exists: `gunzipBounded` in `logs.ts`).

### 5. ~~Unauthenticated device-slug DB-write amplification~~ ✅ FIXED
`doh.ts:103-106` + `ruleStore.ts:384-398`: each new `device` slug → one `profile_devices` upsert. The in-memory dedupe cap (200/profile) **evicts the oldest**, so an attacker cycling slugs on a token-free profile (or a leaked tokened path) generates unlimited DB writes and unbounded row growth — one HTTP request = one DB write, no rate limit on the DoH path.

**Fix:** cap *total* device inserts per profile (reject/ignore beyond N, don't evict-and-continue), and/or a cheap per-IP limiter on the DoH route for new-slug inserts only.

### 6. ~~SSRF residual: TOCTOU + 60 s cached "safe" boolean~~ ✅ FIXED
`netGuard.ts` validates DNS, then `fetch()` **re-resolves** — classic rebinding window; the 60 s `dnsCache` of the *boolean* (`netGuard.ts:38-39,179`) widens it: an attacker flips DNS right after the first validation and gets a minute of fetches to private space. Existing mitigations: metadata IPs are blocked even with `ALLOW_PRIVATE_TARGETS=1`, and upstream SSRF-read is neutered by `validateUpstreamResponse` (non-DNS bodies are thrown away). But blocklist GETs reach internal HTTP (blind), and 6PN-internal services are in scope once the DNS check is bypassed.

**Fix:** connect to the *validated* IP (resolve once, dial by IP with TLS SNI/Host pinned) or route these fetches through an egress allowlist proxy; shorten/negatively-cache the boolean.

### 7. ~~`/readyz` leaks user data~~ ✅ FIXED
`index.ts:128-143` — the public readiness response includes `failedBlocklists` (actual subscribed list URLs — these frequently contain **secret path tokens**) and raw `configPollError` strings (DB error text can embed connection details). `/readyz` must stay public for Fly checks, so it should expose booleans/counts only.

### 8. ~~Log export has no cost guard~~ ✅ FIXED
`logs.ts:49-149` — one call lists up to 50k keys and downloads+gunzips **every object** under the profile prefix; no rate limit, no date required. Repeated calls = S3 egress bill + CPU. For token-free profiles this is anonymous (see §3). Add a limiter and/or require `date=` for unauthenticated/token-free profiles.

---

## Low / hardening

| # | Item | Where | Status |
|---|---|---|---|
| 9 | `?token=` accepted on logs/stats/admin → tokens land in proxy/access logs. Prefer Bearer-only here (DoH path tokens are documented NextDNS-parity design). | `logs.ts:13-19`, `stats.ts:100-102`, `admin.ts:29-35` | ⏸ Deferred |
| 10 | PROXY v1 header trusted from **any** peer. Safe on Fly (proxy is the only ingress), but a footgun if the listener is ever directly exposed — forged header = arbitrary source IP = full auth bypass. Document the invariant or pin trusted proxy peers. | `dns53.ts:199-214` | ⏸ Deferred |
| 11 | Single-flight coalescing patches the txid but not the 0x20 question case — strict stubs reject and retry (self-healing, but wasted upstream calls). | `upstream.ts:155-161` | ⏸ Deferred |
| 12 | Rate-limiter keys and log `clientIp` trust `fly-client-ip`/XFF — correct on Fly; spoofable if the instance is ever reachable directly. XFF rotation also bypasses the update-ip limiter when `fly-client-ip` is absent. | `admin.ts:63-68`, `doh.ts:287-289` | ⏸ Deferred |
| 13 | DoH POST body: size checks happen **after** `arrayBuffer()` completes; chunked bodies are read fully into memory first. | `doh.ts:114-118` | ✅ Fixed |
| 14 | `scripts/dump-sessions.ts` prints live session tokens; `mk-session.ts` mints session cookies. Keep these out of the prod image and treat like root shells on the DB. | `apps/edge/scripts/` | ✅ Fixed |
| 15 | Default `REFUSED` to unauthorized UDP sources = 1:1 reflection (no amplification, but confirms service and reflects). `UDP_UNKNOWN_SOURCE=silent` exists — consider making silent the hosted default. | `dns53.ts:245-258` | ⏸ Deferred |
| 16 | `S3ArchiveSink` staging has no line cap within a 15-min window — memory grows with sustained QPS (batcher cap helps but doesn't bound throughput). | `sinks/s3.ts:217-233` | ⏸ Deferred |
| 17 | xxhash64 allow-table collisions are craftable in principle (non-cryptographic hash; public lists) — documented as accepted risk; just noting it's a *bypass* primitive if an attacker ever gets a private list's contents. | `fingerprint.ts` | ⏸ Deferred |
| 18 | `pnpm audit`: critical `tinypool` + moderate `esbuild` advisories are **dev-tooling chains only** (vitest/drizzle-kit), not shipped in the edge runtime. No prod-runtime CVEs. Bump when convenient. | `pnpm-lock.yaml` | ⏸ Deferred |

---

## What's solid (no action)

- **SSRF guard architecture**: protocol/credential checks, v4+v6 private ranges incl. CGNAT/ULA/NAT64/v4-mapped, fail-closed DNS, **per-hop redirect re-validation**. URL-parser IPv4 normalization covers `127.1`/hex shorthands.
- **Log handling**: bounded streaming gunzip (zip-bomb safe), CSV formula-injection neutralized, gzip-size caps.
- **Auth plumbing**: constant-time token compare; `profileId` charset regex (`^[0-9a-f-]{12,64}$`) doubles as S3-key traversal protection.
- **DNS correctness/security**: upstream response validation (QR/ID/question), OPT-record stripping before caching, TTL countdown, negative-cache caps, per-upstream cache keying (no cross-upstream poisoning), single-flight coalescing, TC handling.
- **Ops**: metrics on private 9091 only, privilege drop after bind, SIGTERM drain order, advisory-lock rollups, parameterized queries throughout, fail-closed boot snapshot.
- **DB layer**: all drizzle/postgres.js tagged templates — no injection surface found.

---

## Suggested priority order

1. Fix `update-ip` ownership proof + block cross-profile moves (§1a) — small change, kills the worst chain.
2. TCP buffer cap + timeouts (§2) — small change, kills the easy DoS.
3. Boot-time "no token-free profiles in hosted mode" enforcement (§3).
4. Streaming caps on list/upstream reads (§4).
5. Scrub `/readyz` (§7), rate-limit log export (§8), device-insert cap (§5).

---

## Delta vs `CODE_REVIEW_REPORT.md` v3 (2026-10-19)

Overlaps two already-known items: rate-limiting deferred decision, and tokens plaintext at rest — both still accurate. Everything in §1–§8 is new relative to v3.

# Rules at Scale — Architecture Notes

**Status:** design discussion, not implemented
**Last updated:** 2026-10-20
**Branch:** `node-runtime`

This captures the scaling discussion around blocklists, per-tenant rules, edge memory,
Node vs Bun, and whether Redis should be part of the rule path.

---

## 1. TL;DR

- **Do not use Redis as the primary rule store or per-query lookup.** It adds a network
  hop and another stateful system without solving compilation, distribution, boot time, or
  tenant isolation.
- **Compile rules into immutable, content-addressed bundles**, distribute them through
  object storage/CDN, and load them into process memory with an atomic swap.
- **Separate shared public-list bundles from small per-tenant overlays.** Tenants with the
  same list subscriptions share one base bundle; only custom rules are tenant-specific.
- **Keep Node for production growth.** It is the safer choice because of memory
  predictability and rule capacity per GB, not because it is faster per query. Bun wins the
  small-rule-set memory baseline and may win some raw throughput paths.
- **2 GB guidance (current architecture):** Node ~15–25M total rules; Bun ~8–12M. With
  merged/compiled bundles and a snapshot pipeline, both can go higher; the table itself is
  only ~8 bytes/rule.
- **100 lists does not mean 100 tables per query.** Compile the union of a subscription set
  into one base bundle, so the query path does one base lookup plus one overlay lookup.

---

## 2. What exists today

Current edge flow:

- Postgres is authoritative for profiles, rules, zones, and `profile_blocklists`.
- `edge_config_state.config_version` / `.blocklist_version` act as a watermark.
- Each edge polls every ~5 s and, on a blocklist version change, calls `startBlocklistSync`.
- `startBlocklistSync` fetches each **unique URL sequentially**, parses it into `Set<string>`,
  builds a `SuffixFingerprintTable`, and stores one table per URL in `RuleStore.listCatalog`.
- `RuleStore.resolveRemote()` walks every subscribed URL twice per query — once for allow
  tables, once for block tables.
- Tables are sorted `BigUint64Array`s of **one 64-bit fingerprint per rule** (not one per
  suffix), so the sealed table costs ~8 bytes/rule.
- The per-list parse transient is much larger than the sealed table: raw text + `split("\n")`
  array + `Set<string>` + builder capacity.
- `MAX_LIST_BYTES` is 30 MB per list; the dashboard currently caps a profile at 20 blocklist
  subscriptions.

Relevant files:

- `apps/edge/src/blocklists.ts` — fetch, parse, sync loop, status writes.
- `apps/edge/src/fingerprint.ts` — builder/table, xxhash64.
- `apps/edge/src/ruleStore.ts` — shared list catalog and `resolveRemote()`.
- `apps/edge/src/ruleSync.ts` — config version polling.
- `apps/edge/src/index.ts` — boot-time `initialSync()` before binding 53.

---

## 3. Measured baseline

### Production / staging

| Runtime | Machine | Rules | RSS |
|---|---:|---:|---:|
| Bun (production, current 4 lists) | 256 MB | ~397k | 83–87 MB |
| Node (staging, same lists) | 512 MB | ~397k | ~156 MB |

Node at 256 MB **stalled during blocklist boot** on the 397k-rule set; 512 MB recovered.
This is the reason the Node staging config uses 512 MB.

### Node vs Bun latency (external client, same test)

| Path | Bun | Node |
|---|---|---|
| DoH p50 / p95 | 35.6 / 41.1 ms | 37.1 / 41.6 ms |
| Cached UDP | comparable (anycast routing confounds single runs) | comparable |
| Cached TCP | 39.7 / 46.7 ms | 41.5 / 48.5 ms |
| Upstream miss (NXDOMAIN) | ~25–27 ms | ~40–47 ms |

Caveat: production and staging were not always in the same region; anycast routing
confounded the UDP/TCP numbers. DoH was pinned to `fra` and is the fairest comparison.
The upstream-miss difference needs a controlled same-region benchmark before drawing a
conclusion.

### Synthetic memory scaling

These were run locally (Mac) with generated unique domains, `parseList`, and the real
fingerprint builder. They are directional, not Fly production measurements.

| Case | Node RSS | Bun RSS |
|---|---:|---:|
| 4M rules across 10 lists (400k each) | ~312 MB steady / ~349 MB peak | ~587 MB steady |
| One 1M-rule list | ~487 MB peak | ~557 MB peak |

Observations:

- The sealed table is only ~8 bytes/rule: 5M rules ≈ 40 MB, 10M ≈ 80 MB, 20M ≈ 160 MB.
- The per-list parse transient dominates RAM, not the final table.
- In this synthetic test Bun retained more per-list memory than Node at multi-million-rule
  scale. Production at 397k still shows Bun with the lower baseline.
- **Validate with real lists on staging before sizing production.**

---

## 4. Why 100 lists is a problem today

Adding 100 lists primarily affects four things:

1. **Lookup cost**
   `resolveRemote()` checks every subscribed table twice. With 100 lists that is up to 200
   table probes per query, each hashing suffixes and binary-searching a table. Memory may fit;
   p99 and CPU may not.

2. **Boot time**
   Lists are fetched and parsed sequentially before DNS binds. 100 lists can exceed the
   120 s health grace and make deploys fail. A prebuilt snapshot is effectively mandatory.

3. **Cross-list duplication**
   One table per URL stores duplicate fingerprints when lists overlap. A merged base bundle
   deduplicates them.

4. **Fetch amplification**
   Every PoP fetches every list every ~6 h. With N PoPs and 100 lists this is wasteful and
   rate-limit-sensitive. Compile once, distribute the artifact.

Also relevant:

- Dashboard limit is currently **20 blocklist subscriptions per profile**.
- A single 30 MB list can transiently add hundreds of MB during parse.
- 64-bit fingerprints have a small collision risk that grows with rule count; at 20M+ rules,
  consider 128-bit fingerprints or a collision-check strategy.
- The top comment in `fingerprint.ts` about "~150 MB @ 5M rules storing ~20M suffix
  fingerprints" reflects an older suffix-expansion design. The current builder stores only
  the exact rule fingerprint, so the sealed table is much smaller; the parse transient is the
  real memory cost.

---

## 5. Node vs Bun at bigger load

**Recommendation: keep Node for production growth, but do not claim it is faster.**

| Dimension | Bun | Node |
|---|---|---|
| Small-rule-set baseline | **Lower** (~83 MB vs ~156 MB at 397k) | Higher |
| Practical rule capacity on 2 GB | ~8–12M (current tests) | ~15–25M (current tests) |
| Memory predictability at multi-million scale | Less predictable in synthetic tests | Better |
| Cached DNS latency | Comparable | Comparable |
| DoH latency | Comparable (~1–2 ms p50 edge in our test) | Comparable |
| Upstream-miss latency | Looked better in one test | Looked worse; needs controlled test |
| Raw throughput | Often strong; not measured at load here | Not proven faster |
| Ops/ecosystem/diagnostics | Good | Stronger |
| Image size | ~90 MB | ~104 MB |
| Machine cost | 256 MB baseline | 512 MB baseline |

The 512 MB vs 256 MB difference is a **starter-size** difference, not a scale difference:

- At 2 GB it is 12.5% of the machine.
- On Fly shared CPU, 256 → 512 MB is roughly +$1.50/machine/month.
- At 100 machines that is ~$150/month; less than the cost of one OOM incident.

For **QPS**, neither runtime removes the single-event-loop limit. Scale with multiple
processes/machines/regions regardless of runtime. Node has mature `cluster` /
`worker_threads` / `SO_REUSEPORT` options; validate the chosen process model under load.

**Decision:** Node is the conservative production choice for growing rule volume and
operational predictability. Keep a benchmark harness and revisit Bun if its memory behavior
improves or if raw DoH throughput becomes the dominant constraint at small rule counts.

---

## 6. Should each edge have the full list?

**No — and "just one list" is also too simple.**

Each edge needs the **compiled rules for the profiles it serves**, not the raw upstream
lists and not one copy of every shared list per tenant.

Two layers:

```text
PoP memory
├─ shared base bundle A   ← tenants subscribed to lists 1,2,3
├─ shared base bundle B   ← tenants subscribed to lists 4,5
├─ tenant overlay 123     ← custom rules for tenant 123
├─ tenant overlay 456     ← custom rules for tenant 456
└─ IP → profile map
```

- **Base bundle** = merged, deduplicated public lists for a distinct subscription set.
  - Keyed by hash(sorted list IDs + list versions).
  - Shared by every tenant with that set.
  - One lookup instead of N list lookups.
- **Tenant overlay** = custom block/allow rules, exceptions, zones.
  - Small compared with public lists.
  - Rebuilt on client edits after a short debounce.
- **Profile manifest** = base bundle refs + overlay + upstream + logging policy.

Query path:

```text
profile -> base bundle lookup + overlay lookup
```

Rules of thumb:

- All tenants subscribe to the same 100 lists → **one shared base bundle per PoP**.
  Not 100 raw lists. Not 100 copies.
- Different subscription sets → cache one bundle per distinct set, not per tenant.
- Edge serves only a subset of tenants → only needs bundles/overlays for that subset.
- Anycast can send any tenant to any PoP → either every PoP holds active bundles, or shard
  tenants and route them, or lazily load an overlay on first query.
- **Never duplicate shared public lists per tenant.** Share the base; keep only the overlay
  separate.

---

## 7. Target architecture

```text
Clients / dashboard
        │
        ▼
Postgres  ── outbox/events ──►  Compiler workers
(authoritative rules,           (validate, dedupe, merge,
 lists, tenants, versions)       fingerprint, sign)
                                      │
                                      ▼
                              S3/R2 artifact store
                              + manifest (versioned)
                                      │
                                      ▼
                              CDN / regional pull
                                      │
                                      ▼
Edge PoP: manifest poll → download → verify → atomic swap
          ├─ shared base bundles (public lists)
          ├─ tenant overlays (custom rules/zones)
          ├─ IP → profile map
          └─ local disk cache
Query path: profile → bundle refs → in-memory lookup
            (no Postgres, no Redis, no S3)
```

### Artifact types

1. **Public list bundle**
   - Compiled from one or more upstream lists.
   - Deduplicated, normalized, fingerprint arrays.
   - Content-addressed and immutable.
   - Can be shared by any number of tenants.

2. **Tenant overlay**
   - Custom allow/block rules and exceptions.
   - Tiny; versioned per tenant.
   - Can be loaded lazily for inactive tenants.

3. **Profile manifest**
   - Points at base bundle hashes + overlay version + upstream/logging config.
   - Signed/checksummed.
   - Changes atomically; old versions retained for rollback.

4. **IP → profile map**
   - Small global map for UDP source-IP authorization.
   - Versioned like other artifacts.

### Update flow

1. Client write goes to Postgres.
2. Outbox event or debounced trigger enqueues compilation for the affected list/bundle/overlay.
3. Compiler validates, normalizes, deduplicates, builds fingerprints, writes a compressed
   artifact + manifest entry.
4. Edge polls manifest ETag/version (or receives a regional notification), downloads changed
   artifacts, verifies checksum, loads, and atomically swaps pointers.
5. DNS cache is flushed only when the effective rule state changes.
6. Canary a percentage of PoPs/profiles; rollback by pointing the manifest at the previous
   version.

### Why this is better than Redis

- Rules are read-mostly and versioned: an artifact is the natural unit.
- Query path stays in-process: no network hop, no serialization, no eviction surprises.
- Object storage is cheaper than RAM and durable.
- Compilation happens once, not per PoP and not per tenant.
- Rollback and canary are version/manifest operations.
- Redis does not solve boot time, fetch amplification, or per-tenant isolation.

### Where Redis can still fit

Use Redis (or NATS/another queue) for:

- background job queues
- rate limiting
- sessions/API state
- pub/sub notifications
- short-lived caches

Do **not** use it as the authoritative rule store or per-query lookup. A local Redis as an
L2 cache of compressed artifacts is possible, but the process still needs the compiled table
in memory; object storage + local disk cache is simpler.

---

## 8. Tenant scale and sharding

At 100k tenants × 100 custom rules = 10M overlay rules ≈ 80 MB of fingerprint arrays. That
is manageable on 2 GB.

At 1M tenants × 100 rules = 100M rules ≈ 800 MB, plus object overhead and parse transients;
too much for every PoP. Then:

1. Shard profiles by consistent hash into rule shards.
2. Route DoH by tenant hostname/token to the right shard.
3. Keep a small global IP → profile + shard map for UDP.
4. For UDP, either preload active profiles per PoP or load overlays from local disk/object
   cache on first query with an LRU.
5. Keep public base bundles global; only overlays are tenant-specific.

Do not put all tenant rules behind Redis and fetch them per query. Use bundle hashes, local
disk cache, and an in-process LRU.

Capacity rough guide:

| Total rules | Fingerprint table | Node 2 GB | Bun 2 GB |
|---:|---:|---|---|
| 1M | ~8 MB | trivial | trivial |
| 5M | ~40 MB | easy | OK |
| 10M | ~80 MB | OK | tight |
| 20M | ~160 MB | workable | likely no |
| 50M | ~400 MB | tight/shard | no |
| 100M | ~800 MB | shard/snapshot only | no |

These assume the current one-table-per-URL/serial-parse architecture, not the merged bundle
pipeline. Merging/deduping and snapshot loading improve both capacity and latency.

---

## 9. 100-list scenarios

Approximate, assuming average list sizes:

| Scenario | Total rules | Node 2 GB | Bun 2 GB |
|---|---:|---|---|
| 100 × 10k | 1M | trivial | trivial |
| 100 × 50k | 5M | easy | OK |
| 100 × 100k | 10M | OK | tight |
| 100 × 250k | 25M | tight | no |
| 100 × 500k | 50M | no/shard | no |

The list **count** is not the limit. Total unique rules, the largest list, lookup cost, and
boot time are.

---

## 10. Roadmap

### Phase 1 — snapshot pipeline (next 1–2 months)

- Build a compiler that merges/dedupes lists, normalizes domains, builds fingerprint arrays,
  and writes signed/compressed artifacts to S3/R2.
- Add a versioned manifest with checksums.
- Edge downloads at boot, verifies, loads, then binds 53.
- Keep the current parser as the compiler core.
- No Redis.

### Phase 2 — bundles + overlays (3–6 months)

- Split shared base bundles from tenant overlays.
- Client writes go to Postgres + outbox; compiler debounces and rebuilds only the affected
  artifact.
- Atomic swap, canary percentage, rollback to previous manifest.
- Metrics: bundle size, load time, RSS, p99, compile lag, artifact cache hit rate.

### Phase 3 — tenant scale (6–12 months)

- Add profile sharding/lazy overlay loading if tenant count demands it.
- Regional artifact replication and data residency.
- Optional Redis/NATS for control-plane queues/rate limits/notifications.
- Per-tenant quotas (rules, lists, bundle size) and validation.
- Consider 128-bit fingerprints above ~20M rules.

---

## 11. Benchmark method and caveats

The numbers in this document came from:

- Production Bun RSS/CPU via private metrics on port 9091.
- Node staging on `resolvezero-edge-staging` (fra, 512 MB, ingress IP `213.188.210.31`).
- External UDP/TCP/DoH benchmark from the same client (`apps/edge/scripts/bench-node-vs-bun.ts`).
- Synthetic local parse/build probes with generated unique domains.

Caveats:

- External UDP/TCP runs are affected by anycast region selection; DoH was pinned to `fra`.
- Synthetic local runs include a Mac/tsx/db-import baseline; absolute RSS is higher than Fly.
- Bun's synthetic retention numbers need validation with real lists.
- The upstream-miss difference between Bun and Node needs a controlled same-region test.
- A proper throughput test should use concurrent UDP/DoH load at target QPS, not sequential
  queries.

Open questions:

- What is the real total unique-rule count of the proposed 100 lists?
- What is the largest single list?
- How many tenants are active per PoP at 12 months?
- Do most tenants share the same list subscriptions, or is it long-tail?
- What is the target p99 and QPS per machine?
- Is DoH or UDP the dominant traffic?
- Do we need data residency / regional rule storage?

---

## 12. Decision log

| Date | Decision | Rationale |
|---|---|---|
| 2026-10-20 | Keep Node for production growth | Better memory predictability and rule capacity per GB in current tests; 512 MB cost is small |
| 2026-10-20 | Do not use Redis as the rule store | Adds latency/state; artifacts + in-process tables are faster and simpler |
| 2026-10-20 | Compile base bundles + tenant overlays | Avoids per-list lookup and per-tenant duplication |
| 2026-10-20 | Use object storage/CDN + manifest | Compile once, distribute everywhere, version/rollback |
| 2026-10-20 | Shard tenants only when overlays demand it | Don't pre-build sharding before tenant volume requires it |

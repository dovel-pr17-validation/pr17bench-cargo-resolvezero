# Rule Artifacts — Format & Pipeline

**Status:** implemented on `feat/rust-edge`
**Last updated:** 2026-11-07

Compiled, content-addressed blocklist artifacts shared by the Node and Rust
edges. The binary format is deliberately tiny: no strings, no parse on the
data plane.

---

## 1. Binary layout

All integers little-endian.

```
offset  size  field
0       4     magic "RZA1"
4       1     format version (1)
5       1     flags        bit0 = allow table present
6       2     header bytes (24)
8       4     allow count  (u32)
12      4     block count  (u32)
16      4     total rules = allow + block
20      4     reserved (0)
24      …     allow: u64 × allowCount, sorted ascending
…       …     block: u64 × blockCount, sorted ascending
```

- Each entry is the **xxhash64 (seed 0)** of a normalized domain, identical in
  `apps/edge/src/fingerprint.ts` and `apps/edge-rust/src/fingerprint.rs`.
- Rules are stored exactly as written; the query side probes every label
  suffix, which preserves subtree semantics.
- Allow entries are checked before block entries, across all lists.
- There are no timestamps or URLs in the file, so the bytes are deterministic
  for the same rule set. **Artifact id = sha256(file).**

Size: `24 + 8 × rules`. A 500k-rule list is 4.0 MB (vs ~15 MB of source text).

## 2. Sidecar

`<sha256>.json`:

```json
{
  "id": "…",
  "source": "https://…",
  "allow": 0,
  "block": 200230,
  "rules": 200230,
  "bytes": 1601864,
  "compiler": "rz-compile/0.1",
  "hash": "xxhash64/seed0",
  "createdAt": "2026-11-07T11:14:00Z"
}
```

`hash` is an invariant check: if the fingerprint function ever changes, the
loader must reject the artifact rather than silently serve unfiltered answers.

## 3. Storage layout

```
artifacts/<sha256>.bin
artifacts/<sha256>.json
```

Private bucket (iDrive E2): custom-rule overlays can reveal blocked domains,
so artifacts are never public. The prefix is `ARTIFACT_PREFIX` (default
`artifacts`).

Postgres is the manifest:

- `rule_artifacts`: hash, source URL, byte size, allow/block counts, compiler,
  created_at.
- `profile_blocklists.artifact_hash` / `artifact_rules` / `compiled_at`:
  which artifact this subscription should load.

## 4. Compiler

`apps/edge-rust/src/bin/rz-compile.rs`:

```sh
rz-compile --url https://example/list.txt --out ./artifacts
rz-compile --file ./list.txt --format hosts --out ./artifacts
```

It reuses the same parser and fingerprint builder as the edge. Output is the
`.bin` + `.json`; the sidecar is also printed to stdout.

## 5. Publishing

`apps/edge/scripts/artifacts.ts`:

```sh
pnpm exec tsx apps/edge/scripts/artifacts.ts --all
pnpm exec tsx apps/edge/scripts/artifacts.ts --status
```

For every distinct enabled `profile_blocklists.url` it:

1. runs `rz-compile` (path via `RZ_COMPILE`),
2. uploads `<hash>.bin` + `<hash>.json` to E2,
3. upserts `rule_artifacts`,
4. sets `artifact_hash` / `artifact_rules` / `compiled_at` on the rows,
5. bumps `edge_config_state.blocklist_version` once.

The bump is explicit because the blocklist trigger intentionally excludes
status columns (`artifact_hash` was added after) to avoid sync loops.

`.github/workflows/artifacts.yml` wraps this for CI, gated on
`vars.ARTIFACTS_ENABLED == 'true'` and manual dispatch only.

## 6. Loading

- **Node edge** (`apps/edge/src/blocklists.ts`): if `artifact_hash` is set,
  GET the object, verify sha256, decode into `SuffixFingerprintTable`. On any
  failure it logs and falls back to fetching + parsing the raw text.
- **Rust edge** (`apps/edge-rust/src/lists.rs`): same, with a small SigV4 GET
  client (no AWS SDK). Falls back to text identically.

`/readyz` exposes `artifactLists` / `rawLists`, and metrics expose
`rz_artifact_lists` / `rz_raw_lists`, so a mixed rollout is visible.

## 7. What to watch

- Artifact failures are non-fatal but silent-ish: search logs for
  `artifact load failed`.
- A wrong `hash`/seed would make every rule miss; the sidecar invariant and
  the loader's sha256 check are the guards.
- Old artifacts are immutable. Delete unreferenced hashes after 30 days.

# Token-at-rest decision

Status: **decided, not yet implemented** (2026-10-28)

## Current state

- `profiles.doh_token` stores the DoH token in plaintext.
- The edge loads the token and compares it timing-safely.
- The console/control plane reads the same column to call edge admin endpoints
  (`logs`, `stats`, `cache purge`, `blocklists sync`, `update-ip`).
- The token is never written to query logs, but a database replica or backup
  disclosure yields a usable DNS/log/admin credential.

The review recommendation “store only hashes” is directionally right, but a
hash alone is not a drop-in replacement: the console needs an authenticating
credential when it calls the edge.

## Decision

Split the two uses of the token:

1. **DoH authentication** uses a one-way keyed hash.
2. **Console → edge administration** uses a short-lived signed JWT, not the
   profile’s DoH token.

This removes recoverable profile secrets from the database while keeping the
public NextDNS-style DoH/API token flow working for external clients.

## Target design

### DoH credential

Add `profiles.doh_token_hash`:

```text
hash = HMAC-SHA256(TOKEN_HASH_KEY, token)
```

- The edge compares `HMAC(token)` to the stored hash.
- No plaintext token is stored in Postgres.
- Existing tokens can be migrated without rotating every device: hash the
  current value during migration, then drop `doh_token`.
- Keep the raw token only long enough to display it once when created/rotated.

### Console → edge administration

The console mints a short-lived token for each edge call:

```json
{
  "typ": "rz-admin",
  "sub": "<profile-id>",
  "aud": "resolvezero-edge",
  "exp": "<now + 60s>",
  "scope": ["logs", "stats", "purge", "sync", "ip"]
}
```

Signed with `EDGE_ADMIN_SECRET` using HMAC-SHA256 (or Ed25519 if we want
asymmetric verification later). The edge verifies signature, audience, profile,
expiry, and scope.

The profile id is the only subject; the edge still applies its existing
profile checks. A leaked console session cannot mint a token for another
profile because the console only signs after resolving `owner_user_id`.

### External API compatibility

External clients keep using the DoH token in the URL or bearer header. The
edge hashes the presented value and compares it to `doh_token_hash`. The
console no longer needs that token for its own calls.

## Migration plan

1. Add `doh_token_hash` and `EDGE_ADMIN_SECRET` / `TOKEN_HASH_KEY` envs.
2. Backfill `doh_token_hash` from existing `doh_token` values.
3. Switch the edge `RuleStore` to hash inputs and compare hashes.
4. Add JWT verification to edge admin/log stats/logs endpoints.
5. Switch console/control edge calls to minted JWTs.
6. Rotate any token that was ever stored in plaintext or committed.
7. Drop `doh_token` after the compatibility window.

Steps 1–3 and 4–5 can ship separately. Do not drop the old column until every
edge and console instance is on the new path.

## Why not encryption-only

Encrypting `doh_token` at rest (AES-GCM with a KMS/env key) is simpler to bolt
on, but it still leaves a recoverable credential in the database and pushes a
long-lived key into every edge process. Hashing plus short-lived admin JWTs
limits the blast radius of a database or backup leak.

## Non-goals

- This does not change the DoH URL shape or force every user to re-enroll.
- This does not add public API keys; it only changes how the console
  authenticates its internal edge calls.

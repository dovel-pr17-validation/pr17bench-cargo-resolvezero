# ResolveZero

**A DNS firewall you actually own.** Self-hostable, API-first, and built for households rather than enterprise tenants.

ResolveZero is a personal DNS and DNS-over-HTTPS resolver. It filters queries at the edge, answers local names, and keeps query history in storage you control. Think NextDNS or Pi-hole, but cloud-native and programmable from the start.

> **Status:** pre-1.0. The edge has been running in production; the hosted console and onboarding are still being finished. Self-hosting works, but interfaces may change.

## Why ResolveZero

- **Profiles, not tenants.** Small isolated configs for `home`, `laptop`, or `phone`, each with its own rules, blocklists, devices, and DoH URL.
- **Cloud-native.** No local box to babysit and no DHCP integration. Run the edge as a single static binary, with Postgres.
- **Privacy-respecting logs.** Raw query logs are optional and live in S3-compatible storage you choose. Postgres keeps bounded rollups, not raw logs.
- **Local names work.** Split-horizon `.lan` records and overrides are answered before blocklists or upstream.
- **API-first.** Edge endpoints and configuration are designed as data primitives, so the UI is not the only way to manage a profile.

## Features

| Area | What you get |
|---|---|
| Resolution | DNS-over-HTTPS, UDP 53, and TCP 53 |
| Filtering | Per-profile block/allow rules and remote blocklists |
| Local DNS | A/AAAA/CNAME/TXT records, exact and `*.` wildcard names |
| Profiles | Isolated configs, source-IP allowlists, per-device DoH tags |
| Observability | Query log, live stats, top domains/clients/devices, block rate |
| Operations | Edge health, cache purge, config-version propagation, DNS presence probe |
| Access | GitHub OAuth, session-guarded server functions, owner-scoped data |

## Architecture

```text
                 DoH / UDP / TCP
   Clients ─────────────────────────▶ Edge (Rust)
                                      │  in-memory policy + DNS cache
                                      │  DoH upstream / sinkhole
                                      │
                                      ▼
                              Postgres (control plane)
                                      ▲
                                      │  config watermark
                                      │
                              Console / API
```

**Edge data plane (`apps/edge-rust`; the Node reference is `apps/edge`)**
- Holds all profile policies in memory and resolves from an O(1) rule lookup.
- Authenticates via DoH profile token or UDP source-IP allowlist.
- Answers local zones first, then rules/blocklists, then cache or upstream DoH.
- Emits raw logs to S3-compatible storage and bounded rollups to Postgres.
- Polls a Postgres watermark every few seconds; no `LISTEN`/`NOTIFY` on the hot path.

**Control plane**
- Postgres schema, migrations, and config state live in `packages/db`.
- Better Auth + GitHub OAuth protect the console and every private server function.
- Console queries resolve profiles only through `profiles.owner_user_id`.

**Storage**
- Postgres: profiles, rules, blocklists, source IPs, zones, auth, and stats rollups.
- S3-compatible storage: optional compressed raw query logs.

## Repository layout

| Path | Purpose |
|---|---|
| `apps/edge-rust` | Production DNS/DoH/DoT edge (Rust), policy cache, logs, stats |
| `apps/edge` | Node reference implementation (kept for parity/reference) |
| `apps/console` | TanStack Start console and authenticated server functions |
| `apps/agent` | Local DNS forwarding agent |
| `packages/db` | Drizzle schema, migrations, database client |
| `packages/shared` | Shared runtime helpers |
| `docs` | Design notes, including rules-at-scale |

## Self-hosting

### Requirements

- Node.js 24 (console, scripts, Node reference)
- Rust 1.99+ (edge; `cargo build --release`)
- pnpm 10
- Postgres
- Optional: an S3-compatible bucket for raw logs
- Optional: a GitHub OAuth app for console login

### 1. Install

```sh
git clone https://github.com/digitalmio/resolvezero.git
cd resolvezero
pnpm install
cp .env.example .env
```

Edit `.env` and set at minimum:

```sh
DATABASE_URL=postgres://user:password@localhost:5432/resolvezero
DATABASE_URL_ADMIN=postgres://user:password@localhost:5432/resolvezero
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=<openssl rand -base64 32>
GITHUB_CLIENT_ID=<github oauth client id>
GITHUB_CLIENT_SECRET=<github oauth client secret>
```

If your Postgres provider uses a separate pooled runtime port, point `DATABASE_URL` at that port and keep `DATABASE_URL_ADMIN` on the direct admin connection.

Register the GitHub callback as:

```text
http://localhost:3000/api/auth/callback/github
```

### 2. Migrate

```sh
node --env-file=.env node_modules/tsx/dist/cli.mjs apps/edge/scripts/migrate.ts
```

`DATABASE_URL_ADMIN` is used only for migrations. Runtime uses `DATABASE_URL`.

### 3. Run the edge

```sh
node --env-file=.env node_modules/tsx/dist/cli.mjs apps/edge/src/index.ts
```

Port 53 is optional locally. If you cannot bind it, set `DNS53_ENABLED=0` and use the DoH endpoint on `http://localhost:8080`.

### 4. Run the console

```sh
pnpm --filter @resolvezero/console dev
```

Open `http://localhost:3000` and sign in with GitHub.

### 5. Seed a first profile

The console expects a profile owned by your signed-in user. The dev seed creates a usable `home` profile:

```sh
node --env-file=.env node_modules/tsx/dist/cli.mjs apps/edge/scripts/seed.ts
```

After signing in once, assign the seeded profile to your user:

```sql
UPDATE profiles
SET owner_user_id = '<your-user-id>'
WHERE name = 'home';
```

Your user id is the `user.id` row created by Better Auth after the first GitHub login.

## Configuration

The full set of options lives in [`.env.example`](.env.example). The important ones:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Runtime Postgres connection |
| `DATABASE_URL_ADMIN` | Migration-only Postgres connection |
| `PORT` | Edge HTTP/DoH port (default `8080`) |
| `BETTER_AUTH_URL` | Public console origin |
| `BETTER_AUTH_SECRET` | Session signing key |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | GitHub OAuth credentials |
| `TRUSTED_ORIGINS` | Extra allowed console/API origins |
| `UPSTREAM_PRESET` / `UPSTREAM_DOH_URL` | Edge default upstream resolver |
| `S3_*` | Raw-log archive credentials and endpoint |
| `QUERY_LOG_STDOUT` | Send raw logs to stdout instead of S3 |
| `DNS53_ENABLED` | Set `0` to skip binding port 53 |
| `PROBE_DOMAIN` | Domain used by the DNS-presence canary |

## Security and privacy

- Every private console server function re-checks the session before reading tenant data.
- Profiles are resolved by `owner_user_id`; there is no global “latest profile” fallback.
- DoH tokens are kept server-side and never written to query logs. Database access should be treated as credential-bearing until token-at-rest hardening lands.
- Raw query logging can be disabled per profile. When disabled, that profile's queries are not added to raw logs or stats rollups.
- UDP source addresses are spoofable. Use source-IP allowlists with that in mind.
- The edge applies per-PoP ingress limits for DoH, UDP/TCP, blocklist sync, log export, and raw-log staging. Hosted deployments still need network-level DDoS protection and per-tenant quotas in front of them.
- Do not run the console without authentication.

## Development

```sh
pnpm test
pnpm typecheck
pnpm typecheck:console
pnpm build:console
```

Useful package scripts:

```sh
pnpm --filter @resolvezero/edge dev
pnpm --filter @resolvezero/console dev
pnpm --filter @resolvezero/agent dev
pnpm --filter @resolvezero/db db:studio
```

Source files should stay small and focused. See [`AGENTS.md`](AGENTS.md) for the 250–300 line guideline, verification commands, and tenant-safety rules.

## Roadmap

- Hosted console deployment and first-run onboarding
- DNS-over-TLS (port 853) for Android Private DNS and native profiles
- Rate limiting and abuse protection for the hosted edge
- NextDNS import for easier migration
- Exploratory: AI-assisted weekly reports, anomaly explanations, and natural-language rule suggestions

## Documentation

- [`docs/rules-at-scale.md`](docs/rules-at-scale.md) — blocklist/rule compilation and distribution design
- [`docs/token-at-rest.md`](docs/token-at-rest.md) — DoH token hashing and edge-admin credential plan
- [`packages/db/src/schema.ts`](packages/db/src/schema.ts) — database schema
- [`AGENTS.md`](AGENTS.md) — repository conventions and guardrails

## Contributing

Issues and pull requests are welcome. Please:

- Keep changes tenant-scoped and session-guarded.
- Add or update tests for behavior changes.
- Do not commit real credentials, customer domains, or production logs.
- Run the checks above before opening a PR.

## License

A license has not been published yet. One should be added before the repository is made public.

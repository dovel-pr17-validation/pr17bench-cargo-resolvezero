# ResolveZero Console

TanStack Start console for ResolveZero — profiles, rules, local DNS, query logs, and analytics.

## Stack

- TanStack Start 1.x
- TanStack Router
- TanStack Query
- React 19
- Tailwind CSS 4
- shadcn-style Radix primitives for Button, Select, Switch, and DropdownMenu
- lucide-react

The edge keeps its own Hono HTTP app; this app is the control-plane UI and API.

## Control-plane API

Every profile operation the console performs is also available as an oRPC
procedure at `/rpc`, authenticated either by the session cookie or by a
long-lived profile-scoped API key (`Authorization: Bearer rz_…`).

- `GET /openapi.json` — generated OpenAPI 3.1 document
- `GET /docs` — Scalar reference UI
- Keys are profile-scoped (`read` or `read-write`), stored hashed by
  `@better-auth/api-key`, rate limited at 60 req/min per key, and the raw value
  is shown once at creation.
- Key management (`/api-keys` in the console) is **session-only** and is not
  mounted on the public router, so a key can never mint or revoke another key.
- Mutating calls — including key create/revoke — append a row to
  `api_audit_log` (actor, key id, procedure, short summary, IP, user agent).
- `PATCH /rpc/settings` updates the upstream preset/custom URL, query logging,
  and retention; the console's Settings form uses the same procedure.
- The edge data plane (UDP/TCP 53, DoH, `/readyz`, `/metrics`) stays outside
  this API.

## Status

Implemented:

- Email OTP sign-in via Better Auth (no passwords): 6-digit codes, hashed at
  rest, 10-minute TTL, 5 attempts, sent over any SMTP endpoint (`SMTP_URL`).
  Dev without SMTP logs the code; production refuses to boot without it.
  GitHub OAuth remains as an alternative. A root route guard protects every
  screen and all server functions are session-scoped. Sign-in emails are capped
  three ways: 5 requests/min per IP (Better Auth), 3 codes/15 min per address,
  and 100 sends/hour per instance — a blocked request still answers `200` so it
  never reveals whether an account exists.
- Owner-scoped profile selection, a real profile switcher, and `rz_profile_id` preference cookie
- Overview with live traffic, KPIs, query chart, top blocked domains, devices, and Local DNS summary
- Query-volume chart ranges: 1H / 24H / 7D / 30D (KPIs remain fixed to 24h)
- Rules screen backed by Postgres rules, zones, and blocklist subscriptions, with add/disable/delete for block and allow rules (validated domains, subdomain matching)
- Devices screen backed by stats rollups: DoH tags and UDP source-IP counts
- Local DNS CRUD for `.lan` records (A/AAAA/CNAME/TXT, exact and wildcard)
- Blocklists screen backed by `profile_blocklists`: add a list (http/https validation, hosts/domains/abp), enable/disable, and remove
- Analytics screen backed by 24h/7d/30d `stats_hourly` rollups
- Logs screen backed by the edge log archive (latest 100 entries)
- Settings screen backed by profile, upstream, linked IPs, and capacity counts
- Public `/waitlist` placeholder for hosted registration
- Favicon set generated from the `RØ` mark (SVG, PNG, ICO, Apple touch)
- Loading and error states instead of dummy data flashes
- "This device is using ResolveZero DNS" probe in the topbar. The browser
  looks up a random `<nonce>.probe.resolvezero.com` name (no public record);
  the edge records it only after profile/source-IP auth. No wildcard TLS
  certificate is needed because the lookup itself is the signal.

Not implemented yet:

- oRPC router
- Public `/v1` OpenAPI surface and API keys
- Automated console tests

## Run

The app loads the repo-root `.env` automatically. It expects:

```sh
DATABASE_URL=postgres://...
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=<openssl rand -base64 32>
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

Register the GitHub callback as `http://localhost:3000/api/auth/callback/github`.

```bash
pnpm --filter @resolvezero/console dev
```

Build and typecheck:

```bash
pnpm --filter @resolvezero/console build
pnpm --filter @resolvezero/console typecheck
```

## Design direction

- Editorial ink/cream/orange system with hard 1px rules, zero-radius controls, and numbered sections
- Archivo Variable for expanded display type; Inter for body; monospace for domains, IPs, and logs
- Orange for brand and primary actions, green for healthy states, red for blocked/alerts
- Dense but calm data surfaces; the console should not become a marketing page
- The `RØ` mark and orange favicon are the brand anchors

## Next

1. Add console security regression tests for session guards, owner scoping, profile selection, and validators.
2. Add oRPC v1 contracts and an internal `/rpc` endpoint.
3. Add the public `/v1` OpenAPI surface and API keys.
4. Add first-run onboarding after the hosted registration flow is ready.

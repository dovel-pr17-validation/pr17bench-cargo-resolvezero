# AGENTS.md

## File size

Keep source files small and focused.

- **Hard ceiling: 300 lines** per source file.
- **Target: 250 lines.** If a file crosses 250, look for a clean split before adding more.
- Split by responsibility (route, data loader, card, hook, parser), not just to move lines around.
- A split that creates a vague `utils.ts` or `helpers.ts` grab bag is worse than leaving the file alone.

Allowed exceptions:

- Test files (`*.test.ts`, `*.spec.ts`, fixtures).
- Generated files (route trees, migrations, lock files).
- Long static data: rule catalogs, region maps, blocklist constants, schema/type definitions.
- Thin re-export barrels and directory indexes.
- Genuinely indivisible definitions where splitting would only add indirection.

If an exception is used, keep the reason obvious in the file or the PR description.

## Project shape

- `apps/edge` — DNS/DoH data plane (Node 24). Keep the hot path allocation-light.
- `apps/agent` — per-host agent.
- `apps/console` — TanStack Start console and authenticated server functions (React 19 + Vite + Tailwind 4).
- `packages/db` — Drizzle schema and client. Schema changes need a migration.

## Working rules

- Every private server function re-checks the session and scopes queries to the owning user. Never add a global "latest profile" fallback.
- UI data must be real and tenant-scoped. No dummy metrics or placeholder numbers.
- DNS names accepted by the console stay validated in `apps/console/src/lib/zone.ts`.
- Preserve the editorial ink/cream/orange design language: ink sidebar, cream canvas, bone cards, Archivo expanded display type, orange brand/CTA, green healthy states, red blocked/alerts.
- Prefer existing components and tokens in `apps/console/src/styles.css` over new one-off styles.
- Do not expose the console without auth.

## Verification

Run before calling work done:

```sh
pnpm test
pnpm --filter @resolvezero/console typecheck
pnpm --filter @resolvezero/console build
```

For edge or schema work, also run the relevant package typecheck (`pnpm typecheck`) and check `progress.md` for deploy/runtime caveats.

### Local previews (do not kill the developer's server)

- The developer's console dev server may already be running on `3000`. **Never** kill processes by port without checking what they are.
- Start agent previews on a separate port, e.g. `3100`, with `--strictPort` so Vite fails instead of stealing another port.
- Use a separate Chrome debugging port, e.g. `9333`, and a temporary `--user-data-dir`.
- Kill only PIDs you started; never use broad cleanup such as `lsof -ti tcp:3000 | xargs kill`.
- Temporary session rows and `/tmp` files may be cleaned up; the developer's dev server and browser processes are off-limits.

## Git

- Keep changes on the active feature branch unless asked to merge.
- Commit messages: short imperative summary; append `[skip ci]` for docs/design-only changes when a deploy is not intended.
- Never force-push or rewrite `main`.

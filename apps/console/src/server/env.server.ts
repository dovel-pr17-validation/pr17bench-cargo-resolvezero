import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Local dev convenience: pnpm may run from the repo root or apps/console,
 * while the shared secrets live in the repo-root .env. Production env vars
 * are injected by the platform and are never overridden by this file.
 */
if (!process.env.DATABASE_URL || !process.env.BETTER_AUTH_SECRET) {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.env.DASHBOARD_ENV_FILE,
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(process.cwd(), "../../../.env"),
    resolve(here, "../../../../.env"),
    resolve(here, "../../../../../.env"),
  ].filter((path): path is string => Boolean(path));

  for (const envFile of candidates) {
    if (!existsSync(envFile)) continue;
    try {
      process.loadEnvFile(envFile);
      if (process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET) break;
    } catch {
      // try the next candidate; a malformed file will surface as a config error
    }
  }
}

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

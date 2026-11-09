import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";
import { sanitizePgUrl } from "./url";

type Db = PostgresJsDatabase<typeof schema>;

interface Handle {
  client: postgres.Sql;
  db: Db;
}

let handle: Handle | undefined;

function init(): Handle {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  // max: 1 — this client shares a single pooled connection for queries.
  // The pg-listen socket in the edge app MUST be a separate dedicated
  // postgres connection (LISTEN does not work through PgBouncer in
  // transaction pooling mode; see readme.md §2).
  //
  // postgres.js passes unknown libpq URI params as server options (server
  // hard-rejects `sslrootcert`); sanitize first (boxes/db/src/url.ts).
  const client = postgres(sanitizePgUrl(connectionString), { max: 1 });
  return { client, db: drizzle(client, { schema }) };
}

function get(): Handle {
  return (handle ??= init());
}

/**
 * Lazily-initialized drizzle db: importing this module is safe without a
 * DATABASE_URL (pure unit tests import rollup/stats logic); only the first
 * actual query throws. Type = real drizzle instance.
 */
export const db: Db = new Proxy({} as Db, {
  get(_, prop) {
    const real = get().db as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
});

/**
 * Underlying postgres.js client (for raw multi-statement SQL like the
 * NOTIFY trigger bootstrap, and for the edge LISTEN socket when the
 * edge wants to derive its own dedicated connection).
 */
export function rawClient(): postgres.Sql {
  return get().client;
}

export { schema };
export { sanitizePgUrl } from "./url";

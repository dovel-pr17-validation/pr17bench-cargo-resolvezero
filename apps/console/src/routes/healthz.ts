import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";

import { db } from "@resolvezero/db/client";

/** Fly readiness probe: the console is useless if it cannot reach Postgres. */
export const Route = createFileRoute("/healthz")({
  server: {
    handlers: {
      GET: async () => {
        try {
          await Promise.race([
            db.execute(sql`select 1`),
            new Promise((_, reject) => setTimeout(() => reject(new Error("database timeout")), 2_000)),
          ]);
          return Response.json({ ok: true, region: process.env.FLY_REGION ?? null });
        } catch (err) {
          return Response.json(
            { ok: false, error: err instanceof Error ? err.message : "database unavailable" },
            { status: 503 },
          );
        }
      },
    },
  },
});

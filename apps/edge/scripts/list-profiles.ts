import { rawClient } from "@resolvezero/db/client";
const c = rawClient();
const rows = (await c`SELECT id, name, doh_token FROM profiles ORDER BY created_at`) as unknown[];
for (const r of rows) console.log(JSON.stringify(r));
await c.end();
process.exit(0);

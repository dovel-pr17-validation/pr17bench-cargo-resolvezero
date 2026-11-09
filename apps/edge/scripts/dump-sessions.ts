import { rawClient } from "@resolvezero/db/client";
const c = rawClient();
const s = (await c`SELECT token, user_id, expires_at < now() AS expired FROM session ORDER BY created_at DESC LIMIT 2`) as unknown[];
console.log(JSON.stringify(s));
await c.end();
process.exit(0);

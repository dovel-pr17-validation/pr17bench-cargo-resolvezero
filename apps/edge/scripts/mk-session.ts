import { rawClient } from "@resolvezero/db/client";
const client = rawClient();
const user = (await client`SELECT id FROM "user" LIMIT 1`)[0];
const token = "rzs" + crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
const id = crypto.randomUUID();
const now = new Date();
await client`
  INSERT INTO session (id, expires_at, token, created_at, updated_at, user_id)
  VALUES (${id}, ${new Date(Date.now() + 3600e3).toISOString()}, ${token}, ${now.toISOString()}, ${now.toISOString()}, ${user.id})`;
console.log("cookie: better-auth.session_token=" + token);
await client.end();

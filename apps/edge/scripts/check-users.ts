import { rawClient } from "@resolvezero/db/client";
const client = rawClient();
const users = await client`SELECT id, email, name, created_at FROM "user" ORDER BY created_at DESC LIMIT 5`;
console.log("users:", JSON.stringify(users));
const profs = await client`SELECT id, name, owner_user_id, doh_token IS NOT NULL AS has_token FROM profiles ORDER BY created_at DESC`;
console.log("profiles:", JSON.stringify(profs));
await client.end();

import { rawClient } from "@resolvezero/db/client";
const client = rawClient();
// assign `home` to Maciej; also give it an auto-generated token (hosting hygiene)
const token = crypto.randomUUID().replace(/-/g, "");
const r = await client`
  UPDATE profiles
     SET owner_user_id = 'otuey6NkyUIL5JeoDWlEScC03AeMhvLb',
         doh_token = ${token}
   WHERE id = '55eee5e7-b98f-4091-b080-3def0ab477b9'
     AND owner_user_id IS NULL
   RETURNING id, name`;
console.log("assigned:", JSON.stringify(r));
await client.end();

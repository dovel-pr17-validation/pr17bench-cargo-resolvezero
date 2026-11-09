import { rawClient } from "@resolvezero/db/client";
const client = rawClient();
const P = "55eee5e7-b98f-4091-b080-3def0ab477b9";
// drop the dead URL
await client`DELETE FROM profile_blocklists WHERE url = 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/multi.txt'`;
// add the live location (Multi NORMAL, adblock syntax — parser supports it)
const r = await client`
  INSERT INTO profile_blocklists (profile_id, url, format, enabled)
  VALUES (${P}, 'https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/multi.txt', 'abp', true)
  ON CONFLICT DO NOTHING RETURNING id`;
console.log("inserted:", JSON.stringify(r));
await client.end();

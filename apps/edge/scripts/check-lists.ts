import { sanitizePgUrl, rawClient } from "@resolvezero/db/client";
const client = rawClient();
const rows = (await client`SELECT enabled, last_status, entry_count, url FROM profile_blocklists`) as {
  enabled: boolean; last_status: string | null; entry_count: number; url: string;
}[];
for (const r of rows) console.log(r.entry_count, "|", r.last_status, "|", r.url.split("/").slice(-2).join("/"));
await client.end();

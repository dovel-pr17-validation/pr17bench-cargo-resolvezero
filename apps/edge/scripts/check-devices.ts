import { rawClient } from "@resolvezero/db/client";
const client = rawClient();
const rows = (await client`SELECT hour, top_devices FROM stats_hourly ORDER BY hour DESC LIMIT 3`) as { hour: string; top_devices: unknown }[];
for (const r of rows) console.log(r.hour, JSON.stringify(r.top_devices));
await client.end();
process.exit(0);

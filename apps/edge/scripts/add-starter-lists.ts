import { rawClient } from "@resolvezero/db/client";
const client = rawClient();
const P = "55eee5e7-b98f-4091-b080-3def0ab477b9";
const lists = [
  {
    profile_id: P,
    url: "https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt",
    format: "abp",
  },
  {
    profile_id: P,
    url: "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/multi.txt",
    format: "domains",
  },
];
for (const l of lists) {
  const inserted = await client`
    INSERT INTO profile_blocklists (profile_id, url, format, enabled)
    VALUES (${l.profile_id}, ${l.url}, ${l.format}, true)
    ON CONFLICT DO NOTHING
    RETURNING id`;
  console.log("inserted:", JSON.stringify(inserted));
}
await client.end();

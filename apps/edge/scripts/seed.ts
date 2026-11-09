/**
 * Dev seed: `home` profile (token-free DoH auth), a block rule, a zone
 * override. Idempotent — upserts by natural key.
 *
 * Usage: bun --env-file=.env apps/edge/scripts/seed.ts
 */
const { db, rawClient } = await import("@resolvezero/db/client");
const { profiles, profileRules, profileZones, profileBlocklists } = await import("@resolvezero/db/schema");
const { eq } = await import("drizzle-orm");

// 1. home profile (id-only auth so we can curl it trivially)
const existing = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.name, "home")).limit(1);
const profileId =
  existing[0]?.id ??
  (await db.insert(profiles).values({ name: "home" }).returning({ id: profiles.id }))[0]!.id;

// 2. rules: test-block + allowlist demo
await db
  .insert(profileRules)
  .values([
    { profileId, domain: "doubleclick.net", action: "block" },
    { profileId, domain: "evil-ads.net", action: "block" },
    { profileId, domain: "allowme.example", action: "allow" },
  ])
  .onConflictDoNothing();

// 3. zone override: nas.lan → local NAS (split-horizon sanity check)
await db
  .insert(profileZones)
  .values({ profileId, domain: "nas.lan", recordType: "A", values: ["192.168.1.24"], ttl: 120 })
  .onConflictDoNothing();

// 4. remote blocklists (Polish + anti-scam; hosts format, Pi-hole compatible)
await db
  .insert(profileBlocklists)
  .values([
    {
      profileId,
      url: "https://raw.githubusercontent.com/MajkiIT/polish-ads-filter/master/polish-pihole-filters/hostfile.txt",
      format: "hosts",
    },
    { profileId, url: "https://raw.githubusercontent.com/FiltersHeroes/KADhosts/master/KADhosts.txt", format: "hosts" },
  ])
  .onConflictDoNothing();

const id = profileId;
console.log(`seeded ✅ profile_id=${id}`);
console.log(`   DoH url:  http://localhost:8080/v1/${id}`);
console.log("   rules:    doubleclick.net(block), evil-ads.net(block), allowme.example(allow)");
console.log("   zone:     nas.lan → 192.168.1.24 (A, ttl 120)");
console.log("   lists:    polish-ads-filter hostfile.txt, KADhosts (remote blocklists)");
await rawClient().end();
process.exit(0);

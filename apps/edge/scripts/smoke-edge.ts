import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * - /readyz must be ok
 * - UDP and TCP 53 must answer (any RCODE; the CI runner's IP is not in
 *   profile_source_ips, so REFUSED is a valid listener response)
 * - DoH must forward, sinkhole a configured block rule, and answer a zone
 *
 * Usage:
 *   DATABASE_URL_ADMIN=... EDGE_IP=37.16.24.46 pnpm exec tsx apps/edge/scripts/smoke-edge.ts
 */
if (process.env.SMOKE_USE_ADMIN === "1" && process.env.DATABASE_URL_ADMIN) {
  process.env.DATABASE_URL = process.env.DATABASE_URL_ADMIN;
}
process.env.DATABASE_URL ??= process.env.DATABASE_URL_ADMIN;

const EDGE_IP = process.env.EDGE_IP ?? "37.16.24.46";
const DOH_BASE = process.env.EDGE_DOH_URL ?? "https://resolvezero-edge.fly.dev";

const failures: string[] = [];
function fail(msg: string): void {
  failures.push(msg);
  console.error(`FAIL ${msg}`);
}
function pass(msg: string): void {
  console.log(`ok   ${msg}`);
}

async function checkReady(): Promise<void> {
  const res = await fetch(`${DOH_BASE}/readyz`, { signal: AbortSignal.timeout(10_000) });
  if (res.status !== 200) return fail(`/readyz status ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (body.ok !== true) return fail(`/readyz not ok: ${JSON.stringify(body)}`);
  if (body.dns53Bound !== true) fail("/readyz dns53Bound false");
  if (body.blocklistsLoaded !== true) fail("/readyz blocklistsLoaded false");
  const age = Number(body.configPollAgeMs ?? 0);
  if (age > 300_000) fail(`config poll age ${age}ms > 300s`);
  const failed = Number(body.failedBlocklists ?? 0);
  if (failed > 0) console.warn(`WARN ${failed} blocklist(s) failed on boot`);
  pass(`/readyz (${body.region ?? "?"})`);
}

async function checkPort(protocol: "udp" | "tcp"): Promise<void> {
  const args = ["+time=3", "+tries=1"];
  if (protocol === "tcp") args.push("+tcp");
  args.push("example.com", `@${EDGE_IP}`);
  try {
    const { stdout } = await execFileAsync("dig", args, { timeout: 10_000 });
    const status = stdout.match(/status: ([A-Z]+)/)?.[1];
    if (!status) return fail(`${protocol} 53 got no DNS response`);
    // REFUSED is expected from a non-whitelisted CI runner; a response proves
    // the listener is alive and the process is routing DNS.
    pass(`${protocol} 53 responded status=${status}`);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    fail(`${protocol} 53 dig failed: ${(e.stderr || e.message || "unknown").trim()}`);
  }
}

async function main(): Promise<void> {
  console.log(`smoke start edge=${EDGE_IP} doh=${DOH_BASE}`);
  await checkReady();
  await checkPort("udp");
  await checkPort("tcp");
  console.log("network probes done");

  if (!process.env.DATABASE_URL) {
    fail("DATABASE_URL_ADMIN/DATABASE_URL not set — cannot run functional DoH checks");
    return;
  }

  const { db } = await import("@resolvezero/db/client");
  const { profiles, profileRules, profileZones } = await import("@resolvezero/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const { decode, encode } = await import("dns-packet");

  // Smoke checks must never pollute a customer's logs or rollups. Use a
  // dedicated log-disabled profile with its own block rule and zone. It is
  // created once, then reused by later deploys.
  const smokeName = process.env.SMOKE_PROFILE_NAME ?? "ci-smoke";
  const smokeDomain = "smoke-block.example";
  const smokeZone = "smoke-zone.lan";
  let [profile] = await db
    .select({ id: profiles.id, token: profiles.dohToken, logQueries: profiles.logQueries })
    .from(profiles)
    .where(eq(profiles.name, smokeName))
    .limit(1);

  let configChanged = false;
  if (!profile) {
    const token = randomBytes(24).toString("hex");
    [profile] = await db
      .insert(profiles)
      .values({ name: smokeName, dohToken: token, logQueries: false, logRetentionDays: 1 })
      .returning({ id: profiles.id, token: profiles.dohToken, logQueries: profiles.logQueries });
    configChanged = true;
  } else if (!profile.token || profile.logQueries) {
    const token = profile.token ?? randomBytes(24).toString("hex");
    await db
      .update(profiles)
      .set({ dohToken: token, logQueries: false })
      .where(eq(profiles.id, profile.id));
    profile = { ...profile, token, logQueries: false };
    configChanged = true;
  }

  if (!profile?.token) {
    fail("could not create a smoke profile with a DoH token");
    return;
  }

  const insertedRule = await db
    .insert(profileRules)
    .values({ profileId: profile.id, domain: smokeDomain, action: "block" })
    .onConflictDoNothing()
    .returning({ profileId: profileRules.profileId });
  const insertedZone = await db
    .insert(profileZones)
    .values({
      profileId: profile.id,
      domain: smokeZone,
      recordType: "A",
      values: ["192.0.2.1"],
      ttl: 60,
    })
    .onConflictDoNothing()
    .returning({ profileId: profileZones.profileId });
  configChanged ||= insertedRule.length > 0 || insertedZone.length > 0;

  if (configChanged) {
    // Edges poll the watermark every 5s; wait for this profile/rules/zone to
    // land before sending DoH checks, otherwise the first request can 404.
    console.log("smoke profile changed; waiting for edge config propagation…");
    await new Promise((resolve) => setTimeout(resolve, 7_000));
  }

  const dohPath = `${DOH_BASE}/v1/${encodeURIComponent(profile.id)}/${encodeURIComponent(profile.token)}`;

  async function dohQuery(name: string, type = "A"): Promise<Record<string, unknown>> {
    const wire = new Uint8Array(
      encode({
        id: 0x4242,
        type: "query",
        flags: 0x0100,
        questions: [{ name, type, class: "IN" }],
      } as never),
    );
    const res = await fetch(dohPath, {
      method: "POST",
      headers: { "content-type": "application/dns-message" },
      body: wire,
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 200) throw new Error(`DoH HTTP ${res.status}`);
    return decode(Buffer.from(await res.arrayBuffer())) as unknown as Record<string, unknown>;
  }

  // Forward path.
  try {
    const packet = await dohQuery("example.com", "A");
    const answers = (packet.answers as { data?: string }[] | undefined) ?? [];
    if (((packet.flags as number) & 0x000f) !== 0 || answers.length === 0) {
      fail("DoH forward: no NOERROR answer for example.com");
    } else {
      pass(`DoH forward example.com -> ${answers[0]?.data}`);
    }
  } catch (err) {
    fail(`DoH forward failed: ${String(err)}`);
  }

  // Sinkhole path from an actual block rule.
  try {
    const [rule] = await db
      .select({ domain: profileRules.domain })
      .from(profileRules)
      .where(and(eq(profileRules.profileId, profile.id), eq(profileRules.action, "block")))
      .limit(1);
    if (!rule) {
      console.warn("WARN no block rule for sinkhole smoke");
    } else {
      const packet = await dohQuery(rule.domain, "A");
      const data = ((packet.answers as { data?: string }[] | undefined) ?? [])[0]?.data;
      if (data === "0.0.0.0") pass(`DoH sinkhole ${rule.domain} -> 0.0.0.0`);
      else fail(`DoH sinkhole ${rule.domain} -> ${String(data)}`);
    }
  } catch (err) {
    fail(`DoH sinkhole failed: ${String(err)}`);
  }

  // Zone override path.
  try {
    const [zone] = await db
      .select({
        domain: profileZones.domain,
        recordType: profileZones.recordType,
        values: profileZones.values,
      })
      .from(profileZones)
      .where(eq(profileZones.profileId, profile.id))
      .limit(1);
    if (!zone) {
      console.warn("WARN no zone for zone-override smoke");
    } else {
      const zoneName = zone.domain.startsWith("*.") ? `smoke.${zone.domain.slice(2)}` : zone.domain;
      const packet = await dohQuery(zoneName, zone.recordType);
      const answers = (packet.answers as { data?: string | string[] }[] | undefined) ?? [];
      const flat = answers.flatMap((a) => (Array.isArray(a.data) ? a.data : [a.data]));
      if (zone.values.some((v) => flat.includes(v))) {
        pass(`DoH zone ${zoneName} ${zone.recordType} -> ${zone.values.join(",")}`);
      } else {
        fail(`DoH zone ${zoneName}: got ${JSON.stringify(flat)} expected ${zone.values.join(",")}`);
      }
    }
  } catch (err) {
    fail(`DoH zone failed: ${String(err)}`);
  }
}

try {
  await main();
} catch (err) {
  fail(`unexpected: ${String(err)}`);
}
if (failures.length > 0) {
  console.error(`\n${failures.length} smoke failure(s)`);
  process.exit(1);
}
console.log("\nedge smoke passed");
process.exit(0);

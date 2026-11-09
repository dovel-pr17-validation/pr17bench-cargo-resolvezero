/**
 * Imports a NextDNS "Download logs" CSV export into stats_hourly rollups
 * (readme §6 — seeds the dashboard with real history, benchmarks rollups).
 *
 * Usage:
 *   DATABASE_URL=... pnpm exec tsx scripts/import-nextdns.ts ./logs.csv --profile <profile_id> [--dry-run]
 *
 * Header-driven column mapping (known NextDNS columns + fallbacks), bad
 * rows counted and skipped. Domain/client maps are aggregated in full
 * fidelity per hour, capped at the same limits as the live rollup writer
 * (200 domains / 50 clients / 100 blocked). On conflict DO NOTHING, so
 * re-runs never double-count.
 */
import { sql } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { access } from "node:fs/promises";
import { Readable } from "node:stream";
import type { StatsTopEntry } from "@resolvezero/db/schema";

const { db } = await import("@resolvezero/db/client");
const { statsHourly } = await import("@resolvezero/db/schema");

interface Args {
  csv: string;
  profileId: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const args = argv.slice(2);
  let path = "";
  let profileId = "";
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--profile") profileId = args[++i] ?? "";
    else if (a === "--dry-run") dryRun = true;
    else if (!path) path = a;
  }
  if (!path || !profileId) {
    console.error("Usage: pnpm exec tsx scripts/import-nextdns.ts <logs.csv> --profile <profile_id> [--dry-run]");
    process.exit(1);
  }
  return { csv: path, profileId, dryRun };
}

// header alias candidates (first match wins, lowercased, trimmed)
const CANDIDATES = {
  domain: ["domain", "name", "hostname", "fqdn"],
  time: ["time", "timestamp", "date", "datetime", "logged_at"],
  client: ["client", "client_ip", "clientip", "ip", "device", "device_id"],
  rtt: ["rtt", "rtt_ms", "latency", "latency_ms"],
  action: ["action", "status", "decision", "result", "blocked"],
};

function columnIndex(header: string[]): Record<keyof typeof CANDIDATES, number> {
  const lower = header.map((h) => h.trim().toLowerCase());
  const out = {} as Record<keyof typeof CANDIDATES, number>;
  for (const [k, names] of Object.entries(CANDIDATES) as [keyof typeof CANDIDATES, string[]][]) {
    out[k] = lower.findIndex((h) => names.includes(h));
  }
  return out;
}

function parseTime(t: string): Date | null {
  for (const candidate of [t, t.replace(" UTC", "Z"), t.replace(" ", "T") + "Z"]) {
    const d = new Date(candidate);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function statusToAction(raw: string): "block" | "forward" {
  const s = raw.toLowerCase();
  return s.includes("block") || s === "true" || s === "1" ? "block" : "forward";
}

const MAX_TOP_DOMAINS = 200;
const MAX_TOP_CLIENTS = 50;
const MAX_TOP_BLOCKED = 100;

interface BucketAgg {
  total: number;
  blocked: number;
  rttSumMs: number;
  rttCount: number;
  domains: Map<string, number>;
  clients: Map<string, number>;
  blockedDomains: Map<string, number>;
}

const { csv, profileId, dryRun } = parseArgs(process.argv.slice(2));

const fileExists = await access(csv).then(() => true).catch(() => false);
if (!fileExists) {
  console.error(`File not found: ${csv}`);
  process.exit(1);
}

// ---- streaming parse (600MB+ files must never materialize in RAM) ----
const buckets = new Map<number, BucketAgg>(); // key: hour floor ms
let colIdx: Record<keyof typeof CANDIDATES, number> | null = null;
let skipped = 0;
let parsed = 0;
let remainder = "";

function processLine(line: string): void {
  if (!line) return;
  if (colIdx === null) {
    colIdx = columnIndex(line.split(","));
    if (colIdx.domain === -1 || colIdx.time === -1) {
      console.error("CSV header missing domain/time columns; got:", line);
      process.exit(1);
    }
    console.log("Columns:", colIdx);
    return;
  }
  try {
    const cells = line.split(",");
    const at = colIdx;
    const time = parseTime(cells[at.time] ?? "");
    const domain = (cells[at.domain] ?? "").trim().toLowerCase().split("?")[0] || "";
    if (!time || !domain) {
      skipped++;
      return;
    }
    const hourMs = Math.floor(time.getTime() / 3_600_000) * 3_600_000;
    let agg = buckets.get(hourMs);
    if (!agg) {
      agg = {
        total: 0, blocked: 0, rttSumMs: 0, rttCount: 0,
        domains: new Map(), clients: new Map(), blockedDomains: new Map(),
      };
      buckets.set(hourMs, agg);
    }
    agg.total++;
    incr(agg.domains, domain);
    const client = at.client >= 0 ? (cells[at.client] ?? "").trim() : "";
    if (client) incr(agg.clients, client);
    if (at.rtt >= 0) {
      const rtt = Number(cells[at.rtt]);
      if (Number.isFinite(rtt) && rtt >= 0) {
        agg.rttSumMs += Math.min(rtt, 32_767);
        agg.rttCount++;
      }
    }
    if (at.action >= 0 && statusToAction(cells[at.action] ?? "") === "block") {
      agg.blocked++;
      incr(agg.blockedDomains, domain);
    }
    parsed++;
    if (parsed % 100_000 === 0) console.log(`  parsed: ${parsed.toLocaleString()}`);
  } catch {
    skipped++;
  }
}

// Stream text, split on newlines (handles chunk boundaries across awaits).
const stream = Readable.toWeb(createReadStream(csv)).pipeThrough(new TextDecoderStream("utf-8"));
for await (const chunk of stream) {
  const text = remainder + chunk;
  const parts = text.split("\n");
  remainder = parts.pop() ?? "";
  for (const line of parts) processLine(line.replace(/\r$/, ""));
}
processLine(remainder.replace(/\r$/, "")); // final unterminated line

console.log(
  `Parsed ${parsed.toLocaleString()} rows across ${buckets.size.toLocaleString()} hourly buckets (skipped: ${skipped.toLocaleString()})`,
);

function toTop(map: Map<string, number>, cap: number, keyName: "domain" | "clientIp"): StatsTopEntry[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([k, count]) => (keyName === "domain" ? { domain: k, count } : { clientIp: k, count }));
}

if (dryRun) {
  for (const [hourMs, agg] of [...buckets.entries()].sort((a, b) => a[0] - b[0]).slice(0, 3)) {
    console.log("Sample bucket:", new Date(hourMs).toISOString(), {
      total: agg.total,
      blocked: agg.blocked,
      topDomains: toTop(agg.domains, 5, "domain"),
      topClients: toTop(agg.clients, 3, "clientIp"),
    });
  }
  process.exit(0);
}

// ---- write into stats_hourly (upsert, hour-aligned) ----
const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
console.log(`Writing ${sorted.length.toLocaleString()} hourly buckets for profile ${profileId}...`);

let batch: (typeof statsHourly.$inferInsert)[] = [];
for (const [hourMs, agg] of sorted) {
  batch.push({
    profileId,
    hour: new Date(hourMs),
    totalQueries: agg.total,
    blocked: agg.blocked,
    rttSumMs: agg.rttSumMs,
    rttCount: agg.rttCount,
    topDomains: toTop(agg.domains, MAX_TOP_DOMAINS, "domain"),
    topBlocked: toTop(agg.blockedDomains, MAX_TOP_BLOCKED, "domain"),
    topClients: toTop(agg.clients, MAX_TOP_CLIENTS, "clientIp"),
  });
  if (batch.length >= 100) {
    await db.insert(statsHourly).values(batch).onConflictDoNothing();
    batch = [];
  }
}
if (batch.length) {
  await db.insert(statsHourly).values(batch).onConflictDoNothing();
}

await db.execute(sql`SELECT 1`);
console.log("Import complete. (/stats now reflects imported history)");

function incr(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

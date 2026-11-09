import { Hono } from "hono";
import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { statsHourly, statsMinute, type StatsTopEntry } from "@resolvezero/db/schema";
import type { RuleStore } from "./ruleStore";
import { moduleLogger } from "./logger";

/**
 * Adaptive-resolution ladder (NextDNS parity, ~30 points per graph):
 *   30m → 1-min   (stats_minute)      6h  → 15-min (stats_minute)
 *   24h → 1-hour  (stats_hourly)      7d  → 6-hour (stats_hourly)
 *   30d → daily   (stats_hourly)      90d → daily  (stats_hourly)
 * Minute rows live ≤ 6h (pruned), so short ranges never touch the other table.
 */
export type RangeConfigEntry = { ms: number; bucketMs: number; source: "minute" | "hour" };
export type RangeConfigMap = Record<string, RangeConfigEntry>;
export const RANGE_CONFIG: RangeConfigMap = {
  "30m": { ms: 30 * 60_000, bucketMs: 60_000, source: "minute" },
  "6h": { ms: 6 * 3_600_000, bucketMs: 15 * 60_000, source: "minute" },
  "24h": { ms: 24 * 3_600_000, bucketMs: 3_600_000, source: "hour" },
  "7d": { ms: 7 * 86_400_000, bucketMs: 6 * 3_600_000, source: "hour" },
  "30d": { ms: 30 * 86_400_000, bucketMs: 86_400_000, source: "hour" },
  "90d": { ms: 90 * 86_400_000, bucketMs: 86_400_000, source: "hour" },
};

export type RangeKey = keyof typeof RANGE_CONFIG;

const log = moduleLogger("stats");

export interface StatsDeps {
  store: RuleStore;
}

/** Aggregates for the headline tiles — pure, unit-tested. */
export function sumTotals(rows: { totalQueries: number; blocked: number; rttSumMs: number; rttCount: number }[]) {
  let total = 0, blocked = 0, rttSumMs = 0, rttCount = 0;
  for (const r of rows) {
    total += r.totalQueries;
    blocked += r.blocked;
    rttSumMs += r.rttSumMs;
    rttCount += r.rttCount;
  }
  return {
    total,
    blocked,
    avgRttMs: rttCount > 0 ? Math.round(rttSumMs / rttCount) : null,
  };
}

/** Exact short-window totals from minute rows (no hourly interval skew). */
export function sumMinuteTotals(rows: { totalQueries: number; blocked: number }[]) {
  let total = 0;
  let blocked = 0;
  for (const r of rows) {
    total += r.totalQueries;
    blocked += r.blocked;
  }
  return { total, blocked };
}

export function mergeTop(lists: StatsTopEntry[][], keyName: "domain" | "clientIp" | "device", cap: number): StatsTopEntry[] {
  const counts = new Map<string, number>();
  for (const list of lists) {
    for (const e of list ?? []) {
      const k = keyName === "domain" ? e.domain : keyName === "device" ? e.device : e.clientIp;
      if (typeof k === "string") counts.set(k, (counts.get(k) ?? 0) + (e.count || 0));
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([k, count]) =>
      keyName === "domain" ? { domain: k, count } : keyName === "device" ? { device: k, count } : { clientIp: k, count },
    );
}

/** Buckets raw points into a zero-filled grid of exactly-width buckets ending now. Pure — unit-tested. */
export function buildSeries(
  points: { t: number; total: number; blocked: number }[],
  bucketMs: number,
  cfg: { ms: number; now: number },
): { bucket: string; total: number; blocked: number }[] {
  const start = Math.floor((cfg.now - cfg.ms) / bucketMs) * bucketMs;
  const end = Math.floor(cfg.now / bucketMs) * bucketMs; // current bucket included
  const byKey = new Map<number, { total: number; blocked: number }>();
  for (const p of points) {
    const k = Math.floor(p.t / bucketMs) * bucketMs;
    if (k < start || k > end) continue;
    const cur = byKey.get(k) ?? { total: 0, blocked: 0 };
    cur.total += p.total;
    cur.blocked += p.blocked;
    byKey.set(k, cur);
  }
  const out: { bucket: string; total: number; blocked: number }[] = [];
  for (let k = start; k <= end; k += bucketMs) {
    const cur = byKey.get(k) ?? { total: 0, blocked: 0 };
    out.push({ bucket: new Date(k).toISOString(), ...cur });
  }
  return out;
}

/**
 * Per-profile stats endpoints (readme §6.6 — NextDNS-style dashboard data).
 * Auth mirrors DoH: id in path; profiles with a token pass `?token=`.
 */
export function createStatsApp(deps: StatsDeps) {
  const app = new Hono().basePath("/v1");

  app.get(":profileId/stats", async (c) => {
    const profileId = c.req.param("profileId");
    const qToken = c.req.query("token");
    const h = c.req.header("authorization");
    const token = qToken ?? (h?.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() || undefined : undefined);

    if (!deps.store.hasProfile(profileId, token)) {
      return c.body(null, 404); // silent, same as DoH auth
    }

    const range = (c.req.query("range") ?? "24h") as RangeKey;
    const cfg = RANGE_CONFIG[range];
    if (!cfg) {
      return c.json({ error: "range must be 30m|6h|24h|7d|30d|90d" }, 400);
    }
    const rawLimit = Number(c.req.query("limit") ?? 10);
    const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 10, 1), 50);

    const now = Date.now();
    const since = new Date(now - cfg.ms);

    let series: { bucket: string; total: number; blocked: number }[];
    let totals: ReturnType<typeof sumTotals>;
    let hourlyForTops: {
      totalQueries: number;
      blocked: number;
      rttSumMs: number;
      rttCount: number;
      topDomains: StatsTopEntry[];
      topBlocked: StatsTopEntry[];
      topClients: StatsTopEntry[];
      topDevices?: StatsTopEntry[];
    }[];

    try {
      if (cfg.source === "minute") {
        // Short ranges: totals and points come from stats_minute so the
        // headline numbers exactly match the chart. Top lists and average RTT
        // are still hourly-granular; include the whole first overlapping hour
        // instead of filtering it out at the hour boundary.
        const minuteRows = await db
          .select({ minute: statsMinute.minute, totalQueries: statsMinute.totalQueries, blocked: statsMinute.blocked })
          .from(statsMinute)
          .where(and(eq(statsMinute.profileId, profileId), gte(statsMinute.minute, since)))
          .orderBy(asc(statsMinute.minute));

        const sinceHour = new Date(Math.floor(since.getTime() / 3_600_000) * 3_600_000);
        hourlyForTops = await db.select().from(statsHourly).where(
          and(eq(statsHourly.profileId, profileId), gte(statsHourly.hour, sinceHour)),
        );

        const exact = sumMinuteTotals(minuteRows);
        const hourly = sumTotals(hourlyForTops);
        totals = { ...exact, avgRttMs: hourly.avgRttMs };
        series = buildSeries(
          minuteRows.map((r) => ({ t: r.minute.getTime(), total: r.totalQueries, blocked: r.blocked })),
          cfg.bucketMs,
          { ms: cfg.ms, now },
        );
      } else {
        // Long ranges: everything from stats_hourly
        const hourRows = await db
          .select()
          .from(statsHourly)
          .where(and(eq(statsHourly.profileId, profileId), gte(statsHourly.hour, since)))
          .orderBy(asc(statsHourly.hour));

        hourlyForTops = hourRows;
        totals = sumTotals(hourRows);
        series = buildSeries(
          hourRows.map((r) => ({ t: r.hour.getTime(), total: r.totalQueries, blocked: r.blocked })),
          cfg.bucketMs,
          { ms: cfg.ms, now },
        );
      }
    } catch (err) {
      log.error({ err }, "stats query failed");
      return c.json({ error: "stats unavailable" }, 503);
    }

    return c.json({
      range,
      totalQueries: totals.total,
      blocked: totals.blocked,
      blockRatio: totals.total > 0 ? Number((totals.blocked / totals.total).toFixed(4)) : 0,
      avgRttMs: totals.avgRttMs,
      topDomains: mergeTop(hourlyForTops.map((r) => r.topDomains ?? []), "domain", limit),
      topBlocked: mergeTop(hourlyForTops.map((r) => r.topBlocked ?? []), "domain", limit),
      series,
      queriesPerClient: mergeTop(hourlyForTops.map((r) => r.topClients ?? []), "clientIp", limit),
      queriesPerDevice: mergeTop(hourlyForTops.map((r) => r.topDevices ?? []), "device", limit),
    });
  });

  return app;
}

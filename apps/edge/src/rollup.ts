import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { profiles, statsHourly, statsMinute, type StatsTopEntry } from "@resolvezero/db/schema";
import type { QueryLogRow } from "./batcher";
import { applyDeviceRollups } from "./deviceRollup";
import {
  MAX_TOP_BLOCKED,
  MAX_TOP_CLIENTS,
  MAX_TOP_DEVICES,
  MAX_TOP_DOMAINS,
  hourFloor,
  incr,
  lockBucket,
  mergeTopEntries,
  minuteFloor,
  toTopEntries,
  type Tx,
} from "./rollupShared";

// Re-exported so existing imports/tests keep one entry point.
export {
  MAX_TOP_BLOCKED,
  MAX_TOP_CLIENTS,
  MAX_TOP_DEVICES,
  MAX_TOP_DOMAINS,
  hourFloor,
  mergeTopEntries,
  minuteFloor,
  toTopEntries,
} from "./rollupShared";

/** Rows older than this in stats_minute are pruned by the daily job. */
export const MINUTE_RETENTION_HOURS = 6;

interface BucketAgg {
  profileId: string;
  hour: Date;
  total: number;
  blocked: number;
  rttSumMs: number;
  rttCount: number;
  domains: Map<string, number>;
  clients: Map<string, number>;
  devices: Map<string, number>;
  blockedDomains: Map<string, number>;
}

/**
 * Updates the stats_hourly rollups for a batch of flushed query-log rows.
 * Called on every batcher flush → /stats stays near-real-time.
 *
 * Concurrency: each (profile, hour) bucket is read-merge-written inside a
 * transaction holding `pg_advisory_xact_lock`, so two edge regions flushing
 * the same bucket serialize instead of losing increments.
 */
async function applyHourly(rows: QueryLogRow[], tx: Tx): Promise<void> {
  if (rows.length === 0) return;
  for (const agg of aggregate(rows).values()) {
    await applyBucket(agg, tx);
  }
}

/**
 * Full rollup pass per batcher flush: minute rows (totals-only counters,
 * SQL-additive upsert) + hourly rows (top-lists, read-merge-write).
 */
/**
 * Apply one batched flush atomically.
 *
 * Rows for profiles that no longer exist are dropped instead of failing the
 * batch: a stale buffer entry (rename/delete) used to wedge the queue and the
 * batcher replayed the batch forever, inflating stats and the archive.
 * Minute + hourly share one transaction, so a retry can never double-count.
 */
export async function updateRollups(rows: QueryLogRow[]): Promise<void> {
  if (rows.length === 0) return;

  await db.transaction(async (tx) => {
    const ids = [...new Set(rows.map((row) => row.profileId))];
    const known = new Set(
      (
        await tx.select({ id: profiles.id }).from(profiles).where(inArray(profiles.id, ids))
      ).map((row) => row.id),
    );
    const valid = selectRunnableRows(rows, known);
    if (valid.length === 0) return;

    await applyHourly(valid, tx);
    await applyMinutes(valid, tx);
    await applyDeviceRollups(valid, tx);
  });
}

/** Drop rows whose profile no longer exists (rename/delete leaves stale buffers). */
export function selectRunnableRows(rows: QueryLogRow[], knownProfileIds: Set<string>): QueryLogRow[] {
  return rows.filter((row) => knownProfileIds.has(row.profileId));
}

/**
 * Minute rollups: counters only, so a plain additive upsert is
 * race-safe across multiple edge writers (unlike the hour maps).
 */
async function applyMinutes(rows: QueryLogRow[], tx: Tx): Promise<void> {
  if (rows.length === 0) return;

  const buckets = new Map<string, { profileId: string; minute: Date; total: number; blocked: number }>();
  for (const row of rows) {
    const minute = minuteFloor(row.loggedAt);
    const key = `${row.profileId}|${minute.toISOString()}`;
    let b = buckets.get(key);
    if (!b) {
      b = { profileId: row.profileId, minute, total: 0, blocked: 0 };
      buckets.set(key, b);
    }
    b.total++;
    if (row.action === "block") b.blocked++;
  }

  for (const b of buckets.values()) {
    await tx
      .insert(statsMinute)
      .values({ profileId: b.profileId, minute: b.minute, totalQueries: b.total, blocked: b.blocked })
      .onConflictDoUpdate({
        target: [statsMinute.profileId, statsMinute.minute],
        set: {
          totalQueries: sql`${statsMinute.totalQueries} + excluded.total_queries`,
          blocked: sql`${statsMinute.blocked} + excluded.blocked`,
        },
      });
  }
}

/** Groups rows into per-(profile, hour) aggregates. Pure — unit-tested. */
export function aggregate(rows: QueryLogRow[]): Map<string, BucketAgg> {
  const buckets = new Map<string, BucketAgg>();
  for (const row of rows) {
    const hour = hourFloor(row.loggedAt);
    const key = `${row.profileId}|${hour.toISOString()}`;
    let agg = buckets.get(key);
    if (!agg) {
      agg = {
        profileId: row.profileId,
        hour,
        total: 0,
        blocked: 0,
        rttSumMs: 0,
        rttCount: 0,
        domains: new Map(),
        clients: new Map(),
        devices: new Map(),
        blockedDomains: new Map(),
      };
      buckets.set(key, agg);
    }
    agg.total++;
    if (row.action === "block") {
      agg.blocked++;
      incr(agg.blockedDomains, row.domain);
    }
    if (row.rttMs !== null) {
      agg.rttSumMs += row.rttMs;
      agg.rttCount++;
    }
    if (row.clientIp) incr(agg.clients, row.clientIp);
    if (row.device) incr(agg.devices, row.device);
    incr(agg.domains, row.domain);
  }
  return buckets;
}

async function applyBucket(agg: BucketAgg, tx: Tx): Promise<void> {
  // Read-modify-write must be serialized across edge regions. A
  // transaction-scoped advisory lock per (profile, hour) is cheap and
  // avoids a schema migration; the lock releases on commit/rollback.
  await lockBucket(tx, `${agg.profileId}:${agg.hour.getTime()}`);

  const existing = await tx
    .select()
    .from(statsHourly)
    .where(and(eq(statsHourly.profileId, agg.profileId), eq(statsHourly.hour, agg.hour)))
    .limit(1);

  const prev = existing[0] ?? {
    totalQueries: 0,
    blocked: 0,
    rttSumMs: 0,
    rttCount: 0,
    topDomains: [] as StatsTopEntry[],
    topBlocked: [] as StatsTopEntry[],
    topClients: [] as StatsTopEntry[],
    topDevices: [] as StatsTopEntry[],
  };

  const domains = new Map<string, number>();
  const clients = new Map<string, number>();
  const devices = new Map<string, number>();
  const blockedDomains = new Map<string, number>();
  mergeTopEntries(domains, prev.topDomains, "domain");
  mergeTopEntries(clients, prev.topClients, "clientIp");
  mergeTopEntries(devices, prev.topDevices ?? [], "device");
  mergeTopEntries(blockedDomains, prev.topBlocked, "domain");
  for (const [k, v] of agg.domains) incr(domains, k, v);
  for (const [k, v] of agg.clients) incr(clients, k, v);
  for (const [k, v] of agg.devices) incr(devices, k, v);
  for (const [k, v] of agg.blockedDomains) incr(blockedDomains, k, v);

  const values = {
    profileId: agg.profileId,
    hour: agg.hour,
    totalQueries: prev.totalQueries + agg.total,
    blocked: prev.blocked + agg.blocked,
    rttSumMs: prev.rttSumMs + agg.rttSumMs,
    rttCount: prev.rttCount + agg.rttCount,
    topDomains: toTopEntries(domains, MAX_TOP_DOMAINS, "domain"),
    topBlocked: toTopEntries(blockedDomains, MAX_TOP_BLOCKED, "domain"),
    topClients: toTopEntries(clients, MAX_TOP_CLIENTS, "clientIp"),
    topDevices: toTopEntries(devices, MAX_TOP_DEVICES, "device"),
  };

  await tx
    .insert(statsHourly)
    .values(values)
    .onConflictDoUpdate({
      target: [statsHourly.profileId, statsHourly.hour],
      set: {
        totalQueries: values.totalQueries,
        blocked: values.blocked,
        rttSumMs: values.rttSumMs,
        rttCount: values.rttCount,
        topDomains: values.topDomains,
        topBlocked: values.topBlocked,
        topClients: values.topClients,
        topDevices: values.topDevices,
      },
    });
}

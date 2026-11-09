import { and, eq, sql } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { statsHourlyDevice, statsMinuteDevice, type StatsTopEntry } from "@resolvezero/db/schema";

import type { QueryLogRow } from "./batcher";
import {
  MAX_DEVICE_TOP_BLOCKED,
  MAX_DEVICE_TOP_DOMAINS,
  hourFloor,
  incr,
  lockBucket,
  mergeTopEntries,
  minuteFloor,
  toTopEntries,
  type Tx,
} from "./rollupShared";

export interface DeviceBucketAgg {
  profileId: string;
  device: string;
  hour: Date;
  total: number;
  blocked: number;
  rttSumMs: number;
  rttCount: number;
  domains: Map<string, number>;
  blockedDomains: Map<string, number>;
}

const EMPTY_TOP: StatsTopEntry[] = [];

/**
 * Groups rows into per-(profile, device, hour) aggregates. Rows without a
 * device tag are skipped: they belong to the profile totals only.
 * Pure — unit-tested.
 */
export function aggregateDevices(rows: QueryLogRow[]): Map<string, DeviceBucketAgg> {
  const buckets = new Map<string, DeviceBucketAgg>();
  for (const row of rows) {
    if (!row.device) continue;
    const hour = hourFloor(row.loggedAt);
    const key = `${row.profileId}|${row.device}|${hour.toISOString()}`;
    let agg = buckets.get(key);
    if (!agg) {
      agg = {
        profileId: row.profileId,
        device: row.device,
        hour,
        total: 0,
        blocked: 0,
        rttSumMs: 0,
        rttCount: 0,
        domains: new Map(),
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
    incr(agg.domains, row.domain);
  }
  return buckets;
}

/**
 * Writes the per-device rollups for one flush. Runs inside the caller's
 * transaction so a retried batch can never double-count.
 *
 * Hourly rows hold top-lists, so they are read-merge-written under a
 * transaction-scoped advisory lock (same reason as the profile hourly rows).
 * Minute rows are counters only and use an additive upsert.
 */
export async function applyDeviceRollups(rows: QueryLogRow[], tx: Tx): Promise<void> {
  if (rows.length === 0) return;

  for (const agg of aggregateDevices(rows).values()) {
    await applyDeviceBucket(agg, tx);
  }
  await applyDeviceMinutes(rows, tx);
}

async function applyDeviceBucket(agg: DeviceBucketAgg, tx: Tx): Promise<void> {
  await lockBucket(tx, `device:${agg.profileId}:${agg.device}:${agg.hour.getTime()}`);

  const existing = await tx
    .select()
    .from(statsHourlyDevice)
    .where(
      and(
        eq(statsHourlyDevice.profileId, agg.profileId),
        eq(statsHourlyDevice.device, agg.device),
        eq(statsHourlyDevice.hour, agg.hour),
      ),
    )
    .limit(1);

  const prev = existing[0];
  const domains = new Map<string, number>();
  const blockedDomains = new Map<string, number>();
  mergeTopEntries(domains, prev?.topDomains ?? EMPTY_TOP, "domain");
  mergeTopEntries(blockedDomains, prev?.topBlocked ?? EMPTY_TOP, "domain");
  for (const [k, v] of agg.domains) incr(domains, k, v);
  for (const [k, v] of agg.blockedDomains) incr(blockedDomains, k, v);

  const values = {
    profileId: agg.profileId,
    device: agg.device,
    hour: agg.hour,
    totalQueries: (prev?.totalQueries ?? 0) + agg.total,
    blocked: (prev?.blocked ?? 0) + agg.blocked,
    rttSumMs: (prev?.rttSumMs ?? 0) + agg.rttSumMs,
    rttCount: (prev?.rttCount ?? 0) + agg.rttCount,
    topDomains: toTopEntries(domains, MAX_DEVICE_TOP_DOMAINS, "domain"),
    topBlocked: toTopEntries(blockedDomains, MAX_DEVICE_TOP_BLOCKED, "domain"),
  };

  await tx
    .insert(statsHourlyDevice)
    .values(values)
    .onConflictDoUpdate({
      target: [statsHourlyDevice.profileId, statsHourlyDevice.device, statsHourlyDevice.hour],
      set: {
        totalQueries: values.totalQueries,
        blocked: values.blocked,
        rttSumMs: values.rttSumMs,
        rttCount: values.rttCount,
        topDomains: values.topDomains,
        topBlocked: values.topBlocked,
      },
    });
}

async function applyDeviceMinutes(rows: QueryLogRow[], tx: Tx): Promise<void> {
  const buckets = new Map<
    string,
    { profileId: string; device: string; minute: Date; total: number; blocked: number }
  >();

  for (const row of rows) {
    if (!row.device) continue;
    const minute = minuteFloor(row.loggedAt);
    const key = `${row.profileId}|${row.device}|${minute.toISOString()}`;
    let b = buckets.get(key);
    if (!b) {
      b = { profileId: row.profileId, device: row.device, minute, total: 0, blocked: 0 };
      buckets.set(key, b);
    }
    b.total++;
    if (row.action === "block") b.blocked++;
  }

  for (const b of buckets.values()) {
    await tx
      .insert(statsMinuteDevice)
      .values({
        profileId: b.profileId,
        device: b.device,
        minute: b.minute,
        totalQueries: b.total,
        blocked: b.blocked,
      })
      .onConflictDoUpdate({
        target: [statsMinuteDevice.profileId, statsMinuteDevice.device, statsMinuteDevice.minute],
        set: {
          totalQueries: sql`${statsMinuteDevice.totalQueries} + excluded.total_queries`,
          blocked: sql`${statsMinuteDevice.blocked} + excluded.blocked`,
        },
      });
  }
}


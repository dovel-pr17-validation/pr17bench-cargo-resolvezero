import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { statsHourly, statsHourlyDevice, statsMinute, statsMinuteDevice } from "@resolvezero/db/schema";

import { overviewRange, type OverviewRangeKey } from "../../lib/overview-range";
import { findProfile } from "./profile.server";

export interface QueryVolumeData {
  profileId: string;
  profileName: string;
  range: OverviewRangeKey;
  /** Device tag when the chart is scoped to one device. */
  device: string | null;
  series: { bucket: string; total: number; blocked: number }[];
}

/**
 * Chart-only series loader; dashboard KPIs stay on their fixed 24h window.
 *
 * Short ranges read the minute tables, long ranges the hourly tables. Device
 * scoping switches to the per-device tables, which only contain device-tagged
 * DoH traffic.
 */
export async function loadQueryVolume(
  ownerUserId: string,
  range: OverviewRangeKey,
  profileId?: string,
  device?: string,
): Promise<QueryVolumeData> {
  const cfg = overviewRange(range);
  const now = Date.now();
  const start = Math.floor((now - cfg.ms) / cfg.bucketMs) * cfg.bucketMs;
  const end = Math.floor(now / cfg.bucketMs) * cfg.bucketMs;
  const profile = await findProfile(ownerUserId, profileId);
  const since = new Date(start);

  let rows: { at: Date; total: number; blocked: number }[];
  if (device) {
    rows =
      cfg.source === "minute"
        ? await db
            .select({ at: statsMinuteDevice.minute, total: statsMinuteDevice.totalQueries, blocked: statsMinuteDevice.blocked })
            .from(statsMinuteDevice)
            .where(
              and(
                eq(statsMinuteDevice.profileId, profile.id),
                eq(statsMinuteDevice.device, device),
                gte(statsMinuteDevice.minute, since),
              ),
            )
            .orderBy(asc(statsMinuteDevice.minute))
        : await db
            .select({ at: statsHourlyDevice.hour, total: statsHourlyDevice.totalQueries, blocked: statsHourlyDevice.blocked })
            .from(statsHourlyDevice)
            .where(
              and(
                eq(statsHourlyDevice.profileId, profile.id),
                eq(statsHourlyDevice.device, device),
                gte(statsHourlyDevice.hour, since),
              ),
            )
            .orderBy(asc(statsHourlyDevice.hour));
  } else if (cfg.source === "minute") {
    rows = await db
      .select({ at: statsMinute.minute, total: statsMinute.totalQueries, blocked: statsMinute.blocked })
      .from(statsMinute)
      .where(and(eq(statsMinute.profileId, profile.id), gte(statsMinute.minute, since)))
      .orderBy(asc(statsMinute.minute));
  } else {
    rows = await db
      .select({ at: statsHourly.hour, total: statsHourly.totalQueries, blocked: statsHourly.blocked })
      .from(statsHourly)
      .where(and(eq(statsHourly.profileId, profile.id), gte(statsHourly.hour, since)))
      .orderBy(asc(statsHourly.hour));
  }

  const byBucket = new Map<number, { total: number; blocked: number }>();
  for (const row of rows) {
    const key = Math.floor(row.at.getTime() / cfg.bucketMs) * cfg.bucketMs;
    const current = byBucket.get(key) ?? { total: 0, blocked: 0 };
    current.total += row.total;
    current.blocked += row.blocked;
    byBucket.set(key, current);
  }

  const series: QueryVolumeData["series"] = [];
  for (let t = start; t <= end; t += cfg.bucketMs) {
    const point = byBucket.get(t) ?? { total: 0, blocked: 0 };
    series.push({ bucket: new Date(t).toISOString(), ...point });
  }

  return {
    profileId: profile.id,
    profileName: profile.name,
    range,
    device: device ?? null,
    series,
  };
}

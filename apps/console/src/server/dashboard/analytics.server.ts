import { and, asc, eq, gte } from "drizzle-orm";
import { formatInTimeZone } from "date-fns-tz";
import { db } from "@resolvezero/db/client";
import { statsHourly } from "@resolvezero/db/schema";

import { merge, top } from "./aggregate";
import { findProfile } from "./profile.server";
import { HOUR, type AnalyticsData } from "./types";

/** Reject unknown zones rather than letting Intl throw during a render. */
export function normalizeTimeZone(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: value });
    return value;
  } catch {
    return "UTC";
  }
}

export async function loadAnalytics(
  ownerUserId: string,
  profileId?: string,
  tz?: string,
): Promise<AnalyticsData> {
  const profile = await findProfile(ownerUserId, profileId);
  const zone = normalizeTimeZone(tz);
  const now = new Date();
  // 31 days of rows so the earliest local day is complete in any timezone.
  const since = new Date(now.getTime() - 31 * 24 * HOUR);
  const rows = await db
    .select({
      hour: statsHourly.hour,
      total: statsHourly.totalQueries,
      blocked: statsHourly.blocked,
      topDomains: statsHourly.topDomains,
      topBlocked: statsHourly.topBlocked,
    })
    .from(statsHourly)
    .where(and(eq(statsHourly.profileId, profile.id), gte(statsHourly.hour, since)))
    .orderBy(asc(statsHourly.hour));

  const dayMap = new Map<string, { total: number; blocked: number }>();
  const hourMap = new Map<number, { total: number; blocked: number }>();
  const domains = new Map<string, number>();
  const blockedDomains = new Map<string, number>();
  let total30d = 0;
  let blocked30d = 0;

  for (const row of rows) {
    total30d += row.total;
    blocked30d += row.blocked;
    merge(domains, row.topDomains);
    merge(blockedDomains, row.topBlocked);
    const day = formatInTimeZone(row.hour, zone, "yyyy-MM-dd");
    const d = dayMap.get(day) ?? { total: 0, blocked: 0 };
    d.total += row.total;
    d.blocked += row.blocked;
    dayMap.set(day, d);
    const h = Math.floor(row.hour.getTime() / HOUR) * HOUR;
    const hv = hourMap.get(h) ?? { total: 0, blocked: 0 };
    hv.total += row.total;
    hv.blocked += row.blocked;
    hourMap.set(h, hv);
  }

  const hourSeries: AnalyticsData["series"]["24h"] = [];
  const hourStart = Math.floor((now.getTime() - 24 * HOUR) / HOUR) * HOUR;
  for (let t = hourStart; t <= Math.floor(now.getTime() / HOUR) * HOUR; t += HOUR) {
    const v = hourMap.get(t) ?? { total: 0, blocked: 0 };
    hourSeries.push({ label: formatInTimeZone(new Date(t), zone, "HH:mm"), ...v });
  }

  const days = (count: number) => {
    const out: AnalyticsData["series"]["7d"] = [];
    // Build calendar keys from "today in the viewer's zone" instead of UTC
    // midnight, so a UTC+13 viewer's last bucket really is their today.
    const [year, month, day] = formatInTimeZone(now, zone, "yyyy-MM-dd").split("-").map(Number);
    for (let i = count - 1; i >= 0; i--) {
      const key = new Date(Date.UTC(year!, month! - 1, day! - i)).toISOString().slice(0, 10);
      out.push({ label: key.slice(5), ...(dayMap.get(key) ?? { total: 0, blocked: 0 }) });
    }
    return out;
  };

  return {
    profileId: profile.id,
    profileName: profile.name,
    total30d,
    blocked30d,
    series: { "24h": hourSeries, "7d": days(7), "30d": days(30) },
    topBlocked: top(blockedDomains, 8).map(([domain, count]) => ({ domain, count })),
    topDomains: top(domains, 8).map(([domain, count]) => ({ domain, count })),
  };
}

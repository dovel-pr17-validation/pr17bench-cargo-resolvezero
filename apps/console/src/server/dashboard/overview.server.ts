import { and, asc, eq, gte } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import {
  edgeConfigState,
  profileRules,
  profileZones,
  statsHourly,
  statsHourlyDevice,
  type StatsTopEntry,
} from "@resolvezero/db/schema";

import { merge, top } from "./aggregate";
import { loadEdgeHealth } from "./edge.server";
import { findProfile, ownedProfiles } from "./profile.server";
import { HOUR, type OverviewData, type Viewer } from "./types";

/**
 * Overview payload for the rolling 24h window.
 *
 * `device` scopes every number to one device tag. Device rows only exist for
 * device-tagged DoH traffic, so a scoped view is a subset of the profile
 * total, not a partition of it.
 */
export async function loadOverview(
  ownerUserId: string,
  viewer: Viewer,
  profileId?: string,
  device?: string,
): Promise<OverviewData> {
  const activeDevice = device ?? null;
  const now = new Date();
  // Align the query and the plotted series to the same floored hour. Filtering
  // from `now - 24h` while plotting from the floored hour made the first
  // bucket look like a real zero even when it had queries.
  const start = Math.floor((now.getTime() - 24 * HOUR) / HOUR) * HOUR;
  const end = Math.floor(now.getTime() / HOUR) * HOUR;
  const startDate = new Date(start);
  const profile = await findProfile(ownerUserId, profileId);

  const [rows, deviceRows, configRows, rules, zones, edge, profiles] = await Promise.all([
    db
      .select({
        hour: statsHourly.hour,
        totalQueries: statsHourly.totalQueries,
        blocked: statsHourly.blocked,
        rttSumMs: statsHourly.rttSumMs,
        rttCount: statsHourly.rttCount,
        topDomains: statsHourly.topDomains,
        topBlocked: statsHourly.topBlocked,
        topClients: statsHourly.topClients,
      })
      .from(statsHourly)
      .where(and(eq(statsHourly.profileId, profile.id), gte(statsHourly.hour, startDate)))
      .orderBy(asc(statsHourly.hour)),
    db
      .select({
        device: statsHourlyDevice.device,
        hour: statsHourlyDevice.hour,
        totalQueries: statsHourlyDevice.totalQueries,
        blocked: statsHourlyDevice.blocked,
        rttSumMs: statsHourlyDevice.rttSumMs,
        rttCount: statsHourlyDevice.rttCount,
        topDomains: statsHourlyDevice.topDomains,
        topBlocked: statsHourlyDevice.topBlocked,
      })
      .from(statsHourlyDevice)
      .where(and(eq(statsHourlyDevice.profileId, profile.id), gte(statsHourlyDevice.hour, startDate)))
      .orderBy(asc(statsHourlyDevice.hour)),
    db
      .select({ configVersion: edgeConfigState.configVersion, blocklistVersion: edgeConfigState.blocklistVersion })
      .from(edgeConfigState)
      .where(eq(edgeConfigState.id, true))
      .limit(1),
    db
      .select({ domain: profileRules.domain })
      .from(profileRules)
      .where(eq(profileRules.profileId, profile.id)),
    db
      .select({ domain: profileZones.domain })
      .from(profileZones)
      .where(eq(profileZones.profileId, profile.id)),
    loadEdgeHealth(),
    ownedProfiles(ownerUserId),
  ]);

  // Device list + selector come from the per-device rollups, so the Devices
  // page, the selector and the scoped Overview all read the same numbers.
  const perDevice = new Map<string, number>();
  for (const row of deviceRows) {
    perDevice.set(row.device, (perDevice.get(row.device) ?? 0) + row.totalQueries);
  }
  const devices = [...perDevice.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([slug, queries]) => ({ device: slug, queries }));

  // Everything the page renders comes from either the profile rows or, when a
  // device is selected, that device's rows.
  const scopedRows = activeDevice ? deviceRows.filter((row) => row.device === activeDevice) : rows;

  let totalQueries = 0;
  let blocked = 0;
  let rttSumMs = 0;
  let rttCount = 0;
  const domainCounts = new Map<string, number>();
  const blockedCounts = new Map<string, number>();
  const clientCounts = new Map<string, number>();

  for (const row of scopedRows) {
    totalQueries += row.totalQueries;
    blocked += row.blocked;
    rttSumMs += row.rttSumMs;
    rttCount += row.rttCount;
    merge(domainCounts, row.topDomains);
    merge(blockedCounts, row.topBlocked);
  }
  if (!activeDevice) {
    for (const row of rows) merge(clientCounts, row.topClients as StatsTopEntry[]);
  }

  const byHour = new Map<number, { total: number; blocked: number }>();
  for (const row of scopedRows) {
    const key = Math.floor(row.hour.getTime() / HOUR) * HOUR;
    const current = byHour.get(key) ?? { total: 0, blocked: 0 };
    current.total += row.totalQueries;
    current.blocked += row.blocked;
    byHour.set(key, current);
  }
  const series: OverviewData["series"] = [];
  for (let t = start; t <= end; t += HOUR) {
    const point = byHour.get(t) ?? { total: 0, blocked: 0 };
    series.push({ bucket: new Date(t).toISOString(), ...point });
  }

  return {
    profileId: profile.id,
    profileName: profile.name,
    profiles,
    device: activeDevice,
    devices,
    deviceSince: activeDevice && scopedRows.length > 0 ? scopedRows[0]!.hour.toISOString() : null,
    generatedAt: new Date().toISOString(),
    configVersion: configRows[0]?.configVersion ?? 0,
    blocklistVersion: configRows[0]?.blocklistVersion ?? 0,
    ruleCount: rules.length,
    zoneCount: zones.length,
    viewer,
    edge,
    totalQueries,
    blocked,
    blockRatio: totalQueries > 0 ? Number((blocked / totalQueries).toFixed(4)) : 0,
    avgRttMs: rttCount > 0 ? Math.round(rttSumMs / rttCount) : null,
    activeDevices: activeDevice ? 1 : perDevice.size,
    series,
    topBlocked: top(blockedCounts, 5).map(([domain, count]) => ({ domain, count })),
    topDomains: top(domainCounts, 5).map(([domain, count]) => ({ domain, count })),
    topDevices: activeDevice
      ? [{ device: activeDevice, count: perDevice.get(activeDevice) ?? totalQueries }]
      : top(perDevice, 6).map(([slug, count]) => ({ device: slug, count })),
    topClients: top(clientCounts, 6).map(([clientIp, count]) => ({ clientIp, count })),
  };
}

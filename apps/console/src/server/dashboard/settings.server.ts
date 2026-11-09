import { and, eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import {
  profileBlockedServices,
  profileBlocklists,
  profileRules,
  profileSourceIps,
  profileZones,
  profiles,
} from "@resolvezero/db/schema";

import { isIP } from "node:net";

import { edgeBaseUrl } from "./edge.server";
import { findProfile } from "./profile.server";
import type { SettingsInput } from "../../lib/settings";
import type { CachePurgeResult, SettingsData } from "./types";

export async function loadSettings(ownerUserId: string, profileId?: string): Promise<SettingsData> {
  const profile = await findProfile(ownerUserId, profileId);
  const [full, sourceIps, rules, zones, lists, services] = await Promise.all([
    db
      .select({
        dohToken: profiles.dohToken,
        upstream: profiles.upstream,
        upstreamUrl: profiles.upstreamUrl,
        logQueries: profiles.logQueries,
        logRetentionDays: profiles.logRetentionDays,
        blockMode: profiles.blockMode,
        blockIpv4: profiles.blockIpv4,
        blockIpv6: profiles.blockIpv6,
        blockTtl: profiles.blockTtl,
        safeSearch: profiles.safeSearch,
        createdAt: profiles.createdAt,
      })
      .from(profiles)
      .where(eq(profiles.id, profile.id))
      .limit(1),
    db.select({ ip: profileSourceIps.ipAddress }).from(profileSourceIps).where(eq(profileSourceIps.profileId, profile.id)),
    db.select({ domain: profileRules.domain }).from(profileRules).where(eq(profileRules.profileId, profile.id)),
    db.select({ domain: profileZones.domain }).from(profileZones).where(eq(profileZones.profileId, profile.id)),
    db.select({ id: profileBlocklists.id }).from(profileBlocklists).where(eq(profileBlocklists.profileId, profile.id)),
    db
      .select({ service: profileBlockedServices.service })
      .from(profileBlockedServices)
      .where(eq(profileBlockedServices.profileId, profile.id)),
  ]);
  const p = full[0];
  if (!p) throw new Error("profile disappeared");
  return {
    profileId: profile.id,
    profileName: profile.name,
    hasDohToken: Boolean(p.dohToken),
    upstream: p.upstream,
    upstreamUrl: p.upstreamUrl,
    logQueries: p.logQueries,
    logRetentionDays: p.logRetentionDays,
    blockMode: (p.blockMode as SettingsData["blockMode"]) ?? "null",
    blockIpv4: p.blockIpv4,
    blockIpv6: p.blockIpv6,
    blockTtl: p.blockTtl,
    safeSearch: p.safeSearch ?? {},
    blockedServices: services.map((row) => row.service).sort(),
    createdAt: p.createdAt.toISOString(),
    sourceIps: sourceIps.map((row) => row.ip),
    counts: { rules: rules.length, zones: zones.length, lists: lists.length },
  };
}

/**
 * Remove one linked source IP from this profile. Linking itself happens at the
 * edge (`POST /v1/:profile/update-ip`) so the caller has to actually own the
 * IP; removal only needs ownership of the profile.
 */
export async function unlinkSourceIp(
  ownerUserId: string,
  ip: string,
  profileId?: string,
): Promise<{ ok: true; ip: string }> {
  const profile = await findProfile(ownerUserId, profileId);
  const address = ip.trim();
  if (!address || isIP(address) === 0) throw new Error("Enter a valid IP address");
  await db
    .delete(profileSourceIps)
    .where(and(eq(profileSourceIps.ipAddress, address), eq(profileSourceIps.profileId, profile.id)));
  return { ok: true, ip: address };
}

/** Queue an edge-cache purge. Upstream resolver caches remain TTL-bound. */
/** Persist resolver/logging settings for a profile. */
export async function updateSettings(
  ownerUserId: string,
  input: SettingsInput,
  profileId?: string,
): Promise<SettingsData> {
  const profile = await findProfile(ownerUserId, profileId);
  await db.transaction(async (tx) => {
    await tx
      .update(profiles)
      .set({
        upstream: input.upstream,
        upstreamUrl: input.upstreamUrl,
        logQueries: input.logQueries,
        logRetentionDays: input.logRetentionDays,
        blockMode: input.blockMode,
        blockIpv4: input.blockIpv4,
        blockIpv6: input.blockIpv6,
        blockTtl: input.blockTtl,
        safeSearch: input.safeSearch,
      })
      .where(eq(profiles.id, profile.id));

    await tx.delete(profileBlockedServices).where(eq(profileBlockedServices.profileId, profile.id));
    if (input.blockedServices.length > 0) {
      await tx
        .insert(profileBlockedServices)
        .values(input.blockedServices.map((service) => ({ profileId: profile.id, service })));
    }
  });
  return loadSettings(ownerUserId, profile.id);
}

export async function purgeCache(
  ownerUserId: string,
  domain: string,
  type?: string,
  profileId?: string,
): Promise<CachePurgeResult> {
  const profile = await findProfile(ownerUserId, profileId);
  const token = await db
    .select({ token: profiles.dohToken })
    .from(profiles)
    .where(eq(profiles.id, profile.id))
    .limit(1)
    .then((rows) => rows[0]?.token);
  if (!token) throw new Error("profile has no DoH token; cannot purge cache");

  const res = await fetch(`${edgeBaseUrl()}/v1/${encodeURIComponent(profile.id)}/cache/purge`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ name: domain, ...(type ? { type } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { name?: string; type?: string | null; error?: string };
  if (!res.ok) throw new Error(body.error ?? `edge returned HTTP ${res.status}`);
  return { ok: true, name: body.name ?? domain, type: body.type ?? null };
}

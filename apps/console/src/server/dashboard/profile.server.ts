import { asc, desc, eq } from "drizzle-orm";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { db } from "@resolvezero/db/client";
import { profiles, statsHourly } from "@resolvezero/db/schema";

/**
 * Resolve the profile this session is allowed to see. Every query below is
 * scoped by the owning user id; there is no global "latest profile" fallback.
 * An explicit profileId is verified against the same owned set before use.
 */
export async function findProfile(
  ownerUserId: string,
  requestedProfileId?: string | null,
  cookieHeader?: string,
): Promise<{ id: string; name: string }> {
  const owned = await db
    .select({ id: profiles.id, name: profiles.name })
    .from(profiles)
    .where(eq(profiles.ownerUserId, ownerUserId))
    .orderBy(asc(profiles.createdAt));

  if (owned.length === 0) {
    throw new Error("No DNS profile is linked to this account.");
  }

  if (requestedProfileId) {
    const requested = owned.find((profile) => profile.id === requestedProfileId);
    if (!requested) throw new Error("Profile not found.");
    return requested;
  }

  const preferred = preferredProfileId(cookieHeader);
  if (preferred) {
    const match = owned.find((profile) => profile.id === preferred);
    if (match) return match;
  }

  const configuredProfile = process.env.DASHBOARD_PROFILE_ID;
  if (configuredProfile) {
    const configured = owned.find((profile) => profile.id === configuredProfile);
    if (configured) return configured;
  }

  // Prefer the owned profile with the most recent rollup so the dashboard
  // follows the profile that is actually serving queries. The profile-id
  // tie-breaker makes fallback deterministic when profiles share an hour.
  const latest = await db
    .select({ profileId: statsHourly.profileId })
    .from(statsHourly)
    .innerJoin(profiles, eq(statsHourly.profileId, profiles.id))
    .where(eq(profiles.ownerUserId, ownerUserId))
    .orderBy(desc(statsHourly.hour), asc(statsHourly.profileId))
    .limit(1);
  if (latest[0]) {
    const active = owned.find((profile) => profile.id === latest[0]!.profileId);
    if (active) return active;
  }

  return owned[0]!;
}

/** Profile selection is a UI preference; ownership is re-checked in findProfile. */
function preferredProfileId(explicitCookieHeader?: string): string | null {
  try {
    const cookie = explicitCookieHeader ?? getRequestHeaders().get("cookie") ?? "";
    const match = cookie.match(/(?:^|;\s*)rz_profile_id=([^;]+)/);
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  } catch {
    return null;
  }
}

export async function ownedProfiles(ownerUserId: string): Promise<{ id: string; name: string }[]> {
  return db
    .select({ id: profiles.id, name: profiles.name })
    .from(profiles)
    .where(eq(profiles.ownerUserId, ownerUserId))
    .orderBy(asc(profiles.createdAt));
}

import { and, asc, eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { profileBlocklists } from "@resolvezero/db/schema";

import { normalizeBlocklistFormat, normalizeBlocklistUrl } from "../../lib/policy";
import { findProfile } from "./profile.server";
import type { BlocklistsData } from "./types";

export async function loadBlocklists(ownerUserId: string, profileId?: string): Promise<BlocklistsData> {
  const profile = await findProfile(ownerUserId, profileId);
  const lists = await db
    .select({
      id: profileBlocklists.id,
      url: profileBlocklists.url,
      format: profileBlocklists.format,
      detectedFormat: profileBlocklists.detectedFormat,
      enabled: profileBlocklists.enabled,
      entries: profileBlocklists.entryCount,
      lastSyncedAt: profileBlocklists.lastSyncedAt,
      lastStatus: profileBlocklists.lastStatus,
    })
    .from(profileBlocklists)
    .where(eq(profileBlocklists.profileId, profile.id))
    .orderBy(asc(profileBlocklists.url));

  return {
    profileId: profile.id,
    profileName: profile.name,
    lists: lists.map((list) => ({
      ...list,
      lastSyncedAt: list.lastSyncedAt ? list.lastSyncedAt.toISOString() : null,
    })),
  };
}

export async function createBlocklist(
  ownerUserId: string,
  input: { url: string; format: string; profileId?: string },
): Promise<{ id: string; url: string; format: string; enabled: boolean }> {
  const profile = await findProfile(ownerUserId, input.profileId);
  const url = normalizeBlocklistUrl(input.url);
  const format = normalizeBlocklistFormat(input.format);

  const existing = await db
    .select({ id: profileBlocklists.id })
    .from(profileBlocklists)
    .where(and(eq(profileBlocklists.profileId, profile.id), eq(profileBlocklists.url, url)))
    .limit(1);
  if (existing.length > 0) {
    throw new Error("That list is already subscribed on this profile.");
  }

  const [row] = await db
    .insert(profileBlocklists)
    .values({ profileId: profile.id, url, format, enabled: true })
    .returning({
      id: profileBlocklists.id,
      url: profileBlocklists.url,
      format: profileBlocklists.format,
      detectedFormat: profileBlocklists.detectedFormat,
      enabled: profileBlocklists.enabled,
    });
  if (!row) throw new Error("Could not save blocklist");
  return row;
}

export async function setBlocklistEnabled(
  ownerUserId: string,
  id: string,
  enabled: boolean,
  profileId?: string,
): Promise<{ id: string; enabled: boolean }> {
  const profile = await findProfile(ownerUserId, profileId);
  const [row] = await db
    .update(profileBlocklists)
    .set({ enabled })
    .where(and(eq(profileBlocklists.id, id), eq(profileBlocklists.profileId, profile.id)))
    .returning({ id: profileBlocklists.id, enabled: profileBlocklists.enabled });
  if (!row) throw new Error("Blocklist not found.");
  return row;
}

export async function removeBlocklist(
  ownerUserId: string,
  id: string,
  profileId?: string,
): Promise<{ ok: true }> {
  const profile = await findProfile(ownerUserId, profileId);
  await db
    .delete(profileBlocklists)
    .where(and(eq(profileBlocklists.id, id), eq(profileBlocklists.profileId, profile.id)));
  return { ok: true };
}

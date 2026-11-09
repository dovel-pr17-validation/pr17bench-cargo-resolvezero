import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, inArray } from "drizzle-orm";
import { randomBytes } from "node:crypto";

import { db } from "@resolvezero/db/client";
import {
  apikey,
  profileBlockedServices,
  profileBlocklists,
  profileDevices,
  profileRules,
  profileSourceIps,
  profileZones,
  profiles,
  statsHourly,
  statsHourlyDevice,
  statsMinute,
  statsMinuteDevice,
} from "@resolvezero/db/schema";

import { requireSessionUser } from "./auth.server";

const NAME_MAX = 40;

/** Trim + collapse whitespace; reject empty or over-long names. */
export function normalizeProfileName(raw: unknown): string {
  const name = String(raw ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name) throw new Error("Enter a profile name.");
  if (name.length > NAME_MAX) throw new Error(`Profile names are limited to ${NAME_MAX} characters.`);
  return name;
}

export const createProfile = createServerFn({ method: "POST" })
  .validator((data: { name?: string }) => ({ name: normalizeProfileName(data?.name) }))
  .handler(async ({ data }) => {
    const user = await requireSessionUser();
    const existing = await db
      .select({ name: profiles.name })
      .from(profiles)
      .where(eq(profiles.ownerUserId, user.id));
    if (existing.some((row) => row.name.toLowerCase() === data.name.toLowerCase())) {
      throw new Error("You already have a profile with that name.");
    }

    const [created] = await db
      .insert(profiles)
      .values({
        name: data.name,
        ownerUserId: user.id,
        // 24 hex chars, same shape as the existing tokens.
        dohToken: randomBytes(12).toString("hex"),
      })
      .returning({ id: profiles.id, name: profiles.name });

    return created!;
  });

export const deleteProfile = createServerFn({ method: "POST" })
  .validator((data: { id?: string }) => {
    const id = String(data?.id ?? "").trim();
    if (!/^[a-z0-9]{6,32}$/i.test(id)) throw new Error("Invalid profile.");
    return { id };
  })
  .handler(async ({ data }) => {
    const user = await requireSessionUser();
    const owned = await db
      .select({ id: profiles.id, name: profiles.name })
      .from(profiles)
      .where(eq(profiles.ownerUserId, user.id))
      .orderBy(asc(profiles.createdAt));

    if (owned.length <= 1) throw new Error("You need at least one profile.");
    if (!owned.some((profile) => profile.id === data.id)) throw new Error("Profile not found.");

    // Most child tables predate cascade delete; remove them explicitly and in
    // dependency order so the profile row can go.
    await db.transaction(async (tx) => {
      const drop = async (table: Parameters<typeof tx.delete>[0], column: unknown) => {
        await tx.delete(table).where(eq(column as never, data.id));
      };
      await drop(statsHourlyDevice, statsHourlyDevice.profileId);
      await drop(statsMinuteDevice, statsMinuteDevice.profileId);
      await drop(statsHourly, statsHourly.profileId);
      await drop(statsMinute, statsMinute.profileId);
      await drop(profileDevices, profileDevices.profileId);
      await drop(profileBlockedServices, profileBlockedServices.profileId);
      await drop(profileSourceIps, profileSourceIps.profileId);
      await drop(profileBlocklists, profileBlocklists.profileId);
      await drop(profileRules, profileRules.profileId);
      await drop(profileZones, profileZones.profileId);
      // Keys are bound to a profile through a JSON string in `metadata`
      // (text column); parse in JS rather than relying on a jsonb cast.
      const keys = await tx.select({ id: apikey.id, metadata: apikey.metadata }).from(apikey);
      const staleKeys = keys
        .filter((key) => {
          try {
            return (JSON.parse(key.metadata ?? "{}") as { profileId?: string }).profileId === data.id;
          } catch {
            return false;
          }
        })
        .map((key) => key.id);
      if (staleKeys.length > 0) {
        await tx.delete(apikey).where(inArray(apikey.id, staleKeys));
      }
      await tx.delete(profiles).where(and(eq(profiles.id, data.id), eq(profiles.ownerUserId, user.id)));
    });

    const remaining = owned.filter((profile) => profile.id !== data.id);
    return { deleted: data.id, nextProfileId: remaining[0]?.id ?? null };
  });

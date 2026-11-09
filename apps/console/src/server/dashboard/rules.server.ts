import { and, asc, eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import {
  edgeConfigState,
  profileRules,
  profileZones,
} from "@resolvezero/db/schema";

import { normalizeRuleAction, normalizeRuleDomain, type RuleAction } from "../../lib/policy";
import type { LocalDnsZone } from "../../lib/zone";
import { findProfile } from "./profile.server";
import type { LocalDnsData, RulesData } from "./types";

export async function loadRules(ownerUserId: string, profileId?: string): Promise<RulesData> {
  const profile = await findProfile(ownerUserId, profileId);
  const [rules, configRows] = await Promise.all([
    db
      .select({ domain: profileRules.domain, action: profileRules.action, enabled: profileRules.enabled })
      .from(profileRules)
      .where(eq(profileRules.profileId, profile.id))
      .orderBy(asc(profileRules.domain)),
    db
      .select({ configVersion: edgeConfigState.configVersion })
      .from(edgeConfigState)
      .where(eq(edgeConfigState.id, true))
      .limit(1),
  ]);

  const counts = {
    block: rules.filter((r) => r.action === "block").length,
    allow: rules.filter((r) => r.action === "allow").length,
  };
  return {
    profileId: profile.id,
    profileName: profile.name,
    configVersion: configRows[0]?.configVersion ?? 0,
    rules: rules.map((r) => ({
      domain: r.domain,
      action: r.action as "block" | "allow",
      enabled: r.enabled,
    })),
    counts,
  };
}

export async function createRule(
  ownerUserId: string,
  input: { domain: string; action: string; profileId?: string },
): Promise<{ domain: string; action: RuleAction; enabled: boolean }> {
  const profile = await findProfile(ownerUserId, input.profileId);
  const domain = normalizeRuleDomain(input.domain);
  const action = normalizeRuleAction(input.action);

  const [row] = await db
    .insert(profileRules)
    .values({ profileId: profile.id, domain, action, enabled: true })
    .onConflictDoUpdate({
      target: [profileRules.profileId, profileRules.domain],
      set: { action, enabled: true },
    })
    .returning({ domain: profileRules.domain, action: profileRules.action, enabled: profileRules.enabled });

  if (!row) throw new Error("Could not save rule");
  return { domain: row.domain, action: row.action as RuleAction, enabled: row.enabled };
}

export async function setRuleEnabled(
  ownerUserId: string,
  domain: string,
  enabled: boolean,
  profileId?: string,
): Promise<{ domain: string; enabled: boolean }> {
  const profile = await findProfile(ownerUserId, profileId);
  const normalized = normalizeRuleDomain(domain);

  const [row] = await db
    .update(profileRules)
    .set({ enabled })
    .where(and(eq(profileRules.profileId, profile.id), eq(profileRules.domain, normalized)))
    .returning({ domain: profileRules.domain, enabled: profileRules.enabled });

  if (!row) throw new Error("Rule not found.");
  return row;
}

export async function removeRule(
  ownerUserId: string,
  domain: string,
  profileId?: string,
): Promise<{ ok: true }> {
  const profile = await findProfile(ownerUserId, profileId);
  const normalized = normalizeRuleDomain(domain);
  await db
    .delete(profileRules)
    .where(and(eq(profileRules.profileId, profile.id), eq(profileRules.domain, normalized)));
  return { ok: true };
}

export async function loadLocalDns(ownerUserId: string, profileId?: string): Promise<LocalDnsData> {
  const profile = await findProfile(ownerUserId, profileId);
  const rows = await db
    .select({
      domain: profileZones.domain,
      recordType: profileZones.recordType,
      values: profileZones.values,
      ttl: profileZones.ttl,
    })
    .from(profileZones)
    .where(eq(profileZones.profileId, profile.id))
    .orderBy(asc(profileZones.domain), asc(profileZones.recordType));

  return {
    profileId: profile.id,
    profileName: profile.name,
    zones: rows.map((row) => ({
      domain: row.domain,
      recordType: row.recordType as LocalDnsZone["recordType"],
      values: row.values ?? [],
      ttl: row.ttl,
    })),
  };
}

export async function upsertLocalDnsZone(
  ownerUserId: string,
  zone: LocalDnsZone,
  profileId?: string,
): Promise<LocalDnsZone> {
  const profile = await findProfile(ownerUserId, profileId);
  await db
    .insert(profileZones)
    .values({
      profileId: profile.id,
      domain: zone.domain,
      recordType: zone.recordType,
      values: zone.values,
      ttl: zone.ttl,
    })
    .onConflictDoUpdate({
      target: [profileZones.profileId, profileZones.domain, profileZones.recordType],
      set: { values: zone.values, ttl: zone.ttl },
    });
  return zone;
}

export async function removeLocalDnsZone(
  ownerUserId: string,
  domain: string,
  recordType: LocalDnsZone["recordType"],
  profileId?: string,
): Promise<{ ok: true }> {
  const profile = await findProfile(ownerUserId, profileId);
  await db
    .delete(profileZones)
    .where(
      and(
        eq(profileZones.profileId, profile.id),
        eq(profileZones.domain, domain),
        eq(profileZones.recordType, recordType),
      ),
    );
  return { ok: true };
}

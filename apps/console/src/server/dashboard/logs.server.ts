import { eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { dnsProbes, profileBlocklists, profiles } from "@resolvezero/db/schema";

import { edgeBaseUrl } from "./edge.server";
import { findProfile } from "./profile.server";
import type { DnsProbeStatus, LogEntry } from "./types";

/**
 * Did this browser's probe query reach the edge? The edge only writes these
 * rows after profile/source-IP authentication, so this is not a public
 * resolver checker. The nonce carries the profile id as a prefix, which lets
 * us reject a session trying to poll another tenant's canary.
 */
export async function loadDnsProbe(ownerUserId: string, nonce: string): Promise<DnsProbeStatus> {
  const owned = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(eq(profiles.ownerUserId, ownerUserId));
  const allowed = owned.some((profile) => nonce.startsWith(profile.id.replace(/-/g, "")));
  if (!allowed) {
    return { seen: false, seenAt: null, region: null };
  }

  const rows = await db
    .select({
      seenAt: dnsProbes.seenAt,
      region: dnsProbes.region,
    })
    .from(dnsProbes)
    .where(eq(dnsProbes.nonce, nonce))
    .limit(1);
  const row = rows[0];
  return {
    seen: Boolean(row),
    seenAt: row?.seenAt.toISOString() ?? null,
    region: row?.region ?? null,
  };
}

export async function loadLogs(ownerUserId: string, profileId?: string): Promise<{ profileId: string; profileName: string; entries: LogEntry[] }> {
  const profile = await findProfile(ownerUserId, profileId);
  const [token, lists] = await Promise.all([
    db
      .select({ token: profiles.dohToken })
      .from(profiles)
      .where(eq(profiles.id, profile.id))
      .limit(1)
      .then((rows) => rows[0]?.token),
    db
      .select({ id: profileBlocklists.id, url: profileBlocklists.url })
      .from(profileBlocklists)
      .where(eq(profileBlocklists.profileId, profile.id)),
  ]);
  if (!token) throw new Error("profile has no DoH token; cannot read logs");

  const listLabels = new Map(lists.map((list) => [list.id, safeListLabel(list.url)]));
  const res = await fetch(`${edgeBaseUrl()}/v1/${encodeURIComponent(profile.id)}/logs?limit=100&format=jsonl&order=desc`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`edge logs returned HTTP ${res.status}`);
  const text = await res.text();
  const entries: LogEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row.warning) continue;
      const listId = row.listId == null ? null : String(row.listId);
      entries.push({
        time: String(row.time ?? ""),
        domain: String(row.domain ?? ""),
        action: String(row.action ?? ""),
        clientIp: row.clientIp == null ? null : String(row.clientIp),
        device: row.device == null ? null : String(row.device),
        rttMs: row.rttMs == null ? null : Number(row.rttMs),
        reason: row.reason == null ? null : String(row.reason),
        listId,
        listLabel: listId ? (listLabels.get(listId) ?? "Removed list") : null,
        region: row.region == null ? null : String(row.region),
        transport: row.transport == null ? null : String(row.transport),
        upstream: row.upstream == null ? null : String(row.upstream),
      });
    } catch {
      // ignore malformed/archive warning lines
    }
  }
  return { profileId: profile.id, profileName: profile.name, entries };
}

/** Display-safe list label — strips query/hash so tokenized URLs never reach the UI. */
function safeListLabel(raw: string): string {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    const label = `${url.hostname}${path}`;
    return label.length > 64 ? `${label.slice(0, 61)}…` : label;
  } catch {
    return "Custom list";
  }
}

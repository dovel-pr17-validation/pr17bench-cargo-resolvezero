import { createServerFn } from "@tanstack/react-start";

import { parseDeviceTag } from "../lib/device";
import { DEFAULT_OVERVIEW_RANGE, isOverviewRange } from "../lib/overview-range";
import { normalizeDomain, normalizeRecordType, normalizeZoneInput, type ZoneInput } from "../lib/zone";
import { sessionClient } from "./orpc/call.server";
import { normalizeTimeZone } from "./dashboard/analytics.server";

export type { OverviewData, RulesData, LocalDnsData } from "./dashboard.server";

const MAX_DOMAIN_LENGTH = 253;
const MAX_RECORD_TYPE_LENGTH = 16;
const MAX_LOCAL_DNS_VALUES = 8;
const MAX_LOCAL_DNS_VALUE_LENGTH = 255;
const MAX_LOCAL_DNS_RAW_LENGTH = 4096;

function validateProfileId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error("Invalid profile id");
  const value = raw.trim();
  if (!/^[a-z0-9]{6,32}$/i.test(value)) throw new Error("Invalid profile id");
  return value;
}

/**
 * Structural only: cheap length checks before auth, no mapping/dedup work.
 * Full DNS validation runs in the authenticated handler.
 */
function validateLocalDnsShape(data: unknown): ZoneInput & { profileId?: string } {
  if (!data || typeof data !== "object") throw new Error("Invalid local DNS input");
  const input = data as Record<string, unknown>;
  if (typeof input.domain !== "string" || input.domain.length > MAX_DOMAIN_LENGTH) {
    throw new Error("Invalid local DNS name");
  }
  if (typeof input.recordType !== "string" || input.recordType.length > MAX_RECORD_TYPE_LENGTH) {
    throw new Error("Invalid record type");
  }
  const values = input.values;
  if (typeof values === "string") {
    if (values.length > MAX_LOCAL_DNS_RAW_LENGTH) throw new Error("Too many answer values");
  } else if (Array.isArray(values)) {
    if (values.length > MAX_LOCAL_DNS_VALUES) throw new Error("Add at most 8 answer values");
    for (const value of values) {
      if (typeof value !== "string" || value.length > MAX_LOCAL_DNS_VALUE_LENGTH) {
        throw new Error("Invalid answer value");
      }
    }
  } else {
    throw new Error("Invalid answer values");
  }
  if (input.ttl !== undefined && typeof input.ttl !== "string" && typeof input.ttl !== "number") {
    throw new Error("Invalid TTL");
  }
  return {
    domain: input.domain,
    recordType: input.recordType,
    values: values as string[] | string,
    ttl: input.ttl as string | number | undefined,
    profileId: validateProfileId(input.profileId),
  };
}

function validateZoneKeyShape(data: unknown): { domain: string; recordType: string; profileId?: string } {
  if (!data || typeof data !== "object") throw new Error("Invalid local DNS input");
  const input = data as Record<string, unknown>;
  if (typeof input.domain !== "string" || input.domain.length > MAX_DOMAIN_LENGTH) {
    throw new Error("Invalid local DNS name");
  }
  if (typeof input.recordType !== "string" || input.recordType.length > MAX_RECORD_TYPE_LENGTH) {
    throw new Error("Invalid record type");
  }
  return {
    domain: input.domain,
    recordType: input.recordType,
    profileId: validateProfileId(input.profileId),
  };
}

export const getOverview = createServerFn({ method: "GET" })
  .validator((data: { device?: string } | undefined) => ({ device: parseDeviceTag(data?.device) }))
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.overview({ device: data.device });
  });

export const getQueryVolume = createServerFn({ method: "GET" })
  .validator((data: { range?: string; device?: string } | undefined) => {
    const range = data?.range ?? DEFAULT_OVERVIEW_RANGE;
    if (!isOverviewRange(range)) throw new Error("Invalid overview range");
    return { range, device: parseDeviceTag(data?.device) };
  })
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.queryVolume({ range: data.range, device: data.device });
  });

export const getRulesData = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.rules.list();
});

export const getLocalDnsData = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.localDns.list();
});

export const saveLocalDnsZone = createServerFn({ method: "POST" })
  .validator(validateLocalDnsShape)
  .handler(async ({ data }) => {
    const zone = normalizeZoneInput(data);
    const client = await sessionClient();
    return client.localDns.upsert({
      domain: zone.domain,
      recordType: zone.recordType,
      values: zone.values,
      ttl: zone.ttl,
    });
  });

export const deleteLocalDnsZone = createServerFn({ method: "POST" })
  .validator(validateZoneKeyShape)
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.localDns.delete({
      domain: normalizeDomain(data.domain),
      recordType: normalizeRecordType(data.recordType),
    });
  });

export const getBlocklistsData = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.blocklists.list();
});

export const getAnalyticsData = createServerFn({ method: "GET" })
  .validator((data: { tz?: string } | undefined) => ({ tz: normalizeTimeZone(data?.tz) }))
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.analytics({ tz: data.tz });
  });

export const getSettingsData = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.settings.get();
});

export const updateSettings = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    if (!data || typeof data !== "object") throw new Error("Invalid settings input");
    const input = data as Record<string, unknown>;
    if (typeof input.logQueries !== "boolean") throw new Error("Invalid log setting");
    if (typeof input.logRetentionDays !== "number") throw new Error("Invalid retention");
    if (input.upstream !== null && typeof input.upstream !== "string") throw new Error("Invalid upstream");
    if (input.upstreamUrl !== null && typeof input.upstreamUrl !== "string") {
      throw new Error("Invalid upstream URL");
    }
    if (typeof input.blockMode !== "string") throw new Error("Invalid block mode");
    if (typeof input.blockTtl !== "number") throw new Error("Invalid block TTL");
    if (input.blockIpv4 !== null && typeof input.blockIpv4 !== "string") throw new Error("Invalid block IPv4");
    if (input.blockIpv6 !== null && typeof input.blockIpv6 !== "string") throw new Error("Invalid block IPv6");
    return {
      upstream: input.upstream as "cloudflare" | "google" | "quad9" | null,
      upstreamUrl: input.upstreamUrl as string | null,
      logQueries: input.logQueries,
      logRetentionDays: input.logRetentionDays,
      blockMode: input.blockMode as "null" | "nxdomain" | "refused" | "custom",
      blockIpv4: (input.blockIpv4 as string | null) ?? null,
      blockIpv6: (input.blockIpv6 as string | null) ?? null,
      blockTtl: input.blockTtl,
      safeSearch: (input.safeSearch as { google?: boolean; bing?: boolean; duckduckgo?: boolean; youtube?: boolean }) ?? {},
      blockedServices: Array.isArray(input.blockedServices) ? (input.blockedServices as string[]) : [],
    };
  })
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.settings.update(data);
  });

export const unlinkSourceIp = createServerFn({ method: "POST" })
  .validator((data: { ip?: string }) => {
    const ip = String(data?.ip ?? "").trim();
    if (!ip || ip.length > 45) throw new Error("Enter a valid IP address");
    return { ip };
  })
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.settings.unlinkSourceIp({ ip: data.ip });
  });

export const getLogsData = createServerFn({ method: "GET" }).handler(async () => {
  const client = await sessionClient();
  return client.logs();
});

export const purgeCache = createServerFn({ method: "POST" })
  .validator((data: { domain: string; type?: string; profileId?: string }) => {
    const domain = String(data?.domain ?? "").trim().toLowerCase().replace(/\.+$/, "");
    if (
      !domain ||
      domain.length > 253 ||
      domain.includes("..") ||
      !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)+$/.test(domain)
    ) {
      throw new Error("Enter a valid DNS name");
    }
    const type = data?.type ? String(data.type).toUpperCase() : undefined;
    return { domain, type, profileId: validateProfileId(data?.profileId) };
  })
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.cache.purge({ domain: data.domain, type: data.type });
  });

export const checkDnsProbe = createServerFn({ method: "POST" })
  .validator((nonce: string) => {
    if (!/^[a-z0-9]{16,64}$/.test(nonce)) throw new Error("invalid probe nonce");
    return nonce;
  })
  .handler(async ({ data }) => {
    const [{ requireSessionUser }, { loadDnsProbe }] = await Promise.all([
      import("./auth.server"),
      import("./dashboard.server"),
    ]);
    const user = await requireSessionUser();
    return loadDnsProbe(user.id, data);
  });

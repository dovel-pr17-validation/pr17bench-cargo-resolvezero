import { z } from "zod";

/** Response schemas for the read procedures. Kept in one place so the
 *  OpenAPI document and the handlers cannot disagree. */

export const viewerSchema = z.object({
  name: z.string(),
  image: z.string().nullable(),
  email: z.string().nullable(),
});

export const edgeHealthSchema = z.object({
  ok: z.boolean(),
  region: z.string().nullable(),
  rulesLoaded: z.boolean(),
  blocklistsLoaded: z.boolean(),
  dns53Bound: z.boolean(),
  configPollAgeMs: z.number().nullable(),
  failedBlocklists: z.number(),
});

export const overviewSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  profiles: z.array(z.object({ id: z.string(), name: z.string() })),
  generatedAt: z.string(),
  configVersion: z.number(),
  blocklistVersion: z.number(),
  ruleCount: z.number(),
  zoneCount: z.number(),
  viewer: viewerSchema,
  edge: edgeHealthSchema,
  device: z.string().nullable(),
  devices: z.array(z.object({ device: z.string(), queries: z.number() })),
  deviceSince: z.string().nullable(),
  totalQueries: z.number(),
  blocked: z.number(),
  blockRatio: z.number(),
  avgRttMs: z.number().nullable(),
  activeDevices: z.number(),
  series: z.array(z.object({ bucket: z.string(), total: z.number(), blocked: z.number() })),
  topBlocked: z.array(z.object({ domain: z.string(), count: z.number() })),
  topDomains: z.array(z.object({ domain: z.string(), count: z.number() })),
  topDevices: z.array(z.object({ device: z.string(), count: z.number() })),
  topClients: z.array(z.object({ clientIp: z.string(), count: z.number() })),
});

export const queryVolumeSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  range: z.enum(["1h", "24h", "7d", "30d"]),
  device: z.string().nullable(),
  series: z.array(z.object({ bucket: z.string(), total: z.number(), blocked: z.number() })),
});

export const ruleRowSchema = z.object({
  domain: z.string(),
  action: z.enum(["block", "allow"]),
  enabled: z.boolean(),
});

export const rulesSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  configVersion: z.number(),
  rules: z.array(ruleRowSchema),
  counts: z.object({ block: z.number(), allow: z.number() }),
});

export const zoneSchema = z.object({
  domain: z.string(),
  recordType: z.enum(["A", "AAAA", "CNAME", "TXT"]),
  values: z.array(z.string()),
  ttl: z.number(),
});

export const localDnsSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  zones: z.array(zoneSchema),
});

export const blocklistsSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  lists: z.array(
    z.object({
      id: z.string(),
      url: z.string(),
      format: z.string(),
      detectedFormat: z.string().nullable(),
      enabled: z.boolean(),
      entries: z.number(),
      lastSyncedAt: z.string().nullable(),
      lastStatus: z.string().nullable(),
    }),
  ),
});

export const analyticsSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  total30d: z.number(),
  blocked30d: z.number(),
  series: z.object({
    "24h": z.array(z.object({ label: z.string(), total: z.number(), blocked: z.number() })),
    "7d": z.array(z.object({ label: z.string(), total: z.number(), blocked: z.number() })),
    "30d": z.array(z.object({ label: z.string(), total: z.number(), blocked: z.number() })),
  }),
  topBlocked: z.array(z.object({ domain: z.string(), count: z.number() })),
  topDomains: z.array(z.object({ domain: z.string(), count: z.number() })),
});

export const logEntrySchema = z.object({
  time: z.string(),
  domain: z.string(),
  action: z.string(),
  clientIp: z.string().nullable(),
  device: z.string().nullable(),
  rttMs: z.number().nullable(),
  reason: z.string().nullable(),
  listId: z.string().nullable(),
  listLabel: z.string().nullable(),
  region: z.string().nullable(),
  transport: z.string().nullable(),
  upstream: z.string().nullable(),
});

export const logsSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  entries: z.array(logEntrySchema),
});

export const settingsSchema = z.object({
  profileId: z.string(),
  profileName: z.string(),
  hasDohToken: z.boolean(),
  upstream: z.string().nullable(),
  upstreamUrl: z.string().nullable(),
  logQueries: z.boolean(),
  logRetentionDays: z.number(),
  blockMode: z.enum(["null", "nxdomain", "refused", "custom"]),
  blockIpv4: z.string().nullable(),
  blockIpv6: z.string().nullable(),
  blockTtl: z.number(),
  safeSearch: z.object({
    google: z.boolean().optional(),
    bing: z.boolean().optional(),
    duckduckgo: z.boolean().optional(),
    youtube: z.boolean().optional(),
  }),
  blockedServices: z.array(z.string()),
  createdAt: z.string(),
  sourceIps: z.array(z.string()),
  counts: z.object({ rules: z.number(), zones: z.number(), lists: z.number() }),
});

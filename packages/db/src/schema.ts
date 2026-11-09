import { customAlphabet } from "nanoid";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const inet = customType<{ data: string; driverData: string }>({
  dataType() {
    return "inet";
  },
});

// ---- Better-Auth tables (login-first phase, readme §4a) ----
// Shapes mirror @better-auth/core 1.7 db contract exactly (drizzle adapter).
// IDs are strings (better-auth generates uuids) — do NOT "fix" these to uuid
// FK types, the adapter treats ids as text.

const baText = (name: string) => varchar(name, { length: 255 });

/** CSPRNG-backed 8-char lowercase base36 id (36^8 ≈ 2.8e12). */
const newProfileId = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 8);

export const user = pgTable("user", {
  id: baText("id").primaryKey(),
  name: baText("name").notNull(),
  email: baText("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: baText("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable(
  "session",
  {
    id: baText("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: baText("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: baText("ip_address"),
    userAgent: baText("user_agent"),
    userId: baText("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: baText("id").primaryKey(),
    accountId: baText("account_id").notNull(),
    providerId: baText("provider_id").notNull(),
    userId: baText("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: baText("access_token"),
    refreshToken: baText("refresh_token"),
    idToken: baText("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: baText("scope"),
    password: baText("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: baText("id").primaryKey(),
    identifier: baText("identifier").notNull(),
    value: baText("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

/**
 * Better Auth API keys (`@better-auth/api-key`). `referenceId` is the owning
 * user; the bound profile and scope live in `metadata` as JSON:
 *   { "profileId": "<uuid>", "scope": "read" | "read-write" }
 * Keys are stored hashed by the plugin — never store the raw value.
 */
export const apikey = pgTable(
  "apikey",
  {
    id: baText("id").primaryKey(),
    configId: baText("config_id").notNull().default("default"),
    name: baText("name"),
    start: baText("start"),
    prefix: baText("prefix"),
    key: baText("key").notNull(),
    referenceId: baText("reference_id").notNull(),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: timestamp("last_refill_at", { withTimezone: true }),
    enabled: boolean("enabled").notNull().default(true),
    rateLimitEnabled: boolean("rate_limit_enabled").notNull().default(true),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count").notNull().default(0),
    remaining: integer("remaining"),
    lastRequest: timestamp("last_request", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (t) => [index("apikey_key_idx").on(t.key), index("apikey_reference_idx").on(t.referenceId)],
);

/** Append-only trail of mutating API calls (session or key). */
export const apiAuditLog = pgTable(
  "api_audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: varchar("profile_id", { length: 8 })
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 255 }).notNull(),
    /** Null for session calls. */
    keyId: varchar("key_id", { length: 255 }),
    /** How the caller authenticated: 'session' | 'key'. */
    via: varchar("via", { length: 16 }).notNull(),
    procedure: varchar("procedure", { length: 120 }).notNull(),
    /** Short human-readable description, never the raw payload. */
    summary: varchar("summary", { length: 255 }),
    status: varchar("status", { length: 16 }).notNull(), // 'ok' | 'error'
    ip: varchar("ip", { length: 64 }),
    userAgent: varchar("user_agent", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("api_audit_log_profile_created_idx").on(t.profileId, t.createdAt)],
);

export const profiles = pgTable("profiles", {
  /** 8-char lowercase base36 id (url-safe); replaces the old uuid. */
  id: varchar("id", { length: 8 }).primaryKey().$defaultFn(() => newProfileId()),
  name: varchar("name", { length: 255 }).notNull(),
  dohToken: varchar("doh_token", { length: 255 }).unique(),
  logQueries: boolean("log_queries").notNull().default(true),
  logRetentionDays: integer("log_retention_days").notNull().default(30),
  /** Upstream resolver selector: 'cloudflare' | 'google' | 'quad9' | ... (null = edge default) */
  upstream: varchar("upstream", { length: 50 }),
  /** Custom upstream DoH URL — wins over `upstream` preset when set (self-hosters). */
  upstreamUrl: varchar("upstream_url", { length: 255 }),
  /** How blocked answers are shaped: null | nxdomain | refused | custom. */
  blockMode: varchar("block_mode", { length: 16 }).notNull().default("null"),
  /** Custom block answers, only used when block_mode = 'custom'. */
  blockIpv4: varchar("block_ipv4", { length: 45 }),
  blockIpv6: varchar("block_ipv6", { length: 45 }),
  /** TTL for synthesised block answers (seconds). */
  blockTtl: integer("block_ttl").notNull().default(300),
  /** SafeSearch engines forced for this profile (CNAME rewrites). */
  safeSearch: jsonb("safe_search").$type<SafeSearchSettings>().notNull().default(sql`'{}'::jsonb`),
  /** Lowercase label used for DoT: `<dot_id>.dot.resolvezero.com`. */
  dotId: varchar("dot_id", { length: 32 }).unique(),
  /** Owning account (better-auth user id) — nullable until hosted launch flips NOT NULL. */
  ownerUserId: varchar("owner_user_id", { length: 255 }).references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

/** Per-engine SafeSearch toggles stored on the profile as jsonb. */
export interface SafeSearchSettings {
  google?: boolean;
  bing?: boolean;
  duckduckgo?: boolean;
  youtube?: boolean;
}

/**
 * Services a profile blocks wholesale (TikTok, YouTube, …). The catalog lives
 * in `services.ts`; the edge expands these ids into synthetic block rules.
 */
export const profileBlockedServices = pgTable(
  "profile_blocked_services",
  {
    profileId: varchar("profile_id", { length: 8 })
      .notNull()
      .references(() => profiles.id, { onUpdate: "cascade", onDelete: "cascade" }),
    service: varchar("service", { length: 32 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.service] })],
);

/**
 * Public waitlist for hosted access. Pre-account only: one row per email,
 * lowercased, no marketing consent beyond "we will email you when invited".
 */
export const waitlist = pgTable("waitlist", {
  email: varchar("email", { length: 254 }).primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Single-row watermark for edge config propagation. Triggers bump one of the
 * counters in the same transaction as the config write; edges poll this row
 * (LISTEN/NOTIFY is intentionally not used). `id` is always true.
 */
export const edgeConfigState = pgTable("edge_config_state", {
  id: boolean("id").primaryKey().default(true),
  configVersion: integer("config_version").notNull().default(0),
  blocklistVersion: integer("blocklist_version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Flat domain rules, expanded for fast edge lookups.
// Suffix semantics: stored "corp.example.com" matches "*.corp.example.com".
export const profileRules = pgTable(
  "profile_rules",
  {
    profileId: varchar("profile_id", { length: 8 })
      .notNull()
      .references(() => profiles.id),
    domain: varchar("domain", { length: 255 }).notNull(),
    action: varchar("action", { length: 20 }).notNull(), // 'block' | 'allow'
    /** Disabled rules stay stored (and visible in the console) but never reach the edge. */
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.domain] })],
);

/**
 * Custom DNS zone records served locally from the edge cache (split-horizon
 * DNS rewrites, LAN names, overrides). Exact-match by default; entries whose
 * domain starts with "*." use suffix-wildcard semantics.
 * Order: zone override → policy (block/allow) → cache → upstream.
 */
export const profileZones = pgTable(
  "profile_zones",
  {
    profileId: varchar("profile_id", { length: 8 })
      .notNull()
      .references(() => profiles.id),
    domain: varchar("domain", { length: 255 }).notNull(), // 'nas.lan' or '*.home.example.com'
    recordType: varchar("record_type", { length: 10 }).notNull(), // 'A' | 'AAAA' | 'CNAME' | 'TXT'
    // One value per row entry; multiple rows round-robin-ish (all returned).
    values: jsonb("values").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    ttl: integer("ttl").notNull().default(300),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.domain, t.recordType] })],
);

/**
 * Short-lived resolver-presence canaries (dashboard "this device uses
 * ResolveZero DNS" check). The edge records a random nonce only after the
 * caller is authorized for a profile; the console polls for it. The daily
 * retention job removes rows older than 15 minutes.
 */
export const dnsProbes = pgTable(
  "dns_probes",
  {
    nonce: varchar("nonce", { length: 64 }).primaryKey(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
    region: varchar("region", { length: 32 }),
    transport: varchar("transport", { length: 8 }).notNull(),
  },
  (t) => [index("dns_probes_seen_at_idx").on(t.seenAt)],
);

/**
 * Per-POP DNS-cache purge requests. Edges poll this table (~5s), remove
 * matching entries from their local LRU, and leave the row for audit/prune.
 * The cache itself is global (not profile-scoped), so a purge may evict the
 * same upstream answer for other profiles; that is safe because rules/zones
 * are evaluated before the cache.
 */
export const dnsCachePurges = pgTable(
  "dns_cache_purges",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: varchar("profile_id", { length: 8 })
      .notNull()
      .references(() => profiles.id, { onDelete: "cascade" }),
    domain: varchar("domain", { length: 255 }).notNull(),
    /** NULL = purge every record type for the name. */
    recordType: varchar("record_type", { length: 10 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dns_cache_purges_created_at_idx").on(t.createdAt)],
);

/**
 * Devices seen per profile (lazy-created on first device-tagged DoH query).
 * The edge inserts on first sight; the dashboard later reads/renames.
 * slug stays the raw client-provided tag (≤64 chars, url-safe charset).
 */
export const profileDevices = pgTable(
  "profile_devices",
  {
    profileId: varchar("profile_id", { length: 8 })
      .notNull()
      .references(() => profiles.id),
    slug: varchar("slug", { length: 64 }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.profileId, t.slug] })],
);

// Optional UDP ingress whitelist per profile (routers / legacy devices)
export const profileSourceIps = pgTable("profile_source_ips", {
  ipAddress: inet("ip_address").primaryKey(),
  profileId: varchar("profile_id", { length: 8 })
    .notNull()
    .references(() => profiles.id),
})

/** Shape of entries inside the top_* jsonb lists. */
export interface StatsTopEntry {
  domain?: string;
  clientIp?: string;
  device?: string;
  count: number;
}

/**
 * Hourly stats rollups — the ONLY query-log-derived data in Postgres.
 * Raw logs live in S3-compatible storage (readme §3 C); PG holds bounded
 * aggregate rows so /stats stays near-real-time and PG stays tiny.
 *
 * Bounded per row: top 200 domains / top 50 clients / top 100 blocked
 * (excess trimmed in app code by the rollup writer).
 */
export const statsHourly = pgTable(
  "stats_hourly",
  {
    profileId: varchar("profile_id", { length: 8 })
      .notNull()
      .references(() => profiles.id),
    /** Start of the aggregated hour (UTC). */
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    totalQueries: integer("total_queries").notNull().default(0),
    blocked: integer("blocked").notNull().default(0),
    /** Sum of upstream RTT over forwarded queries (ms) + count for mean. */
    rttSumMs: bigint("rtt_sum_ms", { mode: "number" }).notNull().default(0),
    rttCount: integer("rtt_count").notNull().default(0),
    /** Sorted desc, capped at 200 */
    topDomains: jsonb("top_domains").$type<StatsTopEntry[]>().notNull().default(sql`'[]'::jsonb`),
    /** Capped at 100 */
    topBlocked: jsonb("top_blocked").$type<StatsTopEntry[]>().notNull().default(sql`'[]'::jsonb`),
    /** Capped at 50 */
    topClients: jsonb("top_clients").$type<StatsTopEntry[]>().notNull().default(sql`'[]'::jsonb`),
    /** Capped at 50 — device slugs from device-tagged DoH paths */
    topDevices: jsonb("top_devices").$type<StatsTopEntry[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    // one row per profile per hour — the rollup writer upserts on this
    primaryKey({ columns: [t.profileId, t.hour] }),
  ],
);

/**
 * Per-device hourly rollups. Same shape as `stats_hourly`, keyed by the device
 * slug carried in device-tagged DoH paths (`/v1/:profile/:device`). Only rows
 * with a device tag land here, so the sum of device rows is a subset of the
 * profile total (tagged DoH traffic only).
 *
 * Top lists are capped smaller than the profile row because they are
 * multiplied by devices × hours.
 */
export const statsHourlyDevice = pgTable(
  "stats_hourly_device",
  {
    profileId: varchar("profile_id", { length: 8 })
      .notNull()
      .references(() => profiles.id, { onUpdate: "cascade", onDelete: "cascade" }),
    /** Raw client-provided slug (`[a-zA-Z0-9_-]{1,32}` at the edge). */
    device: varchar("device", { length: 64 }).notNull(),
    hour: timestamp("hour", { withTimezone: true }).notNull(),
    totalQueries: integer("total_queries").notNull().default(0),
    blocked: integer("blocked").notNull().default(0),
    rttSumMs: bigint("rtt_sum_ms", { mode: "number" }).notNull().default(0),
    rttCount: integer("rtt_count").notNull().default(0),
    /** Capped at 50 */
    topDomains: jsonb("top_domains").$type<StatsTopEntry[]>().notNull().default(sql`'[]'::jsonb`),
    /** Capped at 50 */
    topBlocked: jsonb("top_blocked").$type<StatsTopEntry[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.device, t.hour] }),
    index("stats_hourly_device_profile_hour_idx").on(t.profileId, t.hour),
  ],
);

/**
 * Per-device minute rollups (totals + blocked only), used by the 1H chart
 * range when a device is selected. Pruned with `stats_minute`.
 */
export const statsMinuteDevice = pgTable(
  "stats_minute_device",
  {
    profileId: varchar("profile_id", { length: 8 })
      .notNull()
      .references(() => profiles.id, { onUpdate: "cascade", onDelete: "cascade" }),
    device: varchar("device", { length: 64 }).notNull(),
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    totalQueries: integer("total_queries").notNull().default(0),
    blocked: integer("blocked").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.device, t.minute] }),
    index("stats_minute_device_profile_minute_idx").on(t.profileId, t.minute),
  ],
);

/**
 * Minute-level stats for short-range charts (~NextDNS "30m/6h" views).
 * Totals only (no top-lists — hourly rolls own those). Hard-bounded:
 * rows older than MINUTE_RETENTION_HOURS are pruned by the daily job.
 */
export const statsMinute = pgTable(
  "stats_minute",
  {
    profileId: varchar("profile_id", { length: 8 })
      .notNull()
      .references(() => profiles.id),
    /** Start of the aggregated minute (UTC). */
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    totalQueries: integer("total_queries").notNull().default(0),
    blocked: integer("blocked").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.profileId, t.minute] }),
  ],
);

/**
 * Remote blocklist subscriptions per profile (custom-URL blocklists).
 * PG stores ONLY urls + sync metadata; the parsed domain sets live in edge
 * memory (same as profile_rules). Each edge fetches lists independently —
 * a BLOCKLIST NOTIFY kicks them into a re-sync.
 *
 * format: 'hosts' (0.0.0.0 d, Pi-hole/KADhosts) | 'domains' (plain list)
 *         | 'abp' (||d^ blocks + @@||d^ exceptions)
 */
export const profileBlocklists = pgTable(
  "profile_blocklists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    profileId: varchar("profile_id", { length: 8 })
      .notNull()
      .references(() => profiles.id),
    url: varchar("url", { length: 1024 }).notNull(),
    format: varchar("format", { length: 16 }).notNull().default("hosts"),
    /** Format the edge detected from the payload when `format` is `auto`. */
    detectedFormat: varchar("detected_format", { length: 16 }),
    enabled: boolean("enabled").notNull().default(true),
    /** Write-back from the edge sync loop. */
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    lastStatus: varchar("last_status", { length: 50 }), // 'ok' | 'error: ...'
    entryCount: integer("entry_count").notNull().default(0),
    /** Content-addressed compiled artifact; NULL = parse the text on the edge. */
    artifactHash: text("artifact_hash"),
    artifactRules: integer("artifact_rules"),
    compiledAt: timestamp("compiled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("profile_blocklists_profile_idx").on(t.profileId)],
);

/** Metadata for compiled rule artifacts stored in object storage. */
export const ruleArtifacts = pgTable("rule_artifacts", {
  hash: text("hash").primaryKey(),
  sourceUrl: text("source_url").notNull(),
  bytes: integer("bytes").notNull(),
  allowCount: integer("allow_count").notNull(),
  blockCount: integer("block_count").notNull(),
  compiler: varchar("compiler", { length: 40 }).notNull().default("rz-compile/0.1"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

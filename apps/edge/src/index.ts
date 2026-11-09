import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { asc, gte } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { dnsCachePurges, dnsProbes, profileDevices } from "@resolvezero/db/schema";
import { startPruneLoop } from "@resolvezero/db";
import { dropPrivileges, parseLocalDomains } from "@resolvezero/shared";
import { QueryLogBatcher } from "./batcher";
import { createDohApp, type QueryLogEntry } from "./doh";
import { DnsCache } from "./dnsCache";
import { moduleLogger } from "./logger";
import { resolveWire } from "./upstream";
import { RuleStore } from "./ruleStore";
import { startRuleSync } from "./ruleSync";
import { updateRollups } from "./rollup";
import { createStatsApp } from "./stats";
import { createLogsApp } from "./logs";
import { createHealthApp, startEventLoopMonitor } from "./metrics";
import { memoryLimitMb, rssMb, startMemoryWatchdog } from "./memory";
import { createAdminApp } from "./admin";
import { startBlocklistSync } from "./blocklists";
import { createDns53Service, type Dns53Handle } from "./dns53";
import { createDotService, type DotHandle } from "./dot";
import { S3ArchiveSink, createS3ClientFromEnv } from "./sinks/s3";
import { normalizeProbeDomain } from "./probe";

const PORT = Number(process.env.PORT ?? 8080);
const METRICS_PORT = Number(process.env.METRICS_PORT ?? 9091);
const LOG_PREFIX = process.env.S3_LOG_PREFIX ?? "logs";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set");
}

const log = moduleLogger("boot");
const logQueryLogger = moduleLogger("query");

const store = new RuleStore();
const dnsCache = new DnsCache();

// ---- Raw-log persistence: exactly one of two paths ----
// 1. QUERY_LOG_STDOUT=1        → pino lines (kind:"query") → Fly Log Shipper
//                               (Vector) can route them to the same key layout.
// 2. S3_BUCKET + creds set     → in-process S3ArchiveSink (S3_FLUSH_MINUTES objects).
// 3. Neither                   → stats rollups only, raw logs not persisted.
const stdoutQueryLog = process.env.QUERY_LOG_STDOUT === "1";

const s3Client = createS3ClientFromEnv();
const FLUSH_MINUTES = Number(process.env.S3_FLUSH_MINUTES ?? 1) || 1;
const LOCAL_DOMAINS = parseLocalDomains(process.env.LOCAL_DOMAINS ?? "lan,home.arpa");
const LOCAL_TTL = Number(process.env.LOCAL_TTL ?? 60) || 60;
const ALLOW_PUBLIC_IP_ENCODING = process.env.ALLOW_PUBLIC_IP_ENCODING === "1";
// No public DNS record should exist for PROBE_DOMAIN. A client only reaches
// this edge for `<nonce>.<PROBE_DOMAIN>` when it is using our resolver.
const PROBE_DOMAIN = normalizeProbeDomain(process.env.PROBE_DOMAIN ?? "probe.resolvezero.com");
const archive = s3Client
  ? new S3ArchiveSink({ client: s3Client, prefix: LOG_PREFIX, flushMinutes: FLUSH_MINUTES })
  : null;

const batcher = new QueryLogBatcher({
  insert: async (rows) => {
    // Rollups first: if they fail the batcher retries, and the archive must not
    // receive the same rows twice. archive.add is in-memory staging and does not
    // throw, so a failure after it is not a realistic retry path.
    await updateRollups(rows);
    if (archive) archive.add(rows);
  },
});
batcher.start();

if (!archive && !stdoutQueryLog) {
  log.warn("raw query logging disabled: set S3_* or QUERY_LOG_STDOUT=1 (stats still recorded)");
}

// Record resolver-presence canaries. This is intentionally write-behind and
// best-effort: a DB hiccup must never affect DNS answers or the query path.
function recordProbe(nonce: string, transport: "doh" | "udp" | "tcp" | "dot" | "dot"): void {
  void db
    .insert(dnsProbes)
    .values({
      nonce,
      transport,
      region: process.env.FLY_REGION ?? "local",
    })
    .onConflictDoNothing()
    .catch((err) => log.warn({ err }, "probe insert failed"));
}

// Cache purges are per-POP in-memory state, so every edge polls a small
// request table and evicts locally. Upstream resolver caches remain TTL-bound.
const PURGE_POLL_MS = Math.max(1_000, Number(process.env.CACHE_PURGE_POLL_MS ?? 5_000) || 5_000);
let lastPurgeAt = new Date(Date.now() - 10 * 60_000);
const processedPurges = new Set<string>();

async function pollCachePurges(): Promise<void> {
  const rows = await db
    .select({
      id: dnsCachePurges.id,
      domain: dnsCachePurges.domain,
      recordType: dnsCachePurges.recordType,
      createdAt: dnsCachePurges.createdAt,
    })
    .from(dnsCachePurges)
    .where(gte(dnsCachePurges.createdAt, lastPurgeAt))
    .orderBy(asc(dnsCachePurges.createdAt))
    .limit(500);

  for (const row of rows) {
    if (processedPurges.has(row.id)) continue;
    processedPurges.add(row.id);
    const removed = dnsCache.purge(row.domain, row.recordType);
    if (removed > 0) {
      log.info(
        { domain: row.domain, recordType: row.recordType, removed },
        "cache entries purged",
      );
    }
    if (row.createdAt > lastPurgeAt) lastPurgeAt = row.createdAt;
  }

  // Purges are rare; keep the dedupe set bounded during pathological use.
  if (processedPurges.size > 5_000) processedPurges.clear();
}

const purgeTimer = setInterval(() => {
  void pollCachePurges().catch((err) => log.warn({ err }, "cache purge poll failed"));
}, PURGE_POLL_MS);
purgeTimer.unref?.();
void pollCachePurges().catch((err) => log.warn({ err }, "initial cache purge poll failed"));

// Enqueue only when the profile hasn't opted out of logging.
function logQuery(entry: QueryLogEntry): void {
  if (!store.shouldLog(entry.profileId)) return;
  if (stdoutQueryLog) {
    // One line per event — the Log Shipper contract (kind:"query").
    logQueryLogger.info({
      kind: "query",
      time: new Date().toISOString() as string,
      profile: entry.profileId,
      domain: entry.domain,
      action: entry.action,
      rttMs: entry.rttMs,
      clientIp: entry.clientIp,
      region: process.env.FLY_REGION ?? "local",
    });
  }
  batcher.add(entry); // rollups always (still respected below opt-out)
}

// Only the primary region owns one-off DDL/prune; every POP runs the sync loop.
const isPrimaryRegion =
  !process.env.FLY_REGION || process.env.FLY_REGION === (process.env.PRIMARY_REGION ?? "fra");

if (isPrimaryRegion && process.env.PRUNE_ENABLED !== "0") {
  // NOTIFY triggers are created by the migrate job (admin role); the edge's
  // app role intentionally has no DDL rights.
  // Daily retention pruning of stats_hourly (readme §3 C).
  startPruneLoop(24);
} else {
  log.info({ region: process.env.FLY_REGION }, "skipping primary-only prune job");
}

const readiness = {
  rulesLoaded: false,
  blocklistsLoaded: false,
  dns53Bound: false,
};

// Remote custom-URL blocklists: initial fetch before binding 53, then
// NOTIFY-driven re-sync + interval refresh.
const blocklists = startBlocklistSync({ store, dnsCache });

const ruleSync = await startRuleSync(store, () => {
  void blocklists.syncNow();
});
readiness.rulesLoaded = true;

// Hosted profiles must not rely on the dev-only token-free auth mode. Leaving
// one tokenless profile in production exposes logs/stats/update-ip by ID alone.
if (process.env.FLY_REGION && process.env.ALLOW_TOKENLESS_PROFILES !== "1") {
  const tokenless = store.tokenlessProfileIds();
  if (tokenless.length > 0) {
    log.error({ profiles: tokenless }, "hosted edge refuses token-free profiles; set a DoH token");
    process.exit(1);
  }
}

try {
  await blocklists.initialSync();
} catch (err) {
  log.error({ err }, "initial blocklist sync failed; serving with explicit rules only");
}
readiness.blocklistsLoaded = true;

// Logs a warning/error on threshold crossings; /readyz carries the live value
// so the hourly sentinel can alert on a machine that is close to OOM.
startMemoryWatchdog();

const { app: healthApp, metricsApp, recorder } = createHealthApp({
  store,
  dnsCache,
  // Metrics are served on a separate private port (Fly [metrics] scrapes it);
  // never expose them on the public 8080 app.
  exposeMetrics: false,
  readiness: () => {
    const rs = ruleSync.status();
    const bs = blocklists.status();
    return {
      ok: readiness.rulesLoaded && readiness.blocklistsLoaded && readiness.dns53Bound,
      details: {
        region: process.env.FLY_REGION ?? "local",
        rulesLoaded: readiness.rulesLoaded,
        blocklistsLoaded: readiness.blocklistsLoaded,
        dns53Bound: readiness.dns53Bound,
        remoteLists: store.remoteBlocklistEntryCount,
        remoteListTables: store.stats.remoteListTables,
        profiles: store.stats.profiles,
        configPollAgeMs: rs.lastPollAt == null ? null : Date.now() - rs.lastPollAt,
        // Public readiness must not expose URLs/errors that may contain
        // credentials or database details.
        configPollError: rs.lastPollError != null,
        blocklistLastSyncAt: bs.lastSyncAt,
        blocklistError: bs.lastError != null,
        failedBlocklists: bs.failedUrls.length,
        rssMb: rssMb(),
        memoryLimitMb: memoryLimitMb(),
      },
    };
  },
});

const app = new Hono()
  .route("/", healthApp)
  .route("/", createAdminApp({ store, blocklists }))
  .route("/", createStatsApp({ store }))
  .route("/", createLogsApp({ store, client: s3Client, prefix: LOG_PREFIX }))
  .route("/", createDohApp(
    {
      store,
      dnsCache,
      upstream: { resolveWire },
      logQuery,
      recorder,
      localDomains: LOCAL_DOMAINS,
      localTtl: LOCAL_TTL,
      allowPublicIpEncoding: ALLOW_PUBLIC_IP_ENCODING,
      probeDomain: PROBE_DOMAIN,
      onProbeSeen: recordProbe,
      onNewDevice(profileId, slug) {
        // lazy device registration — one insert per new (profile, device)
        void db
          .insert(profileDevices)
          .values({ profileId, slug })
          .onConflictDoUpdate({
            target: [profileDevices.profileId, profileDevices.slug],
            set: { lastSeenAt: new Date() },
          })
          .catch((err) => log.warn({ err, profileId, slug }, "device insert failed"));
      },
    }),
  );

// Port-53 ingress (Deco/router path) — UDP on fly-global-services. Skipped
// locally when the bind fails (no root); decided by DNS53_ENABLED=0.
let dns53Handle: Dns53Handle | null = null;
if (process.env.DNS53_ENABLED !== "0") {
  dns53Handle = await createDns53Service({
    store,
    dnsCache,
    upstream: { resolveWire },
    logQuery: function (entry) {
      if (store.shouldLog(entry.profileId)) batcher.add(entry);
    },
    recorder,
    localDomains: LOCAL_DOMAINS,
    localTtl: LOCAL_TTL,
    allowPublicIpEncoding: ALLOW_PUBLIC_IP_ENCODING,
    probeDomain: PROBE_DOMAIN,
    onProbeSeen: recordProbe,
  });
  if (!dns53Handle) {
    log.error("port-53 DNS ingress not started (bind failed)");
    // On Fly (or any deployment that explicitly requires it), silence is
    // dangerous: DoH would keep working while every router/UDP client loses
    // DNS. Crash loudly instead so the health check/rollout fails.
    if (process.env.FLY_REGION || process.env.DNS53_REQUIRED === "1") {
      log.error("DNS53_REQUIRED: refusing to run without port 53 — exiting");
      process.exit(1);
    }
  }
}
readiness.dns53Bound = process.env.DNS53_ENABLED === "0" || dns53Handle !== null;

// DNS-over-TLS. TLS is terminated by Fly's proxy (tls + proxy_proto v2), which
// forwards the SNI hostname in the PROXY header; the app only speaks plaintext.
let dotHandle: DotHandle | null = null;
if (dns53Handle && process.env.DOT_ENABLED !== "0") {
  dotHandle = await createDotService({
    store,
    resolve: (wire, sourceIp, profileId) => dns53Handle!.resolve(wire, sourceIp, "dot", profileId),
  });
  if (!dotHandle) log.error("DoT ingress not started (bind failed)");
}

startEventLoopMonitor();

const server = serve({
  port: PORT,
  hostname: "0.0.0.0",
  fetch: app.fetch,
  // Keep backend connections warm between DoH requests. Fly terminates TLS
  // in front of the app, so this is the app<->Fly hop, not the client hop.
  serverOptions: {
    keepAliveTimeout: Number(process.env.KEEP_ALIVE_TIMEOUT_MS ?? 65_000),
    headersTimeout: Number(process.env.HEADERS_TIMEOUT_MS ?? 66_000),
  },
});

// Metrics on a private port; Fly's [metrics] scraper reaches it over 6PN.
let metricsServer: ReturnType<typeof serve> | undefined;
try {
  metricsServer = serve({
    port: METRICS_PORT,
    hostname: "0.0.0.0",
    fetch: metricsApp.fetch,
  });
  log.info({ port: METRICS_PORT }, "metrics listening (private)");
} catch (err) {
  log.error({ err, port: METRICS_PORT }, "metrics server failed to bind");
}

// Ports are bound (8080 + 53); become unprivileged before serving traffic.
try {
  const dropped = dropPrivileges({
    onDrop: (uid, gid) => log.info({ uid, gid }, "dropped root privileges after binding ports"),
  });
  if (!dropped) {
    log.info({ uid: process.getuid?.(), gid: process.getgid?.() }, "running without privilege drop");
  }
} catch (err) {
  log.error({ err }, "privilege drop failed");
  if (process.env.FLY_REGION || process.env.DROP_PRIVILEGES === "1") process.exit(1);
}

// Drain: stop intake first, then flush archives before exit (rollups survive via retry).
process.on("SIGTERM", () => {
  log.info("SIGTERM — draining");
  void (async () => {
    try {
      // Stop intake first so no new DNS/HTTP work lands while we flush.
      server.close();
      metricsServer?.close();
      await dns53Handle?.stop();
      ruleSync.stop();
      blocklists.stop();
      await batcher.stop();
      await archive?.flushAll();
      archive?.stop();
    } finally {
      process.exit(0);
    }
  })();
});

log.info(
  {
    ...store.stats,
    dnsCache: dnsCache.stats,
    remoteListEntries: store.remoteBlocklistEntryCount,
    rawLogs: archive ? "s3" : stdoutQueryLog ? "stdout" : "off",
  },
  `resolvezero edge listening on :${PORT}`,
);


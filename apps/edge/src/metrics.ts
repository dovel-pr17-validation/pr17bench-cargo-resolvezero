import { Hono, type Context } from "hono";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { Counter, Gauge, Histogram, collectDefaultMetrics, register, type Registry } from "prom-client";
import type { RuleStore } from "./ruleStore";
import type { DnsCache } from "./dnsCache";

let cpuUsageLast = process.cpuUsage();
let wallLast = Number(process.hrtime.bigint());

/**
 * Start the process-wide event-loop delay monitor. Kept separate from
 * createHealthApp so unit tests don't leave a live timer behind.
 */
let eventLoopDelay: ReturnType<typeof monitorEventLoopDelay> | undefined;
let eventLoopResolutionMs = 20;
export function startEventLoopMonitor(resolutionMs = 20): void {
  if (eventLoopDelay) return;
  eventLoopResolutionMs = resolutionMs;
  eventLoopDelay = monitorEventLoopDelay({ resolution: resolutionMs });
  eventLoopDelay.enable();
}

/** monitorEventLoopDelay includes the sampling interval in its baseline. */
function eventLoopLagMs(percentile?: number): number {
  if (!eventLoopDelay) return 0;
  const ns = percentile == null ? eventLoopDelay.mean : eventLoopDelay.percentile(percentile);
  return Math.max(0, ns / 1e6 - eventLoopResolutionMs);
}

/** Slices process CPU% since the last observation. Pure — unit-tested. */
export function cpuPercent(
  current: { user: number; system: number },
  wallNs: number,
  lastCpu: { user: number; system: number },
  lastWallNs: number,
): number {
  const wallMs = (wallNs - lastWallNs) / 1e6;
  if (wallMs <= 0) return 0;
  const userMs = (current.user - lastCpu.user) / 1000; // µs → ms
  const sysMs = (current.system - lastCpu.system) / 1000;
  return Number((((userMs + sysMs) / wallMs) * 100).toFixed(2));
}

export type Transport = "udp" | "tcp" | "doh" | "dot";

export interface Recorder {
  recordQuery(action: "block" | "forward"): void;
  recordRtt(ms: number): void;
  /** End-to-end time inside the edge for a DNS query. */
  recordDuration(transport: Transport, ms: number): void;
  recordCacheHit(transport: Transport): void;
  recordCacheMiss(transport: Transport): void;
  /** Dropped packets (unauthorized source, malformed) — never counted as queries. */
  recordDrop(reason: string): void;
}

/**
 * /healthz (deep-readiness ping) + /metrics (Prometheus scrape).
 *
 * rz_cpu_percent is the scaling signal: Fly's proxy meters HTTP but not
 * UDP datagrams, so CPU% (sampled in-process) is the honest load proxy —
 * wire this metric to fly-autoscaler when multi-machine scaling is wanted
 * (readme §7). Gauges for rule/cache sizes ship in the same registry.
 */
let defaultMetricsCollected = false;

export function createHealthApp(deps: {
  store?: RuleStore;
  dnsCache?: DnsCache;
  registry?: Registry;
  readiness?: () => { ok: boolean; details?: Record<string, unknown> };
  /** Keep /metrics on the main (public) app for tests; production sets false. */
  exposeMetrics?: boolean;
}) {
  const app = new Hono().basePath("/");
  const metricsApp = new Hono();
  const registry = deps.registry ?? register;

  if (!deps.registry && !defaultMetricsCollected) {
    // once per process: prom-client throws on duplicate default registrations
    collectDefaultMetrics({ register });
    defaultMetricsCollected = true;
  }

  const cpu = new Gauge({
    name: "rz_cpu_percent",
    help: "Process CPU % since last scrape",
    registers: [registry],
  });
  const queries = new Counter({
    name: "rz_queries_total",
    help: "Domain resolution outcomes",
    labelNames: ["action"] as const,
    registers: [registry],
  });
  const rtt = new Histogram({
    name: "rz_query_rtt_ms",
    help: "Upstream RTT ms (forwarded queries)",
    buckets: [5, 10, 25, 50, 100, 250, 500, 1000],
    registers: [registry],
  });
  const duration = new Histogram({
    name: "rz_query_duration_ms",
    help: "End-to-end time inside the edge for a DNS query",
    labelNames: ["transport"] as const,
    buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500],
    registers: [registry],
  });
  const cacheHits = new Counter({
    name: "rz_cache_hits_total",
    help: "DNS cache hits",
    labelNames: ["transport"] as const,
    registers: [registry],
  });
  const cacheMisses = new Counter({
    name: "rz_cache_misses_total",
    help: "DNS cache misses (forwarded upstream)",
    labelNames: ["transport"] as const,
    registers: [registry],
  });
  const dropped = new Counter({
    name: "rz_dropped_total",
    help: "Packets dropped before policy evaluation",
    labelNames: ["reason"] as const,
    registers: [registry],
  });
  new Gauge({
    name: "rz_event_loop_lag_ms",
    help: "Mean event-loop delay since process start (ms)",
    registers: [registry],
    collect() { this.set(eventLoopLagMs()); },
  });
  new Gauge({
    name: "rz_event_loop_lag_p99_ms",
    help: "p99 event-loop delay since process start (ms)",
    registers: [registry],
    collect() { this.set(eventLoopLagMs(99)); },
  });

  if (deps.store) {
    new Gauge({
      name: "rz_rules",
      help: "In-memory rule count",
      registers: [registry],
      collect() { this.set(deps.store!.stats.rules); },
    });
  }
  if (deps.dnsCache) {
    new Gauge({
      name: "rz_dns_cache_entries",
      help: "DNS response LRU entries",
      registers: [registry],
      collect() { this.set(deps.dnsCache!.stats.entries); },
    });
  }
  if (deps.store) {
    // remote blocklist catalog state (GRAFANA: rz_remote_list_*)
    new Gauge({
      name: "rz_remote_list_tables",
      help: "Shared remote blocklist tables registered in this machine's catalog",
      registers: [registry],
      collect() { this.set(deps.store!.stats.remoteListTables); },
    });
    new Gauge({
      name: "rz_remote_list_rules",
      help: "Remote blocklist rules across the catalog (all lists hosted locally)",
      registers: [registry],
      collect() { this.set(deps.store!.remoteBlocklistEntryCount); },
    });
  }

  const recorder: Recorder = {
    recordQuery: (action) =>
      queries.inc({ action: action === "block" ? "block" : "forward" }),
    recordRtt: (ms) => rtt.observe(ms),
    recordDuration: (transport, ms) => {
      if (Number.isFinite(ms) && ms >= 0) duration.observe({ transport }, ms);
    },
    recordCacheHit: (transport) => cacheHits.inc({ transport }),
    recordCacheMiss: (transport) => cacheMisses.inc({ transport }),
    recordDrop: (reason) => dropped.inc({ reason }),
  };

  app.get("healthz", (c) => c.body(null, 204));

  // Deep readiness: rules snapshot + remote lists + bound DNS listener.
  app.get("readyz", (c) => {
    const r = deps.readiness?.() ?? { ok: true, details: { region: process.env.FLY_REGION ?? "local" } };
    return c.json({ ok: r.ok, ...r.details }, r.ok ? 200 : 503);
  });

  const metricsHandler = async (c: Context) => {
    // Optional bearer gate. In production the metrics app runs on a private
    // port (Fly [metrics]) so no token is needed; keep this for direct use.
    const metricsToken = process.env.METRICS_TOKEN;
    if (metricsToken) {
      const header = c.req.header("authorization");
      const supplied = c.req.query("token") ?? (header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : undefined);
      if (supplied !== metricsToken) return c.body(null, 401);
    }
    try {
      const cpuNow = process.cpuUsage();
      const wallNow = Number(process.hrtime.bigint());
      cpu.set(cpuPercent(cpuNow, wallNow, cpuUsageLast, wallLast));
      cpuUsageLast = cpuNow;
      wallLast = wallNow;
    } catch {
      // scrape failures must never 500 the endpoint
    }
    return c.body(await registry.metrics(), 200, {
      "content-type": registry.contentType,
    });
  };

  if (deps.exposeMetrics !== false) app.get("metrics", metricsHandler);
  metricsApp.get("/metrics", metricsHandler);

  return { app, metricsApp, recorder };
}

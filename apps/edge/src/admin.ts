import { Hono } from "hono";
import { isIP } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { dnsCachePurges, profileSourceIps } from "@resolvezero/db/schema";
import type { RuleStore } from "./ruleStore";
import { moduleLogger } from "./logger";
import { normalizeIp } from "./wire";
import { readTextBounded } from "./body";
import { createRateLimiter } from "./limits";

const log = moduleLogger("admin");

const updateIpLimiter = createRateLimiter(30, 60_000);
const whoamiLimiter = createRateLimiter(60, 60_000);
const syncLimiter = createRateLimiter(10, 60_000);
const syncGlobalLimiter = createRateLimiter(6, 60_000);
const purgeLimiter = createRateLimiter(10, 60_000);

const PURGE_TYPES = new Set([
  "A", "AAAA", "CNAME", "TXT", "MX", "NS", "SOA", "SRV", "CAA", "HTTPS", "SVCB",
]);

/**
 * Origins allowed to call the IP-linking routes from a browser. The console is
 * a different origin from the edge, and linking must happen from the user's
 * browser so the edge sees their real public IP.
 */
const CONSOLE_ORIGINS = new Set(
  (process.env.CONSOLE_ORIGINS ??
    "https://my.resolvezero.com,http://localhost:3000,http://localhost:3100")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
);
const CORS_ROUTE_RE = /^\/v1\/[^/]+\/(whoami|update-ip)$/;

function callerIp(c: {
  req: { header(name: string): string | undefined };
}): string | undefined {
  const flyClientIp = c.req.header("fly-client-ip")?.trim();
  const xff = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    flyClientIp ||
    (process.env.ALLOW_UNTRUSTED_IP_HEADERS === "1" ? xff : undefined) ||
    ""
  );
}

function bearerOrQuery(c: { req: { query(k: string): string | undefined; header(n: string): string | undefined } }): string | undefined {
  const q = c.req.query("token");
  if (q) return q;
  const h = c.req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || undefined;
  return undefined;
}

export interface AdminDeps {
  store: RuleStore;
  /** Force a remote-blocklist re-sync (custom-URL feature). */
  blocklists?: { syncNow(): Promise<void> };
}

/**
 * Router-side account maintenance (NextDNS "linked IP" mechanic, readme §4):
 *   POST /v1/:profileId/update-ip[?token=][&ip=1.2.3.4]
 *
 * Links the calling Fly client IP to the profile's UDP whitelist. Explicit
 * ?ip= is disabled unless ALLOW_EXPLICIT_IP_LINK=1 (self-host/dev). IPs owned
 * by another profile return 409; ownership is never silently transferred.
 * The ip_update_trigger NOTIFY keeps already-running edges live.
 */
export function createAdminApp(deps: AdminDeps) {
  const app = new Hono().basePath("/v1");

  // CORS only for the browser-driven IP linking routes. Credentials are never
  // used (bearer tokens only), so no Access-Control-Allow-Credentials.
  app.use("*", async (c, next) => {
    if (!CORS_ROUTE_RE.test(c.req.path)) return next();
    const origin = c.req.header("origin");
    if (origin && CONSOLE_ORIGINS.has(origin)) {
      c.header("access-control-allow-origin", origin);
      c.header("vary", "Origin");
      c.header("access-control-allow-methods", "GET,POST,OPTIONS");
      c.header("access-control-allow-headers", "authorization,content-type");
      c.header("access-control-max-age", "600");
    }
    if (c.req.method === "OPTIONS") return c.body(null, 204);
    return next();
  });

  /**
   * Reports the caller's public IP without linking it. The console's setup
   * page calls this from the browser, so the edge sees the network that the
   * resolver will actually see for plain UDP.
   */
  app.get(":profileId/whoami", (c) => {
    const profileId = c.req.param("profileId");
    if (!deps.store.hasProfile(profileId, bearerOrQuery(c))) {
      return c.body(null, 404);
    }
    const caller = callerIp(c);
    const ip = caller ? normalizeIp(caller) : "";
    if (!ip || isIP(ip) === 0) {
      return c.json({ error: "no valid caller IP" }, 400);
    }
    if (!whoamiLimiter(`${ip}:${profileId}`)) {
      return c.json({ error: "rate limited" }, 429);
    }
    return c.json({
      ip,
      profileId,
      linked: deps.store.authorizeSourceIp(ip) === profileId,
    });
  });

  app.post(":profileId/update-ip", async (c) => {
    const profileId = c.req.param("profileId");
    const token = bearerOrQuery(c);

    if (!deps.store.hasProfile(profileId, token)) {
      return c.body(null, 404);
    }

    // Hosted profiles must use a token. The boot guard already refuses
    // token-free profiles in production, but keep the endpoint safe if that
    // guard is ever bypassed.
    if (process.env.FLY_REGION && !deps.store.hasToken(profileId)) {
      return c.body(null, 404);
    }

    const caller = callerIp(c) ?? "";
    if (!caller) return c.json({ error: "caller IP unavailable" }, 400);
    if (!updateIpLimiter(`${caller}:${profileId}`)) {
      return c.json({ error: "rate limited" }, 429);
    }

    const explicit = c.req.query("ip")?.trim();
    if (explicit && process.env.ALLOW_EXPLICIT_IP_LINK !== "1") {
      return c.json({ error: "explicit IP linking is disabled" }, 400);
    }
    const rawIp = explicit || caller;
    const ip = rawIp ? normalizeIp(rawIp) : "";
    if (!ip || isIP(ip) === 0) {
      return c.json({ error: "no valid caller IP" }, 400);
    }

    // Never steal an IP from another profile. onConflictDoNothing closes the
    // insert race; the follow-up owner check makes cross-profile moves a 409
    // instead of a silent ownership transfer.
    const inserted = await db
      .insert(profileSourceIps)
      .values({ ipAddress: ip, profileId })
      .onConflictDoNothing({ target: profileSourceIps.ipAddress })
      .returning({ profileId: profileSourceIps.profileId });

    if (inserted.length === 0) {
      const existing = await db
        .select({ profileId: profileSourceIps.profileId })
        .from(profileSourceIps)
        .where(eq(profileSourceIps.ipAddress, ip))
        .limit(1);
      if (existing[0] && existing[0].profileId !== profileId) {
        return c.json({ error: "IP is linked to another profile" }, 409);
      }
    }

    log.info({ profileId, ip }, "source IP linked");
    return c.json({ ok: true, ip, profileId });
  });

  /**
   * Queue a cache purge for this profile. Edges poll `dns_cache_purges` every
   * ~5s and evict locally; upstream resolver caches remain TTL-bound.
   */
  app.post(":profileId/cache/purge", async (c) => {
    const profileId = c.req.param("profileId");
    if (!deps.store.hasProfile(profileId, bearerOrQuery(c))) {
      return c.body(null, 404);
    }
    if (process.env.FLY_REGION && !deps.store.hasToken(profileId)) {
      return c.body(null, 404);
    }

    const caller = c.req.header("fly-client-ip") ?? "unknown";
    if (!purgeLimiter(`${caller}:${profileId}`)) {
      return c.json({ error: "rate limited" }, 429);
    }

    let name = c.req.query("name")?.trim() ?? "";
    let type = c.req.query("type")?.trim() ?? "";
    if (!name) {
      const declared = Number(c.req.header("content-length") ?? "0");
      try {
        const text = await readTextBounded(c.req.raw.body, 4096, declared);
        if (text) {
          const body = JSON.parse(text) as Record<string, unknown>;
          name = String(body.name ?? "").trim();
          type = String(body.type ?? "").trim();
        }
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
    }

    const domain = name.toLowerCase().replace(/\.+$/, "");
    if (
      !domain ||
      domain.length > 253 ||
      domain.includes("..") ||
      !/^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)+$/.test(domain)
    ) {
      return c.json({ error: "invalid domain" }, 400);
    }

    const normalizedType = type ? type.toUpperCase() : "";
    if (normalizedType && normalizedType !== "ANY" && !PURGE_TYPES.has(normalizedType)) {
      return c.json({ error: "invalid record type" }, 400);
    }
    const recordType = normalizedType && normalizedType !== "ANY" ? normalizedType : null;

    await db.insert(dnsCachePurges).values({ profileId, domain, recordType });
    log.info({ profileId, domain, recordType }, "cache purge queued");
    return c.json({ ok: true, status: "queued", name: domain, type: recordType, profileId }, 202);
  });

  app.post(":profileId/blocklists/sync", async (c) => {
    if (!deps.store.hasProfile(c.req.param("profileId"), bearerOrQuery(c))) {
      return c.body(null, 404);
    }
    const caller = c.req.header("fly-client-ip") ?? "unknown";
    if (!syncLimiter(`${caller}:${c.req.param("profileId")}`)) {
      return c.json({ error: "rate limited" }, 429);
    }
    if (!syncGlobalLimiter("global")) {
      return c.json({ error: "global sync budget exhausted" }, 429);
    }
    void deps.blocklists?.syncNow();
    return c.json({ ok: true, msg: "re-sync kicked" });
  });

  // Convenience informational endpoint (NextDNS /info parity)
  app.get(":profileId/info", (c) => {
    const region = process.env.FLY_REGION ?? "local";
    return c.json({
      app: "resolvezero",
      region,
      locationName: REGION_NAMES[region] ?? region,
      pop: region,
      rttMs: null, // Fly terminates TLS in its proxy — client measures its own RTT
      measuredBy: "client",
    });
  });

  return app;
}

const REGION_NAMES: Record<string, string> = {
  lhr: "London, United Kingdom",
  fra: "Frankfurt, Germany",
  iad: "Ashburn, United States",
  sjc: "San José, United States",
  nrt: "Tokyo, Japan",
  syd: "Sydney, Australia",
  gru: "São Paulo, Brazil",
};

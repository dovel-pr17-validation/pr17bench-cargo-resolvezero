import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";

/**
 * SSRF guard for server-side fetches whose URL can be influenced by a user
 * (remote blocklist subscriptions and per-profile custom upstreams).
 *
 * Two layers:
 *  1. Syntax/literal checks (protocol, credentials, metadata hostnames,
 *     private IP literals).
 *  2. DNS resolution: every address the hostname resolves to must be public.
 *
 * Callers that follow redirects MUST use `fetchWithSafeRedirects` so each
 * hop is re-validated — otherwise an attacker can redirect a safe initial
 * URL to `http://169.254.169.254/`.
 *
 * Self-hosters pointing at a local Unbound / internal list server can opt
 * out of the private-range check with ALLOW_PRIVATE_TARGETS=1. Metadata
 * endpoints remain blocked regardless.
 */

export interface SafeUrlOptions {
  /** Allowed protocols (default: http + https). Lists should pass ["https:"]. */
  protocols?: string[];
  /** Allow RFC1918/loopback/link-local targets (self-host only). */
  allowPrivate?: boolean;
  /**
   * Hosts whose DNS private-range check can be skipped because they are
   * built-in, hard-coded endpoints (upstream presets). The address is still
   * resolved and pinned for the actual connection.
   */
  trustedHosts?: readonly string[];
  /** Human label used in error messages ("list URL", "upstream"). */
  label?: string;
}

const DEFAULT_PROTOCOLS = ["http:", "https:"];
const DNS_CACHE_TTL_MS = 60_000;

interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

const dnsCache = new Map<string, { expiresAt: number; addresses: ResolvedAddress[] }>();

export interface SafeTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

export function allowPrivateTargets(): boolean {
  return process.env.ALLOW_PRIVATE_TARGETS === "1";
}

/**
 * Resolve and validate a URL, returning the exact address the caller must
 * connect to. This closes the DNS-rebinding TOCTOU window: callers must not
 * re-resolve the hostname after this check.
 */
export async function resolveSafeTarget(raw: string, opts: SafeUrlOptions = {}): Promise<SafeTarget> {
  const label = opts.label ?? "URL";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`${label}: invalid URL`);
  }

  const protocols = opts.protocols ?? DEFAULT_PROTOCOLS;
  if (!protocols.includes(u.protocol)) {
    throw new Error(`${label}: protocol must be ${protocols.join(" or ")}`);
  }
  if (u.username || u.password) {
    throw new Error(`${label}: must not embed credentials`);
  }

  const host = stripBrackets(u.hostname).toLowerCase().replace(/\.+$/, "");
  if (!host) throw new Error(`${label}: missing host`);
  if (isMetadataHost(host)) throw new Error(`${label}: metadata host blocked`);

  const literal = isIP(host);
  if (literal !== 0) {
    if (isPrivateIp(host) && !opts.allowPrivate) {
      throw new Error(`${label}: private/loopback address blocked`);
    }
    return { url: u, address: host, family: literal as 4 | 6 };
  }

  const addresses = await resolveAddresses(host);
  if (addresses.length === 0) throw new Error(`${label}: host could not be resolved`);
  const trusted = opts.allowPrivate || opts.trustedHosts?.includes(host);
  if (!trusted && addresses.some((a) => isPrivateIp(a.address))) {
    throw new Error(`${label}: host resolves to a private address`);
  }
  // Pin the first validated address. Never pass the hostname to the socket.
  return { url: u, address: addresses[0]!.address, family: addresses[0]!.family };
}

/** Backwards-compatible URL-only validation for callers that do not fetch. */
export async function assertSafeRemoteUrl(raw: string, opts: SafeUrlOptions = {}): Promise<URL> {
  return (await resolveSafeTarget(raw, opts)).url;
}

/** Fetch with manual redirect handling; every hop is re-validated and pinned. */
export async function fetchWithSafeRedirects(
  raw: string,
  init: RequestInit,
  opts: SafeUrlOptions = {},
  maxRedirects = 3,
): Promise<{ response: Response; finalUrl: string }> {
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const target = await resolveSafeTarget(current, opts);
    const response = await pinnedRequest(target, init);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`${opts.label ?? "URL"}: redirect without Location`);
      current = new URL(location, target.url).toString();
      await response.body?.cancel().catch(() => undefined);
      continue;
    }
    return { response, finalUrl: target.url.toString() };
  }
  throw new Error(`${opts.label ?? "URL"}: too many redirects`);
}

/**
 * Minimal http/https request with a pinned lookup. We keep the original
 * hostname for SNI and Host, but the socket can only connect to `target.address`.
 */
async function pinnedRequest(target: SafeTarget, init: RequestInit): Promise<Response> {
  const u = target.url;
  const isHttps = u.protocol === "https:";
  const transport = isHttps ? https : http;
  const headers = new Headers(init.headers);
  // Avoid implicit gzip/deflate responses that the pinned transport would
  // otherwise leave compressed (and break existing size checks).
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");
  headers.set("host", u.host);

  const lookupPinned: LookupFunction = (_hostname, options, callback) => {
    const all = typeof options === "object" && options !== null && "all" in options && options.all === true;
    if (all) {
      (callback as (err: NodeJS.ErrnoException | null, addresses: ResolvedAddress[]) => void)(null, [
        { address: target.address, family: target.family },
      ]);
      return;
    }
    callback(null, target.address, target.family);
  };

  return await new Promise<Response>((resolve, reject) => {
    const req = transport.request(
      {
        protocol: u.protocol,
        hostname: stripBrackets(u.hostname),
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: init.method ?? "GET",
        headers: Object.fromEntries(headers.entries()),
        lookup: lookupPinned,
        ...(isHttps ? { servername: stripBrackets(u.hostname) } : {}),
        signal: init.signal ?? undefined,
      },
      (res) => {
        try {
          const responseHeaders = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value == null) continue;
            if (Array.isArray(value)) responseHeaders.set(key, value.join(", "));
            else responseHeaders.set(key, String(value));
          }
          const body = Readable.toWeb(res) as ReadableStream<Uint8Array>;
          resolve(new Response(body, {
            status: res.statusCode ?? 502,
            statusText: res.statusMessage,
            headers: responseHeaders,
          }));
        } catch (err) {
          reject(err);
        }
      },
    );
    req.on("error", reject);
    const body = init.body;
    if (body == null) {
      req.end();
    } else if (typeof body === "string") {
      req.end(body);
    } else if (body instanceof Uint8Array) {
      req.end(Buffer.from(body));
    } else {
      req.destroy(new Error("unsupported request body type for pinned transport"));
    }
  });
}

function stripBrackets(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}

function isMetadataHost(host: string): boolean {
  return (
    host === "metadata.google.internal" ||
    host === "metadata.goog" ||
    host === "169.254.169.254" ||
    host === "fd00:ec2::254"
  );
}

/** True when `ip` is loopback/private/link-local/CGNAT/multicast/reserved. */
export function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIpv4(ip);
  if (version === 6) return isPrivateIpv6(ip);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 (CGNAT)
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 192 && b === 0) return true; // 192.0.0/24 / 192.0.2/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const h = ip.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // fc00::/7 ULA
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(h)) return true; // ff00::/8 multicast

  // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1) and NAT64 (64:ff9b::/96)
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIpv4(mapped[1]!);
  if (h.includes(":ffff:") || h.startsWith("64:ff9b:")) {
    const groups = h.split(":");
    const hi = Number.parseInt(groups.at(-2) ?? "", 16);
    const lo = Number.parseInt(groups.at(-1) ?? "", 16);
    if (Number.isFinite(hi) && Number.isFinite(lo)) {
      return isPrivateIpv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
  }
  return false;
}

/** Resolve and cache all addresses; validation remains the caller's job. */
async function resolveAddresses(host: string): Promise<ResolvedAddress[]> {
  const now = Date.now();
  const cached = dnsCache.get(host);
  if (cached && cached.expiresAt > now) return cached.addresses;

  let rows: { address: string; family: number }[];
  try {
    rows = await lookup(host, { all: true, verbatim: true });
  } catch {
    // Fail closed: an unresolvable host cannot be safely fetched.
    throw new Error("host could not be resolved");
  }
  const addresses: ResolvedAddress[] = rows
    .filter((row) => row.family === 4 || row.family === 6)
    .map((row) => ({ address: row.address, family: row.family as 4 | 6 }));
  dnsCache.set(host, { expiresAt: now + DNS_CACHE_TTL_MS, addresses });
  return addresses;
}

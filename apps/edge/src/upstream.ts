import { decode, type Packet } from "dns-packet";
import { allowPrivateTargets, fetchWithSafeRedirects } from "./netGuard";
import { readBytesBounded } from "./body";
import { ecsKey } from "./dnsKey";

/**
 * Upstream DoH presets (readme §2). Verified against Bun's fetch:
 *  - cloudflare/google speak HTTP/2 **or** 1.1 → both return 200 over h1.
 *  - quad9 505s HTTP/1.1 ("requires HTTP/2", RFC 8484 §5.2) — legitimate
 *    preset, but verify h2 negotiation from the deploy target before
 *    making it the default. Cloudflare is the default preset for that reason.
 */
export const UPSTREAM_PRESETS = {
  cloudflare: "https://cloudflare-dns.com/dns-query",
  google: "https://dns.google/dns-query",
  quad9: "https://dns.quad9.net/dns-query",
} as const;

export type UpstreamPreset = keyof typeof UPSTREAM_PRESETS;

const ENV_URL = process.env.UPSTREAM_DOH_URL;
const ENV_PRESET = process.env.UPSTREAM_PRESET as UpstreamPreset | undefined;
const TRUSTED_UPSTREAM_HOSTS = [...new Set(Object.values(UPSTREAM_PRESETS).map((url) => new URL(url).hostname))];

/** Edge default: preset/env over rid. */
export function defaultUpstreamUrl(): string {
  if (ENV_URL) return ENV_URL;
  if (ENV_PRESET && Object.hasOwn(UPSTREAM_PRESETS, ENV_PRESET)) return UPSTREAM_PRESETS[ENV_PRESET as UpstreamPreset];
  return UPSTREAM_PRESETS.cloudflare;
}

export interface UpstreamResult {
  /** Backed by a dedicated ArrayBuffer (TS5.7 generics; BodyInit-safe). */
  wire: Uint8Array<ArrayBuffer>;
  rttMs: number;
}

/** DNS responses are small; anything bigger is a broken/malicious upstream. */
const MAX_UPSTREAM_BYTES = 65_535;
const UPSTREAM_TIMEOUT_MS = 2_500;

/** Coalesce concurrent identical cache misses (per PoP). */
const inFlight = new Map<string, Promise<UpstreamResult>>();

/**
 * Forwards a DNS wire-format query to a DoH upstream.
 * `upstreamUrl` is chosen per profile (preset name, absolute URL, or the
 * edge default). Custom URLs are SSRF-checked (redirects re-validated,
 * private targets denied unless ALLOW_PRIVATE_TARGETS=1 for self-hosting).
 *
 * Fail fast (no retries — the client stub resolver owns retransmission);
 * SERVFAIL upstream is NOT cached (only healthy responses enter the LRU).
 */
export async function resolveWire(
  wire: Uint8Array,
  upstreamUrl?: string,
): Promise<UpstreamResult> {
  const url = upstreamUrl ?? defaultUpstreamUrl();
  const finalUrl = Object.hasOwn(UPSTREAM_PRESETS, url)
    ? UPSTREAM_PRESETS[url as UpstreamPreset]
    : url;

  const key = flightKey(wire, finalUrl);
  if (key) {
    const existing = inFlight.get(key);
    if (existing) return patchTransactionId(await existing, wire);
  }

  const request = fetchUpstream(wire, finalUrl).finally(() => {
    if (key) inFlight.delete(key);
  });
  if (key) inFlight.set(key, request);
  return request;
}

async function fetchUpstream(wire: Uint8Array, finalUrl: string): Promise<UpstreamResult> {
  const startedAt = performance.now();
  const { response } = await fetchWithSafeRedirects(
    finalUrl,
    {
      method: "POST",
      headers: { "content-type": "application/dns-message", accept: "application/dns-message" },
      body: Buffer.from(wire),
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    },
    {
      label: "upstream",
      allowPrivate: allowPrivateTargets(),
      // Presets are hard-coded and safe; skip a DNS lookup on every cache
      // expiry. Redirects to other hosts still get the full SSRF check.
      trustedHosts: TRUSTED_UPSTREAM_HOSTS,
    },
  );
  if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  const body = await readBytesBounded(response.body, MAX_UPSTREAM_BYTES, declared);
  if (body.length === 0) throw new Error("empty upstream response");

  validateUpstreamResponse(wire, body);
  const rttMs = Math.round(performance.now() - startedAt);
  return { wire: body as Uint8Array<ArrayBuffer>, rttMs };
}

/**
 * Rejects mismatched upstream responses before they can enter the cache:
 * QR must be set, ID must match, and the question section must match the
 * query (name/type/class). A malicious/buggy upstream otherwise poisons the
 * cache under the query's key.
 */
export function validateUpstreamResponse(queryWire: Uint8Array, responseWire: Uint8Array): void {
  let query: Packet;
  let response: Packet;
  try {
    query = decode(Buffer.from(queryWire));
    response = decode(Buffer.from(responseWire));
  } catch {
    throw new Error("upstream response is not valid DNS");
  }

  if (response.type !== "response") {
    throw new Error("upstream response missing QR bit");
  }
  if (response.id !== query.id) {
    throw new Error("upstream response ID mismatch");
  }

  const q = query.questions?.[0] as { name: string; type: string; class?: string } | undefined;
  const r = response.questions?.[0] as { name: string; type: string; class?: string } | undefined;
  if (!q || !r) throw new Error("upstream response missing question");
  const canonical = (name: string) => name.toLowerCase().replace(/\.+$/, "");
  if (
    canonical(r.name) !== canonical(q.name) ||
    String(r.type) !== String(q.type) ||
    (r.class ?? "IN") !== (q.class ?? "IN")
  ) {
    throw new Error("upstream response question mismatch");
  }
}

/** A single-flight key that ignores the client transaction ID. */
function flightKey(wire: Uint8Array, finalUrl: string): string | undefined {
  let packet: Packet;
  try {
    packet = decode(Buffer.from(wire));
  } catch {
    return undefined;
  }
  const q = packet.questions?.[0] as { name: string; type: string; class?: string } | undefined;
  if (!q) return undefined;
  const opt = (packet.additionals ?? []).find((r) => r.type === "OPT") as { flags?: number } | undefined;
  const doBit = typeof opt?.flags === "number" && (opt.flags & 0x8000) !== 0;
  const cdBit = ((packet.flags ?? 0) & 0x0010) !== 0;
  const name = q.name.toLowerCase().replace(/\.+$/, "");
  return `${finalUrl}|${name}|${q.type}|${q.class ?? "IN"}|${doBit ? "do" : "nodo"}|${cdBit ? "cd" : "nocd"}|${ecsKey(packet)}`;
}

function patchTransactionId(result: UpstreamResult, query: Uint8Array): UpstreamResult {
  const copy = new Uint8Array(result.wire.length);
  copy.set(result.wire);
  copy[0] = query[0]!;
  copy[1] = query[1]!;
  return { wire: copy, rttMs: result.rttMs };
}

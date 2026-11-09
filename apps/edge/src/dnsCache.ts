import { LRUCache } from "lru-cache";
import { decode, encode, type Packet } from "dns-packet";
import { ecsKey } from "./dnsKey";

/**
 * LRU cache for upstream DNS responses — the ONLY evictable state
 * (readme.md §2: policies must never be evicted, this must always evict).
 *
 * Key: question (name|type|class) + upstream + EDNS DO/CD/Client-Subnet.
 * Answers vary by provider, DNSSEC intent, and ECS scope, so those must not
 * share entries.
 *
 * Stored responses are normalized before caching:
 *  - the OPT pseudo-record is stripped (never replay a provider's EDNS
 *    payload size / flags to another client);
 *  - the question name is rewritten to the requesting query's exact case
 *    (0x20-randomizing stub resolvers reject mismatched question names).
 *
 * TTL policy (filtering-resolver style, not a plain forwarder):
 *  - Positive answers: min TTL across answers+authorities, capped at
 *    MAX_POSITIVE_TTL_MS (5 min default). TTL 0 is floored to 1 s so a
 *    zero-TTL record cannot turn into an upstream hot loop.
 *  - Empty NOERROR (NODATA) and NXDOMAIN: SOA MINIMUM (RFC 2308), capped
 *    at MAX_NEGATIVE_TTL_MS (60s). A transient upstream NODATA must never
 *    hide a real record for 30 min (howmuchpermile.co.uk apex-A incident).
 */
const MAX_POSITIVE_TTL_MS = 5 * 60_000;
const MAX_NEGATIVE_TTL_MS = 60_000;
const MIN_TTL_MS = 1_000;

interface CachedResponse {
  wire: Uint8Array<ArrayBuffer>;
  /** Question name exactly as it appeared in the originating query. */
  questionName: string;
  /** Monotonic-ish wall clock at insertion (Date.now by default). */
  cachedAt: number;
  /** When this entry must no longer be served. */
  expiresAt: number;
}

interface QueryMeta {
  key: string;
  /** Question name including its original case and trailing dot. */
  rawName: string;
  doBit: boolean;
  cdBit: boolean;
}

export class DnsCache {
  private cache = new LRUCache<string, CachedResponse>({
    max: 100_000,
    maxSize: 50 * 1024 * 1024,
    sizeCalculation(v) {
      return v.wire.length;
    },
  });
  /** Keys with a background refresh already in flight. */
  private refreshing = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * @param onRefresh optional background refresh hook. It is invoked once when
   *   the entry has consumed ~80% of its cache lifetime, so the next client
   *   still gets the cached response while the upstream is refreshed.
   */
  get(
    wire: Uint8Array,
    upstream?: string | null,
    onRefresh?: () => Promise<void>,
  ): Uint8Array<ArrayBuffer> | undefined {
    const meta = queryMeta(wire, upstream);
    if (!meta) return undefined;
    const cached = this.cache.get(meta.key);
    if (!cached) return undefined;

    const now = this.now();
    if (now >= cached.expiresAt) {
      this.cache.delete(meta.key);
      return undefined;
    }

    if (onRefresh && !this.refreshing.has(meta.key)) {
      const lifetime = cached.expiresAt - cached.cachedAt;
      if (lifetime > 0 && now >= cached.cachedAt + lifetime * 0.8) {
        this.refreshing.add(meta.key);
        void Promise.resolve()
          .then(onRefresh)
          .catch(() => undefined)
          .finally(() => this.refreshing.delete(meta.key));
      }
    }

    // RFC 1035/2181: TTLs count down while an answer sits in a cache.
    const elapsedSeconds = Math.max(0, Math.floor((now - cached.cachedAt) / 1000));
    return patchResponse(cached, wire, meta.rawName, elapsedSeconds);
  }

  /**
   * @param queryWire the original query (defines the cache key/flags/case)
   * @param responseWire the upstream response
   */
  set(queryWire: Uint8Array, responseWire: Uint8Array, upstream?: string | null): void {
    const meta = queryMeta(queryWire, upstream);
    const packet = safeDecode(responseWire);
    if (!meta || !packet) return;

    const rcode = (packet.flags ?? 0) & 0x000f;
    if (rcode !== 0 && rcode !== 3) return; // only NOERROR / NXDOMAIN

    const negative = rcode === 3 || (packet.answers ?? []).length === 0;
    const cap = negative ? MAX_NEGATIVE_TTL_MS : MAX_POSITIVE_TTL_MS;
    const advertised = negative ? (soaMinimum(packet) ?? minTtl(packet)) : minTtl(packet);
    const ttl = Math.min(Math.max(advertised, MIN_TTL_MS), cap);

    // Normalize: request-case question name + no OPT replay.
    if (packet.questions?.[0]) packet.questions[0].name = meta.rawName;
    packet.additionals = (packet.additionals ?? []).filter((r) => r.type !== "OPT");

    const normalized = encodePacket(packet);
    if (!normalized) return;
    const now = this.now();
    this.cache.set(
      meta.key,
      { wire: normalized, questionName: meta.rawName, cachedAt: now, expiresAt: now + ttl },
      { ttl },
    );
  }

  /** Drop every cached upstream answer (blocklist refresh may change policy). */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Evict cached answers for one name, optionally limited to a record type.
   * Cache keys are global (name|type|class|flags|upstream), so this may also
   * evict the same upstream answer for other profiles — safe because policy
   * and zones are evaluated before the cache.
   */
  purge(name: string, recordType?: string | null): number {
    const normalized = name.toLowerCase().replace(/\.+$/, "");
    const wantedType = recordType?.toUpperCase();
    let removed = 0;
    for (const key of this.cache.keys()) {
      const [keyName, keyType] = key.split("|");
      if (keyName !== normalized) continue;
      if (wantedType && keyType !== wantedType) continue;
      this.cache.delete(key);
      removed++;
    }
    return removed;
  }

  get stats() {
    return {
      entries: this.cache.size,
      maxSize: this.cache.max,
    };
  }
}

function queryMeta(wire: Uint8Array, upstream?: string | null): QueryMeta | undefined {
  const packet = safeDecode(wire);
  const q = packet?.questions?.[0];
  if (!q) return undefined;
  const rawName = String(q.name);
  const name = rawName.toLowerCase().replace(/\.+$/, "");
  const cls = (q as { class?: string }).class ?? "IN";
  const doBit = hasDoBit(packet);
  const cdBit = (((packet.flags ?? 0) & 0x0010) !== 0);
  return {
    key: `${name}|${q.type}|${cls}|${doBit ? "do" : "nodo"}|${cdBit ? "cd" : "nocd"}|${ecsKey(packet)}|${upstream ?? "default"}`,
    rawName,
    doBit,
    cdBit,
  };
}

function hasDoBit(packet: Packet): boolean {
  const opt = (packet.additionals ?? []).find((r) => r.type === "OPT") as
    | { flags?: number }
    | undefined;
  return typeof opt?.flags === "number" && (opt.flags & 0x8000) !== 0;
}

function safeDecode(wire: Uint8Array): Packet | undefined {
  try {
    return decode(Buffer.from(wire));
  } catch {
    return undefined;
  }
}

function minTtl(packet: Packet): number {
  const records = [...(packet.answers ?? []), ...(packet.authorities ?? [])] as { ttl?: number }[];
  return minTtlSeconds(records);
}

/** RFC 2308: negative responses use the SOA record's MINIMUM field. */
function soaMinimum(packet: Packet): number | undefined {
  for (const record of [...(packet.authorities ?? []), ...(packet.answers ?? [])]) {
    if (record.type !== "SOA") continue;
    const data = record.data as { minimum?: number } | undefined;
    if (typeof data?.minimum === "number") return data.minimum * 1000;
  }
  return undefined;
}

function minTtlSeconds(records: { ttl?: number }[]): number {
  let min = Infinity;
  for (const record of records) {
    if (typeof record.ttl === "number" && record.ttl < min) min = record.ttl;
  }
  return min === Infinity ? 0 : min * 1000;
}

function patchResponse(
  cached: CachedResponse,
  query: Uint8Array,
  queryName: string,
  elapsedSeconds: number,
): Uint8Array<ArrayBuffer> {
  if (elapsedSeconds === 0 && cached.questionName === queryName) {
    const copy = new Uint8Array(cached.wire.length);
    copy.set(cached.wire);
    copy[0] = query[0]!;
    copy[1] = query[1]!;
    return copy;
  }

  // Case-randomizing client and/or elapsed time: re-encode so the question
  // name matches and every record's TTL reflects the remaining lifetime.
  const packet = safeDecode(cached.wire);
  if (!packet) return cached.wire;
  packet.id = (query[0]! << 8) | query[1]!;
  if (packet.questions?.[0]) packet.questions[0].name = queryName;
  if (elapsedSeconds > 0) decrementTtls(packet, elapsedSeconds);
  return encodePacket(packet) ?? cached.wire;
}

function decrementTtls(packet: Packet, elapsedSeconds: number): void {
  const records = [
    ...(packet.answers ?? []),
    ...(packet.authorities ?? []),
    ...(packet.additionals ?? []),
  ] as { ttl?: number }[];
  for (const record of records) {
    if (typeof record.ttl === "number") {
      record.ttl = Math.max(0, record.ttl - elapsedSeconds);
    }
  }
}

function encodePacket(packet: Packet): Uint8Array<ArrayBuffer> | undefined {
  try {
    const raw = encode(packet as never);
    const out = new Uint8Array(raw.length);
    out.set(raw);
    return out;
  } catch {
    return undefined;
  }
}

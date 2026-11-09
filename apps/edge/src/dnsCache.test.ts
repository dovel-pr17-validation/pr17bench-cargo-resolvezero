import { describe, expect, test } from "vitest";
import { decode, encode } from "dns-packet";
import { DnsCache } from "./dnsCache";

function query(name: string, id = 1, opts: { opt?: boolean; doBit?: boolean; cls?: string; ecs?: string } = {}): Uint8Array {
  return new Uint8Array(
    encode({
      id,
      type: "query",
      flags: 0x0100,
      questions: [{ name, type: "A", class: opts.cls ?? "IN" }],
      ...(opts.opt
        ? {
            additionals: [
              {
                name: ".",
                type: "OPT",
                udpPayloadSize: 4096,
                extendedRcode: 0,
                ednsVersion: 0,
                flags: opts.doBit ? 0x8000 : 0,
                options: opts.ecs
                  ? [
                      {
                        code: 8,
                        type: "CLIENT_SUBNET",
                        family: 1,
                        sourcePrefixLength: 24,
                        scopePrefixLength: 0,
                        ip: opts.ecs,
                      },
                    ]
                  : [],
              },
            ],
          }
        : {}),
    } as never),
  );
}

function response(
  name: string,
  id = 1,
  opts: { ttl?: number; opt?: boolean } = {},
): Uint8Array {
  return new Uint8Array(
    encode({
      id,
      type: "response",
      flags: 0x8180,
      questions: [{ name, type: "A", class: "IN" }],
      answers: [{ name, type: "A", class: "IN", ttl: opts.ttl ?? 300, data: "1.2.3.4" }],
      ...(opts.opt
        ? {
            additionals: [
              {
                name: ".",
                type: "OPT",
                udpPayloadSize: 4096,
                extendedRcode: 0,
                ednsVersion: 0,
                flags: 0,
                options: [],
              },
            ],
          }
        : {}),
    } as never),
  );
}

describe("DnsCache", () => {
  test("round-trips an answer and patches the transaction id", () => {
    const cache = new DnsCache();
    cache.set(query("example.com", 1), response("example.com", 1));
    const got = cache.get(query("example.com", 0x4242));
    expect(got).toBeDefined();
    const packet = decode(Buffer.from(got!));
    expect(packet.id).toBe(0x4242);
    expect((packet.answers?.[0] as { data?: string } | undefined)?.data).toBe("1.2.3.4");
  });

  test("never shares entries across upstreams", () => {
    const cache = new DnsCache();
    cache.set(query("example.com"), response("example.com"), "https://a/dns-query");
    expect(cache.get(query("example.com"), "https://a/dns-query")).toBeDefined();
    expect(cache.get(query("example.com"), "https://b/dns-query")).toBeUndefined();
  });

  test("never shares entries across query classes or DO bits", () => {
    const cache = new DnsCache();
    cache.set(query("example.com", 1, { opt: true, doBit: true }), response("example.com"));
    expect(cache.get(query("example.com", 1, { opt: true, doBit: true }))).toBeDefined();
    expect(cache.get(query("example.com", 1, { opt: true, doBit: false }))).toBeUndefined();
    expect(cache.get(query("example.com", 1, { cls: "CH" }))).toBeUndefined();
  });

  test("never shares entries across EDNS Client Subnet values", () => {
    const cache = new DnsCache();
    cache.set(query("geo.example", 1, { opt: true, ecs: "203.0.113.0" }), response("geo.example"));
    expect(cache.get(query("geo.example", 2, { opt: true, ecs: "203.0.113.0" }))).toBeDefined();
    expect(cache.get(query("geo.example", 3, { opt: true, ecs: "198.51.100.0" }))).toBeUndefined();
    expect(cache.get(query("geo.example", 4, { opt: true }))).toBeUndefined();
  });

  test("strips OPT from the cached response", () => {
    const cache = new DnsCache();
    cache.set(query("example.com", 1, { opt: true }), response("example.com", 1, { opt: true }));
    const got = cache.get(query("example.com", 2, { opt: true }));
    expect(got).toBeDefined();
    const packet = decode(Buffer.from(got!));
    expect((packet.additionals ?? []).some((r) => r.type === "OPT")).toBe(false);
  });

  test("rewrites the question name to the requesting 0x20 case", () => {
    const cache = new DnsCache();
    cache.set(query("Example.COM.", 1), response("Example.COM.", 1));
    const got = cache.get(query("eXaMpLe.cOm.", 2));
    expect(got).toBeDefined();
    const packet = decode(Buffer.from(got!));
    expect(packet.questions?.[0]?.name).toBe("eXaMpLe.cOm");
  });

  test("caches TTL-0 answers for at least 1s (no hot loop)", () => {
    const cache = new DnsCache();
    cache.set(query("zero.test"), response("zero.test", 1, { ttl: 0 }));
    expect(cache.get(query("zero.test", 2))).toBeDefined();
  });

  test("decrements TTLs on cache hits (RFC 1035/2181)", () => {
    let now = 1_000_000;
    const cache = new DnsCache(() => now);
    cache.set(query("ttl.test"), response("ttl.test", 1, { ttl: 300 }));

    now += 5_000;
    const got = cache.get(query("ttl.test", 2));
    expect(got).toBeDefined();
    const packet = decode(Buffer.from(got!));
    expect((packet.answers?.[0] as { ttl?: number }).ttl).toBe(295);

    now += 60_000;
    const later = decode(Buffer.from(cache.get(query("ttl.test", 3))!));
    expect((later.answers?.[0] as { ttl?: number }).ttl).toBe(235);
  });

  test("stops serving an entry once its TTL has elapsed", () => {
    let now = 1_000_000;
    const cache = new DnsCache(() => now);
    cache.set(query("expire.test"), response("expire.test", 1, { ttl: 60 }));
    now += 61_000;
    expect(cache.get(query("expire.test", 2))).toBeUndefined();
  });

  test("purge evicts one name/type without touching other entries", () => {
    const cache = new DnsCache();
    cache.set(query("purge.test"), response("purge.test"));
    cache.set(query("keep.test"), response("keep.test"));
    cache.set(query("purge.test"), response("purge.test"), "https://a/dns-query");

    expect(cache.purge("PURGE.test.")).toBe(2);
    expect(cache.get(query("purge.test"))).toBeUndefined();
    expect(cache.get(query("purge.test"), "https://a/dns-query")).toBeUndefined();
    expect(cache.get(query("keep.test"))).toBeDefined();
  });

  test("refreshes once at 80% lifetime and dedupes concurrent refreshes", async () => {
    let now = 1_000_000;
    const cache = new DnsCache(() => now);
    cache.set(query("refresh.test"), response("refresh.test", 1, { ttl: 100 }));

    let calls = 0;
    let release!: () => void;
    const refresh = (): Promise<void> => {
      calls++;
      return new Promise<void>((resolve) => { release = resolve; });
    };

    now += 70_000; // below 80%
    expect(cache.get(query("refresh.test", 2), undefined, refresh)).toBeDefined();
    await Promise.resolve();
    expect(calls).toBe(0);

    now += 10_000; // 80%
    expect(cache.get(query("refresh.test", 3), undefined, refresh)).toBeDefined();
    await Promise.resolve();
    expect(calls).toBe(1);

    now += 5_000; // still in flight
    expect(cache.get(query("refresh.test", 4), undefined, refresh)).toBeDefined();
    await Promise.resolve();
    expect(calls).toBe(1);

    release();
    await new Promise((resolve) => setImmediate(resolve));
    now += 5_000; // 90%; allow a fresh refresh after the first completed
    expect(cache.get(query("refresh.test", 5), undefined, refresh)).toBeDefined();
    await Promise.resolve();
    expect(calls).toBe(2);
    release();
  });
});

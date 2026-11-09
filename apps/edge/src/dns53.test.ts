import { describe, expect, test } from "vitest";
import dgram from "node:dgram";
import net from "node:net";
import { encode, decode } from "dns-packet";
import { normalizeIp, UDP_MAX_PAYLOAD } from "./wire";
import { createDns53Service, type Dns53Deps } from "./dns53";
import { RuleStore } from "./ruleStore";
import { DnsCache } from "./dnsCache";
import { SuffixFingerprintBuilder } from "./fingerprint";
import type { QueryLogEntry } from "./doh";

const wireQuery = (name: string, type = "A") =>
  new Uint8Array(encode({
    id: 0x2, type: "query", flags: 0x0100,
    questions: [{ name, type }],
  } as never));

const P1 = "11111111-1111-1111-1111-111111111111";

function fakeDeps(authSourceIp: string | null = "127.0.0.1"): Dns53Deps & { logs: QueryLogEntry[]; calls: string[] } {
  const store = new RuleStore();
  store.replaceAll(
    [{ profileId: P1, domain: "evil.com", action: "block" }],
    authSourceIp ? [{ ipAddress: authSourceIp, profileId: P1 }] : [],
    [{ id: P1, dohToken: null, logQueries: true, upstream: null }],
    [{ profileId: P1, domain: "nas.lan", recordType: "A", values: ["192.168.1.24"], ttl: 120 }],
  );
  const logs: QueryLogEntry[] = [];
  const calls: string[] = [];
  return {
    store,
    dnsCache: new DnsCache(),
    upstream: {
      async resolveWire(wire: Uint8Array) {
        const name = String(decode(Buffer.from(wire)).questions?.[0]?.name);
        calls.push(name);
        return {
          wire: new Uint8Array(encode({
            id: wire[0]! << 8 | wire[1]!,
            type: "response", flags: 0x8180,
            questions: decode(Buffer.from(wire)).questions,
            answers: [{ name, type: "A" as const, class: "IN" as const, ttl: 300, data: "1.2.3.4" }],
          } as never)),
          rttMs: 1,
        };
      },
    },
    logQuery: (e) => logs.push(e),
    logs,
    calls,
  };
}

/** Real UDP client pointed at the test service. */
function client(port: number): Promise<{ ask(wire: Uint8Array): Promise<Uint8Array | undefined>; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    let pending: ((v: Uint8Array | undefined) => void) | undefined;
    const sock = dgram.createSocket("udp4");
    sock.on("message", (msg) => {
      pending?.(new Uint8Array(msg));
    });
    sock.on("error", reject);
    sock.connect(port, "127.0.0.1", () => {
      resolve({
        ask: (wire) =>
          new Promise((res) => {
            pending = (v) => {
              pending = undefined;
              res(v);
            };
            sock.send(wire);
            setTimeout(() => {
              if (pending) {
                pending = undefined;
                res(undefined); // timeout = silence
              }
            }, 700);
          }),
        close: () =>
          new Promise((res) => {
            sock.close(() => res());
          }),
      });
    });
  });
}

/** Minimal TCP DNS client (2-byte length-prefixed frames) for the test service. */
function tcpAsk(port: number, wire: Uint8Array, proxySource?: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const sock = net.connect({ host: "127.0.0.1", port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("tcp timeout"));
    }, 1500);
    sock.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    sock.on("connect", () => {
      const header = proxySource
        ? Buffer.from(`PROXY TCP4 ${proxySource} 127.0.0.1 12345 53\r\n`)
        : Buffer.alloc(0);
      const len = Buffer.alloc(2);
      len.writeUInt16BE(wire.length);
      sock.write(Buffer.concat([header, len, Buffer.from(wire)]));
    });
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < 2) return;
      const len = buf.readUInt16BE(0);
      if (buf.length >= len + 2) {
        clearTimeout(timer);
        sock.end();
        resolve(new Uint8Array(buf.subarray(2, 2 + len)));
      }
    });
  });
}

const PORT = 15353;
const PORT2 = 15354;
const PORT_TC = 15355;

function logsFor(deps: { logs: QueryLogEntry[] }, domain: string): QueryLogEntry | undefined {
  return deps.logs.find((entry) => entry.domain === domain);
}

describe("dns53 over real sockets", () => {
  test("normalizeIp", () => {
    expect(normalizeIp("::ffff:92.239.76.43")).toBe("92.239.76.43");
    expect(normalizeIp("92.239.76.43%en0")).toBe("92.239.76.43");
  });

  test("forward path: authorized source gets an upstream answer", async () => {
    const deps = fakeDeps();
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT, tcp: false });
    expect(svc?.udpPort).toBe(PORT);

    const c = await client(PORT);
    const reply = await c.ask(wireQuery("example.com"));
    expect(reply).toBeDefined();
    const p = decode(Buffer.from(reply!));
    expect(((p as any).answers?.[0] as { data?: string })?.data).toBe("1.2.3.4");
    expect(deps.logs.some((l) => l.action === "forward")).toBe(true);
    await c.close();
    await svc!.stop();
  });

  test("TCP framing path answers (TC fallback)", async () => {
    const deps = fakeDeps();
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: 15356 });
    expect(svc?.tcpPort).toBe(15356);
    const reply = await tcpAsk(15356, wireQuery("example.com"));
    const p = decode(Buffer.from(reply));
    expect((p.answers?.[0] as { data?: string } | undefined)?.data).toBe("1.2.3.4");
    await svc!.stop();
  });

  test("TCP PROXY protocol header supplies the real client IP", async () => {
    const deps = fakeDeps();
    // Only the PROXY-header source is authorized; the socket peer (127.0.0.1)
    // is intentionally not, so this fails unless the header is parsed.
    deps.store.replaceAll(
      [],
      [{ ipAddress: "9.9.9.9", profileId: P1 }],
      [{ id: P1, dohToken: null, logQueries: true, upstream: null }],
      [],
    );
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: 15357 });
    const reply = await tcpAsk(15357, wireQuery("example.com"), "9.9.9.9");
    const p = decode(Buffer.from(reply));
    expect((p.answers?.[0] as { data?: string } | undefined)?.data).toBe("1.2.3.4");
    await svc!.stop();
  });

  test("unauthorized source gets REFUSED by default (debuggable, never logged)", async () => {
    const deps = fakeDeps(null); // no whitelisted source
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT2, tcp: false });
    const c = await client(PORT2);
    const reply = await c.ask(wireQuery("example.com"));
    expect(reply).toBeDefined();
    const p = decode(Buffer.from(reply!)) as { id: number; flags: number };
    expect(p.id).toBe(2); // wireQuery id
    expect(p.flags & 0x000f).toBe(5); // RCODE = REFUSED
    expect(deps.logs).toHaveLength(0); // nothing processed, nothing logged
    await c.close();
    await svc!.stop();
  });

  test("unauthorized source dropped silently in silent mode", async () => {
    const deps = fakeDeps(null);
    const prev = process.env.UDP_UNKNOWN_SOURCE;
    process.env.UDP_UNKNOWN_SOURCE = "silent";
    try {
      const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT2, tcp: false });
      const c = await client(PORT2);
      const reply = await c.ask(wireQuery("example.com"));
      expect(reply).toBeUndefined(); // timeout = silence
      expect(deps.logs).toHaveLength(0);
      await c.close();
      await svc!.stop();
    } finally {
      if (prev === undefined) delete process.env.UDP_UNKNOWN_SOURCE;
      else process.env.UDP_UNKNOWN_SOURCE = prev;
    }
  });

  test("block + zone override flow over UDP", async () => {
    const deps = fakeDeps();
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT, tcp: false });
    const c = await client(PORT);
    expect((((decode(Buffer.from((await c.ask(wireQuery("ads.evil.com")))!)).answers?.[0] ?? {}) as { data?: string })).data).toBe("0.0.0.0");
    expect(logsFor(deps, "ads.evil.com")).toMatchObject({ action: "block", reason: "manual", transport: "udp" });
    expect((((decode(Buffer.from((await c.ask(wireQuery("nas.lan")))!)).answers?.[0] ?? {}) as { data?: string })).data).toBe("192.168.1.24");
    expect(logsFor(deps, "nas.lan")).toMatchObject({ action: "override", reason: "zone", transport: "udp" });
    expect(deps.calls).not.toContain("nas.lan"); // zone never hits upstream
    await c.close();
    await svc!.stop();
  });

  test("explicit allow overrides a remote blocklist (DoH parity)", async () => {
    const deps = fakeDeps();
    deps.store.replaceAll(
      [{ profileId: P1, domain: "allowed.example", action: "allow" }],
      [{ ipAddress: "127.0.0.1", profileId: P1 }],
      [{ id: P1, dohToken: null, logQueries: true, upstream: null }],
      [],
    );
    const builder = new SuffixFingerprintBuilder();
    builder.add("allowed.example", "block");
    builder.add("other.example", "block");
    deps.store.upsertList("https://lists.example/block", builder.seal());
    deps.store.setSubscriptions(P1, ["https://lists.example/block"]);

    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT, tcp: false });
    const c = await client(PORT);

    const allowed = decode(Buffer.from((await c.ask(wireQuery("allowed.example")))!));
    expect((allowed.answers?.[0] as { data?: string } | undefined)?.data).toBe("1.2.3.4");
    const blocked = decode(Buffer.from((await c.ask(wireQuery("other.example")))!));
    expect((blocked.answers?.[0] as { data?: string } | undefined)?.data).toBe("0.0.0.0");

    await c.close();
    await svc!.stop();
  });

  test("oversized reply is TC-flagged (client retries over TCP)", async () => {
    const deps = fakeDeps();
    deps.upstream = {
      async resolveWire(wire) {
        const name = String(decode(Buffer.from(wire)).questions?.[0]?.name);
        // ~2.4KB of A records → above UDP_MAX_PAYLOAD
        const replies = Array.from({ length: 100 }, (_, i) => ({
          name, type: "A" as const, class: "IN" as const, ttl: 300, data: `10.0.${Math.floor(i / 256)}.${i % 256}`,
        }));
        return {
          wire: new Uint8Array(encode({
            id: wire[0]! << 8 | wire[1]!,
            type: "response", flags: 0x8180,
            questions: decode(Buffer.from(wire)).questions,
            answers: replies,
          } as never)),
          rttMs: 1,
        };
      },
    };
    const svc = await createDns53Service({ ...deps, host: "127.0.0.1", port: PORT_TC, tcp: false });
    const c = await client(PORT_TC);
    const reply = await c.ask(wireQuery("big.test"));
    const flags = decode(Buffer.from(reply!)).flags!;
    expect(reply!.length).toBeLessThan(40);
    expect(flags & 0x0200).toBe(0x0200); // TC bit set
    await c.close();
    await svc!.stop();
  });

  test("resolver probe records nonce and returns NXDOMAIN", async () => {
    const deps = fakeDeps();
    const seen: string[] = [];
    const svc = await createDns53Service({
      ...deps,
      host: "127.0.0.1",
      port: PORT,
      tcp: false,
      probeDomain: "probe.resolvezero.com",
      onProbeSeen: (nonce) => seen.push(nonce),
    });
    const c = await client(PORT);
    const nonce = "0123456789abcdef0123456789abcdef";
    const reply = await c.ask(wireQuery(`${nonce}.probe.resolvezero.com`));
    const packet = decode(Buffer.from(reply!)) as { flags: number };
    expect(packet.flags & 0x000f).toBe(3);
    expect(seen).toEqual([nonce]);
    expect(deps.calls).toHaveLength(0);
    await c.close();
    await svc!.stop();
  });

  test("UDP_MAX_PAYLOAD", () => {
    expect(UDP_MAX_PAYLOAD).toBe(1232);
  });
});

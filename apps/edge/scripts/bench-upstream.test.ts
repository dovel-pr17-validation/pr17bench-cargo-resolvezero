import { describe, expect, test } from "vitest";
import {
  BENCH_PROVIDERS,
  DOMAINS,
  type BenchRuntime,
  type TransportSession,
  benchProvidersByName,
  decodeWire,
  formatReport,
  queryWire,
  runBench,
  summarize,
  transportsFor,
} from "./bench-upstream";

describe("providers + matrix", () => {
  test("matrix shape", () => {
    const cf = benchProvidersByName("cloudflare");
    const q9 = benchProvidersByName("quad9");
    expect(transportsFor(cf!)).toEqual(["doh-h1", "udp", "tcp"]);
    expect(transportsFor(q9!)).toEqual(["doh-h2", "udp", "tcp"]);
  });
});

describe("query wire", () => {
  test("encodes and round-trips", () => {
    const p = decodeWire(queryWire("example.com", 4242))!;
    expect(p.id).toBe(4242);
    expect(p.questions?.[0]?.name).toBe("example.com");
  });
});

/** Fake session with deterministic latency per query (no network). */
function fakeSession(latencyMs: number, failEvery = 0): TransportSession {
  let n = 0;
  return {
    async query() {
      n++;
      if (failEvery > 0 && n % failEvery === 0) return null;
      await new Promise((r) => setTimeout(r, latencyMs));
      return latencyMs;
    },
    close() {},
  };
}

function fakeRuntime(providerLatency: Record<string, number>): BenchRuntime {
  return {
    udpSession: (ip) => Promise.resolve(fakeSession(providerLatency[ip] ?? 5)),
    tcpSession: (ip) => Promise.resolve(fakeSession((providerLatency[ip] ?? 5) + 1)),
    h1Session: (url) => Promise.resolve(fakeSession((providerLatency[url] ?? 10) + 2)),
    h2Session: (url) => Promise.resolve(fakeSession((providerLatency[url] ?? 10) + 3)),
  };
}

describe("runBench (fake runtime)", () => {
  test("produce warm cells for all providers; deterministic stats", async () => {
    const results = await runBench(
      fakeRuntime({ "1.1.1.1": 3, "8.8.8.8": 8, "9.9.9.9": 12, "193.138.218.74": 20 }),
      BENCH_PROVIDERS.slice(0, 2),
      { warmup: 2, measure: 20, includeCold: false },
    );
    expect(results.length).toBe(6); // 2 providers × (doh + udp + tcp)
    const cfUdp = results.find((r) => r.provider === "cloudflare" && r.transport === "udp")!;
    expect(cfUdp.errors).toBe(0);
    expect(cfUdp.n).toBe(20);
    expect(cfUdp.p50).toBeGreaterThanOrEqual(3);
    const gDoh = results.find((r) => r.provider === "google" && r.transport === "doh-h1")!;
    expect(gDoh.p50).toBeGreaterThan(cfUdp.p50);
  });

  test("errors counted on failing transport", async () => {
    const rt = fakeRuntime({ "1.1.1.1": 2 });
    (rt as { udpSession: BenchRuntime["udpSession"] }).udpSession = () =>
      Promise.resolve(fakeSession(1, 3)); // every 3rd fails
    const results = await runBench(rt, [BENCH_PROVIDERS[0]], { warmup: 1, measure: 9, includeCold: false });
    const udp = results.find((r) => r.transport === "udp")!;
    expect(udp.errors).toBeGreaterThanOrEqual(1);
  });

  test("cold mode runs bounded samples", async () => {
    const results = await runBench(fakeRuntime({ "1.1.1.1": 1 }), [BENCH_PROVIDERS[0]], {
      warmup: 0,
      measure: 50,
      includeCold: true,
    });
    const coldRows = results.filter((r) => r.mode === "cold");
    expect(coldRows.length).toBe(3);
    expect(coldRows[0]!.n).toBe(50);
  });
});

describe("formatReport", () => {
  test("tsv table with header", () => {
    const out = formatReport(
      [
        summarize("cloudflare", "udp", "warm", { times: [5, 6, 7], errors: 0 }),
        summarize("cloudflare", "doh-h1", "warm", { times: [9, 10, 16], errors: 1 }),
      ],
      { region: "fra" },
    );
    expect(out).toContain("region=fra");
    expect(out).toContain("provider\ttransport\tmode");
    expect(out).toContain("cloudflare\tudp\twarm");
  });
});

describe("DOMAINS sanity", () => {
  test("five real domains", () => {
    expect(DOMAINS.length).toBe(5);
    expect(DOMAINS.every((d) => d.includes("."))).toBe(true);
  });
});

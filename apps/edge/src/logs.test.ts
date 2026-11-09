import { describe, expect, test } from "vitest";
import { gzipSync } from "node:zlib";
import { createLogsApp } from "./logs";
import { RuleStore } from "./ruleStore";
import type { S3ClientLike } from "./sinks/s3";

const P1 = "11111111-1111-1111-1111-111111111111";
const P2 = "22222222-2222-2222-2222-222222222222";

function fixtureClient(): S3ClientLike & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  const enc = new TextEncoder();
  const put = (key: string, obj: object) => objects.set(key, gzipSync(enc.encode(JSON.stringify(obj))));
  put("logs/11111111-1111-1111-1111-111111111111/2026-10-07/1030.0.jsonl.gz", { kind: "query", time: "2026-10-07T10:35:00Z", domain: "a.com", action: "forward", rttMs: 10, clientIp: "9.9.9.1" });
  put("logs/11111111-1111-1111-1111-111111111111/2026-10-08/0800.0.jsonl.gz", { kind: "query", time: "2026-10-08T08:00:01Z", domain: "b.com", action: "block", rttMs: null, clientIp: "9.9.9.2" });
  put("logs/11111111-1111-1111-1111-111111111111/2026-10-08/0800.1.jsonl.gz", { kind: "query", time: "2026-10-08T08:05:02Z", domain: "c.com", action: "forward", rttMs: 22, clientIp: "9.9.9.2" });
  put("logs/22222222-2222-2222-2222-222222222222/2026-10-08/0800.0.jsonl.gz", { kind: "query", time: "2026-10-08T08:00:00Z", domain: "p2-only.com", action: "forward", rttMs: 5, clientIp: "8.8.8.8" });

  return {
    objects,
    async write() {},
    file(key: string) {
      return { arrayBuffer: async () => objects.get(key) ?? new ArrayBuffer(0) };
    },
    async list({ prefix }: { prefix: string }) {
      return { contents: [...objects.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
    async delete(keys: string | string[]) {
      const arr = Array.isArray(keys) ? keys : [keys];
      for (const k of arr) objects.delete(k);
      return arr.length;
    },
  } as unknown as S3ClientLike & { objects: Map<string, Uint8Array> };
}

describe("logs router", () => {
  const app = (client: S3ClientLike | null) => {
    const store = new RuleStore();
    store.replaceAll(
      [{ profileId: P1, domain: "evil.com", action: "block" }],
      [],
      [{ id: P1, dohToken: null, logQueries: true, upstream: null }],
    );
    return createLogsApp({ store, client, prefix: "logs" });
  };

  test("unknown profile -> silent 404", async () => {
    const res = await app(fixtureClient()).request(`/v1/${P2}/logs`);
    expect(res.status).toBe(404);
  });

  test("jsonl download streams all events in key order", async () => {
    const res = await app(fixtureClient()).request(`/v1/${P1}/logs?format=jsonl`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(lines[0].domain).toBe("a.com");
    expect(lines[1].domain).toBe("b.com");
    expect(lines[2].domain).toBe("c.com");
  });

  test("order=desc reverses object and line order", async () => {
    const res = await app(fixtureClient()).request(`/v1/${P1}/logs?format=jsonl&order=desc`);
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((line) => line.domain)).toEqual(["c.com", "b.com", "a.com"]);
  });

  test("latest-first limit uses the newest objects, not the oldest of the cap", async () => {
    const client = fixtureClient();
    const enc = new TextEncoder();
    const start = Date.UTC(2026, 9, 9, 0, 0, 0);
    for (let i = 0; i <= 500; i++) {
      const d = new Date(start + i * 60_000);
      const key = `logs/${P1}/${d.toISOString().slice(0, 10)}/${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}.bulk.jsonl.gz`;
      client.objects.set(
        key,
        gzipSync(enc.encode(JSON.stringify({
          kind: "query",
          time: d.toISOString(),
          domain: `d${i}.example`,
          action: "forward",
          rttMs: null,
          clientIp: "9.9.9.9",
        }))),
      );
    }

    const res = await app(client).request(`/v1/${P1}/logs?format=jsonl&order=desc&limit=1`);
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const entries = lines.filter((line) => !line.warning);
    expect(entries).toHaveLength(1);
    expect(entries[0].domain).toBe("d500.example");
  });

  test("csv download streams header + rows", async () => {
    const res = await app(fixtureClient()).request(`/v1/${P1}/logs?date=2026-10-08&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv");
    const lines = (await res.text()).trim().split("\n");
    expect(lines[0]).toBe("time,domain,action,client_ip,rtt_ms");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toBe('"2026-10-08T08:00:01Z","b.com","block","9.9.9.2",""');
  });

  test("archive not configured -> 503 with explanation", async () => {
    const res = await app(null).request(`/v1/${P1}/logs`);
    expect(res.status).toBe(503);
  });

  test("clear deletes only that profile's objects", async () => {
    const client = fixtureClient();
    const res = await app(client).request(`/v1/${P1}/logs`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ removed: 3, truncated: false });
    expect([...client.objects.keys()]).toEqual(["logs/22222222-2222-2222-2222-222222222222/2026-10-08/0800.0.jsonl.gz"]);
  });
});

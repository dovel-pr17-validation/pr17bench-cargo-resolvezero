import { describe, expect, test } from "vitest";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  S3ArchiveSink,
  deleteKeys,
  listAllKeys,
  logObjectKey,
  profilePrefix,
  lineFor,
  windowFloor,
  type S3ClientLike,
} from "./s3";
import type { QueryLogRow } from "../batcher";

const row = (over: Partial<QueryLogRow> = {}): QueryLogRow => ({
  profileId: "11111111-1111-1111-1111-111111111111",
  domain: "example.com",
  action: "forward",
  rttMs: 33,
  clientIp: "10.0.0.5",
  device: null,
  loggedAt: new Date("2026-10-08T08:10:30Z"),
  ...over,
});

describe("key layout (shared contract)", () => {
  test("logObjectKey format", () => {
    const key = logObjectKey("logs", "p111", new Date("2026-10-08T08:00:00Z"), "lhr-m1-abc123", 3);
    // {prefix}/{profileId}/{date}/{HHmm}.{instance}.{seq}.jsonl.gz
    expect(key).toBe("logs/p111/2026-10-08/0800.lhr-m1-abc123.3.jsonl.gz");
  });

  test("different instances never collide", () => {
    const a = logObjectKey("logs", "p111", new Date("2026-10-08T08:00:00Z"), "lhr-m1", 0);
    const b = logObjectKey("logs", "p111", new Date("2026-10-08T08:00:00Z"), "fra-m2", 0);
    expect(a).not.toBe(b);
  });

  test("profilePrefix", () => {
    expect(profilePrefix("logs", "p1")).toBe("logs/p1/");
  });

  test("windowFloor grids to the flush window", () => {
    const W = 15 * 60_000;
    expect(windowFloor(Date.parse("2026-10-08T08:14:59Z"), W) % W).toBe(0);
    expect(new Date(windowFloor(Date.parse("2026-10-08T08:14:59Z"), W)).toISOString()).toBe(
      "2026-10-08T08:00:00.000Z",
    );
  });

  test("lineFor event shape (Log Shipper / Vector contract)", () => {
    const e = lineFor(row());
    expect(e.kind).toBe("query");
    expect(e.time).toBe("2026-10-08T08:10:30.000Z");
    expect(e.action).toBe("forward");
    expect(e.rttMs).toBe(33);
    expect(typeof e.region).toBe("string");
    expect(typeof e.machine).toBe("string"); // internal diagnostics
  });

  test("lineFor includes attribution fields when present", () => {
    const e = lineFor(row({
      action: "block",
      reason: "blocklist",
      listId: "11111111-aaaa-bbbb-cccc-222222222222",
      transport: "doh",
      upstream: "custom",
    }));
    expect(e.reason).toBe("blocklist");
    expect(e.listId).toBe("11111111-aaaa-bbbb-cccc-222222222222");
    expect(e.transport).toBe("doh");
    expect(e.upstream).toBe("custom");
  });
});

describe("S3ArchiveSink", () => {
  class FakeClient implements S3ClientLike {
    written: [string, Uint8Array][] = [];
    failedOnce = false;
    async write(key: string, body: Uint8Array) {
      if (this.failedOnce && this.written.length === 0) {
        this.failedOnce = false;
        throw new Error("flare");
      }
      this.written.push([key, body]);
    }
    file() { return { arrayBuffer: async () => new ArrayBuffer(0) }; }
    async list() { return { contents: [] }; }
    async delete() {}
  }

  const windowStart = new Date("2026-10-08T08:00:00Z");
  const filledWindow = (sink: S3ArchiveSink, client: FakeClient, rows: QueryLogRow[]) => {
    sink.add(rows);
    // pretend the window elapsed by calling flushCompleted with now pushed past it
    (sink as any).nowMs = () => Date.parse("2026-10-08T08:16:00Z");
    return sink.flushCompleted().then(() => client);
  };

  test("completed window becomes one gzip NDJSON object", async () => {
    const client = new FakeClient();
    const sink = new S3ArchiveSink({ client, flushMinutes: 15, instanceId: "test" });
    await filledWindow(sink, client, [row(), row({ domain: "x.org" })]);

    expect(client.written).toHaveLength(1);
    const [key, payload] = client.written[0]!;
    expect(key).toBe("logs/11111111-1111-1111-1111-111111111111/2026-10-08/0800.test.0.jsonl.gz");
    const text = new TextDecoder().decode(gunzipSync(payload));
    const lines = text.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).domain).toBe("example.com");
    expect(JSON.parse(lines[0]!).kind).toBe("query");
  });

  test("incomplete window keeps staging until elapsed", async () => {
    const client = new FakeClient();
    const sink = new S3ArchiveSink({ client, flushMinutes: 15 });
    sink.add([row()]);
    (sink as any).nowMs = () => Date.parse("2026-10-08T08:14:00Z"); // still inside 0800 window
    await sink.flushCompleted();
    expect(client.written).toHaveLength(0);
    expect(sink.stats.stagedLines).toBe(1);
  });

  test("flushAll drains everything (SIGTERM path)", async () => {
    const client = new FakeClient();
    const sink = new S3ArchiveSink({ client, flushMinutes: 15 });
    sink.add([row({ loggedAt: new Date("2026-10-08T08:10:30Z") })]);
    await sink.flushAll();
    expect(client.written).toHaveLength(1);
    expect(sink.stats.stagedWindows).toBe(0);
  });

  test("failed upload is queued then retried on next flush", async () => {
    const client = new FakeClient();
    client.failedOnce = true;
    const sink = new S3ArchiveSink({ client, flushMinutes: 15 });
    await filledWindow(sink, client, [row()]);
    // retryPending() inside flushCompleted already succeeded → exactly 1 write
    expect(client.written).toHaveLength(1);
    expect(sink.stats.pendingUploads).toBe(0);
    expect(sink.stats.stagedWindows).toBe(0);
  });
});


describe("listAllKeys / deleteKeys", () => {
  test("walks every page via continuation tokens", async () => {
    const pages = [
      { contents: [{ key: "logs/p/2026-10-08/0800.0.jsonl.gz" }], isTruncated: true, nextContinuationToken: "t1" },
      { contents: [{ key: "logs/p/2026-10-08/0815.0.jsonl.gz" }], isTruncated: true, nextContinuationToken: "t2" },
      { contents: [{ key: "logs/p/2026-10-08/0830.0.jsonl.gz" }], isTruncated: false },
    ];
    const seenTokens: (string | undefined)[] = [];
    const client = {
      async list(opts: { prefix: string; continuationToken?: string }) {
        seenTokens.push(opts.continuationToken);
        return pages[seenTokens.length - 1]!;
      },
    } as unknown as S3ClientLike;

    const { keys, truncated } = await listAllKeys(client, "logs/p/");
    expect(truncated).toBe(false);
    expect(keys).toEqual([
      "logs/p/2026-10-08/0800.0.jsonl.gz",
      "logs/p/2026-10-08/0815.0.jsonl.gz",
      "logs/p/2026-10-08/0830.0.jsonl.gz",
    ]);
    expect(seenTokens).toEqual([undefined, "t1", "t2"]);
  });

  test("reports truncation when the client has no continuation token", async () => {
    const client = {
      async list() {
        return { contents: [{ key: "a" }], isTruncated: true };
      },
    } as unknown as S3ClientLike;
    const { truncated } = await listAllKeys(client, "logs/p/");
    expect(truncated).toBe(true);
  });

  test("deleteKeys honours bounded concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const deleted: string[] = [];
    const client = {
      async delete(key: string) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        deleted.push(key);
        inFlight--;
      },
    } as unknown as S3ClientLike;

    await deleteKeys(client, ["a", "b", "c", "d", "e"], 2);
    expect(deleted.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

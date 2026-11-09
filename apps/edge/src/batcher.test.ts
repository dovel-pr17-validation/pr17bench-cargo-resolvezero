import { describe, expect, test } from "vitest";
import { QueryLogBatcher, type QueryLogEntry } from "./batcher";

const entry = (over: Partial<QueryLogEntry> = {}): QueryLogEntry => ({
  profileId: "p1",
  domain: "example.com",
  action: "forward",
  rttMs: 42,
  clientIp: "10.0.0.9",
  device: null,
  ...over,
});

describe("QueryLogBatcher", () => {
  test("flush persists buffered rows with loggedAt stamped", async () => {
    const inserted: any[] = [];
    const b = new QueryLogBatcher({ insert: async (rows) => inserted.push(...rows) });

    b.add(entry({ domain: "a.com" }));
    b.add(entry({ domain: "b.com", action: "block", rttMs: null }));
    await b.flush();

    expect(inserted).toHaveLength(2);
    expect(inserted[0].domain).toBe("a.com");
    expect(inserted[0].loggedAt).toBeInstanceOf(Date);
    expect(inserted[1].action).toBe("block");
    expect(b.size).toBe(0);
  });

  test("auto-flush when batch fills (maxBatch)", async () => {
    const inserted: any[] = [];
    const b = new QueryLogBatcher({ insert: async (rows) => inserted.push(...rows), maxBatch: 3 });

    b.add(entry()); b.add(entry()); b.add(entry({ domain: "c.com" }));
    // allow the void flush promise to settle
    await new Promise((r) => setTimeout(r, 0));

    expect(inserted).toHaveLength(3);
  });

  test("failed flush retains the batch; retry succeeds", async () => {
    let fail = true;
    const inserted: any[] = [];
    const b = new QueryLogBatcher({
      insert: async (rows) => {
        if (fail) throw new Error("db down");
        inserted.push(...rows);
      },
      maxBatch: 1,
    });

    b.add(entry({ domain: "x.com" }));
    await new Promise((r) => setTimeout(r, 0)); // auto-flush attempted, fails
    expect(inserted).toHaveLength(0);
    expect(b.size).toBe(1); // batch retained

    fail = false;
    await b.flush(); // manual retry succeeds
    expect(inserted).toHaveLength(1);
    expect(b.size).toBe(0);
  });

  test("hard buffer cap drops oldest rows (never blocks)", async () => {
    const inserted: any[] = [];
    const b = new QueryLogBatcher({
      insert: async (rows) => inserted.push(...rows),
      maxBuffer: 0, // force overflow on every add
      maxBatch: 1000,
    });

    for (let i = 0; i < 5; i++) b.add(entry({ domain: `d${i}.com` }));
    await b.flush();

    expect(inserted.length).toBeLessThan(5); // some oldest dropped
  });

  test("stop() flushes remaining and stops accepting", async () => {
    const inserted: any[] = [];
    const b = new QueryLogBatcher({ insert: async (rows) => inserted.push(...rows) });
    b.add(entry());
    await b.stop();
    expect(inserted).toHaveLength(1);

    b.add(entry()); // ignored after stop
    expect(b.size).toBe(0);
  });
});

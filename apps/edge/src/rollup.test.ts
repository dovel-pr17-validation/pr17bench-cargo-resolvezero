import { describe, expect, test } from "vitest";
import {
  aggregate,
  hourFloor,
  mergeTopEntries,
  minuteFloor,
  selectRunnableRows,
  toTopEntries,
} from "./rollup";
import type { QueryLogRow } from "./batcher";

const row = (over: Partial<QueryLogRow> & { loggedAt: Date }): QueryLogRow => ({
  profileId: "p1",
  domain: "example.com",
  action: "forward",
  rttMs: 20,
  clientIp: "10.0.0.9",
  device: null,
  ...over,
});

const H8 = hourFloor(new Date("2026-10-08T08:37:12Z")); // 08:00:00

describe("device rollup (pure)", () => {
  test("aggregate buckets device counts", () => {
    const agg = aggregate([
      row({ loggedAt: H8, device: "phone", domain: "a.com" }),
      row({ loggedAt: H8, device: "phone", domain: "b.com" }),
      row({ loggedAt: H8, device: null, domain: "c.com" }),
    ]);
    const bucket = [...agg.values()][0]!;
    expect(bucket.devices.get("phone")).toBe(2);
    expect(bucket.devices.has("c.com")).toBe(false);
  });

  test("toTopEntries supports device key", () => {
    const m = new Map<string, number>([["phone", 5], ["laptop", 2]]);
    const out = toTopEntries(m, 10, "device");
    expect(out[0]).toEqual({ device: "phone", count: 5 });
  });
});


describe("rollup pure helpers", () => {
  test("hourFloor truncates to the hour (UTC)", () => {
    expect(hourFloor(new Date("2026-10-08T08:59:59.999Z")).toISOString()).toBe(
      "2026-10-08T08:00:00.000Z",
    );
    expect(hourFloor(new Date("2026-10-08T09:00:00Z")).toISOString()).toBe(
      "2026-10-08T09:00:00.000Z",
    );
  });

  test("aggregate groups by profile+hour and counts everything", () => {
    const rows = [
      row({ loggedAt: H8, domain: "a.com", action: "forward", clientIp: "1.1.1.1", rttMs: 10 }),
      row({ loggedAt: H8, domain: "b.com", action: "block", clientIp: "1.1.1.1", rttMs: null }),
      row({
        loggedAt: hourFloor(new Date("2026-10-08T09:05:00Z")),
        domain: "a.com", action: "forward", clientIp: "2.2.2.2",
      }),
      row({ profileId: "p2", loggedAt: H8, domain: "z.com", action: "block" }),
    ];

    const buckets = aggregate(rows);
    expect(buckets.size).toBe(3); // p1@08, p1@09, p2@08

    const p1h8 = buckets.get(`p1|${H8.toISOString()}`)!;
    expect(p1h8.total).toBe(2);
    expect(p1h8.blocked).toBe(1);
    expect(p1h8.rttSumMs).toBe(10); // null rtt excluded
    expect(p1h8.rttCount).toBe(1);
    expect(p1h8.domains.get("a.com")).toBe(1);
    expect(p1h8.domains.get("b.com")).toBe(1);
    expect(p1h8.blockedDomains.get("b.com")).toBe(1);
    expect(p1h8.clients.get("1.1.1.1")).toBe(2); // both rows from that client
  });

  test("toTopEntries sorts desc and caps", () => {
    const m = new Map([["a", 1], ["b", 5], ["c", 3]]);
    const top = toTopEntries(m, 2, "domain");
    expect(top).toEqual([
      { domain: "b", count: 5 },
      { domain: "c", count: 3 },
    ]);
  });

  test("mergeTopEntries folds prior capped lists back in", () => {
    const m = new Map([["fresh", 2]]);
    mergeTopEntries(m, [{ domain: "old", count: 7 }], "domain");
    expect(m.get("old")).toBe(7);
    expect(m.get("fresh")).toBe(2);
  });
});

describe("minute rollups", () => {
  test("minuteFloor truncates to the minute", () => {
    expect(minuteFloor(new Date("2026-10-08T08:37:12.999Z")).toISOString()).toBe(
      "2026-10-08T08:37:00.000Z",
    );
  });
});

describe("selectRunnableRows", () => {
  const row = (profileId: string) =>
    ({ profileId, domain: "example.com", action: "forward", rttMs: 1, clientIp: "1.2.3.4", device: null, loggedAt: new Date() }) as never;

  test("keeps rows for profiles that still exist", () => {
    const kept = selectRunnableRows([row("abc12345"), row("gone1234")], new Set(["abc12345"]));
    expect(kept).toHaveLength(1);
    expect(kept[0]!.profileId).toBe("abc12345");
  });

  test("drops everything when no profile matches", () => {
    expect(selectRunnableRows([row("gone1234")], new Set())).toHaveLength(0);
  });
});

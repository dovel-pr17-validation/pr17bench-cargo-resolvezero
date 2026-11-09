import { describe, expect, test } from "vitest";

import type { QueryLogRow } from "./batcher";
import { aggregateDevices } from "./deviceRollup";

function row(over: Partial<QueryLogRow> & { loggedAt: Date }): QueryLogRow {
  return {
    profileId: "p1",
    domain: "example.com",
    action: "forward",
    rttMs: 10,
    clientIp: "1.2.3.4",
    device: null,
    ...over,
  };
}

const at = new Date("2026-11-01T10:15:00.000Z");

describe("aggregateDevices", () => {
  test("splits buckets per profile + device + hour", () => {
    const buckets = aggregateDevices([
      row({ loggedAt: at, device: "iphone" }),
      row({ loggedAt: at, device: "iphone" }),
      row({ loggedAt: at, device: "ipad" }),
      row({ loggedAt: new Date("2026-11-01T11:00:00.000Z"), device: "iphone" }),
    ]);

    expect(buckets.size).toBe(3);
    expect(buckets.get("p1|iphone|2026-11-01T10:00:00.000Z")?.total).toBe(2);
    expect(buckets.get("p1|ipad|2026-11-01T10:00:00.000Z")?.total).toBe(1);
    expect(buckets.get("p1|iphone|2026-11-01T11:00:00.000Z")?.total).toBe(1);
  });

  test("skips untagged rows entirely", () => {
    const buckets = aggregateDevices([row({ loggedAt: at, device: null })]);
    expect(buckets.size).toBe(0);
  });

  test("counts blocked domains and upstream latency per device", () => {
    const buckets = aggregateDevices([
      row({ loggedAt: at, device: "iphone", action: "block", domain: "ads.example", rttMs: null }),
      row({ loggedAt: at, device: "iphone", action: "block", domain: "ads.example", rttMs: null }),
      row({ loggedAt: at, device: "iphone", domain: "news.example", rttMs: 12 }),
      row({ loggedAt: at, device: "iphone", domain: "news.example", rttMs: 30 }),
    ]);

    const agg = buckets.get("p1|iphone|2026-11-01T10:00:00.000Z")!;
    expect(agg.total).toBe(4);
    expect(agg.blocked).toBe(2);
    expect(agg.rttCount).toBe(2);
    expect(agg.rttSumMs).toBe(42);
    expect(agg.blockedDomains.get("ads.example")).toBe(2);
    expect(agg.domains.get("news.example")).toBe(2);
    expect(agg.domains.get("ads.example")).toBe(2);
  });
});

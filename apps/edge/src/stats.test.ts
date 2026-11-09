import { describe, expect, test } from "vitest";
import { RANGE_CONFIG, buildSeries, mergeTop, sumMinuteTotals, sumTotals } from "./stats";
import type { StatsTopEntry } from "@resolvezero/db/schema";

const MIN = 60_000;

describe("adaptive ladder", () => {
  test("~NextDNS parity: ranges map to sensible bucket sizes", () => {
    expect(RANGE_CONFIG["30m"].bucketMs).toBe(MIN); // 30 pts
    expect(RANGE_CONFIG["6h"].bucketMs).toBe(15 * MIN); // ~25 pts
    expect(RANGE_CONFIG["24h"].bucketMs).toBe(60 * MIN); // 24 pts
    expect(RANGE_CONFIG["7d"].bucketMs).toBe(6 * 60 * MIN); // 28 pts
    expect(RANGE_CONFIG["30d"].bucketMs).toBe(1440 * MIN); // 30 pts
    expect(RANGE_CONFIG["90d"].bucketMs).toBe(1440 * MIN); // ~90 pts

    // short ranges read stats_minute, long ranges stats_hourly
    expect(RANGE_CONFIG["30m"].source).toBe("minute");
    expect(RANGE_CONFIG["6h"].source).toBe("minute");
    expect(RANGE_CONFIG["7d"].source).toBe("hour");
  });
});

describe("buildSeries", () => {
  const now = Date.parse("2026-10-08T09:47:23Z"); // deliberately off-grid

  test("zero-fills the full grid, bucket-aligned, current bucket included", () => {
    const series = buildSeries(
      [{ t: Date.parse("2026-10-08T09:45:10Z"), total: 5, blocked: 2 }],
      MIN, { ms: 30 * MIN, now },
    );
    expect(series.length).toBeGreaterThan(28); // 30-aligned buckets incl. partial head
    expect(series.length).toBeLessThanOrEqual(31);
    const last = series[series.length - 1]!;
    expect(last.bucket).toBe("2026-10-08T09:47:00.000Z"); // floor(now)
    expect(last.total).toBe(0); // nothing logged at 09:47 yet

    const hit = series.find((s) => s.bucket === "2026-10-08T09:45:00.000Z");
    expect(hit).toEqual({ bucket: "2026-10-08T09:45:00.000Z", total: 5, blocked: 2 });
  });

  test("points outside the range are dropped, not spread", () => {
    const series = buildSeries(
      [{ t: now - 40 * MIN, total: 9, blocked: 9 }], // older than the 30m range
      MIN, { ms: 30 * MIN, now },
    );
    expect(series.every((s) => s.total === 0)).toBe(true);
  });

  test("multiple points in the same bucket accumulate", () => {
    const t = Date.parse("2026-10-08T09:45:10Z");
    const series = buildSeries(
      [
        { t, total: 2, blocked: 1 },
        { t: t + 20_000, total: 3, blocked: 0 },
      ],
      MIN, { ms: 30 * MIN, now },
    );
    expect(series.find((s) => s.bucket === "2026-10-08T09:45:00.000Z")).toEqual({
      bucket: "2026-10-08T09:45:00.000Z", total: 5, blocked: 1,
    });
  });
});

describe("headline aggregates", () => {
  test("sumTotals averages RTT only over counted queries", () => {
    const t = sumTotals([
      { totalQueries: 10, blocked: 2, rttSumMs: 500, rttCount: 5 },
      { totalQueries: 5, blocked: 1, rttSumMs: 100, rttCount: 0 },
    ]);
    expect(t.total).toBe(15);
    expect(t.blocked).toBe(3); // post fix: 2+1=3 (bug in first assertion was mine)
    expect(t.avgRttMs).toBe(120); // (500+100)/(5+0)
  });

  test("sumMinuteTotals is exact for short windows", () => {
    expect(sumMinuteTotals([
      { totalQueries: 12, blocked: 2 },
      { totalQueries: 3, blocked: 1 },
    ])).toEqual({ total: 15, blocked: 3 });
  });

  test("mergeTop aggregates across hourly rows and sorts desc", () => {
    const lists: StatsTopEntry[][] = [
      [{ domain: "a.com", count: 3 }, { domain: "b.com", count: 9 }],
      [{ domain: "a.com", count: 4 }],
    ];
    expect(mergeTop(lists, "domain", 10)).toEqual([
      { domain: "a.com", count: 7 },
      { domain: "b.com", count: 9 },
    ].sort((x, y) => y.count - x.count));
  });
});

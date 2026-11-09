import { describe, expect, test } from "vitest";

import { logEntryKey, mergeLogEntries } from "./log-tail";
import type { LogEntry } from "../server/dashboard/types";

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    time: "2026-11-01T13:00:00.000Z",
    domain: "example.com",
    action: "forward",
    clientIp: "1.2.3.4",
    device: null,
    rttMs: 5,
    reason: null,
    listId: null,
    listLabel: null,
    region: "lhr",
    transport: "doh",
    upstream: null,
    ...over,
  };
}

describe("mergeLogEntries", () => {
  test("appends new rows and keeps newest first", () => {
    const older = entry({ time: "2026-11-01T12:59:00.000Z", domain: "old.example" });
    const newer = entry({ time: "2026-11-01T13:01:00.000Z", domain: "new.example" });
    const merged = mergeLogEntries([newer], [older]);
    expect(merged.map((row) => row.domain)).toEqual(["new.example", "old.example"]);
  });

  test("re-fetched windows do not duplicate rows", () => {
    const row = entry();
    const merged = mergeLogEntries([row], [row]);
    expect(merged).toHaveLength(1);
  });

  test("same domain in the same ms counts once per device/client", () => {
    const phone = entry({ device: "iphone" });
    const ipad = entry({ device: "ipad" });
    const merged = mergeLogEntries([phone, ipad], []);
    expect(merged).toHaveLength(2);
    expect(logEntryKey(phone)).not.toBe(logEntryKey(ipad));
  });

  test("caps the tail at the row limit", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      entry({ time: `2026-11-01T13:00:0${i}.000Z`, domain: `d${i}.example` }),
    );
    const merged = mergeLogEntries(rows, [], 5);
    expect(merged).toHaveLength(5);
    expect(merged[0]!.domain).toBe("d7.example");
  });
});

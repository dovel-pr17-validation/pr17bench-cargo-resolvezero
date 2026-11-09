import { describe, expect, test } from "vitest";

import { formatZoned, normalizeTimeZone, zoneLabel } from "./time";

const instant = "2026-01-15T12:00:00Z";

describe("normalizeTimeZone", () => {
  test("keeps a valid IANA zone", () => {
    expect(normalizeTimeZone("Europe/Warsaw")).toBe("Europe/Warsaw");
  });

  test("falls back to UTC for unknown or hostile input", () => {
    expect(normalizeTimeZone("Mars/Olympus_Mons")).toBe("UTC");
    expect(normalizeTimeZone("")).toBe("UTC");
    expect(normalizeTimeZone("x".repeat(80))).toBe("UTC");
    expect(normalizeTimeZone(undefined)).toBe("UTC");
  });
});

describe("formatZoned", () => {
  test("renders the same instant in the requested zone", () => {
    expect(formatZoned(instant, "HH:mm", "UTC")).toBe("12:00");
    expect(formatZoned(instant, "HH:mm", "Europe/Warsaw")).toBe("13:00");
    expect(formatZoned(instant, "HH:mm", "America/New_York")).toBe("07:00");
  });

  test("handles half-hour offsets", () => {
    expect(formatZoned(instant, "HH:mm", "Asia/Kolkata")).toBe("17:30");
  });

  test("is DST-aware", () => {
    expect(formatZoned("2026-07-15T12:00:00Z", "HH:mm", "Europe/Warsaw")).toBe("14:00");
  });

  test("returns a placeholder for an unparseable instant", () => {
    expect(formatZoned("not-a-date", "HH:mm", "UTC")).toBe("—");
  });
});

describe("zoneLabel", () => {
  test("labels UTC explicitly", () => {
    expect(zoneLabel("UTC")).toBe("UTC");
  });

  test("labels other zones with their current offset", () => {
    expect(zoneLabel("Europe/Warsaw")).toMatch(/^GMT[+-]\d/);
  });
});

import { describe, expect, test } from "vitest";

import { normalizeWaitlistEmail } from "./waitlist";

describe("normalizeWaitlistEmail", () => {
  test("trims and lowercases", () => {
    expect(normalizeWaitlistEmail("  Mac@DMIO.co ")).toBe("mac@dmio.co");
  });

  test("rejects malformed addresses", () => {
    expect(normalizeWaitlistEmail("not-an-email")).toBeNull();
    expect(normalizeWaitlistEmail("a@b")).toBeNull();
    expect(normalizeWaitlistEmail("a@b.")).toBeNull();
    expect(normalizeWaitlistEmail("a b@c.com")).toBeNull();
    expect(normalizeWaitlistEmail(42)).toBeNull();
  });

  test("enforces a length cap", () => {
    expect(normalizeWaitlistEmail(`${"a".repeat(250)}@x.co`)).toBeNull();
  });
});

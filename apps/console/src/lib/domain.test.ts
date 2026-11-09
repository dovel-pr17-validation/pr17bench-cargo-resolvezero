import { describe, expect, test } from "vitest";

import { splitDomain } from "./domain";

describe("splitDomain", () => {
  test("keeps the registrable domain as the fixed tail", () => {
    expect(splitDomain("cdn.ads.example.com")).toEqual({ head: "cdn.ads.", tail: "example.com" });
  });

  test("long tracker hash clips at the start, end stays readable", () => {
    const domain = "b79c66077e27a1c100292a6aa5da291cfa7da7ef982a7d0d2708be38d76b31f.us-east-1.prod.service.minerva.devices.a2z.com";
    const { head, tail } = splitDomain(domain);
    expect(tail).toBe("a2z.com");
    expect(head.endsWith("devices.")).toBe(true);
  });

  test("two-label names keep the TLD and let the name clip", () => {
    expect(splitDomain("example.com")).toEqual({ head: "example.", tail: "com" });
    expect(splitDomain("localhost")).toEqual({ head: "", tail: "localhost" });
  });
});

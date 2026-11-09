import { describe, expect, test } from "vitest";

import { buildAppleProfile, normalizeDeviceSlug } from "./apple-profile";

const uuids = { root: "11111111-1111-1111-1111-111111111111", dns: "22222222-2222-2222-2222-222222222222" };

describe("buildAppleProfile", () => {
  test("builds a DoH profile with the canonical payload shape", () => {
    const xml = buildAppleProfile({
      profileName: "Home",
      device: "ipad",
      kind: "https",
      dohUrl: "https://doh.resolvezero.com/v1/p/ipad/token",
      uuids,
    });

    expect(xml.startsWith("<?xml version=\"1.0\"")).toBe(true);
    expect(xml).toContain("com.apple.dnsSettings.managed");
    expect(xml).toContain("<key>DNSProtocol</key>");
    expect(xml).toContain("<string>HTTPS</string>");
    expect(xml).toContain("https://doh.resolvezero.com/v1/p/ipad/token");
    expect(xml).toContain("<key>ServerURL</key>");
    expect(xml).toContain(uuids.root);
    expect(xml).toContain(uuids.dns);
    expect(xml).toContain("ResolveZero — ipad");
  });

  test("builds a DoT profile with ServerName instead of ServerURL", () => {
    const xml = buildAppleProfile({
      profileName: "Home",
      device: "pixel",
      kind: "tls",
      serverName: "abc123.dot.resolvezero.com",
      uuids,
    });

    expect(xml).toContain("<key>DNSProtocol</key>");
    expect(xml).toContain("<string>TLS</string>");
    expect(xml).toContain("abc123.dot.resolvezero.com");
    expect(xml).toContain("<key>ServerName</key>");
    expect(xml).not.toContain("<key>ServerURL</key>");
  });

  test("escapes XML special characters in the display name", () => {
    const xml = buildAppleProfile({
      profileName: "Mum & Dad's <home>",
      device: "ipad",
      kind: "https",
      dohUrl: "https://example.test/a?b=1&c=2",
      uuids,
    });
    expect(xml).toContain("Mum &amp; Dad&apos;s &lt;home&gt;");
    expect(xml).toContain("b=1&amp;c=2");
    expect(xml).not.toContain("<home>");
  });
});

describe("normalizeDeviceSlug", () => {
  test("lowercases and strips unsafe characters", () => {
    expect(normalizeDeviceSlug("  Maciej's iPad  ")).toBe("maciej-s-ipad");
    expect(normalizeDeviceSlug("Living Room TV")).toBe("living-room-tv");
  });

  test("caps the length and rejects empty input", () => {
    expect(normalizeDeviceSlug("a".repeat(60))).toHaveLength(32);
    expect(() => normalizeDeviceSlug("   ")).toThrow(/required/);
    expect(() => normalizeDeviceSlug("!!!")).toThrow(/required/);
  });
});

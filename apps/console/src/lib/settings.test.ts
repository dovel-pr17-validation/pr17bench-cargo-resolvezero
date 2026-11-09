import { describe, expect, test } from "vitest";

import { normalizeSettingsInput } from "./settings";

const base = {
  upstream: null,
  upstreamUrl: null,
  logQueries: true,
  logRetentionDays: 30,
  blockMode: "null",
  blockIpv4: null,
  blockIpv6: null,
  blockTtl: 300,
  safeSearch: {},
  blockedServices: [],
};

describe("normalizeSettingsInput", () => {
  test("accepts the defaults", () => {
    expect(normalizeSettingsInput(base)).toEqual(base);
  });

  test("accepts presets case-insensitively and maps empty to null", () => {
    expect(normalizeSettingsInput({ ...base, upstream: "Cloudflare" }).upstream).toBe("cloudflare");
    expect(normalizeSettingsInput({ ...base, upstream: "" }).upstream).toBeNull();
    expect(normalizeSettingsInput({ ...base, upstream: "default" }).upstream).toBeNull();
  });

  test("rejects unknown presets", () => {
    expect(() => normalizeSettingsInput({ ...base, upstream: "opendns" })).toThrow(/one of cloudflare/);
  });

  test("accepts https custom upstreams and normalises empty to null", () => {
    expect(
      normalizeSettingsInput({ ...base, upstreamUrl: "https://dns.example.com/dns-query" }).upstreamUrl,
    ).toBe("https://dns.example.com/dns-query");
    expect(normalizeSettingsInput({ ...base, upstreamUrl: "   " }).upstreamUrl).toBeNull();
  });

  test("rejects non-https, relative, and credentialed upstream URLs", () => {
    expect(() => normalizeSettingsInput({ ...base, upstreamUrl: "http://dns.example.com" })).toThrow(/https/);
    expect(() => normalizeSettingsInput({ ...base, upstreamUrl: "dns.example.com" })).toThrow(/full https/);
    expect(() =>
      normalizeSettingsInput({ ...base, upstreamUrl: "https://user:pass@dns.example.com" }),
    ).toThrow(/credentials/);
  });

  test("rejects upstream URLs longer than 255 characters", () => {
    const long = `https://example.com/${"a".repeat(300)}`;
    expect(() => normalizeSettingsInput({ ...base, upstreamUrl: long })).toThrow(/255/);
  });

  test("validates retention bounds and whole numbers", () => {
    expect(normalizeSettingsInput({ ...base, logRetentionDays: 1 }).logRetentionDays).toBe(1);
    expect(normalizeSettingsInput({ ...base, logRetentionDays: 365 }).logRetentionDays).toBe(365);
    expect(() => normalizeSettingsInput({ ...base, logRetentionDays: 0 })).toThrow(/between 1 and 365/);
    expect(() => normalizeSettingsInput({ ...base, logRetentionDays: 366 })).toThrow(/between 1 and 365/);
    expect(() => normalizeSettingsInput({ ...base, logRetentionDays: 1.5 })).toThrow(/whole number/);
  });

  test("requires an explicit logQueries boolean", () => {
    expect(() => normalizeSettingsInput({ ...base, logQueries: "yes" })).toThrow(/true or false/);
    expect(() => normalizeSettingsInput({ ...base, logQueries: undefined })).toThrow();
  });
});

describe("filtering settings", () => {
  test("accepts the four block modes and rejects anything else", () => {
    for (const mode of ["null", "nxdomain", "refused", "custom"]) {
      expect(normalizeSettingsInput({ ...base, blockMode: mode }).blockMode).toBe(mode);
    }
    expect(() => normalizeSettingsInput({ ...base, blockMode: "blackhole" })).toThrow(/Block mode/);
  });

  test("validates custom block addresses", () => {
    const ok = normalizeSettingsInput({ ...base, blockMode: "custom", blockIpv4: "203.0.113.7", blockIpv6: "2001:db8::7" });
    expect(ok.blockIpv4).toBe("203.0.113.7");
    expect(ok.blockIpv6).toBe("2001:db8::7");
    expect(() => normalizeSettingsInput({ ...base, blockIpv4: "999.1.1.1" })).toThrow(/IPv4/);
    expect(() => normalizeSettingsInput({ ...base, blockIpv6: "not-an-ip" })).toThrow(/IPv6/);
  });

  test("bounds the block TTL", () => {
    expect(normalizeSettingsInput({ ...base, blockTtl: 0 }).blockTtl).toBe(0);
    expect(normalizeSettingsInput({ ...base, blockTtl: "60" }).blockTtl).toBe(60);
    expect(() => normalizeSettingsInput({ ...base, blockTtl: -1 })).toThrow(/TTL/);
    expect(() => normalizeSettingsInput({ ...base, blockTtl: 86_401 })).toThrow(/TTL/);
  });

  test("keeps only enabled SafeSearch engines", () => {
    expect(
      normalizeSettingsInput({ ...base, safeSearch: { google: true, bing: false, duckduckgo: true } }).safeSearch,
    ).toEqual({ google: true, duckduckgo: true });
  });

  test("dedupes blocked services and rejects unknown ids", () => {
    expect(
      normalizeSettingsInput({ ...base, blockedServices: ["tiktok", "tiktok", "youtube"] }).blockedServices,
    ).toEqual(["tiktok", "youtube"]);
    expect(() => normalizeSettingsInput({ ...base, blockedServices: ["myspace"] })).toThrow(/Unknown blocked service/);
  });
});

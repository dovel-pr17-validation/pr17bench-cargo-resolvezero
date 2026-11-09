import { describe, expect, test } from "vitest";
import { matchProbeNonce, normalizeProbeDomain } from "./probe";

const DOMAIN = "probe.resolvezero.com";
const NONCE = "0123456789abcdef0123456789abcdef";

describe("resolver-presence canary", () => {
  test("normalizes configured domain", () => {
    expect(normalizeProbeDomain(".Probe.ResolveZero.COM.")).toBe(DOMAIN);
    expect(normalizeProbeDomain("  ")).toBeNull();
  });

  test("matches one nonce label under the probe domain", () => {
    expect(matchProbeNonce(`${NONCE}.${DOMAIN}`, DOMAIN)).toBe(NONCE);
    expect(matchProbeNonce(`${NONCE}.${DOMAIN}.`, DOMAIN)).toBe(NONCE);
    expect(matchProbeNonce(`x.${NONCE}.${DOMAIN}`, DOMAIN)).toBeNull();
    expect(matchProbeNonce(`${NONCE}.other.example`, DOMAIN)).toBeNull();
    expect(matchProbeNonce(DOMAIN, DOMAIN)).toBeNull();
    expect(matchProbeNonce(`${NONCE}.${DOMAIN}`, null)).toBeNull();
  });

  test("rejects short or unsafe nonces", () => {
    expect(matchProbeNonce(`short.${DOMAIN}`, DOMAIN)).toBeNull();
    expect(matchProbeNonce(`${"a".repeat(65)}.${DOMAIN}`, DOMAIN)).toBeNull();
    expect(matchProbeNonce(`${NONCE.slice(0, -1)}-${DOMAIN}`, DOMAIN)).toBeNull();
  });
});

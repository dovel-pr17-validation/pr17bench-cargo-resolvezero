import { describe, expect, test } from "vitest";
import { decode } from "dns-packet";

import { blockedResponse, cnameResponse, type QuestionInfo } from "./wire";
import { safeSearchTarget } from "./safeSearch";

const question: QuestionInfo = { id: 0x1234, name: "www.google.com", type: "A" };

/** dns-packet's response type omits rcode, but it sets it at runtime. */
function rcode(packet: unknown): string | undefined {
  return (packet as { rcode?: string }).rcode;
}

function decodeBlock(questionType: string, mode: "null" | "nxdomain" | "refused" | "custom", extra = {}) {
  const packet = decode(Buffer.from(blockedResponse({ ...question, type: questionType }, {
    mode,
    ipv4: null,
    ipv6: null,
    ttl: 300,
    ...extra,
  })));
  return packet;
}

describe("blockedResponse", () => {
  test("null mode answers A with 0.0.0.0 and honours the custom TTL", () => {
    const packet = decodeBlock("A", "null", { ttl: 120 });
    expect(rcode(packet)).toBe("NOERROR");
    expect(packet.answers?.[0]).toMatchObject({ type: "A", data: "0.0.0.0", ttl: 120 });
  });

  test("custom mode answers with the operator's addresses", () => {
    const a = decodeBlock("A", "custom", { ipv4: "203.0.113.7" });
    expect(a.answers?.[0]).toMatchObject({ type: "A", data: "203.0.113.7" });
    const aaaa = decodeBlock("AAAA", "custom", { ipv6: "2001:db8::7" });
    expect(aaaa.answers?.[0]).toMatchObject({ type: "AAAA", data: "2001:db8::7" });
  });

  test("nxdomain mode sets RCODE 3 without answers", () => {
    const packet = decodeBlock("A", "nxdomain");
    expect(rcode(packet)).toBe("NXDOMAIN");
    expect(packet.answers ?? []).toHaveLength(0);
  });

  test("refused mode sets RCODE 5", () => {
    expect(rcode(decodeBlock("A", "refused"))).toBe("REFUSED");
  });
});

describe("cnameResponse", () => {
  test("rewrites the queried name to a canonical target", () => {
    const packet = decode(Buffer.from(cnameResponse(question, "forcesafesearch.google.com", 600)));
    expect(packet.answers?.[0]).toMatchObject({ type: "CNAME", data: "forcesafesearch.google.com", ttl: 600 });
  });
});

describe("safeSearchTarget", () => {
  test("maps the configured engines", () => {
    expect(safeSearchTarget({ google: true }, "www.google.com")).toBe("forcesafesearch.google.com");
    expect(safeSearchTarget({ google: true }, "google.co.uk")).toBe("forcesafesearch.google.com");
    expect(safeSearchTarget({ bing: true }, "www.bing.com")).toBe("strict.bing.com");
    expect(safeSearchTarget({ duckduckgo: true }, "start.duckduckgo.com")).toBe("safe.duckduckgo.com");
    expect(safeSearchTarget({ youtube: true }, "m.youtube.com")).toBe("restrict.youtube.com");
  });

  test("ignores engines that are off", () => {
    expect(safeSearchTarget({ bing: true }, "www.google.com")).toBeUndefined();
    expect(safeSearchTarget({}, "www.google.com")).toBeUndefined();
    expect(safeSearchTarget(undefined, "www.google.com")).toBeUndefined();
  });

  test("does not rewrite unrelated or lookalike hosts", () => {
    expect(safeSearchTarget({ google: true }, "mail.google.com")).toBeUndefined();
    expect(safeSearchTarget({ google: true }, "notgoogle.com")).toBeUndefined();
  });
});

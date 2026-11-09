import { describe, expect, test } from "vitest"

import {
  normalizeBlocklistFormat,
  normalizeBlocklistUrl,
  normalizeRuleAction,
  normalizeRuleDomain,
} from "./policy"

describe("normalizeRuleDomain", () => {
  test("lowercases, trims, and strips the trailing dot", () => {
    expect(normalizeRuleDomain("  Ads.Example.COM.  ")).toBe("ads.example.com")
  })

  test("accepts multi-label and punycode names", () => {
    expect(normalizeRuleDomain("school.example.co.uk")).toBe("school.example.co.uk")
    expect(normalizeRuleDomain("xn--bcher-kva.example")).toBe("xn--bcher-kva.example")
  })

  test("rejects empty, single-label, and malformed names", () => {
    expect(() => normalizeRuleDomain("")).toThrow(/valid domain/)
    expect(() => normalizeRuleDomain("localhost")).toThrow(/valid domain/)
    expect(() => normalizeRuleDomain("bad_domain.com")).toThrow()
    expect(() => normalizeRuleDomain("-leading.com")).toThrow()
    expect(() => normalizeRuleDomain("a..b")).toThrow()
  })

  test("rejects wildcards with an explanation", () => {
    expect(() => normalizeRuleDomain("*.example.com")).toThrow(/match subdomains automatically/)
  })

  test("rejects names longer than 253 characters", () => {
    const long = `${"a".repeat(60)}.`.repeat(5) + "com"
    expect(() => normalizeRuleDomain(long)).toThrow()
  })
})

describe("normalizeRuleAction", () => {
  test("accepts block and allow in any case", () => {
    expect(normalizeRuleAction("block")).toBe("block")
    expect(normalizeRuleAction("ALLOW")).toBe("allow")
    expect(normalizeRuleAction(" Allow ")).toBe("allow")
  })

  test("rejects anything else", () => {
    expect(() => normalizeRuleAction("")).toThrow(/block or allow/)
    expect(() => normalizeRuleAction("zone")).toThrow()
    expect(() => normalizeRuleAction(null)).toThrow()
  })
})

describe("normalizeBlocklistFormat", () => {
  test("accepts supported formats", () => {
    expect(normalizeBlocklistFormat("auto")).toBe("auto")
    expect(normalizeBlocklistFormat("hosts")).toBe("hosts")
    expect(normalizeBlocklistFormat("Domains")).toBe("domains")
    expect(normalizeBlocklistFormat("abp")).toBe("abp")
  })

  test("rejects unknown formats", () => {
    expect(() => normalizeBlocklistFormat("csv")).toThrow(/auto, hosts, domains, or abp/)
    expect(() => normalizeBlocklistFormat("")).toThrow()
  })
})

describe("normalizeBlocklistUrl", () => {
  test("keeps https and http URLs", () => {
    expect(normalizeBlocklistUrl("https://example.com/list.txt")).toBe("https://example.com/list.txt")
    expect(normalizeBlocklistUrl(" http://example.com/hosts ")).toBe("http://example.com/hosts")
  })

  test("rejects relative and protocol-relative input", () => {
    expect(() => normalizeBlocklistUrl("example.com/list.txt")).toThrow(/full URL/)
    expect(() => normalizeBlocklistUrl("//example.com/list.txt")).toThrow(/full URL/)
    expect(() => normalizeBlocklistUrl("")).toThrow(/Enter a blocklist URL/)
  })

  test("rejects non-HTTP protocols", () => {
    expect(() => normalizeBlocklistUrl("ftp://example.com/list.txt")).toThrow(/http/)
    expect(() => normalizeBlocklistUrl("javascript:alert(1)")).toThrow()
    expect(() => normalizeBlocklistUrl("file:///etc/passwd")).toThrow()
  })

  test("rejects embedded credentials", () => {
    expect(() => normalizeBlocklistUrl("https://user:pass@example.com/list.txt")).toThrow(/credentials/)
  })

  test("rejects URLs over 1024 characters", () => {
    const long = `https://example.com/${"a".repeat(1100)}.txt`
    expect(() => normalizeBlocklistUrl(long)).toThrow(/1024/)
  })
})

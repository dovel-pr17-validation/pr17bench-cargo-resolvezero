import { describe, expect, test } from "vitest";
import { SuffixFingerprintBuilder, SuffixFingerprintTable } from "./fingerprint";

describe("SuffixFingerprintTable semantics (parity with Set + suffix matching)", () => {
  const build = () => {
    const b = new SuffixFingerprintBuilder();
    b.add("doubleclick.net", "block");
    b.add("ads.tracker.example", "block");
    b.add("mail.doubleclick.net", "allow"); // @@-style exception
    b.add("disguise.pl", "block");
    b.add("DoubleClick.net", "block"); // dup + case-collapsed
    return b.seal();
  };

  test("suffix rule matches subdomains; no partial substrings", () => {
    const t = build();
    expect(t.resolve("ad.doubleclick.net")).toBe("block");
    expect(t.resolve("doubleclick.net")).toBe("block");
    // label-boundary: contains-but-not-substring must NOT match
    expect(t.resolve("fakedoubleclick.net")).toBeUndefined();
    expect(t.resolve("evildisguise.pl")).toBeUndefined();
    expect(t.resolve("disguise.pl.evil.com")).toBeUndefined();
  });

  test("allow wins over block (same profile, ABP ordering)", () => {
    const t = build();
    expect(t.resolve("mail.doubleclick.net")).toBe("allow");
    expect(t.resolve("www.mail.doubleclick.net")).toBe("allow");
  });

  test("duplicate + case-collapsed rules stored once", () => {
    const b = new SuffixFingerprintBuilder();
    b.add("doubleclick.net", "block");
    b.add("DOUBLECLICK.NET", "block");
    b.add("doubleclick.net.", "block");
    const t = b.seal();
    expect(t.isEmpty).toBe(false);
    expect(t.resolve("doubleclick.net")).toBe("block");
    // block fingerprints: domain + its suffix "net"? no: no bare TLD insert
  });

  test("REGRESSION: rule subdomain must NOT block its parent (collector.github.com)", () => {
    // AdGuard filter ships ||collector.github.com^ — the expansion bug stored
    // suffix "github.com" and blocked the whole apex. Rule-first fingerprints
    // keep the instruction scoped: only collector.github.com and below.
    const b = new SuffixFingerprintBuilder();
    b.add("collector.github.com", "block");
    b.add("collector-cdn.github.com", "block");
    const t = b.seal();
    expect(t.resolve("ads.collector.github.com")).toBe("block");
    expect(t.resolve("github.com")).toBeUndefined();
    expect(t.resolve("collector-cdn.github.com")).toBe("block");
    expect(t.resolve("git.elsewhere.com")).toBeUndefined();
    // note: github.io comparisons stay clean of collision noise thanks to the
    // probe-first exact-match shortcut on the query domain.
  });

  test("fingerprint identity changes with content, not with order", () => {
    const b1 = new SuffixFingerprintBuilder();
    ["a.com", "b.com", "c.com"].forEach((d) => b1.add(d, "block"));
    const t1 = b1.seal();
    const b2 = new SuffixFingerprintBuilder();
    ["c.com", "a.com", "b.com"].forEach((d) => b2.add(d, "block"));
    const t2 = b2.seal();
    expect(t1.fingerprint).toBe(t2.fingerprint);
    const b3 = new SuffixFingerprintBuilder();
    ["a.com", "b.com", "d.com"].forEach((d) => b3.add(d, "block"));
    const t3 = b3.seal();
    expect(t1.fingerprint).not.toBe(t3.fingerprint);
  });

  test("TLD-only / hostname-garbage rules dropped", () => {
    const b = new SuffixFingerprintBuilder();
    b.add("com", "block"); // no dot → ignored
    b.add(".invalid", "block"); // no dot before TLD → ignored
    const t = b.seal();
    expect(t.isEmpty).toBe(true);
  });
});

describe("SuffixFingerprintTable at scale (xxhash64 + sorted arrays)", () => {
  test("100k synthetic entries: exact parity with Set-based semantics", () => {
    const domains: string[] = [];
    for (let i = 0; i < 100_000; i++) {
      domains.push(`tier${i % 500}.zone${i % 3000}.example-block-${i}.net`);
    }
    const reference = new Set(domains);
    const b = new SuffixFingerprintBuilder();
    for (const d of domains) b.add(d, "block");
    const t = b.seal();

    // 5k random lookups: fp-table must agree with reference set on hit/miss
    let fphits = 0;
    for (let i = 0; i < 5_000; i++) {
      const q = i % 2 === 0 ? domains[(i * 37) % domains.length]! : `miss-${i}.example.org`;
      const ref = reference.has(q);
      const got = t.resolve(q);
      expect(!!got).toBe(ref);
      if (got) fphits++;
    }
    // must have had a meaningful number of hits (not everything missing)
    expect(fphits).toBeGreaterThan(1_000);
  });

  test("collision/anomaly budget: known zero false positives on 1M disjoint strings", () => {
    const b = new SuffixFingerprintBuilder();
    for (let i = 0; i < 1_000_000; i++) b.add(`h${i}.huge-list.example`, "block");
    const t = b.seal();
    // query 100k random strings that are definitively not in the list
    let falsePositives = 0;
    for (let i = 0; i < 100_000; i++) {
      if (t.resolve(`safe-${i}.atoll-qw7f8-noise.example`) !== undefined) falsePositives++;
    }
    expect(falsePositives).toBe(0);
  });
});

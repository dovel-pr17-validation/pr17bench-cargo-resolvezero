/**
 * Suffix-fingerprint blocklist table (readme §2, blocklists at scale).
 *
 * Replaces `Set<string>` domain sets whose RSS blows past machine limits
 * at millions of entries (measured: Set<string> ~1.3GB RSS @ 5M rules;
 * this table ~150MB memory @ 5M rules storing ~20M suffix fingerprints).
 *
 * Semantics preserved from RuleStore.matchesSuffixSet:
 *   - entry  "doubleclick.net"        matches "ads.doubleclick.net" (label-boundary safe)
 *   - entry  "not-evildomain.com"     does NOT match evildomain.com
 *   - allow entries answer "allow" and are checked FIRST (ABP `@@` semantics)
 *
 * Design:
 *   - Every rule expands to the fingerprints of ALL its suffixes
 *     ("a.b.example.com" → a.b.example.com, b.example.com, example.com —
 *     label-boundary correctness comes free from the split).
 *   - Fingerprints are xxhash64 persisted into sorted
 *     BigUint64Arrays; lookup = hash each queried suffix + binary search.
 *   - One 64-bit fingerprint table holds a finite collision risk
 *     (~6.8e-7 for 5M exact-vs-suffix pairs — modeled at ~2^-42 per by
 *     rebuild as an acceptable false-positive rate, see fingerprint.test.ts).
 *     If a stricter variant ever matters, re-run parse with double-hash.
 */

import xxhash from "xxhash-wasm";

export type FingerprintAction = "allow" | "block";

const { h64 } = await xxhash();
const hash64 = (s: string): bigint => h64(s);

export class SuffixFingerprintBuilder {
  // Growable BigUint64Array stages — NEVER boxed bigint[] JS arrays
  // (bigint pages heap-allocate ~20-40B per entry; a 5M-rule list would
  // spike hundreds of MB transiently and OOM small VMs during boot sync).
  private allowFps!: BigUint64Array;
  private allowN = 0;
  private blockFps!: BigUint64Array;
  private blockN = 0;
  private static INITIAL = 4096;

  constructor() {
    this.allowFps = new BigUint64Array(SuffixFingerprintBuilder.INITIAL);
    this.blockFps = new BigUint64Array(SuffixFingerprintBuilder.INITIAL);
  }

  add(domain: string, action: FingerprintAction): void {
    // canonicalize: lowercase, strip trailing dots
    const d = domain.toLowerCase().replace(/\.+$/, "");
    if (!d.includes(".")) return;          // TLD-only rules never make sense
    if (d.startsWith(".") || d.startsWith("*")) return; // "*." wildcard entries unsupported (exact)+suffix semantics only
    // Store ONLY the exact RULE fingerprint. Semantics: a rule blocks/
    // allows itself AND everything beneath it — realized on the QUERY side
    // (probes hash every suffix of the query, so a stored rule matches its
    // subtree). Expanding a RULE into ITS suffixes would be backwards: it
    // would match PARENT/less-specific labels (e.g. rule collector.github.com
    // matching github.com) — a real production semantics bug this module
    // originally shipped with, caught by the memory-sim probe on live data.
    const fps = [hash64(d)];
    const store = action === "allow" ? "a" : "b";
    const buf = store === "a" ? this.allowFps : this.blockFps;
    const n = store === "a" ? this.allowN : this.blockN;
    if (n + fps.length > buf.length) {
      // amortized growth to fit (double until it fits)
      let cap = buf.length;
      while (n + fps.length > cap) cap *= 2;
      const grown = new BigUint64Array(cap);
      grown.set(buf);
      if (store === "a") this.allowFps = grown;
      else this.blockFps = grown;
      const target = store === "a" ? this.allowFps : this.blockFps;
      for (let i = 0; i < fps.length; i++) target[n + i] = fps[i]!;
      if (store === "a") this.allowN = n + fps.length;
      else this.blockN = n + fps.length;
      return;
    }
    for (let i = 0; i < fps.length; i++) buf[n + i] = fps[i]!;
    if (store === "a") this.allowN = n + fps.length;
    else this.blockN = n + fps.length;
  }

  /** Seals the table: trims to used sizes, sorts, and takes an EXPLICIT
   *  entry count (the caller = parseList already has the deduped string
   *  counts; the builder intentionally does not retain strings). */
  seal(entryCountOverride?: number): SuffixFingerprintTable {
    const allow = this.allowFps.subarray(0, this.allowN);
    allow.sort();
    const block = this.blockFps.subarray(0, this.blockN);
    block.sort();
    const out = new SuffixFingerprintTable(
      new BigUint64Array(allow), // copy — subarray shares the oversized buffer
      new BigUint64Array(block),
      entryCountOverride ?? this.allowN + this.blockN,
    );
    this.allowFps = new BigUint64Array(SuffixFingerprintBuilder.INITIAL);
    this.blockFps = new BigUint64Array(SuffixFingerprintBuilder.INITIAL);
    this.allowN = 0;
    this.blockN = 0;
    return out;
  }
}



export class SuffixFingerprintTable {
  constructor(
    private allow: BigUint64Array,
    private block: BigUint64Array,
    /** distinct parsed rules (allow + block) at seal time. */
    readonly entryCount = 0,
  ) {}

  /** Raw sorted arrays for artifact encoding / tests. */
  artifactTables(): { allow: BigUint64Array; block: BigUint64Array } {
    return { allow: this.allow, block: this.block };
  }

  /** Rebuild a table from artifact arrays (already sorted, deduped). */
  static fromArrays(
    allow: BigUint64Array,
    block: BigUint64Array,
    entryCount = allow.length + block.length,
  ): SuffixFingerprintTable {
    return new SuffixFingerprintTable(allow, block, entryCount);
  }

  /**
   * Rule action for a queried domain, or undefined when not listed.
   * Probes every label-boundary suffix of the query + the query itself.
   */
  resolve(domain: string): FingerprintAction | undefined {
    const d = canonical(domain);
    const allowHit = this.checkAllow(d);
    if (allowHit) return "allow";
    return this.checkBlock(d) ? "block" : undefined;
  }

  /** Allow-table probe — used by the shared per-URL registry to give
   *  allow-lists cross-list precedence (ABP `@@` semantics). */
  checkAllow(domain: string): boolean {
    return this.probeAny(this.allow, domain);
  }

  /** Block-table probe. */
  checkBlock(domain: string): boolean {
    return this.probeAny(this.block, domain);
  }

  private probeAny(fps: BigUint64Array, domain: string): boolean {
    if (fps.length === 0) return false;
    const d = canonical(domain);
    if (ContainsBinary(fps, hash64(d))) return true;
    for (const suffix of suffixesAfterFirst(d)) {
      if (ContainsBinary(fps, hash64(suffix))) return true;
    }
    return false;
  }

  get isEmpty(): boolean {
    return this.allow.length === 0 && this.block.length === 0;
  }

  /**
   * Cheap stable identity (XOR fold of all fingerprint bytes) — used by the
   * blocklist sync loop to decide whether a re-fetch actually changed data
   * (vs fingerprinting by size only, which misses entry swaps).
   */
  get fingerprint(): string {
    const fold = (arr: BigUint64Array): string => {
      let h = 0x811c9dc5n;
      for (let i = 0; i < arr.length; i++) {
        h = ((h ^ arr[i]!) * 0x100000001b3n) & 0xffffffffffffffffn;
      }
      return `${arr.length}:${h.toString(16)}`;
    };
    return `allow(${fold(this.allow)})|block(${fold(this.block)})`;
  }
}

/** lowercase + strip FQDN trailing dot — shared by builder and probes. */
function canonical(domain: string): string {
  return domain.toLowerCase().replace(/\.+$/, "");
}

/** Number of distinct parsed RULES inside the sealed table (not suffix fps). */
function ruleCount(entries: Set<string>): number {
  return entries.size;
}

function ContainsBinary(sorted: BigUint64Array, target: bigint): boolean {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const v = sorted[mid]!;
    if (v === target) return true;
    if (v < target) lo = mid + 1;
    else hi = mid - 1;
  }
  return false;
}

/** Rule suffixes INCLUDING the domain, EXCLUDING its final bare-TLD label
 *  (storing "com" as a rule suffix would block the entire .com TLD — the
 *  classic poisoning bug this design guards against). */
function suffixesOf(d: string): string[] {
  const out: string[] = [d];
  let i = d.indexOf(".");
  while (i !== -1) {
    const s = d.slice(i + 1);
    if (s.includes(".")) out.push(s); // skip the bare-TLD slice
    i = d.indexOf(".", i + 1);
  }
  return out;
}

/** Suffixes strictly shorter than the domain (re-probe list once the full domain missed). */
function suffixesAfterFirst(d: string): string[] {
  const out: string[] = [];
  let i = -1;
  while ((i = d.indexOf(".", i + 1)) !== -1) {
    const s = d.slice(i + 1);
    // Skip the bare-TLD slice ("com") — same policy as suffixesOf().
    if (s.includes(".")) out.push(s);
  }
  return out;
}

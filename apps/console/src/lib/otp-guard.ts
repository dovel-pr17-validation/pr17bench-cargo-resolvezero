export interface WindowRule {
  windowMs: number;
  max: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter. One bucket per key, reset when the window elapses.
 * In-memory by design: the console runs a single machine; a shared store would
 * be needed before scaling out.
 */
export class WindowLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(
    private readonly rule: WindowRule,
    private readonly now: () => number = Date.now,
  ) {}

  /** Consume one unit for `key`; false when the window is exhausted. */
  hit(key: string): boolean {
    const at = this.now();
    const bucket = this.buckets.get(key);

    if (!bucket || bucket.resetAt <= at) {
      this.buckets.set(key, { count: 1, resetAt: at + this.rule.windowMs });
      this.prune(at);
      return true;
    }

    if (bucket.count >= this.rule.max) return false;
    bucket.count += 1;
    return true;
  }

  reset(): void {
    this.buckets.clear();
  }

  /** Drop expired buckets once the map grows, so a spray of emails can't leak memory. */
  private prune(at: number): void {
    if (this.buckets.size < 5_000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= at) this.buckets.delete(key);
    }
  }
}

export type OtpDenial = "email" | "global";

export interface OtpGuard {
  allow(email: string): { allowed: true } | { allowed: false; reason: OtpDenial };
  reset(): void;
}

/**
 * Protects the email bill and stops one address being spammed from many IPs.
 * The per-IP limit is enforced separately by Better Auth's rate limiter.
 */
export function createOtpGuard(
  config: { perEmail: WindowRule; global: WindowRule },
  now: () => number = Date.now,
): OtpGuard {
  const perEmail = new WindowLimiter(config.perEmail, now);
  const global = new WindowLimiter(config.global, now);

  return {
    allow(rawEmail) {
      const email = String(rawEmail ?? "").trim().toLowerCase();
      if (!perEmail.hit(email)) return { allowed: false, reason: "email" };
      if (!global.hit("global")) return { allowed: false, reason: "global" };
      return { allowed: true };
    },
    reset() {
      perEmail.reset();
      global.reset();
    },
  };
}

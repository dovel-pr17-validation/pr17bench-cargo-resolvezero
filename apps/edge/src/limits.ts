/**
 * Small, dependency-free resource controls for the edge.
 *
 * These are intentionally process-local: they bound work on one PoP, while
 * per-tenant/config limits live in the database. Keep them cheap enough for the
 * DNS hot path — no timers, no async, no unbounded maps.
 */

export interface RateLimiter {
  (key: string): boolean;
}

/** Fixed-window limiter with a hard key cap so hostile keys can't grow memory. */
export function createRateLimiter(limit: number, windowMs: number, maxKeys = 10_000): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  return (key: string): boolean => {
    const now = Date.now();
    const cur = hits.get(key);
    if (!cur || now > cur.resetAt) {
      if (hits.size >= maxKeys) {
        for (const [k, v] of hits) {
          if (now > v.resetAt) hits.delete(k);
        }
        if (hits.size >= maxKeys) hits.clear();
      }
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return true;
    }
    cur.count += 1;
    return cur.count <= limit;
  };
}

/** Bounded in-flight work counter. */
export class Semaphore {
  private active = 0;

  constructor(readonly capacity: number) {}

  tryAcquire(): boolean {
    if (this.active >= this.capacity) return false;
    this.active += 1;
    return true;
  }

  release(): void {
    if (this.active > 0) this.active -= 1;
  }

  get inFlight(): number {
    return this.active;
  }
}

export function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

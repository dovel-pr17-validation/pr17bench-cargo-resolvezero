import type { Logger } from "pino";
import { moduleLogger } from "./logger";

export interface QueryLogEntry {
  profileId: string;
  domain: string;
  action: "block" | "allow" | "forward" | "override";
  rttMs: number | null;
  clientIp: string | null;
  device: string | null;
  /** Why the policy action happened. Omitted for ordinary forwards. */
  reason?: "manual" | "blocklist" | "zone" | "safesearch";
  /** profile_blocklists.id for blocklist hits (never the URL). */
  listId?: string;
  transport?: "doh" | "udp" | "tcp" | "dot";
  /** Safe upstream label (preset, "custom", or "edge-default"). */
  upstream?: string;
}

export interface QueryLogRow extends QueryLogEntry {
  loggedAt: Date;
}

export interface BatcherOptions {
  /** Persistence sink (drizzle bulk insert in prod; injectable for tests). */
  insert(rows: QueryLogRow[]): Promise<unknown>;
  flushIntervalMs?: number;
  maxBatch?: number;
  /** Hard buffer cap; oldest rows are dropped past it (DNS volume guard). */
  maxBuffer?: number;
  log?: Logger;
}

/**
 * Async query-log batcher (readme §6.5): DNS resolution NEVER waits on the
 * log sink. Entries buffer in memory; flushes every interval or when the
 * batch fills. On sink failure the batch is retained and retried with
 * exponential backoff (cap 30 s) — oldest rows dropped only past maxBuffer.
 */
export class QueryLogBatcher {
  private buffer: QueryLogRow[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private flushing = false;
  private stopped = false;
  private backoffMs = 0;
  private nextAllowedAt = 0;

  private readonly intervalMs: number;
  private readonly maxBatch: number;
  private readonly maxBuffer: number;
  private readonly log: Logger;

  constructor(private opts: BatcherOptions) {
    this.intervalMs = opts.flushIntervalMs ?? 2000;
    this.maxBatch = opts.maxBatch ?? 500;
    this.maxBuffer = opts.maxBuffer ?? 10_000;
    this.log = (opts.log ?? moduleLogger("batcher"));
  }

  add(entry: QueryLogEntry): void {
    if (this.stopped) return;
    this.buffer.push({ ...entry, loggedAt: new Date() });
    if (this.buffer.length > this.maxBuffer) {
      this.buffer.shift(); // drop oldest, warn — never block the hot path
      this.log.warn("query-log buffer overflow, dropped oldest entry");
    }
    if (this.buffer.length >= this.maxBatch) {
      void this.flush();
    }
  }

  start(): void {
    if (this.stopped || this.timer) return;
    this.timer = setInterval(() => {
      if (Date.now() < this.nextAllowedAt) return;
      void this.flush();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    clearTimeout(this.retryTimer);
    // Drain every full batch (single flush() caps at maxBatch).
    while (this.buffer.length > 0) {
      const before = this.buffer.length;
      await this.flush().catch(() => undefined);
      if (this.buffer.length >= before) break; // sink failing — retain for next boot, don't spin
      if (this.flushing) break;
    }
  }

  /** Persist the current buffer. Safe to call concurrently (de-duped). */
  flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return Promise.resolve();
    this.flushing = true;
    const batch = this.buffer.splice(0, this.maxBatch);

    return this.opts
      .insert(batch)
      .then(() => {
        this.backoffMs = 0;
      })
      .catch((err) => {
        // Re-queue the failed batch at the front (best effort ordering).
        this.buffer.unshift(...batch);
        this.backoffMs = this.backoffMs === 0 ? 500 : Math.min(this.backoffMs * 2, 30_000);
        this.nextAllowedAt = Date.now() + this.backoffMs;
        this.log.error({ err, retryInMs: this.backoffMs }, "query-log flush failed");
        if (!this.stopped) {
          this.retryTimer = setTimeout(() => void this.flush(), this.backoffMs);
        }
      })
      .finally(() => {
        this.flushing = false;
      });
  }

  get size(): number {
    return this.buffer.length;
  }
}

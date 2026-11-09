import { gzip as gzipCallback } from "node:zlib";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { moduleLogger } from "../logger";
import type { QueryLogRow } from "../batcher";
import { positiveInt } from "../limits";

const log = moduleLogger("s3sink");

// Best-effort archive budgets. Raw logs are allowed to drop under pressure;
// DNS resolution and rollups must keep moving.
const MAX_STAGED_BYTES = positiveInt(process.env.S3_MAX_STAGED_BYTES, 64 * 1024 * 1024);
const MAX_PENDING_BYTES = positiveInt(process.env.S3_MAX_PENDING_BYTES, 128 * 1024 * 1024);

/** Minimal S3 surface we rely on (injectable for tests). */
export interface S3ClientLike {
  write(key: string, body: Uint8Array): Promise<unknown>;
  file(key: string): { arrayBuffer(): Promise<ArrayBuffer> };
  /** One page; nextContinuationToken feeds the next call. */
  list(opts: {
    prefix: string;
    continuationToken?: string;
    maxKeys?: number;
  }): Promise<{
    contents: { key: string }[];
    isTruncated?: boolean;
    nextContinuationToken?: string;
  }>;
  delete(key: string): Promise<unknown>;
}

/** Collects every key under a prefix across all pages (caps at 50k for safety). */
/** Builds the production S3 adapter from env. Returns null when unconfigured. */
export function createS3ClientFromEnv(): S3ClientLike | null {
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return null;

  const endpoint = process.env.S3_ENDPOINT;
  const client = new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint,
    // iDrive E2 (and most S3-compatible stores) require path-style URLs.
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });

  return {
    async write(key, body) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: "application/gzip",
        }),
      );
    },
    file(key) {
      return {
        async arrayBuffer() {
          const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
          const body = out.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
          if (!body?.transformToByteArray) throw new Error("S3 GetObject returned no body");
          const bytes = await body.transformToByteArray();
          return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        },
      };
    },
    async list({ prefix, continuationToken, maxKeys }) {
      const out = await client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
          MaxKeys: maxKeys,
        }),
      );
      return {
        contents: (out.Contents ?? []).map((o) => ({ key: o.Key! })),
        isTruncated: out.IsTruncated,
        nextContinuationToken: out.NextContinuationToken,
      };
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    },
  };
}

export async function listAllKeys(
  client: S3ClientLike,
  prefix: string,
  cap = 50_000,
): Promise<{ keys: string[]; truncated: boolean }> {
  const keys: string[] = [];
  const seen = new Set<string>();
  let continuationToken: string | undefined;
  let truncated = false;
  let pages = 0;

  for (;;) {
    if (++pages > 100) {
      truncated = true;
      break;
    }
    const page = await client.list({ prefix, continuationToken, maxKeys: 1000 });
    for (const obj of page.contents ?? []) {
      if (!seen.has(obj.key)) {
        seen.add(obj.key);
        keys.push(obj.key);
      }
      if (keys.length >= cap) break;
    }
    if (keys.length >= cap) {
      truncated = true;
      break;
    }
    if (!page.isTruncated) break;
    if (!page.nextContinuationToken || page.nextContinuationToken === continuationToken) {
      // Client promises more but gives us no usable cursor — do not loop
      // forever on a client that ignores continuationToken.
      truncated = true;
      break;
    }
    continuationToken = page.nextContinuationToken;
  }

  keys.sort();
  return { keys, truncated };
}

/** Deletes keys with bounded concurrency (avoids 50k simultaneous requests). */
export async function deleteKeys(client: S3ClientLike, keys: string[], concurrency = 8): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, keys.length) }, async () => {
    for (;;) {
      const i = index++;
      if (i >= keys.length) return;
      await client.delete(keys[i]!);
    }
  });
  await Promise.all(workers);
}

export interface S3SinkOptions {
  client: S3ClientLike;
  /** Object key root. Default "logs". */
  prefix?: string;
  /** Flush window in minutes — one object per window per profile. Default 1. */
  flushMinutes?: number;
  /** Unique per running edge instance (region+machine+boot nonce). */
  instanceId?: string;
  log?: LoggerBaseLike;
}

/**
 * Key layout (SHARED CONTRACT with the Log Shipper/Vector path and the
 * /logs download + clear endpoints — do not change without updating all):
 *   {prefix}/{profileId}/{YYYY-MM-DD}/{HHmm}.{instanceId}.{seq}.jsonl.gz
 *
 * `instanceId` is region+machine+boot-nonce so two PoPs (or a restarted
 * machine) writing the same profile/window never overwrite each other.
 */
export function logObjectKey(
  prefix: string,
  profileId: string,
  windowStart: Date,
  instanceId: string,
  seq: number,
): string {
  const date = windowStart.toISOString().slice(0, 10);
  const hh = String(windowStart.getUTCHours()).padStart(2, "0");
  const mm = String(windowStart.getUTCMinutes()).padStart(2, "0");
  return `${prefix}/${profileId}/${date}/${hh}${mm}.${instanceId}.${seq}.jsonl.gz`;
}

export function profilePrefix(prefix: string, profileId: string): string {
  return `${prefix}/${profileId}/`;
}

interface PendingObject {
  key: string;
  payload: Uint8Array;
  attempts: number;
  bytes: number;
}

/**
 * In-process raw-log sink: stages events in memory per flush window,
 * PUTs one gzip NDJSON object per completed window per profile.
 * Failed uploads are retained and retried on the next tick (bounded by
 * object count and pending bytes, oldest dropped + warned).
 *
 * Crash window = flushMinutes (raw events in RAM) — acceptable; rollups
 * (stats_hourly) are written independently and are the near-live path.
 */
export class S3ArchiveSink {
  private staging = new Map<string, { startsAt: number; profileId: string; lines: string[]; bytes: number }>();
  private pending: PendingObject[] = [];
  private stagedBytes = 0;
  private pendingBytes = 0;
  private droppedLines = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private seq = 0;
  private readonly instanceId: string;
  private readonly log: LoggerBaseLike;

  constructor(private opts: S3SinkOptions) {
    this.instanceId = sanitizeInstanceId(opts.instanceId ?? defaultInstanceId());
    this.log = opts.log ?? moduleLogger("s3sink");
    this.start();
  }

  private start(): void {
    // Check completed windows more often than the window size itself. S3
    // object granularity stays at flushMinutes, but a completed window is
    // uploaded within ~1 minute instead of waiting for the next full window.
    const intervalMs = Math.min(60_000, this.windowMs());
    this.timer = setInterval(() => void this.flushCompleted(), intervalMs);
    this.timer.unref?.();
  }

  /** Append rows to their window staging buffers. Never throws. */
  add(rows: QueryLogRow[]): void {
    try {
      for (const row of rows) {
        const line = JSON.stringify(lineFor(row));
        const bytes = Buffer.byteLength(line) + 1;
        if (this.stagedBytes + bytes > MAX_STAGED_BYTES) {
          this.droppedLines += 1;
          if (this.droppedLines === 1 || this.droppedLines % 1000 === 0) {
            this.log.warn({ droppedLines: this.droppedLines, stagedBytes: this.stagedBytes }, "raw-log staging cap reached, dropping lines");
          }
          continue;
        }
        const startsAt = windowFloor(row.loggedAt.getTime(), this.windowMs());
        const key = `${startsAt}|${row.profileId}`;
        let buf = this.staging.get(key);
        if (!buf) {
          buf = { startsAt, profileId: row.profileId, lines: [], bytes: 0 };
          this.staging.set(key, buf);
        }
        buf.lines.push(line);
        buf.bytes += bytes;
        this.stagedBytes += bytes;
      }
    } catch (err) {
      this.log.error({ err }, "staging failed");
    }
  }

  /** PUT all staged windows whose window has fully elapsed. */
  async flushCompleted(): Promise<void> {
    const now = this.nowMs();
    for (const [key, buf] of [...this.staging]) {
      if (buf.startsAt + this.windowMs() <= now) {
        this.staging.delete(key);
        this.stagedBytes = Math.max(0, this.stagedBytes - buf.bytes);
        await this.put(this.objectKey(buf.startsAt, buf.profileId), buf.lines);
      }
    }
    await this.retryPending();
  }

  /** Force-PUT everything staged (SIGTERM / drain). */
  async flushAll(): Promise<void> {
    for (const [key, buf] of [...this.staging]) {
      this.staging.delete(key);
      this.stagedBytes = Math.max(0, this.stagedBytes - buf.bytes);
      await this.put(this.objectKey(buf.startsAt, buf.profileId), buf.lines);
    }
    await this.retryPending();
  }

  stop(): void {
    clearInterval(this.timer);
  }

  get stats() {
    return {
      stagedWindows: this.staging.size,
      pendingUploads: this.pending.length,
      stagedLines: [...this.staging.values()].reduce((n, b) => n + b.lines.length, 0),
      stagedBytes: this.stagedBytes,
      pendingBytes: this.pendingBytes,
      droppedLines: this.droppedLines,
    };
  }

  // exposed for tests
  protected nowMs(): number {
    return Date.now();
  }

  private windowMs(): number {
    return (this.opts.flushMinutes ?? 1) * 60_000;
  }

  private objectKey(startsAt: number, profileId: string): string {
    return logObjectKey(
      this.opts.prefix ?? "logs",
      profileId,
      new Date(startsAt),
      this.instanceId,
      this.seq++,
    );
  }

  private async put(key: string, lines: string[]): Promise<void> {
    if (lines.length === 0) return;
    const payload = await gzip(lines.join("\n"));
    try {
      await this.opts.client.write(key, payload);
      this.log.debug({ key, lines: lines.length }, "archive object written");
    } catch (err) {
      this.pending.push({ key, payload, attempts: 0, bytes: payload.length });
      this.pendingBytes += payload.length;
      while (this.pending.length > 200 || this.pendingBytes > MAX_PENDING_BYTES) {
        const dropped = this.pending.shift();
        if (!dropped) break;
        this.pendingBytes = Math.max(0, this.pendingBytes - dropped.bytes);
        this.log.warn({ key: dropped.key, bytes: dropped.bytes }, "pending archive uploads overflow, dropped oldest");
      }
      this.log.error({ err, key }, "archive upload failed (queued for retry)");
    }
  }

  private async retryPending(): Promise<void> {
    const still: PendingObject[] = [];
    for (const p of this.pending) {
      try {
        await this.opts.client.write(p.key, p.payload);
      } catch {
        if (++p.attempts > 48) { // bounded retry budget; keeps failed objects from growing forever
          this.log.error({ key: p.key }, "archive upload abandoned after max attempts");
          continue;
        }
        still.push(p);
      }
    }
    this.pending = still;
    this.pendingBytes = still.reduce((sum, p) => sum + p.bytes, 0);
  }
}

export interface LoggerBaseLike {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const EDGE_REGION = process.env.FLY_REGION ?? "local";
/** Internal diagnostics only — not rendered in the customer console. */
const EDGE_MACHINE = process.env.FLY_MACHINE_ID ?? process.env.FLY_ALLOC_ID ?? "local";

/** Wire format for one archived query event (raw-log contract). */
export function lineFor(row: QueryLogRow): Record<string, unknown> {
  return {
    kind: "query",
    time: row.loggedAt.toISOString(),
    profile: row.profileId,
    domain: row.domain,
    action: row.action,
    rttMs: row.rttMs,
    clientIp: row.clientIp,
    // omit device:null — keep the raw-log schema minimal for tokenless queries
    ...(row.device ? { device: row.device } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.listId ? { listId: row.listId } : {}),
    ...(row.transport ? { transport: row.transport } : {}),
    ...(row.upstream ? { upstream: row.upstream } : {}),
    region: EDGE_REGION, // which PoP served this query
    machine: EDGE_MACHINE, // internal diagnostics only
  };
}

function gzip(text: string): Promise<Uint8Array> {
  const input = new TextEncoder().encode(text);
  return new Promise((resolve, reject) => {
    gzipCallback(input, (err, out) => {
      if (err) reject(err);
      else resolve(new Uint8Array(out));
    });
  });
}

/** Aligns a timestamp to the flush window grid (aligned to unix epoch). */
export function windowFloor(t: number, windowMs: number): number {
  return Math.floor(t / windowMs) * windowMs;
}

function defaultInstanceId(): string {
  const region = process.env.FLY_REGION ?? "local";
  const machine = process.env.FLY_MACHINE_ID ?? process.env.FLY_ALLOC_ID ?? "machine";
  const boot = crypto.randomUUID().slice(0, 8);
  return `${region}-${machine.slice(0, 8)}-${boot}`;
}

function sanitizeInstanceId(id: string): string {
  const safe = id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return safe || "local";
}

import { Hono } from "hono";
import { Readable } from "node:stream";
import { moduleLogger } from "./logger";
import type { RuleStore } from "./ruleStore";
import { deleteKeys, listAllKeys, profilePrefix, type S3ClientLike } from "./sinks/s3";
import { createRateLimiter } from "./limits";

const log = moduleLogger("logs");

const CSV_HEADER = "time,domain,action,client_ip,rtt_ms\n";
// Cap inflated log objects at 32 MB — a poisoned/oversized archive object
// must not OOM the 256 MB edge during download.
const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_INFLATED_BYTES = 128 * 1024 * 1024;
const MAX_EXPORT_OBJECTS = 500;
const MAX_DATE_EXPORT_OBJECTS = 5_000;

const exportLimiter = createRateLimiter(10, 60_000);
const deleteLimiter = createRateLimiter(5, 60_000);

function bearerOrQuery(c: { req: { query(k: string): string | undefined; header(n: string): string | undefined } }): string | undefined {
  const q = c.req.query("token");
  if (q) return q;
  const h = c.req.header("authorization");
  if (h?.toLowerCase().startsWith("bearer ")) return h.slice(7).trim() || undefined;
  return undefined;
}

function csvField(v: unknown): string {
  const s = String(v ?? "");
  // Quote always (commas/quotes/newlines in domains) + neutralize spreadsheet
  // formula injection (=,+,-,@,tab) per OWASP CSV guidance.
  const safe = /^[=+\-@\t]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
}

export interface LogsDeps {
  store: RuleStore;
  /** Present only when S3 archive is configured (raw logs live there). */
  client: S3ClientLike | null;
  /** Same object key root as the sinks (default "logs"). */
  prefix?: string;
}

/**
 * Raw-log manager endpoints (NextDNS-parity, readme §6):
 *   GET    /v1/:profileId/logs?format=jsonl|csv&date=YYYY-MM-DD[&token=]
 *   DELETE /v1/:profileId/logs[?token=]
 *
 * Streams objects from the archive bucket; retention/enforcement of the
 * physical raw-log lifetime is the bucket's lifecycle rule (deploy-side).
 */
export function createLogsApp(deps: LogsDeps) {
  const app = new Hono().basePath("/v1");
  const prefix = deps.prefix ?? "logs";

  app.get(":profileId/logs", async (c) => {
    const profileId = c.req.param("profileId");
    if (!deps.store.hasProfile(profileId, bearerOrQuery(c))) {
      return c.body(null, 404);
    }
    if (!deps.client) {
      return c.json({ error: "raw log archive not configured" }, 503);
    }

    const caller = c.req.header("fly-client-ip") ?? "unknown";
    if (!exportLimiter(`${caller}:${profileId}`)) {
      return c.json({ error: "rate limited" }, 429);
    }

    const format = c.req.query("format") ?? "jsonl";
    if (format !== "jsonl" && format !== "csv") {
      return c.json({ error: "format must be jsonl|csv" }, 400);
    }

    let date = c.req.query("date") ?? "";
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return c.json({ error: "date must be YYYY-MM-DD" }, 400);
    }

    const profileObjects = profilePrefix(prefix, profileId);
    const objectPrefix = date ? `${profileObjects}${date}/` : profileObjects;

    const rawLimit = Number(c.req.query("limit") ?? 0);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 10_000) : 0;
    const newestFirst = c.req.query("order") === "desc";

    const { keys, truncated } = date
      ? await listAllKeys(deps.client, objectPrefix)
      : await listRecentLogKeys(deps.client, profileObjects);
    const objectCap = date ? MAX_DATE_EXPORT_OBJECTS : MAX_EXPORT_OBJECTS;
    // `keys` is ascending. Always keep the newest N objects, then reverse
    // only when the caller wants newest-first output. (Reversing before
    // slicing used to keep the OLDEST N when there were >N objects.)
    const cappedKeys = keys.slice(-objectCap);
    const orderedKeys = newestFirst ? [...cappedKeys].reverse() : cappedKeys;
    const capped = truncated || cappedKeys.length !== keys.length;

    const encoder = new TextEncoder();
    const signal = c.req.raw.signal;
    const lines = async function* (): AsyncGenerator<Uint8Array> {
      if (capped) {
        yield encoder.encode(
          format === "jsonl" ? `{"warning":"truncated at ${cappedKeys.length} objects"}\n` : `# warning: truncated at ${cappedKeys.length} objects\n`,
        );
      }
      if (format === "csv") yield encoder.encode(CSV_HEADER);
      let emitted = 0;
      let totalInflated = 0;
      for (const key of orderedKeys) {
        if (signal.aborted) return;
        const compressed = new Uint8Array(await deps.client!.file(key).arrayBuffer());
        if (compressed.length > MAX_INFLATED_BYTES) {
          log.warn({ key }, "log object too large, skipped");
          continue;
        }
        let raw: string;
        try {
          // Bounded streaming inflate: a gzip bomb aborts at the cap
          // instead of allocating its full expansion.
          const inflated = await gunzipBounded(compressed, MAX_INFLATED_BYTES);
          totalInflated += inflated.length;
          if (totalInflated > MAX_TOTAL_INFLATED_BYTES) {
            log.warn({ totalInflated }, "log export hit aggregate inflate cap");
            yield encoder.encode(
              format === "jsonl" ? `{"warning":"export truncated at aggregate size cap"}\n` : `# warning: export truncated at aggregate size cap\n`,
            );
            return;
          }
          raw = new TextDecoder().decode(inflated);
        } catch (err) {
          log.error({ err, key }, "log object corrupt/too large, skipped");
          continue;
        }
        const objectLines = raw.split("\n").filter(Boolean);
        if (newestFirst) objectLines.reverse();
        for (const line of objectLines) {
          if (signal.aborted) return;
          if (limit && emitted >= limit) return;
          if (format === "jsonl") {
            yield encoder.encode(line + "\n");
            emitted++;
            continue;
          }
          const e = JSON.parse(line) as Record<string, unknown>;
          const row = [
            csvField(e.time),
            csvField(e.domain),
            csvField(e.action),
            csvField(e.clientIp ?? ""),
            csvField(e.rttMs ?? ""),
          ].join(",");
          yield encoder.encode(row + "\n");
          emitted++;
        }
      }
    };

    // Readable.from + toWeb gives us real backpressure: a slow client pauses
    // the generator instead of queueing the whole archive in memory.
    const stream = Readable.toWeb(Readable.from(lines())) as ReadableStream<Uint8Array>;

    return new Response(stream, {
      headers: {
        "content-type": format === "csv" ? "text/csv" : "application/x-ndjson",
        "content-disposition": `attachment; filename="rz-logs-${profileId}${date ? "-" + date : ""}.${format}"`,
        ...(capped ? { "x-rz-truncated": "true" } : {}),
        ...(limit ? { "x-rz-limited": String(limit) } : {}),
        "x-rz-objects": String(cappedKeys.length),
      },
    });
  });

  app.delete(":profileId/logs", async (c) => {
    const profileId = c.req.param("profileId");
    if (!deps.store.hasProfile(profileId, bearerOrQuery(c))) {
      return c.body(null, 404);
    }
    const caller = c.req.header("fly-client-ip") ?? "unknown";
    if (!deleteLimiter(`${caller}:${profileId}`)) {
      return c.json({ error: "rate limited" }, 429);
    }
    if (!deps.client) {
      return c.json({ error: "raw log archive not configured" }, 503);
    }

    const { keys, truncated } = await listAllKeys(deps.client, profilePrefix(prefix, profileId));
    await deleteKeys(deps.client, keys);
    log.info({ profileId, removed: keys.length, truncated }, "raw logs cleared");
    // Never claim completeness when the listing was truncated.
    return c.json({ removed: keys.length, truncated });
  });

  return app;
}

/**
 * The console asks for "latest" logs without a date. At 1-minute flush
 * granularity a profile can have thousands of objects per day, so listing
 * the entire retention prefix would be slow and would eventually hit the
 * global 50k-key cap. Fetch the current and previous UTC day, then fall back
 * to the full prefix for old archive-only accounts/tests.
 */
async function listRecentLogKeys(
  client: S3ClientLike,
  prefix: string,
): Promise<{ keys: string[]; truncated: boolean }> {
  const days: string[] = [];
  for (let i = 0; i < 2; i++) {
    days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  }

  const results = await Promise.all(days.map((day) => listAllKeys(client, `${prefix}${day}/`)));
  const keys = results.flatMap((result) => result.keys).sort();
  const truncated = results.some((result) => result.truncated);
  if (keys.length > 0 || truncated) return { keys, truncated };
  return listAllKeys(client, prefix);
}

/** Streaming gzip inflate with a hard output cap (defeats zip bombs). */
async function gunzipBounded(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const decompressed = new Blob([data.slice().buffer as ArrayBuffer])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  const reader = decompressed.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error(`inflated log object exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

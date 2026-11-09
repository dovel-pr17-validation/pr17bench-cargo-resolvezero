import type { LogEntry } from "../server/dashboard/types";

/**
 * The edge writes one S3 object per minute, so polling faster than the flush
 * only lowers the worst-case lag at the bucket boundary. 30s keeps that lag
 * under half a minute without hammering the edge log endpoint (10 req/min).
 */
export const LOG_POLL_MS = 30_000;
/** Rows kept in the tail; older rows fall off the bottom. */
export const LOG_MAX_ROWS = 500;

/**
 * Identity for a log row: the archive has no id, so a composite of the
 * immutable fields stands in. Repeated lookups of the same domain in the same
 * millisecond by the same client collapse into one row — acceptable for a
 * live tail, and it keeps re-fetched windows from duplicating.
 */
export function logEntryKey(entry: LogEntry): string {
  return [entry.time, entry.domain, entry.action, entry.clientIp ?? "", entry.device ?? "", entry.rttMs ?? ""].join("|");
}

/** Newest first, de-duplicated, capped. Pure — unit-tested. */
export function mergeLogEntries(incoming: LogEntry[], existing: LogEntry[], cap = LOG_MAX_ROWS): LogEntry[] {
  const seen = new Set<string>();
  const merged: LogEntry[] = [];
  for (const entry of [...incoming, ...existing]) {
    const key = logEntryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  merged.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
  return merged.slice(0, cap);
}

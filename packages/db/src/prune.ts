import { sql } from "drizzle-orm";
import { db } from "./client";

/**
 * Retention job (readme §3 C / §6.5):
 *   - stats_minute: rows older than 6 hours are always pruned
 *     (short-range chart data; hard bound, independent of profiles).
 *   - stats_hourly: rows older than each profile's log_retention_days.
 * Raw-log lifetime in S3 is enforced by the bucket's lifecycle rules
 * (deploy-side); this job bounds the Postgres side. Run daily:
 * startPruneLoop() from boot or `bun run db:prune` via cron.
 */
export async function pruneExpiredStats(): Promise<number> {
  const res = (await db.execute(sql`
    WITH deleted AS (
      DELETE FROM stats_minute
      WHERE minute < now() - interval '6 hours'
      RETURNING 1
    ), deleted_device_minutes AS (
      DELETE FROM stats_minute_device
      WHERE minute < now() - interval '6 hours'
      RETURNING 1
    ), deleted_hourly AS (
      DELETE FROM stats_hourly s
      USING profiles p
      WHERE s.profile_id = p.id
        AND s.hour < now() - (GREATEST(p.log_retention_days, 1) * interval '1 day')
      RETURNING 1
    ), deleted_hourly_device AS (
      DELETE FROM stats_hourly_device s
      USING profiles p
      WHERE s.profile_id = p.id
        AND s.hour < now() - (GREATEST(p.log_retention_days, 1) * interval '1 day')
      RETURNING 1
    ), deleted_probes AS (
      DELETE FROM dns_probes
      WHERE seen_at < now() - interval '15 minutes'
      RETURNING 1
    ), deleted_purges AS (
      DELETE FROM dns_cache_purges
      WHERE created_at < now() - interval '1 hour'
      RETURNING 1
    )
    SELECT
      (SELECT count(*)::int FROM deleted) AS minute_pruned,
      (SELECT count(*)::int FROM deleted_device_minutes) AS device_minute_pruned,
      (SELECT count(*)::int FROM deleted_hourly) AS hourly_pruned,
      (SELECT count(*)::int FROM deleted_hourly_device) AS device_hourly_pruned,
      (SELECT count(*)::int FROM deleted_probes) AS probe_pruned,
      (SELECT count(*)::int FROM deleted_purges) AS purge_pruned
  `)) as unknown as Array<{
    minute_pruned: number;
    device_minute_pruned: number;
    hourly_pruned: number;
    device_hourly_pruned: number;
    probe_pruned: number;
    purge_pruned: number;
  }>;

  return (
    (res[0]?.minute_pruned ?? 0) +
    (res[0]?.device_minute_pruned ?? 0) +
    (res[0]?.hourly_pruned ?? 0) +
    (res[0]?.device_hourly_pruned ?? 0) +
    (res[0]?.probe_pruned ?? 0) +
    (res[0]?.purge_pruned ?? 0)
  );
}

/** Interval loop for long-running processes. Returns a stop function. */
export function startPruneLoop(intervalHours = 24): () => void {
  const t = setInterval(() => {
    pruneExpiredStats().catch((err) => {
      console.error("[prune] failed:", err);
    });
  }, intervalHours * 3600_000);
  t.unref?.();
  return () => clearInterval(t);
}

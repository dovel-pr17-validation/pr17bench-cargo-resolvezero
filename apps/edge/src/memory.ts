import { positiveInt } from "./limits";
import { moduleLogger } from "./logger";

const log = moduleLogger("memory");

const INTERVAL_MS = 30_000;
const WARN_RATIO = 0.7;
const CRITICAL_RATIO = 0.85;

export type MemoryLevel = "ok" | "warn" | "critical";

/** Fly exports the machine size; fall back to an explicit override or 1 GB. */
export function memoryLimitMb(): number {
  const fly = Number(process.env.FLY_VM_MEMORY_MB);
  if (Number.isFinite(fly) && fly > 0) return Math.round(fly);
  return positiveInt(process.env.MEMORY_LIMIT_MB, 1024);
}

export function rssMb(): number {
  return Math.round(process.memoryUsage.rss() / (1024 * 1024));
}

export function memoryLevel(rss: number, limit: number): MemoryLevel {
  if (!Number.isFinite(limit) || limit <= 0) return "ok";
  const ratio = rss / limit;
  if (ratio >= CRITICAL_RATIO) return "critical";
  if (ratio >= WARN_RATIO) return "warn";
  return "ok";
}

/**
 * Logs once per threshold crossing (not every tick). The hourly sentinel fails
 * when /readyz reports rss >= 85%, which is the actual alert (GitHub email).
 * Blocklist parse transients are the usual cause, so the level hysteresis
 * matters: a single spike should not produce a line every 30 seconds.
 */
export function startMemoryWatchdog(intervalMs = INTERVAL_MS): () => void {
  let level = memoryLevel(rssMb(), memoryLimitMb());
  const timer = setInterval(() => {
    const rss = rssMb();
    const limit = memoryLimitMb();
    const next = memoryLevel(rss, limit);
    if (next === level) return;
    const payload = { rssMb: rss, limitMb: limit, pct: Math.round((rss / limit) * 100) };
    if (next === "critical") log.error(payload, "rss above 85% of the machine limit");
    else if (next === "warn") log.warn(payload, "rss above 70% of the machine limit");
    else log.info(payload, "rss back below the warning threshold");
    level = next;
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

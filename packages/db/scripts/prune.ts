// Cron entrypoint (readme §3 C): prunes stats_hourly rows older than each
// profile's log_retention_days. Requires DATABASE_URL; exits after one pass.
const { pruneExpiredStats } = await import("./prune");

const pruned = await pruneExpiredStats();
console.log(`[db:prune] removed ${pruned} expired stats_hourly rows`);
process.exit(0);

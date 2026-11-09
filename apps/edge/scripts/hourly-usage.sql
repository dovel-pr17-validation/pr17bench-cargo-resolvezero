-- Hourly queries + blocks (stats_hourly, last 24h, UTC)
SELECT hour                     AS hour_utc,
       total_queries,
       blocked,
       round(blocked * 100.0 / GREATEST(total_queries, 1), 1) AS pct_blocked,
       CASE WHEN rtt_count > 0 THEN round(rtt_sum_ms::numeric / rtt_count, 1) END AS upstream_rtt_avg_ms
FROM   stats_hourly
WHERE  hour >= now() - interval '24 hours'
ORDER  BY hour DESC;

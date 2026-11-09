-- Edge config propagation watermark.
--
-- Instead of LISTEN/NOTIFY, every config write bumps one of these counters in
-- the same transaction. Each edge POP polls the row (default every 5s) and
-- re-snapshots/re-syncs when the counter moves. A version row is immune to
-- missed notifications, dedicated LISTEN connections, and PgBouncer
-- transaction-pooling limitations.
--
-- The bump functions are SECURITY DEFINER so the control/app role only needs
-- DML on the config tables, not UPDATE on this watermark.

INSERT INTO "edge_config_state" ("id") VALUES (true) ON CONFLICT ("id") DO NOTHING;

-- The edge app role only needs to read this row.
GRANT SELECT ON "edge_config_state" TO PUBLIC;

CREATE OR REPLACE FUNCTION bump_edge_config_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE edge_config_state
     SET config_version = config_version + 1,
         updated_at = now()
   WHERE id = true;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION bump_edge_blocklist_version()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE edge_config_state
     SET blocklist_version = blocklist_version + 1,
         updated_at = now()
   WHERE id = true;
  RETURN NULL;
END;
$$;

-- Drop the old row-level NOTIFY triggers/functions' triggers (functions can
-- remain for rollback safety). The config writes are now watermark-driven.
DROP TRIGGER IF EXISTS rule_update_trigger ON profile_rules;
DROP TRIGGER IF EXISTS zone_update_trigger ON profile_zones;
DROP TRIGGER IF EXISTS ip_update_trigger ON profile_source_ips;
DROP TRIGGER IF EXISTS profile_config_insert_delete_trigger ON profiles;
DROP TRIGGER IF EXISTS profile_config_update_trigger ON profiles;
DROP TRIGGER IF EXISTS blocklist_update_trigger ON profile_blocklists;
DROP TRIGGER IF EXISTS blocklist_update_cols_trigger ON profile_blocklists;

-- Basic config: profiles + rules + zones + source-IP whitelist.
CREATE TRIGGER edge_config_profiles_trigger
AFTER INSERT OR DELETE OR UPDATE OF
  upstream, upstream_url, doh_token, log_queries, log_retention_days
ON profiles
FOR EACH STATEMENT EXECUTE FUNCTION bump_edge_config_version();

CREATE TRIGGER edge_config_rules_trigger
AFTER INSERT OR UPDATE OR DELETE ON profile_rules
FOR EACH STATEMENT EXECUTE FUNCTION bump_edge_config_version();

CREATE TRIGGER edge_config_zones_trigger
AFTER INSERT OR UPDATE OR DELETE ON profile_zones
FOR EACH STATEMENT EXECUTE FUNCTION bump_edge_config_version();

CREATE TRIGGER edge_config_source_ips_trigger
AFTER INSERT OR UPDATE OR DELETE ON profile_source_ips
FOR EACH STATEMENT EXECUTE FUNCTION bump_edge_config_version();

-- Blocklist subscriptions: a separate version so rule churn doesn't trigger
-- list re-fetches. Status write-backs (last_synced_at/last_status/entry_count)
-- are deliberately excluded to avoid a sync loop.
CREATE TRIGGER edge_blocklist_trigger
AFTER INSERT OR DELETE OR UPDATE OF url, format, enabled, profile_id
ON profile_blocklists
FOR EACH STATEMENT EXECUTE FUNCTION bump_edge_blocklist_version();

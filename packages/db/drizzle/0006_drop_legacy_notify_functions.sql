-- Legacy LISTEN/NOTIFY functions are no longer used by the edge (config
-- propagation is watermark polling). Their triggers were dropped in 0005;
-- CASCADE also removes any lingering trigger that still references them.
--
-- Keep bump_edge_config_version() / bump_edge_blocklist_version(): the
-- edge_config_state triggers call them.

DROP FUNCTION IF EXISTS notify_rule_change() CASCADE;
DROP FUNCTION IF EXISTS notify_zone_change() CASCADE;
DROP FUNCTION IF EXISTS notify_ip_change() CASCADE;
DROP FUNCTION IF EXISTS notify_blocklist_change() CASCADE;
DROP FUNCTION IF EXISTS notify_profile_change() CASCADE;

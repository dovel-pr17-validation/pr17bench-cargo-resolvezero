-- Replace UUID profile ids with 20-char lowercase ids (URL-friendly, no dashes).
-- Internal foreign keys keep pointing at the same rows; only the identifier
-- format changes, so URLs stop containing UUIDs.

CREATE TEMP TABLE _profile_id_map ON COMMIT DROP AS
SELECT id::text AS old_id, lower(substr(md5(id::text || random()::text), 1, 20)) AS new_id
FROM profiles;

-- Drop every FK that references profiles(id), whatever its generated name.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tc.table_name, tc.constraint_name
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
     AND ccu.constraint_schema = tc.constraint_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND ccu.table_name = 'profiles'
      AND ccu.column_name = 'id'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', r.table_name, r.constraint_name);
  END LOOP;
END $$;

-- The blocklist version trigger references profile_id, so it must be recreated.
DROP TRIGGER IF EXISTS edge_blocklist_trigger ON profile_blocklists;

ALTER TABLE profiles ALTER COLUMN id TYPE varchar(64) USING id::text;
ALTER TABLE profile_rules ALTER COLUMN profile_id TYPE varchar(64) USING profile_id::text;
ALTER TABLE profile_zones ALTER COLUMN profile_id TYPE varchar(64) USING profile_id::text;
ALTER TABLE profile_devices ALTER COLUMN profile_id TYPE varchar(64) USING profile_id::text;
ALTER TABLE profile_source_ips ALTER COLUMN profile_id TYPE varchar(64) USING profile_id::text;
ALTER TABLE stats_hourly ALTER COLUMN profile_id TYPE varchar(64) USING profile_id::text;
ALTER TABLE stats_minute ALTER COLUMN profile_id TYPE varchar(64) USING profile_id::text;
ALTER TABLE profile_blocklists ALTER COLUMN profile_id TYPE varchar(64) USING profile_id::text;
ALTER TABLE dns_cache_purges ALTER COLUMN profile_id TYPE varchar(64) USING profile_id::text;
ALTER TABLE api_audit_log ALTER COLUMN profile_id TYPE varchar(64) USING profile_id::text;

UPDATE profiles p SET id = m.new_id FROM _profile_id_map m WHERE p.id = m.old_id;
UPDATE profile_rules t SET profile_id = m.new_id FROM _profile_id_map m WHERE t.profile_id = m.old_id;
UPDATE profile_zones t SET profile_id = m.new_id FROM _profile_id_map m WHERE t.profile_id = m.old_id;
UPDATE profile_devices t SET profile_id = m.new_id FROM _profile_id_map m WHERE t.profile_id = m.old_id;
UPDATE profile_source_ips t SET profile_id = m.new_id FROM _profile_id_map m WHERE t.profile_id = m.old_id;
UPDATE stats_hourly t SET profile_id = m.new_id FROM _profile_id_map m WHERE t.profile_id = m.old_id;
UPDATE stats_minute t SET profile_id = m.new_id FROM _profile_id_map m WHERE t.profile_id = m.old_id;
UPDATE profile_blocklists t SET profile_id = m.new_id FROM _profile_id_map m WHERE t.profile_id = m.old_id;
UPDATE dns_cache_purges t SET profile_id = m.new_id FROM _profile_id_map m WHERE t.profile_id = m.old_id;
UPDATE api_audit_log t SET profile_id = m.new_id FROM _profile_id_map m WHERE t.profile_id = m.old_id;

-- API keys store the profile id inside metadata JSON.
UPDATE apikey a
SET metadata = replace(a.metadata, m.old_id, m.new_id)
FROM _profile_id_map m
WHERE a.metadata IS NOT NULL AND a.metadata LIKE '%' || m.old_id || '%';

ALTER TABLE profiles ALTER COLUMN id TYPE varchar(32);
ALTER TABLE profile_rules ALTER COLUMN profile_id TYPE varchar(32);
ALTER TABLE profile_zones ALTER COLUMN profile_id TYPE varchar(32);
ALTER TABLE profile_devices ALTER COLUMN profile_id TYPE varchar(32);
ALTER TABLE profile_source_ips ALTER COLUMN profile_id TYPE varchar(32);
ALTER TABLE stats_hourly ALTER COLUMN profile_id TYPE varchar(32);
ALTER TABLE stats_minute ALTER COLUMN profile_id TYPE varchar(32);
ALTER TABLE profile_blocklists ALTER COLUMN profile_id TYPE varchar(32);
ALTER TABLE dns_cache_purges ALTER COLUMN profile_id TYPE varchar(32);
ALTER TABLE api_audit_log ALTER COLUMN profile_id TYPE varchar(32);

ALTER TABLE profile_rules ADD CONSTRAINT profile_rules_profile_id_profiles_id_fk
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE profile_zones ADD CONSTRAINT profile_zones_profile_id_profiles_id_fk
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE profile_devices ADD CONSTRAINT profile_devices_profile_id_profiles_id_fk
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE profile_source_ips ADD CONSTRAINT profile_source_ips_profile_id_profiles_id_fk
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE stats_hourly ADD CONSTRAINT stats_hourly_profile_id_profiles_id_fk
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE stats_minute ADD CONSTRAINT stats_minute_profile_id_profiles_id_fk
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE profile_blocklists ADD CONSTRAINT profile_blocklists_profile_id_profiles_id_fk
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE dns_cache_purges ADD CONSTRAINT dns_cache_purges_profile_id_profiles_id_fk
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;
ALTER TABLE api_audit_log ADD CONSTRAINT api_audit_log_profile_id_profiles_id_fk
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE;

CREATE TRIGGER edge_blocklist_trigger
AFTER INSERT OR DELETE OR UPDATE OF url, format, enabled, profile_id
ON profile_blocklists
FOR EACH STATEMENT EXECUTE FUNCTION bump_edge_blocklist_version();

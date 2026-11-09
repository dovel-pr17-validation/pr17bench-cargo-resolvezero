-- Shorten profile ids to 8 lowercase base36 chars (36^8 ≈ 2.8e12; ~0.18%
-- collision chance at 100k rows). Kept separate from `dot_id`, which stays long
-- because the DoT hostname is itself the credential.

CREATE OR REPLACE FUNCTION rz_short_id(n int) RETURNS text
LANGUAGE plpgsql VOLATILE AS $$
DECLARE
  alphabet text := 'abcdefghijklmnopqrstuvwxyz0123456789';
  out text := '';
  i int;
BEGIN
  FOR i IN 1..n LOOP
    out := out || substr(alphabet, 1 + floor(random() * 36)::int, 1);
  END LOOP;
  RETURN out;
END $$;

CREATE TEMP TABLE _profile_id_map ON COMMIT DROP AS
SELECT id AS old_id, rz_short_id(8) AS new_id FROM profiles;

DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT conrelid::regclass AS tbl, conname
    FROM pg_constraint
    WHERE contype = 'f' AND confrelid = 'profiles'::regclass
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

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

UPDATE apikey a
SET metadata = replace(a.metadata, m.old_id, m.new_id)
FROM _profile_id_map m
WHERE a.metadata IS NOT NULL AND a.metadata LIKE '%' || m.old_id || '%';

ALTER TABLE profiles ALTER COLUMN id TYPE varchar(8);
ALTER TABLE profile_rules ALTER COLUMN profile_id TYPE varchar(8);
ALTER TABLE profile_zones ALTER COLUMN profile_id TYPE varchar(8);
ALTER TABLE profile_devices ALTER COLUMN profile_id TYPE varchar(8);
ALTER TABLE profile_source_ips ALTER COLUMN profile_id TYPE varchar(8);
ALTER TABLE stats_hourly ALTER COLUMN profile_id TYPE varchar(8);
ALTER TABLE stats_minute ALTER COLUMN profile_id TYPE varchar(8);
ALTER TABLE profile_blocklists ALTER COLUMN profile_id TYPE varchar(8);
ALTER TABLE dns_cache_purges ALTER COLUMN profile_id TYPE varchar(8);
ALTER TABLE api_audit_log ALTER COLUMN profile_id TYPE varchar(8);

ALTER TABLE profiles ALTER COLUMN id SET DEFAULT rz_short_id(8);

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

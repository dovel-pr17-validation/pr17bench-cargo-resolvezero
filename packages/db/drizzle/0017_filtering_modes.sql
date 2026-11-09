ALTER TABLE "profiles" ADD COLUMN "block_mode" varchar(16) DEFAULT 'null' NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "block_ipv4" varchar(45);--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "block_ipv6" varchar(45);--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "block_ttl" integer DEFAULT 300 NOT NULL;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "safe_search" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE TABLE "profile_blocked_services" (
	"profile_id" varchar(8) NOT NULL,
	"service" varchar(32) NOT NULL,
	CONSTRAINT "profile_blocked_services_profile_id_service_pk" PRIMARY KEY("profile_id","service")
);--> statement-breakpoint
ALTER TABLE "profile_blocked_services" ADD CONSTRAINT "profile_blocked_services_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
-- New profile columns and the blocked-services table must bump the edge config
-- watermark, otherwise edges keep serving the old policy until something else
-- changes.
DROP TRIGGER IF EXISTS edge_config_profiles_trigger ON profiles;--> statement-breakpoint
CREATE TRIGGER edge_config_profiles_trigger
AFTER INSERT OR DELETE OR UPDATE OF
  upstream, upstream_url, doh_token, log_queries, log_retention_days,
  block_mode, block_ipv4, block_ipv6, block_ttl, safe_search
ON profiles
FOR EACH STATEMENT EXECUTE FUNCTION bump_edge_config_version();--> statement-breakpoint
CREATE TRIGGER edge_config_blocked_services_trigger
AFTER INSERT OR UPDATE OR DELETE ON profile_blocked_services
FOR EACH STATEMENT EXECUTE FUNCTION bump_edge_config_version();

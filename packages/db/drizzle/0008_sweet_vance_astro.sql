CREATE TABLE "dns_cache_purges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"domain" varchar(255) NOT NULL,
	"record_type" varchar(10),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dns_cache_purges" ADD CONSTRAINT "dns_cache_purges_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dns_cache_purges_created_at_idx" ON "dns_cache_purges" USING btree ("created_at");
CREATE TABLE "profile_blocklists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"url" varchar(1024) NOT NULL,
	"format" varchar(16) DEFAULT 'hosts' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_status" varchar(50),
	"entry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profile_blocklists" ADD CONSTRAINT "profile_blocklists_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_blocklists_profile_idx" ON "profile_blocklists" USING btree ("profile_id");
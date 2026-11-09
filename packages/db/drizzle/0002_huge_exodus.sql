CREATE TABLE "profile_devices" (
	"profile_id" uuid NOT NULL,
	"slug" varchar(64) NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_devices_profile_id_slug_pk" PRIMARY KEY("profile_id","slug")
);
--> statement-breakpoint
ALTER TABLE "stats_hourly" ADD COLUMN "top_devices" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "profile_devices" ADD CONSTRAINT "profile_devices_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;
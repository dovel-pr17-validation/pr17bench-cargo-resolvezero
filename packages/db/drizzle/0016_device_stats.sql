CREATE TABLE "stats_hourly_device" (
	"profile_id" varchar(8) NOT NULL,
	"device" varchar(64) NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"total_queries" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL,
	"rtt_sum_ms" bigint DEFAULT 0 NOT NULL,
	"rtt_count" integer DEFAULT 0 NOT NULL,
	"top_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"top_blocked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "stats_hourly_device_profile_id_device_hour_pk" PRIMARY KEY("profile_id","device","hour")
);--> statement-breakpoint
CREATE TABLE "stats_minute_device" (
	"profile_id" varchar(8) NOT NULL,
	"device" varchar(64) NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"total_queries" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "stats_minute_device_profile_id_device_minute_pk" PRIMARY KEY("profile_id","device","minute")
);--> statement-breakpoint
CREATE INDEX "stats_hourly_device_profile_hour_idx" ON "stats_hourly_device" USING btree ("profile_id","hour");--> statement-breakpoint
CREATE INDEX "stats_minute_device_profile_minute_idx" ON "stats_minute_device" USING btree ("profile_id","minute");--> statement-breakpoint
ALTER TABLE "stats_hourly_device" ADD CONSTRAINT "stats_hourly_device_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "stats_minute_device" ADD CONSTRAINT "stats_minute_device_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE cascade;

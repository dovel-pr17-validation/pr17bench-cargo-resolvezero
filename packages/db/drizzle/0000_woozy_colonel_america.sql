CREATE TABLE "profile_rules" (
	"profile_id" uuid NOT NULL,
	"domain" varchar(255) NOT NULL,
	"action" varchar(20) NOT NULL,
	CONSTRAINT "profile_rules_profile_id_domain_pk" PRIMARY KEY("profile_id","domain")
);
--> statement-breakpoint
CREATE TABLE "profile_source_ips" (
	"ip_address" "inet" PRIMARY KEY NOT NULL,
	"profile_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profile_zones" (
	"profile_id" uuid NOT NULL,
	"domain" varchar(255) NOT NULL,
	"record_type" varchar(10) NOT NULL,
	"values" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ttl" integer DEFAULT 300 NOT NULL,
	CONSTRAINT "profile_zones_profile_id_domain_record_type_pk" PRIMARY KEY("profile_id","domain","record_type")
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"doh_token" varchar(255),
	"log_queries" boolean DEFAULT true NOT NULL,
	"log_retention_days" integer DEFAULT 30 NOT NULL,
	"upstream" varchar(50),
	"upstream_url" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_doh_token_unique" UNIQUE("doh_token")
);
--> statement-breakpoint
CREATE TABLE "stats_hourly" (
	"profile_id" uuid NOT NULL,
	"hour" timestamp with time zone NOT NULL,
	"total_queries" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL,
	"rtt_sum_ms" bigint DEFAULT 0 NOT NULL,
	"rtt_count" integer DEFAULT 0 NOT NULL,
	"top_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"top_blocked" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"top_clients" jsonb DEFAULT '[]'::jsonb NOT NULL,
	CONSTRAINT "stats_hourly_profile_id_hour_pk" PRIMARY KEY("profile_id","hour")
);
--> statement-breakpoint
CREATE TABLE "stats_minute" (
	"profile_id" uuid NOT NULL,
	"minute" timestamp with time zone NOT NULL,
	"total_queries" integer DEFAULT 0 NOT NULL,
	"blocked" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "stats_minute_profile_id_minute_pk" PRIMARY KEY("profile_id","minute")
);
--> statement-breakpoint
ALTER TABLE "profile_rules" ADD CONSTRAINT "profile_rules_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_source_ips" ADD CONSTRAINT "profile_source_ips_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile_zones" ADD CONSTRAINT "profile_zones_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stats_hourly" ADD CONSTRAINT "stats_hourly_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stats_minute" ADD CONSTRAINT "stats_minute_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE no action ON UPDATE no action;
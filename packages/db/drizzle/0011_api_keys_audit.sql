CREATE TABLE "apikey" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"config_id" varchar(255) DEFAULT 'default' NOT NULL,
	"name" varchar(255),
	"start" varchar(255),
	"prefix" varchar(255),
	"key" varchar(255) NOT NULL,
	"reference_id" varchar(255) NOT NULL,
	"refill_interval" integer,
	"refill_amount" integer,
	"last_refill_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_enabled" boolean DEFAULT true NOT NULL,
	"rate_limit_time_window" integer,
	"rate_limit_max" integer,
	"request_count" integer DEFAULT 0 NOT NULL,
	"remaining" integer,
	"last_request" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"permissions" text,
	"metadata" text
);
--> statement-breakpoint
CREATE INDEX "apikey_key_idx" ON "apikey" USING btree ("key");--> statement-breakpoint
CREATE INDEX "apikey_reference_idx" ON "apikey" USING btree ("reference_id");--> statement-breakpoint
CREATE TABLE "api_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"profile_id" uuid NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"key_id" varchar(255),
	"via" varchar(16) NOT NULL,
	"procedure" varchar(120) NOT NULL,
	"summary" varchar(255),
	"status" varchar(16) NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_audit_log" ADD CONSTRAINT "api_audit_log_profile_id_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_audit_log_profile_created_idx" ON "api_audit_log" USING btree ("profile_id", "created_at");

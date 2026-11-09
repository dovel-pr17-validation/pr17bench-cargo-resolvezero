CREATE TABLE "edge_config_state" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"config_version" integer DEFAULT 0 NOT NULL,
	"blocklist_version" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

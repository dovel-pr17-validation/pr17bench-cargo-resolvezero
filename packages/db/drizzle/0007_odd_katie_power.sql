CREATE TABLE "dns_probes" (
	"nonce" varchar(64) PRIMARY KEY NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"region" varchar(32),
	"transport" varchar(8) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "dns_probes_seen_at_idx" ON "dns_probes" USING btree ("seen_at");
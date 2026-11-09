ALTER TABLE "profile_blocklists"
  ADD COLUMN IF NOT EXISTS "artifact_hash" text,
  ADD COLUMN IF NOT EXISTS "artifact_rules" integer,
  ADD COLUMN IF NOT EXISTS "compiled_at" timestamp with time zone;

CREATE TABLE IF NOT EXISTS "rule_artifacts" (
  "hash" text PRIMARY KEY NOT NULL,
  "source_url" text NOT NULL,
  "bytes" integer NOT NULL,
  "allow_count" integer NOT NULL,
  "block_count" integer NOT NULL,
  "compiler" varchar(40) NOT NULL DEFAULT 'rz-compile/0.1',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

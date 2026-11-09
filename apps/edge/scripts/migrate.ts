/**
 * Admin-side bootstrap (never runs on the edge; requires DATABASE_URL_ADMIN):
 *   1. applies drizzle migrations (drizzle/ journal)
 *   2. relies on version-bump triggers from the migration journal
 *   3. verifies: tables + expected triggers + watermark row
 *
 * Usage: bun --env-file=.env apps/edge/scripts/migrate.ts
 */
// Admin connection string swap BEFORE lazy client init.
if (!process.env.DATABASE_URL_ADMIN) {
  console.error("DATABASE_URL_ADMIN is not set (see .env) — migrations need DDL rights");
  process.exit(1);
}
// @ts-ignore — .env key is admin-only.
process.env.DATABASE_URL = process.env.DATABASE_URL_ADMIN;

import { migrate } from "drizzle-orm/postgres-js/migrator";
import { db, rawClient } from "@resolvezero/db/client";

await migrate(db, { migrationsFolder: "./packages/db/drizzle" });
console.log("→ migrations applied");

const tables = (await rawClient().unsafe(
  `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY 1`,
)) as { table_name: string }[];
console.log("→ tables:", tables.map((t) => t.table_name));

const triggers = (await rawClient().unsafe(
  `SELECT trigger_name, event_object_table FROM information_schema.triggers WHERE trigger_schema = 'public'`,
)) as { trigger_name: string; event_object_table: string }[];
console.log("→ triggers:", triggers.map((t) => t.trigger_name));

const expectedTriggers = [
  "edge_config_profiles_trigger",
  "edge_config_rules_trigger",
  "edge_config_zones_trigger",
  "edge_config_source_ips_trigger",
  "edge_blocklist_trigger",
];
const found = new Set(triggers.map((t) => t.trigger_name));
const missing = expectedTriggers.filter((t) => !found.has(t));
if (missing.length > 0) {
  console.error("→ missing triggers:", missing);
  process.exit(1);
}

const watermark = (await rawClient().unsafe(
  `SELECT config_version, blocklist_version FROM edge_config_state WHERE id = true`,
)) as { config_version: number; blocklist_version: number }[];
if (watermark.length !== 1) {
  console.error("→ edge_config_state singleton row is missing");
  process.exit(1);
}
console.log("→ watermark:", watermark[0]);

const functions = (await rawClient().unsafe(
  `SELECT proname FROM pg_proc WHERE proname LIKE 'bump\\_%' OR proname LIKE 'notify\\_%'`,
)) as { proname: string }[];
const legacyNotify = functions.filter((f) => f.proname.startsWith("notify_"));
if (legacyNotify.length > 0) {
  console.error("→ legacy NOTIFY functions still present:", legacyNotify.map((f) => f.proname));
  process.exit(1);
}
const requiredBumps = ["bump_edge_config_version", "bump_edge_blocklist_version"];
const missingBumps = requiredBumps.filter((name) => !functions.some((f) => f.proname === name));
if (missingBumps.length > 0) {
  console.error("→ missing bump functions:", missingBumps);
  process.exit(1);
}

await rawClient().end();
console.log("admin bootstrap complete ✅");

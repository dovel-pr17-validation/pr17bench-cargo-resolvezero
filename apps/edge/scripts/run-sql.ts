import { rawClient } from "@resolvezero/db/client";
import { readFileSync } from "node:fs";
const client = rawClient();
const sqlFile = readFileSync(new URL(import.meta.resolve("./hourly-usage.sql")).pathname, "utf8");
// strip line comments, allow multi-semicolon statements
const clean = sqlFile.replace(/^--.*$/gm, "").trim().replace(/;+\s*$/, "");
const rows = await client.unsafe(clean);
console.table(rows);
await client.end();
process.exit(0);

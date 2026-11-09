/**
 * Compile blocklists into content-addressed artifacts and publish them.
 *
 *   pnpm tsx apps/edge/scripts/artifacts.ts --all
 *   pnpm tsx apps/edge/scripts/artifacts.ts --url https://example/list.txt
 *   pnpm tsx apps/edge/scripts/artifacts.ts --status
 *   pnpm tsx apps/edge/scripts/artifacts.ts --all --dry-run
 *
 * The compiler itself is Rust (`apps/edge-rust/target/release/rz-compile`);
 * this script only orchestrates: run compiler → upload to E2 → record the
 * hash in Postgres. Edges then fetch the 4 MB artifact instead of parsing.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

import { rawClient } from "@resolvezero/db/client";

interface CompilerOutput {
  id: string;
  source: string;
  allow: number;
  block: number;
  rules: number;
  bytes: number;
  compiler: string;
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string, fallback?: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};

const compiler = value("--compiler", process.env.RZ_COMPILE ?? "apps/edge-rust/target/release/rz-compile");
const prefix = (process.env.ARTIFACT_PREFIX || "artifacts").replace(/^\/+|\/+$/g, "");
const dryRun = flag("--dry-run");
const updateDb = !flag("--no-db") && !dryRun;

const db = rawClient();

async function status(): Promise<void> {
  const rows = await db.unsafe(`
    select pb.url,
           pb.artifact_hash as hash,
           pb.artifact_rules as rules,
           pb.compiled_at,
           a.bytes
      from profile_blocklists pb
      left join rule_artifacts a on a.hash = pb.artifact_hash
     where pb.enabled = true
     order by pb.url
  `);
  console.table(rows);
  const artifacts = await db.unsafe("select count(*)::int as count, coalesce(sum(bytes), 0)::bigint as bytes from rule_artifacts");
  console.log(`artifacts: ${artifacts[0]?.count ?? 0}, stored bytes: ${artifacts[0]?.bytes ?? 0}`);
}

function s3(): S3Client {
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error("S3_BUCKET / S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY are required");
  }
  return new S3Client({
    region: process.env.S3_REGION ?? "auto",
    endpoint: process.env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function compile(url: string): { meta: CompilerOutput; bytes: Uint8Array; sidecar: string } {
  const out = mkdtempSync(join(tmpdir(), "rz-artifact-"));
  const stdout = execFileSync(compiler, ["--url", url, "--out", out], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  const meta = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as CompilerOutput;
  if (!meta.id) throw new Error(`compiler produced no id for ${url}`);
  const bytes = new Uint8Array(readFileSync(join(out, `${meta.id}.bin`)));
  const sidecar = readFileSync(join(out, `${meta.id}.json`), "utf8");
  return { meta, bytes, sidecar };
}

async function publish(url: string): Promise<void> {
  const { meta, bytes, sidecar } = compile(url);
  const bucket = process.env.S3_BUCKET!;
  if (!dryRun) {
    const client = s3();
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}/${meta.id}.bin`,
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
    );
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${prefix}/${meta.id}.json`,
        Body: sidecar,
        ContentType: "application/json",
      }),
    );
    if (updateDb) {
      await db.unsafe(
        `insert into rule_artifacts (hash, source_url, bytes, allow_count, block_count, compiler)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (hash) do update set
           source_url = excluded.source_url,
           bytes = excluded.bytes,
           allow_count = excluded.allow_count,
           block_count = excluded.block_count,
           compiler = excluded.compiler`,
        [meta.id, url, meta.bytes, meta.allow, meta.block, meta.compiler],
      );
      await db.unsafe(
        `update profile_blocklists
            set artifact_hash = $1, artifact_rules = $2, compiled_at = now()
          where url = $3`,
        [meta.id, meta.rules, url],
      );
    }
  }
  console.log(
    `${dryRun ? "dry" : "published"} ${meta.rules} rules (${meta.bytes} bytes) ${meta.id.slice(0, 12)}… ${url}`,
  );
}

async function main(): Promise<void> {
  if (flag("--status")) {
    await status();
    return;
  }
  // Fail early: a compiler that isn't built is the most common mistake.
  execFileSync(compiler, ["--help"], { encoding: "utf8", maxBuffer: 1024 * 1024 });

  const explicit = value("--url");
  const urls = explicit
    ? [explicit]
    : (
        await db.unsafe(
          "select distinct url from profile_blocklists where enabled = true order by url",
        )
      ).map((row) => row.url as string);
  if (urls.length === 0) {
    console.log("no enabled lists");
    return;
  }

  let published = 0;
  for (const url of urls) {
    try {
      await publish(url);
      published += 1;
    } catch (err) {
      console.error(`failed: ${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (published > 0 && updateDb) {
    // artifact_hash updates are deliberately outside the trigger's column
    // list (status writes must not loop), so bump explicitly to reload edges.
    await db.unsafe(
      "update edge_config_state set blocklist_version = blocklist_version + 1, updated_at = now() where id = true",
    );
    console.log(`bumped blocklist_version; ${published}/${urls.length} lists published`);
  }
}

main()
  .then(() => db.end())
  .catch(async (err) => {
    console.error(err);
    await db.end();
    process.exit(1);
  });

import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import { profileBlocklists } from "@resolvezero/db/schema";
import { moduleLogger } from "./logger";
import { SuffixFingerprintBuilder, SuffixFingerprintTable } from "./fingerprint";
import { decodeArtifact, isArtifact } from "./artifact";
import { createS3ClientFromEnv, type S3ClientLike } from "./sinks/s3";
import type { RuleStore } from "./ruleStore";
import type { DnsCache } from "./dnsCache";
import { fetchWithSafeRedirects } from "./netGuard";
import { readTextBounded } from "./body";
import { positiveInt } from "./limits";

const log = moduleLogger("blocklists");

/** Hard cap per list (bytes) — protects edge memory from runaway sources. */
const MAX_LIST_BYTES = 30 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_UNIQUE_LISTS = positiveInt(process.env.BLOCKLIST_MAX_LISTS, 256);
const MAX_LISTS_PER_PROFILE = positiveInt(process.env.BLOCKLIST_MAX_LISTS_PER_PROFILE, 64);
const MAX_TOTAL_ENTRIES = positiveInt(process.env.BLOCKLIST_MAX_TOTAL_ENTRIES, 5_000_000);
const CYCLE_DEADLINE_MS = positiveInt(process.env.BLOCKLIST_CYCLE_DEADLINE_MS, 180_000);

export interface BlocklistDeps {
  store: RuleStore;
  dnsCache: DnsCache;
}

export interface BlocklistRow {
  id: string;
  profileId: string;
  url: string;
  format: string;
  /** Content-addressed compiled artifact; null = parse the text on the edge. */
  artifactHash: string | null;
}

export interface ParsedList {
  blocks: Set<string>;
  allows: Set<string>;
}

export interface BlocklistStatus {
  lastSyncAt: number | null;
  lastError: string | null;
  /** URLs that failed in the most recent cycle (served from previous table). */
  failedUrls: string[];
}

export interface BlocklistSyncHandle {
  /** Debounced NOTIFY-driven re-sync (3s). */
  syncNow(): Promise<void>;
  /** Boot-time synchronous cycle — callers await this before serving DNS. */
  initialSync(): Promise<void>;
  stop(): void;
  status(): BlocklistStatus;
}

/**
 * Fetches + parses remote blocklists and swaps them into the RuleStore.
 * NOTIFY-driven (DB trigger) + interval refresh; failures keep previous sets.
 */
export function startBlocklistSync(deps: BlocklistDeps): BlocklistSyncHandle {
  const intervalHours = Number(process.env.LIST_SYNC_INTERVAL_HOURS ?? 6);
  let timer: ReturnType<typeof setInterval> | undefined;
  let syncing = false;
  let needsResync = false;
  let pending: Promise<void> | undefined;
  let lastSyncAt: number | null = null;
  let lastError: string | null = null;
  let failedUrls: string[] = [];

  const sync = async () => {
    if (syncing) {
      // A NOTIFY arrived mid-fetch: run once more after the current cycle
      // instead of silently dropping it until the 6-hour interval.
      needsResync = true;
      return;
    }
    syncing = true;
    const cycleFailed: string[] = [];
    let cycleError: string | null = null;
    let cycleDeadline = Number.POSITIVE_INFINITY;
    try {
      const rows = (await db
        .select({
          id: profileBlocklists.id,
          profileId: profileBlocklists.profileId,
          url: profileBlocklists.url,
          format: profileBlocklists.format,
          artifactHash: profileBlocklists.artifactHash,
        })
        .from(profileBlocklists)
        .where(eq(profileBlocklists.enabled, true))) as BlocklistRow[];

      // Shared-catalog model: parse each unique URL ONCE per cycle, register
      // it in the store's catalog, then wire per-profile subscriptions.
      const uniqueUrls = new Map<string, { url: string; format: string; artifactHash: string | null }>();
      const enabledByProfile = new Map<string, BlocklistRow[]>();
      for (const row of rows) {
        const existing = uniqueUrls.get(row.url);
        uniqueUrls.set(row.url, {
          url: row.url,
          format: row.format,
          artifactHash: existing?.artifactHash ?? row.artifactHash ?? null,
        });
        enabledByProfile.set(row.profileId, enabledByProfile.get(row.profileId) ?? []);
        enabledByProfile.get(row.profileId)!.push(row);
      }

      const markFailed = async (url: string, message: string): Promise<void> => {
        cycleFailed.push(url);
        for (const profileRowGroups of enabledByProfile.values()) {
          for (const row of profileRowGroups) {
            if (row.url !== url) continue;
            await writeStatus(row.id, `error: ${message.slice(0, 42)}`, 0).catch((statusErr) =>
              log.warn({ err: statusErr }, "blocklist status write failed"),
            );
          }
        }
      };

      const orderedUrls = [...uniqueUrls.values()];
      if (orderedUrls.length > MAX_UNIQUE_LISTS) {
        log.warn(
          { total: orderedUrls.length, cap: MAX_UNIQUE_LISTS },
          "blocklist catalog exceeds unique-list budget; extra lists skipped",
        );
        for (const { url } of orderedUrls.slice(MAX_UNIQUE_LISTS)) {
          await markFailed(url, "global list budget exceeded");
        }
      }
      const cycleUrls = orderedUrls.slice(0, MAX_UNIQUE_LISTS);
      cycleDeadline = Date.now() + CYCLE_DEADLINE_MS;
      let totalEntries = 0;

      // 1) catalog refresh — each URL compiled once per cycle. Prefer the
      // content-addressed artifact (4 MB, no parse); fall back to the raw
      // list for self-hosted setups without a compiler.
      // SEQUENTIAL on purpose: parse+build peak-allocates tens of MB per
      // big list (raw text + string sets + fp arrays); running them in
      // parallel OOM'd the 256MB VMs at boot (multiplied transients).
      const artifactStore = createS3ClientFromEnv();
      let cacheFlushed = false;
      for (const [index, { url, format, artifactHash }] of cycleUrls.entries()) {
        if (Date.now() > cycleDeadline) {
          log.error({ url, remaining: cycleUrls.length - index }, "blocklist cycle deadline reached; skipping remaining lists");
          await markFailed(url, "cycle deadline exceeded");
          for (const rest of cycleUrls.slice(index + 1)) {
            await markFailed(rest.url, "cycle deadline exceeded");
          }
          break;
        }
        try {
          const fromArtifact = artifactHash && artifactStore
            ? await loadArtifactTable(artifactStore, artifactHash).catch((err) => {
                log.warn({ url, err: err instanceof Error ? err.message : String(err) }, "artifact load failed — falling back to text");
                return null;
              })
            : null;

          let table: SuffixFingerprintTable;
          let entryCount: number;
          let resolvedFormat: string;
          if (fromArtifact) {
            table = fromArtifact;
            entryCount = fromArtifact.entryCount;
            resolvedFormat = "artifact";
          } else {
            const text = await fetchListText(url);
            resolvedFormat = resolveListFormat(text, format);
            const parsed = parseList(text, resolvedFormat);
            const builder = new SuffixFingerprintBuilder();
            for (const d of parsed.blocks) builder.add(d, "block");
            for (const d of parsed.allows) builder.add(d, "allow");
            entryCount = parsed.blocks.size + parsed.allows.size;
            table = builder.seal(entryCount);
          }
          if (totalEntries + entryCount > MAX_TOTAL_ENTRIES) {
            throw new Error(`global rule budget exceeded (${totalEntries + entryCount} > ${MAX_TOTAL_ENTRIES})`);
          }
          totalEntries += entryCount;
          const changed = deps.store.upsertList(url, table);
          if (changed) cacheFlushed = true; // flush flag handled below
          log.info({ url, entries: table.entryCount, changed, artifact: Boolean(fromArtifact) }, "list loaded");
          // statuses per row that reference this URL
          for (const profileRowGroups of enabledByProfile.values()) {
            for (const row of profileRowGroups) {
              if (row.url === url) {
                await writeStatus(row.id, "ok", table.entryCount, fromArtifact ? undefined : resolvedFormat).catch((err) =>
                  log.warn({ err, url }, "blocklist status write failed"),
                );
              }
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          log.warn({ url, err: msg }, "list fetch failed — keeping previous table");
          await markFailed(url, msg);
          // the subscription wiring below drops URLs with no table only
          // when the catalog ALSO lacks one (crash-reboot case) — a
          // previously-good table remains in force until de-listed.
        }
      }
      const fetchedAnyChanged = cacheFlushed;

      // 2) wiring — subscriptions for every profile (urls whose table exists).
      //    Defer pruning until all profiles are wired: a profile with a subset
      //    of lists must not delete tables another profile still references.
      for (const [profileId, rowsForProfile] of enabledByProfile) {
        const listIdByUrl = new Map(rowsForProfile.map((row) => [row.url, row.id]));
        const uniqueForProfile = [...new Set(rowsForProfile.map((r) => r.url))]
          .filter((url) => deps.store.hasList(url));
        if (uniqueForProfile.length > MAX_LISTS_PER_PROFILE) {
          log.warn(
            { profileId, total: uniqueForProfile.length, cap: MAX_LISTS_PER_PROFILE },
            "profile blocklist subscription cap reached; extra lists ignored",
          );
        }
        const subscriptions = uniqueForProfile
          .slice(0, MAX_LISTS_PER_PROFILE)
          .map((url) => ({ url, listId: listIdByUrl.get(url) }));
        const changed = deps.store.setSubscriptions(profileId, subscriptions, { prune: false });
        if (changed && !fetchedAnyChanged) log.info({ profileId, urls: subscriptions.length }, "subscriptions rewired");
      }
      deps.store.pruneUnreferencedLists();
      if (deps.store.consumeChanged()) {
        deps.dnsCache.clear();
        log.info("blocklist state changed — dns cache flushed");
      }
    } catch (err) {
      cycleError = err instanceof Error ? err.message : String(err);
      log.error({ err }, "blocklist sync cycle failed");
    } finally {
      failedUrls = cycleFailed;
      lastError = cycleError ?? (failedUrls.length > 0 ? `${failedUrls.length} list(s) failed` : null);
      lastSyncAt = Date.now();
      syncing = false;
      if (needsResync) {
        needsResync = false;
        void sync();
      }
    }
  };

  const syncNow = (): Promise<void> => {
    // trailing debounce — bursty NOTIFYs (multi-row writes) coalesce
    if (pending) return pending;
    pending = new Promise<void>((resolve) => {
      const t = setTimeout(async () => {
        pending = undefined;
        await sync();
        resolve();
      }, 3_000);
      t.unref?.();
    });
    return pending;
  };

  if (intervalHours > 0) {
    // Jitter ±10% so fra/lhr don't hammer the same list hosts in lockstep.
    const jitterMs = intervalHours * 3600_000 * (0.9 + Math.random() * 0.2);
    timer = setInterval(() => void sync(), jitterMs);
    timer.unref?.();
  }

  return {
    syncNow,
    async initialSync() {
      if (syncing) {
        needsResync = true;
        return;
      }
      await sync();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
    status() {
      return { lastSyncAt, lastError, failedUrls: [...failedUrls] };
    },
  };
}

async function writeStatus(
  id: string,
  status: string,
  count: number,
  detectedFormat?: string,
): Promise<void> {
  await db
    .update(profileBlocklists)
    .set({
      lastSyncedAt: new Date(),
      lastStatus: status,
      entryCount: count,
      ...(detectedFormat ? { detectedFormat } : {}),
    })
    .where(and(eq(profileBlocklists.id, id)));
}

/**
 * Load and verify a compiled artifact from object storage. The sha256 check is
 * mandatory: the file name is the content hash, so a truncated/corrupted
 * upload must never be trusted.
 */
async function loadArtifactTable(
  store: S3ClientLike,
  hash: string,
): Promise<SuffixFingerprintTable> {
  const prefix = process.env.ARTIFACT_PREFIX ?? "artifacts";
  const key = `${prefix.replace(/^\/+|\/+$/g, "")}/${hash}.bin`;
  const bytes = new Uint8Array(await store.file(key).arrayBuffer());
  if (!isArtifact(bytes)) throw new Error(`${key} is not an artifact`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== hash) throw new Error(`${key} hash mismatch (${actual})`);
  const { allow, block } = decodeArtifact(bytes);
  return SuffixFingerprintTable.fromArrays(allow, block);
}

/**
 * Fetch a raw list file (any text format) with timeout + size cap.
 * Throws with a short human-readable reason (goes into last_status).
 * SSRF guard: https-only, no private/metadata hosts, and every redirect
 * hop is re-validated (no https → metadata redirect).
 */
export async function fetchListText(url: string): Promise<string> {
  const { response: res } = await fetchWithSafeRedirects(
    url,
    {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": "resolvezero-edge/0.1" },
    },
    { protocols: ["https:"], label: "list URL" },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0);
  return readTextBounded(res.body, MAX_LIST_BYTES, len);
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+\.?$/;
const PUNCT_HOSTS_RE = /^[\s#&+|!'"]*$/;

/**
 * Sniff the list syntax from its content so users never have to pick a format.
 * Samples real (non-comment) lines and scores the three shapes we parse:
 * ABP rules (`||host^`), hosts files (`0.0.0.0 host`), and bare domains.
 */
export function detectFormat(text: string): "abp" | "hosts" | "domains" {
  let abp = 0;
  let hosts = 0;
  let domains = 0;
  let sampled = 0;

  for (const raw of text.split("\n")) {
    if (sampled >= 2_000) break;
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith("#") || line.startsWith("!") || line.startsWith("//")) continue;
    sampled += 1;

    if (/^(@@)?\|\|[a-z0-9.-]+\^/.test(line)) {
      abp += 1;
      continue;
    }
    const tokens = line.split("#")[0].trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && isIpLiteral(tokens[0]!)) {
      hosts += 1;
      continue;
    }
    if (tokens.length === 1 && DOMAIN_RE.test(tokens[0]!) && tokens[0]!.includes(".")) {
      domains += 1;
    }
  }

  if (abp >= hosts && abp >= domains && abp > 0) return "abp";
  if (hosts > domains) return "hosts";
  return "domains";
}

/** Resolve a stored format, sniffing the payload when it is `auto`. */
export function resolveListFormat(text: string, format: string): string {
  return format === "auto" ? detectFormat(text) : format;
}

export function parseList(text: string, format: string): ParsedList {
  const resolved = resolveListFormat(text, format);
  const blocks = new Set<string>();
  const allows = new Set<string>();
  const lines = text.split("\n");
  for (const raw of lines) {
    const line = raw.trim().toLowerCase();
    if (!line || line.startsWith("#") || line.startsWith("!") || line.startsWith("//")) continue;
    if (resolved === "abp") {
      // @@||host^  → allow  |  ||host^  → block. Cosmetic/CSS selectors ignored.
      if (line.startsWith("@@||")) {
        const d = extractAbpDomain(line);
        if (d) allows.add(d);
      } else {
        const d = extractAbpDomain(line);
        if (d) blocks.add(d);
      }
      continue;
    }
    // strip inline comments after the first `#` (hosts + domains formats)
    const noComment = line.split("#")[0].trim();
    const tokens = noComment.split(/\s+/).filter(Boolean);
    // Hosts lines pack aliases ("0.0.0.0 a.com b.com") — every name token
    // counts, not just the last. Skip IP literals themselves.
    for (const candidate of tokens) {
      const domain = candidate.replace(/\.+$/, "");
      if (!domain) continue;
      if (isIpLiteral(domain)) continue;
      // hosts files use bare "localhost" alias lines; ignore punct garbage
      if (domain === "localhost" || PUNCT_HOSTS_RE.test(domain) || domain.length < 3) continue;
      if (!DOMAIN_RE.test(domain) || !domain.includes(".")) continue;
      blocks.add(domain);
    }
  }
  return { blocks, allows };
}

/** `||ads.example.com^$third-party` → `ads.example.com`; `@@||host^` handled by caller. */
function extractAbpDomain(rule: string): string | undefined {
  const m = rule.replace(/^@@\|\|/, "||").match(/^\|\|([a-z0-9.-]+)(\^\S*)?$/);
  if (!m) return undefined;
  const d = m[1].replace(/\*+/g, "");
  if (!d.includes(".") || !DOMAIN_RE.test(d)) return undefined;
  return d;
}

function isIpLiteral(s: string): boolean {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return true;
  if (s.includes(":")) return /^[0-9a-f:]+$/i.test(s);
  return false;
}

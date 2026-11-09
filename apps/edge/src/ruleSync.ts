import { eq } from "drizzle-orm";
import { db } from "@resolvezero/db/client";
import {
  edgeConfigState,
  profileBlockedServices,
  profileRules,
  profiles,
  profileSourceIps,
  profileZones,
} from "@resolvezero/db/schema";
import type { ZoneRecordType } from "@resolvezero/shared";
import { moduleLogger } from "./logger";
import {
  RuleStore,
  type ProfileRow,
  type RuleAction,
  type RuleRow,
  type SourceIpRow,
  type ZoneRow,
} from "./ruleStore";

const log = moduleLogger("ruleSync");

/** How often each POP checks the watermark. Config changes are rare. */
const POLL_MS = Math.max(1_000, Number(process.env.CONFIG_POLL_MS ?? 5_000) || 5_000);
const RETRY_MS = 2_000;
const MAX_RETRY_MS = 30_000;

interface Versions {
  config: number;
  blocklist: number;
}

export interface RuleSyncStatus {
  lastPollAt: number | null;
  lastPollError: string | null;
}

export interface RuleSyncHandle {
  /** Stop the poll timer (SIGTERM). */
  stop(): void;
  /** Force one poll now (tests/manual). */
  pollNow(): Promise<void>;
  status(): RuleSyncStatus;
}

/**
 * Config propagation without LISTEN/NOTIFY.
 *
 * Triggers bump `edge_config_state.config_version` / `.blocklist_version` in
 * the same transaction as config writes. Each POP polls the watermark and
 * re-snapshots (or asks the blocklist sync to refresh) when it changes.
 *
 * Reliability properties:
 *  - a missed poll only delays convergence (no lost events),
 *  - no dedicated LISTEN connection, so it works through PgBouncer,
 *  - reads happen before the snapshot; a change during the snapshot bumps the
 *    version and is picked up by the next poll.
 */
export async function startRuleSync(
  store: RuleStore,
  /** Called when blocklist_version moves (edge re-fetches subscriptions). */
  onBlocklistChange?: () => void,
): Promise<RuleSyncHandle> {
  let lastConfigVersion = -1;
  let lastBlocklistVersion = -1;
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let pendingPoll = false;
  let lastPollAt: number | null = null;
  let lastPollError: string | null = null;

  async function readVersions(): Promise<Versions> {
    const rows = await db
      .select({
        config: edgeConfigState.configVersion,
        blocklist: edgeConfigState.blocklistVersion,
      })
      .from(edgeConfigState)
      .where(eq(edgeConfigState.id, true))
      .limit(1);
    return rows[0] ?? { config: 0, blocklist: 0 };
  }

  async function snapshot(): Promise<void> {
    const [profileRows, ruleRows, sourceIpRows, zoneRows, serviceRows] = await Promise.all([
      db
        .select({
          id: profiles.id,
          dotId: profiles.dotId,
          dohToken: profiles.dohToken,
          logQueries: profiles.logQueries,
          upstream: profiles.upstream,
          upstreamUrl: profiles.upstreamUrl,
          blockMode: profiles.blockMode,
          blockIpv4: profiles.blockIpv4,
          blockIpv6: profiles.blockIpv6,
          blockTtl: profiles.blockTtl,
          safeSearch: profiles.safeSearch,
        })
        .from(profiles),
      db
        .select({
          profileId: profileRules.profileId,
          domain: profileRules.domain,
          action: profileRules.action,
        })
        .from(profileRules)
        .where(eq(profileRules.enabled, true)),
      db
        .select({
          ipAddress: profileSourceIps.ipAddress,
          profileId: profileSourceIps.profileId,
        })
        .from(profileSourceIps),
      db
        .select({
          profileId: profileZones.profileId,
          domain: profileZones.domain,
          recordType: profileZones.recordType,
          values: profileZones.values,
          ttl: profileZones.ttl,
        })
        .from(profileZones),
      db
        .select({
          profileId: profileBlockedServices.profileId,
          service: profileBlockedServices.service,
        })
        .from(profileBlockedServices),
    ]);

    // Snapshot replaces state atomically. The version was read before this
    // query; any concurrent change bumps it and will be caught next poll.
    store.replaceAll(
      ruleRows.map((r): RuleRow => ({ ...r, action: r.action as RuleAction })),
      sourceIpRows.map((s): SourceIpRow => ({ ...s })),
      profileRows.map(
        (p): ProfileRow => ({
          id: p.id,
          dotId: p.dotId ?? null,
          dohToken: p.dohToken,
          logQueries: p.logQueries,
          upstream: p.upstream,
          upstreamUrl: p.upstreamUrl ?? null,
          blockMode: p.blockMode,
          blockIpv4: p.blockIpv4 ?? null,
          blockIpv6: p.blockIpv6 ?? null,
          blockTtl: p.blockTtl,
          safeSearch: p.safeSearch,
        }),
      ),
      zoneRows.map((z): ZoneRow => ({ ...z, recordType: z.recordType as ZoneRecordType })),
      serviceRows,
    );
  }

  async function poll(): Promise<void> {
    const before = await readVersions();

    if (before.config !== lastConfigVersion) {
      await snapshot();
      lastConfigVersion = before.config;
      log.info({ version: before.config, stats: store.stats }, "config snapshot loaded");
    }

    if (before.blocklist !== lastBlocklistVersion) {
      lastBlocklistVersion = before.blocklist;
      onBlocklistChange?.();
    }
  }

  async function runPoll(): Promise<void> {
    if (stopped) return;
    if (polling) {
      pendingPoll = true;
      return;
    }
    polling = true;
    try {
      await poll();
      lastPollAt = Date.now();
      lastPollError = null;
    } catch (err) {
      lastPollError = err instanceof Error ? err.message : String(err);
      log.error({ err }, "config poll failed — retrying next tick");
    } finally {
      polling = false;
      if (pendingPoll) {
        pendingPoll = false;
        void runPoll();
      }
    }
  }

  // Initial snapshot must succeed before the edge starts serving.
  let attempt = 0;
  for (;;) {
    try {
      const initial = await readVersions();
      await snapshot();
      lastConfigVersion = initial.config;
      lastBlocklistVersion = initial.blocklist;
      lastPollAt = Date.now();
      lastPollError = null;
      log.info({ version: initial.config, stats: store.stats }, "snapshot loaded");
      break;
    } catch (err) {
      attempt += 1;
      lastPollError = err instanceof Error ? err.message : String(err);
      const delay = Math.min(RETRY_MS * 2 ** Math.min(attempt - 1, 4), MAX_RETRY_MS);
      log.error({ err, attempt, retryInMs: delay }, "initial snapshot failed, retrying");
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  timer = setInterval(() => void runPoll(), POLL_MS);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
    },
    pollNow: runPoll,
    status() {
      return { lastPollAt, lastPollError };
    },
  };
}

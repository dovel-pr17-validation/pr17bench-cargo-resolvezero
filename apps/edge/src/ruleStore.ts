import type { IpUpdateEvent, RuleUpdateEvent, ZoneRecordType, ZoneUpdateEvent } from "@resolvezero/shared";
import type { SafeSearchSettings } from "@resolvezero/db/schema";
import { blockedServiceDomains } from "@resolvezero/db";
import { SuffixFingerprintTable, type FingerprintAction } from "./fingerprint";
import { DEFAULT_BLOCK_ANSWER, type BlockAnswer, type BlockMode } from "./wire";

export type RuleAction = "block" | "allow";

export interface RuleRow {
  profileId: string;
  domain: string;
  action: RuleAction;
}

export interface SourceIpRow {
  ipAddress: string;
  profileId: string;
}

export interface ProfileRow {
  id: string;
  /** Lowercase label for `<dot_id>.dot.resolvezero.com` (DoT). */
  dotId?: string | null;
  dohToken: string | null;
  logQueries: boolean;
  /** Upstream selector ('cloudflare' | 'google' | 'quad9' | …) or custom URL. */
  upstream: string | null;
  /** Custom upstream DoH URL — wins over `upstream` preset when set. */
  upstreamUrl?: string | null;
  /** Blocked-answer shape for this profile. */
  blockMode?: string | null;
  blockIpv4?: string | null;
  blockIpv6?: string | null;
  blockTtl?: number | null;
  /** SafeSearch engines forced for this profile. */
  safeSearch?: SafeSearchSettings | null;
}

/** A service the profile blocks wholesale (catalog lives in @resolvezero/db). */
export interface BlockedServiceRow {
  profileId: string;
  service: string;
}

export interface ZoneEntry {
  /** '*' when authored as '*.' (suffix wildcard), else exact-match. */
  wildcard: boolean;
  values: string[];
  ttl: number;
}

export interface ZoneRow {
  profileId: string;
  domain: string;
  recordType: ZoneRecordType;
  values: string[];
  ttl: number;
}

export interface ZoneAnswer {
  values: string[];
  ttl: number;
  recordType: ZoneRecordType;
}

/** One enabled remote-list subscription for a profile. */
export interface ListSubscription {
  url: string;
  /** `profile_blocklists.id` for log attribution (IDs never contain secrets). */
  listId?: string;
}

export interface RemoteResolution {
  action: RuleAction;
  /** Present when the match came from a subscribed remote list. */
  listId?: string;
}

/**
 * In-memory rule state for the edge data plane.
 *
 * Backed by plain Maps — rules are a bounded set and must NEVER be
 * evicted (LRU is reserved for the dnsCache; see readme.md §2).
 * Lookups are O(1) exact match plus longest-suffix wildcard match.
 */
export class RuleStore {
  /** profile_id -> (domain -> action) */
  private rules = new Map<string, Map<string, RuleAction>>();
  /** profile_id -> configured DoH token (null = id-only auth) */
  private profileTokens = new Map<string, string | null>();
  /** profile_id -> log opt-out (false = do not record queries) */
  private logQueries = new Map<string, boolean>();
  /** source ip -> profile_id */
  private authorizedSourceIps = new Map<string, string>();
  /** profile_id -> upstream selector/custom URL (null = edge default) */
  private profileUpstreams = new Map<string, string | null>();
  /** profile_id -> custom upstream DoH URL (wins over preset selector). */
  private profileUpstreamUrls = new Map<string, string | null>();
  /** profile_id -> how blocked answers are shaped. */
  private blockAnswers = new Map<string, BlockAnswer>();
  /** profile_id -> forced SafeSearch engines. */
  private safeSearch = new Map<string, SafeSearchSettings>();
  /** profile_id -> `${domain}|${type}` -> entry (EXACT domain zones) */
  private zones = new Map<string, Map<string, ZoneEntry>>();
  /** profile_id -> `${suffix}|${type}` -> entry (from '*.' wildcard zones) */
  private wildcardZones = new Map<string, Map<string, ZoneEntry>>();
  /**
   * Remote blocklist storage — SHARED CATALOG (memory follows the list,
   * not the user): one `SuffixFingerprintTable` per subscribed URL per
   * machine, whatever the profile count. `setRemoteBlocklists` was replaced
   * by `upsertList` + `setSubscriptions` (see blocklists.ts, readme §4a).
   */
  private listCatalog = new Map<string, { table: SuffixFingerprintTable; entryCount: number; fingerprint: string }>();
  /** Dot hostname label -> profile id. */
  private dotIds = new Map<string, string>();

  /** profile_id -> enabled subscriptions (order: allow-precedence pass). */
  private subscriptions = new Map<string, ListSubscription[]>();

  /**
   * Registers a parsed table under its source URL (single copy per machine).
   * Returns whether the remote state is EFFECTIVELY changed (new table or
   * new/changed subscription wiring) — callers flush the DNS caches only on
   * real changes.
   */
  upsertList(url: string, table: SuffixFingerprintTable): boolean {
    const prev = this.listCatalog.get(url);
    const changed = prev?.fingerprint !== table.fingerprint;
    this.listCatalog.set(url, { table, entryCount: table.entryCount, fingerprint: table.fingerprint });
    this.markChanged(changed);
    return changed;
  }

  /** Is a parsed table present for this URL in the local catalog? */
  hasList(url: string): boolean {
    return this.listCatalog.has(url);
  }

  /**
   * Consume the "effectively changed" flag raised by upsertList/
   * setSubscriptions since the last consume — the blocklist loop uses it to
   * decide on a DNS cache flush (avoids flushing when sync found nothing new).
   */
  private changedSinceConsume = false;
  consumeChanged(): boolean {
    const v = this.changedSinceConsume;
    this.changedSinceConsume = false;
    return v;
  }

  private markChanged(value: boolean): void {
    this.changedSinceConsume ||= value;
  }

  /** Sets a profile's enabled subscriptions (tables already upserted). */
  setSubscriptions(
    profileId: string,
    subscriptions: Array<string | ListSubscription>,
    opts: { prune?: boolean } = {},
  ): boolean {
    const normalized = subscriptions.map((item) =>
      typeof item === "string" ? { url: item } : item,
    );
    const prev = (this.subscriptions.get(profileId) ?? [])
      .map((s) => `${s.url}|${s.listId ?? ""}`)
      .join("|");
    const next = normalized.map((s) => `${s.url}|${s.listId ?? ""}`).join("|");
    this.subscriptions.set(profileId, normalized);
    // Multi-profile wiring should pass prune:false and call
    // pruneUnreferencedLists() once after every profile is wired; otherwise a
    // profile with a subset of lists can delete tables another profile needs.
    if (opts.prune !== false) this.pruneCatalog();
    const changed = prev !== next;
    this.markChanged(changed);
    return changed;
  }

  /** Prune catalog entries no subscription references (call after bulk wiring). */
  pruneUnreferencedLists(): void {
    this.pruneCatalog();
  }

  /** Drop catalog entries no subscriber references (memory hygiene). */
  private pruneCatalog(): void {
    if (this.listCatalog.size === 0) return;
    const referenced = new Set<string>();
    for (const subscriptions of this.subscriptions.values()) {
      for (const subscription of subscriptions) referenced.add(subscription.url);
    }
    for (const url of this.listCatalog.keys()) {
      if (!referenced.has(url)) this.listCatalog.delete(url);
    }
  }
  /** profile_id -> set of device slugs seen (dedupe for lazy DB write-behind). */
  private seenDevices = new Map<string, Set<string>>();

  /** Atomically replace all state with a DB snapshot. */
  replaceAll(
    ruleRows: RuleRow[],
    sourceIpRows: SourceIpRow[],
    profileRows: ProfileRow[],
    zoneRows: ZoneRow[] = [],
    serviceRows: BlockedServiceRow[] = [],
  ): void {
    const rules = new Map<string, Map<string, RuleAction>>();
    for (const row of ruleRows) {
      const domain = normalizeRuleDomain(row.domain);
      if (!domain) continue;
      let profile = rules.get(row.profileId);
      if (!profile) {
        profile = new Map();
        rules.set(row.profileId, profile);
      }
      profile.set(domain, row.action);
    }
    this.rules = rules;

    this.profileTokens = new Map(profileRows.map((p) => [p.id, p.dohToken]));
    this.dotIds = new Map(
      profileRows
        .filter((p) => typeof p.dotId === "string" && p.dotId.length > 0)
        .map((p) => [p.dotId as string, p.id]),
    );
    this.logQueries = new Map(profileRows.map((p) => [p.id, p.logQueries]));
    this.profileUpstreams = new Map(profileRows.map((p) => [p.id, p.upstream ?? null]));
    this.profileUpstreamUrls = new Map(profileRows.map((p) => [p.id, p.upstreamUrl ?? null]));
    this.blockAnswers = new Map(
      profileRows.map((p) => [
        p.id,
        {
          mode: normalizeBlockMode(p.blockMode),
          ipv4: p.blockIpv4 ?? null,
          ipv6: p.blockIpv6 ?? null,
          ttl: p.blockTtl ?? DEFAULT_BLOCK_ANSWER.ttl,
        },
      ]),
    );
    this.safeSearch = new Map(profileRows.map((p) => [p.id, p.safeSearch ?? {}]));

    // Blocked services expand into synthetic suffix rules. Existing rules win,
    // so an explicit allow can still carve a host out of a service.
    const servicesByProfile = new Map<string, string[]>();
    for (const row of serviceRows) {
      const list = servicesByProfile.get(row.profileId) ?? [];
      list.push(row.service);
      servicesByProfile.set(row.profileId, list);
    }
    for (const [profileId, services] of servicesByProfile) {
      let profile = rules.get(profileId);
      if (!profile) {
        profile = new Map();
        rules.set(profileId, profile);
      }
      for (const domain of blockedServiceDomains(services)) {
        if (!profile.has(domain)) profile.set(domain, "block");
      }
    }
    this.authorizedSourceIps = new Map(
      sourceIpRows.map((r) => [r.ipAddress, r.profileId]),
    );

    this.zones = new Map();
    this.wildcardZones = new Map();
    for (const row of zoneRows) {
      this.applyZone(row.profileId, row.domain, row.recordType, row.values, row.ttl);
    }

    // Remote subscriptions are owned by the blocklist sync loop (NOT the db
    // snapshot), but stale subscriptions of DELETED profiles must go — the
    // catalog itself is ref-counted by setSubscriptions/pruneCatalog.
    const alive = new Set(profileRows.map((p) => p.id));
    let pruned = false;
    for (const profileId of this.subscriptions.keys()) {
      if (!alive.has(profileId)) {
        this.subscriptions.delete(profileId);
        pruned = true;
      }
    }
    if (pruned) this.pruneCatalog();
  }

  /**
   * DoH auth: profile must exist; token must match when one is configured.
   * Tokens are compared timing-safely against the stored value (stored
   * plaintext for MVP — switch to hash-compare before hosted launch,
   * readme.md §4 DoH token log hygiene).
   */
  hasProfile(profileId: string, token: string | undefined): boolean {
    // Profile ids are 8-char lowercase base36 (was uuid); the guard only
    // rejects obviously malformed input, the map lookup does the real check.
    if (!/^[a-z0-9-]{1,64}$/i.test(profileId)) return false;
    const stored = this.profileTokens.get(profileId);
    if (stored === undefined) return false; // no such profile
    if (stored === null) return true; // id-only auth
    if (!token) return false; // token required
    return constantTimeEquals(token, stored);
  }

  /** Apply a single NOTIFY event from Postgres. Idempotent per event. */
  applyEvent(event: RuleUpdateEvent): void {
    if (event.op === "DELETE" || event.action === null) {
      const domain = normalizeRuleDomain(event.domain);
      if (domain) this.rules.get(event.profile_id)?.delete(domain);
      return;
    }
    const domain = normalizeRuleDomain(event.domain);
    if (!domain) return;
    let profile = this.rules.get(event.profile_id);
    if (!profile) {
      profile = new Map();
      this.rules.set(event.profile_id, profile);
    }
    profile.set(domain, event.action);
  }

  /** Resolve a DoT hostname label to its profile. */
  authorizeDotId(dotId: string): string | undefined {
    return this.dotIds.get(dotId);
  }

  /** Returns the action if the domain matches profile rules, else undefined.
   *  O(domain depth): a rule stored as "corp.example.com" matches the query
   *  domain and any subdomain of it ("*.corp.example.com"). */
  resolve(profileId: string, domain: string): RuleAction | undefined {
    const profile = this.rules.get(profileId);
    if (!profile) return undefined;

    const normalized = normalizeRuleDomain(domain);
    if (!normalized) return undefined;
    const exact = profile.get(normalized);
    if (exact) return exact;

    const labels = normalized.split(".");
    for (let i = 1; i < labels.length; i++) {
      const action = profile.get(labels.slice(i).join("."));
      if (action) return action;
    }
    return undefined;
  }

  /** Blocked-answer shape for a profile (defaults to the classic sinkhole). */
  blockAnswer(profileId: string): BlockAnswer {
    return this.blockAnswers.get(profileId) ?? DEFAULT_BLOCK_ANSWER;
  }

  /** Forced SafeSearch engines for a profile. */
  safeSearchSettings(profileId: string): SafeSearchSettings {
    return this.safeSearch.get(profileId) ?? {};
  }

  /**
   * Where should this profile's queries be recorded? Default true
   * ("log the lot" is the default, like NextDNS — readme §3 C);
   * false only when the profile explicitly opted out.
   */
  shouldLog(profileId: string): boolean {
    return this.logQueries.get(profileId) ?? true;
  }

  /**
   * Remote blocklist check across the profile's subscribed tables.
   * Allow-tables of ALL lists win first (cross-list ABP `@@` semantics),
   * then block-tables — observable parity with previous merged sets.
   */
  resolveRemote(profileId: string, domain: string): RuleAction | undefined {
    return this.resolveRemoteDetailed(profileId, domain)?.action;
  }

  /**
   * Same lookup as `resolveRemote`, plus the winning subscription's stable
   * list ID for query-log attribution. Returning the ID is free: the loop
   * already found the matching list.
   */
  resolveRemoteDetailed(profileId: string, domain: string): RemoteResolution | undefined {
    const subscriptions = this.subscriptions.get(profileId);
    if (!subscriptions?.length) return undefined;
    for (const subscription of subscriptions) {
      const entry = this.listCatalog.get(subscription.url);
      if (entry?.table.checkAllow(domain)) {
        return { action: "allow", listId: subscription.listId };
      }
    }
    for (const subscription of subscriptions) {
      const entry = this.listCatalog.get(subscription.url);
      if (entry?.table.checkBlock(domain)) {
        return { action: "block", listId: subscription.listId };
      }
    }
    return undefined;
  }

  get remoteBlocklistEntryCount(): number {
    return [...this.listCatalog.values()].reduce((n, e) => n + e.entryCount, 0);
  }

  get stats() {
    return {
      profiles: this.rules.size,
      rules: [...this.rules.values()].reduce((n, m) => n + m.size, 0),
      authorizedSourceIps: this.authorizedSourceIps.size,
      zones: [...this.zones.values()].reduce((n, m) => n + m.size, 0),
      wildcardZones: [...this.wildcardZones.values()].reduce((n, m) => n + m.size, 0),
      remoteListTables: this.listCatalog.size,
      remoteListSubscriptions: this.subscriptions.size,
    };
  }

  /** Upstream URL/selector override for this profile, or null for edge default. */
  profileUpstream(profileId: string): string | null {
    // Custom URL wins over the preset selector (readme §2).
    return this.profileUpstreamUrls.get(profileId) ?? this.profileUpstreams.get(profileId) ?? null;
  }

  /** Safe upstream label for logs — never expose a custom URL (may contain a token). */
  profileUpstreamLabel(profileId: string): string {
    const value = this.profileUpstream(profileId);
    if (!value) return "edge-default";
    return value.includes("://") ? "custom" : value;
  }

  // ---- Zone overrides (split-horizon records) ----

  private applyZone(
    profileId: string,
    domain: string,
    recordType: ZoneRecordType,
    values: string[],
    ttl: number,
  ): void {
    const wildcard = domain.startsWith("*.");
    const name = wildcard ? domain.slice(2).toLowerCase() : domain.toLowerCase();
    const entry: ZoneEntry = { wildcard, values, ttl };
    const target = wildcard ? this.wildcardZones : this.zones;
    let zones = target.get(profileId);
    if (!zones) {
      zones = new Map();
      target.set(profileId, zones);
    }
    zones.set(`${name}|${recordType}`, entry);
  }

  /** Apply a single `zone_updates` NOTIFY event. Idempotent per event. */
  applyZoneEvent(event: ZoneUpdateEvent): void {
    if (event.op === "DELETE" || event.values === null || event.ttl === null) {
      this.deleteZone(event.profile_id, event.domain, event.record_type);
      return;
    }
    this.applyZone(event.profile_id, event.domain, event.record_type, event.values, event.ttl);
  }

  private deleteZone(profileId: string, domain: string, recordType: ZoneRecordType): void {
    const wildcard = domain.startsWith("*.");
    const d = wildcard ? domain.slice(2).toLowerCase() : domain.toLowerCase();
    (wildcard ? this.wildcardZones : this.zones).get(profileId)?.delete(`${d}|${recordType}`);
  }

  /**
   * Zone override lookup: exact domain first; then `*.` wildcard zones
   * matched suffix-style (a wildcard "*.home.example.com" TXT matches
   * "print.home.example.com" but not "home.example.com" itself — authored
   * explicitly if needed). CNAME is returned for A/AAAA/TXT misses so local
   * aliases behave like normal DNS. Zone hits short-circuit BEFORE
   * policy/upstream.
   */
  resolveZone(profileId: string, domain: string, recordType: ZoneRecordType): ZoneAnswer | undefined {
    const direct = this.findZone(profileId, domain, recordType);
    if (direct) return direct;
    if (recordType === "CNAME") return undefined;
    return this.findZone(profileId, domain, "CNAME");
  }

  /** Does this local name exist for any record type? Used for local NODATA. */
  hasZoneName(profileId: string, domain: string): boolean {
    const target = domain.toLowerCase();
    const exact = this.zones.get(profileId);
    if (exact) {
      for (const key of exact.keys()) {
        if (key.startsWith(`${target}|`)) return true;
      }
    }

    const wildcards = this.wildcardZones.get(profileId);
    if (wildcards?.size) {
      const labels = target.split(".");
      for (let i = 1; i < labels.length; i++) {
        const suffix = labels.slice(i).join(".");
        for (const key of wildcards.keys()) {
          if (key.startsWith(`${suffix}|`)) return true;
        }
      }
    }
    return false;
  }

  private findZone(
    profileId: string,
    domain: string,
    recordType: ZoneRecordType,
  ): ZoneAnswer | undefined {
    const exact = this.zones.get(profileId)?.get(`${domain.toLowerCase()}|${recordType}`);
    if (exact) {
      return { values: exact.values, ttl: exact.ttl, recordType };
    }

    const wildcards = this.wildcardZones.get(profileId);
    if (wildcards?.size) {
      const labels = domain.toLowerCase().split(".");
      for (let i = 1; i < labels.length; i++) {
        const entry = wildcards.get(`${labels.slice(i).join(".")}|${recordType}`);
        if (entry) return { values: entry.values, ttl: entry.ttl, recordType };
      }
    }
    return undefined;
  }

  /** Which profile (if any) does this source IP belong to? */
  authorizeSourceIp(ip: string): string | undefined {
    return this.authorizedSourceIps.get(ip);
  }

  /** Apply a single `ip_updates` NOTIFY event (whitelist stays live). */
  applySourceIpEvent(event: IpUpdateEvent): void {
    if (event.op === "DELETE") {
      this.authorizedSourceIps.delete(event.ip_address);
      return;
    }
    this.authorizedSourceIps.set(event.ip_address, event.profile_id);
  }

  /** Does a profile carry a DoH token? (path-shape disambiguation helper) */
  hasToken(profileId: string): boolean {
    const stored = this.profileTokens.get(profileId);
    return stored !== undefined && stored !== null;
  }

  /** Profiles that still rely on the dev-only token-free mode. */
  tokenlessProfileIds(): string[] {
    return [...this.profileTokens.entries()]
      .filter(([, token]) => token === null)
      .map(([id]) => id);
  }

  /** Device-seen registry: dedupes lazy device row inserts (hard cap per profile). */
  applyDeviceSeen(profileId: string, device: string): boolean {
    let set = this.seenDevices.get(profileId);
    if (!set) {
      set = new Set();
      this.seenDevices.set(profileId, set);
    }
    if (set.has(device)) return false;
    // Hard cap: never evict-and-continue, or an attacker can generate
    // unlimited device rows one slug at a time.
    if (set.size >= 200) return false;
    set.add(device);
    return true;
  }
}

function normalizeBlockMode(raw: string | null | undefined): BlockMode {
  return raw === "nxdomain" || raw === "refused" || raw === "custom" ? raw : "null";
}

function normalizeRuleDomain(domain: string): string {
  return domain.toLowerCase().replace(/\.+$/, "");
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}


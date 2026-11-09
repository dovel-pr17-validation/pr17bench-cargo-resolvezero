import { BLOCKED_SERVICES } from "@resolvezero/db/services";

export const UPSTREAM_PRESETS = ["cloudflare", "google", "quad9"] as const;
export type UpstreamPreset = (typeof UPSTREAM_PRESETS)[number];

export const BLOCK_MODES = ["null", "nxdomain", "refused", "custom"] as const;
export type BlockMode = (typeof BLOCK_MODES)[number];

export const SAFE_SEARCH_KEYS = ["google", "bing", "duckduckgo", "youtube"] as const;
export type SafeSearchKey = (typeof SAFE_SEARCH_KEYS)[number];
export type SafeSearchInput = Partial<Record<SafeSearchKey, boolean>>;

export interface SettingsInput {
  upstream: UpstreamPreset | null;
  upstreamUrl: string | null;
  logQueries: boolean;
  logRetentionDays: number;
  blockMode: BlockMode;
  blockIpv4: string | null;
  blockIpv6: string | null;
  blockTtl: number;
  safeSearch: SafeSearchInput;
  blockedServices: string[];
}

const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 365;
const MAX_UPSTREAM_URL_LENGTH = 255;

function normalizeUpstream(raw: unknown): UpstreamPreset | null {
  if (raw === null || raw === undefined || raw === "" || raw === "default") return null;
  const value = String(raw).trim().toLowerCase();
  if (!(UPSTREAM_PRESETS as readonly string[]).includes(value)) {
    throw new Error(`Upstream must be one of ${UPSTREAM_PRESETS.join(", ")}`);
  }
  return value as UpstreamPreset;
}

function normalizeUpstreamUrl(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_UPSTREAM_URL_LENGTH) {
    throw new Error(`Custom upstream URL must be ${MAX_UPSTREAM_URL_LENGTH} characters or fewer`);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Custom upstream must be a full https:// URL");
  }
  if (url.protocol !== "https:") throw new Error("Custom upstream must use https://");
  if (!url.hostname) throw new Error("Custom upstream must include a hostname");
  if (url.username || url.password) throw new Error("Upstream URLs with credentials are not supported");
  return url.toString();
}

function normalizeBlockMode(raw: unknown): BlockMode {
  if (raw === null || raw === undefined || raw === "") return "null";
  const value = String(raw).trim().toLowerCase();
  if (!(BLOCK_MODES as readonly string[]).includes(value)) {
    throw new Error(`Block mode must be one of ${BLOCK_MODES.join(", ")}`);
  }
  return value as BlockMode;
}

const IPV4_RE = /^(\d{1,3}\.){3}\d{1,3}$/;
const IPV6_RE = /^[0-9a-f:]+$/i;

function normalizeIpAddress(raw: unknown, family: "ipv4" | "ipv6"): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const value = String(raw).trim();
  if (family === "ipv4") {
    if (!IPV4_RE.test(value) || value.split(".").some((part) => Number(part) > 255)) {
      throw new Error("Custom IPv4 address is not valid");
    }
    return value;
  }
  if (!IPV6_RE.test(value) || !value.includes(":")) throw new Error("Custom IPv6 address is not valid");
  return value;
}

function normalizeBlockTtl(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return 300;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 86_400) {
    throw new Error("Block TTL must be a whole number between 0 and 86400 seconds");
  }
  return value;
}

function normalizeSafeSearch(raw: unknown): SafeSearchInput {
  if (!raw || typeof raw !== "object") return {};
  const input = raw as Record<string, unknown>;
  const result: SafeSearchInput = {};
  for (const key of SAFE_SEARCH_KEYS) {
    if (input[key] === true) result[key] = true;
  }
  return result;
}

function normalizeBlockedServices(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error("blockedServices must be an array of service ids");
  const known = new Set(BLOCKED_SERVICES.map((service) => service.id));
  const ids = new Set<string>();
  for (const value of raw) {
    const id = String(value);
    if (!known.has(id)) throw new Error(`Unknown blocked service: ${id}`);
    ids.add(id);
  }
  return [...ids];
}

function normalizeRetention(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < MIN_RETENTION_DAYS || value > MAX_RETENTION_DAYS) {
    throw new Error(`Retention must be a whole number between ${MIN_RETENTION_DAYS} and ${MAX_RETENTION_DAYS} days`);
  }
  return value;
}

export function normalizeSettingsInput(raw: unknown): SettingsInput {
  if (!raw || typeof raw !== "object") throw new Error("Invalid settings input");
  const input = raw as Record<string, unknown>;
  if (typeof input.logQueries !== "boolean") throw new Error("logQueries must be true or false");

  return {
    upstream: normalizeUpstream(input.upstream),
    upstreamUrl: normalizeUpstreamUrl(input.upstreamUrl),
    logQueries: input.logQueries,
    logRetentionDays: normalizeRetention(input.logRetentionDays),
    blockMode: normalizeBlockMode(input.blockMode),
    blockIpv4: normalizeIpAddress(input.blockIpv4, "ipv4"),
    blockIpv6: normalizeIpAddress(input.blockIpv6, "ipv6"),
    blockTtl: normalizeBlockTtl(input.blockTtl),
    safeSearch: normalizeSafeSearch(input.safeSearch),
    blockedServices: normalizeBlockedServices(input.blockedServices),
  };
}

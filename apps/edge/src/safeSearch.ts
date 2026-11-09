import type { SafeSearchSettings } from "@resolvezero/db/schema";

/**
 * SafeSearch is enforced by answering the search host with a CNAME to the
 * provider's safe endpoint — the provider's addresses rotate, so we must not
 * hardcode an A record.
 */
const GOOGLE_TARGET = "forcesafesearch.google.com";
const BING_TARGET = "strict.bing.com";
const DUCKDUCKGO_TARGET = "safe.duckduckgo.com";
const YOUTUBE_TARGET = "restrict.youtube.com";

const GOOGLE_TLDS = [
  "com", "co.uk", "de", "fr", "es", "it", "nl", "pl", "be", "ch", "at", "se", "no",
  "dk", "fi", "ie", "pt", "cz", "sk", "hu", "ro", "bg", "gr", "tr", "ru", "ua", "ca",
  "com.au", "co.nz", "co.jp", "co.kr", "co.in", "com.br", "com.mx", "com.ar", "co.za",
  "com.sg", "com.hk", "com.tw", "ae", "sa", "il",
];

const GOOGLE = new Set<string>();
for (const tld of GOOGLE_TLDS) {
  GOOGLE.add(`google.${tld}`);
  GOOGLE.add(`www.google.${tld}`);
}

const BING = new Set(["bing.com", "www.bing.com"]);
const DUCKDUCKGO = new Set([
  "duckduckgo.com",
  "www.duckduckgo.com",
  "start.duckduckgo.com",
  "html.duckduckgo.com",
  "lite.duckduckgo.com",
]);
const YOUTUBE = new Set(["youtube.com", "www.youtube.com", "m.youtube.com"]);

/**
 * Returns the CNAME target when this name should be forced into SafeSearch,
 * else undefined. Exact matches only — a wildcard would rewrite search-engine
 * assets that are not the search endpoint.
 */
export function safeSearchTarget(settings: SafeSearchSettings | undefined, name: string): string | undefined {
  if (!settings) return undefined;
  const qname = name.toLowerCase().replace(/\.+$/, "");
  if (settings.google && GOOGLE.has(qname)) return GOOGLE_TARGET;
  if (settings.bing && BING.has(qname)) return BING_TARGET;
  if (settings.duckduckgo && DUCKDUCKGO.has(qname)) return DUCKDUCKGO_TARGET;
  if (settings.youtube && YOUTUBE.has(qname)) return YOUTUBE_TARGET;
  return undefined;
}

/** Config surface for the console/settings API. */
export const SAFE_SEARCH_ENGINES: (keyof SafeSearchSettings)[] = ["google", "bing", "duckduckgo", "youtube"];

import { normalizeDomain } from "./zone"

export const RULE_ACTIONS = ["block", "allow"] as const
export type RuleAction = (typeof RULE_ACTIONS)[number]

export const BLOCKLIST_FORMATS = [
  { value: "auto", label: "Auto-detect" },
  { value: "hosts", label: "Hosts (0.0.0.0 …)" },
  { value: "domains", label: "Domains (one per line)" },
  { value: "abp", label: "Adblock (||domain^)" },
] as const

export type BlocklistFormat = (typeof BLOCKLIST_FORMATS)[number]["value"]

const MAX_URL_LENGTH = 1024

export function normalizeRuleAction(raw: unknown): RuleAction {
  const action = String(raw ?? "").trim().toLowerCase()
  if (!(RULE_ACTIONS as readonly string[]).includes(action)) {
    throw new Error("Action must be block or allow")
  }
  return action as RuleAction
}

/**
 * Rules already match subdomains (the edge walks parent labels), so a leading
 * `*.` is rejected rather than silently stored.
 */
export function normalizeRuleDomain(raw: unknown): string {
  let domain: string
  try {
    domain = normalizeDomain(raw)
  } catch {
    throw new Error("Enter a valid domain, e.g. ads.example.com")
  }
  if (domain.startsWith("*.")) {
    throw new Error("Rules match subdomains automatically — drop the *.")
  }
  return domain
}

export function normalizeBlocklistFormat(raw: unknown): BlocklistFormat {
  const format = String(raw ?? "").trim().toLowerCase()
  if (!BLOCKLIST_FORMATS.some((option) => option.value === format)) {
    throw new Error("Format must be auto, hosts, domains, or abp")
  }
  return format as BlocklistFormat
}

export function normalizeBlocklistUrl(raw: unknown): string {
  const trimmed = String(raw ?? "").trim()
  if (!trimmed) throw new Error("Enter a blocklist URL")
  if (trimmed.length > MAX_URL_LENGTH) {
    throw new Error(`URL must be ${MAX_URL_LENGTH} characters or fewer`)
  }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    throw new Error("Enter a full URL, e.g. https://example.com/list.txt")
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http:// and https:// URLs are supported")
  }
  if (!url.hostname) throw new Error("Enter a full URL with a hostname")
  if (url.username || url.password) {
    throw new Error("URLs with embedded credentials are not supported")
  }

  return url.toString()
}

export const ZONE_RECORD_TYPES = ["A", "AAAA", "CNAME", "TXT"] as const;

export type ZoneRecordType = (typeof ZONE_RECORD_TYPES)[number];

export interface LocalDnsZone {
  domain: string;
  recordType: ZoneRecordType;
  values: string[];
  ttl: number;
}

export interface ZoneInput {
  domain: string;
  recordType: string;
  values: string[] | string;
  ttl?: number | string;
}

const DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const CNAME_RE = /^[a-z0-9._-]+$/i;

function isIPv6(value: string): boolean {
  if (!value.includes(":")) return false;
  try {
    const url = new URL(`http://[${value}]`);
    return url.hostname.startsWith("[") && url.hostname.endsWith("]");
  } catch {
    return false;
  }
}

export function normalizeDomain(raw: unknown): string {
  const cleaned = String(raw ?? "").trim().toLowerCase().replace(/\.+$/, "");
  if (!cleaned) throw new Error("Enter a DNS name");

  const wildcard = cleaned.startsWith("*.");
  const base = wildcard ? cleaned.slice(2) : cleaned;
  if (!DOMAIN_RE.test(base) || base.length > 253) {
    throw new Error("Enter a valid DNS name, e.g. nas.lan or *.home.lan");
  }

  return wildcard ? `*.${base}` : base;
}

export function normalizeRecordType(raw: unknown): ZoneRecordType {
  const type = String(raw ?? "").trim().toUpperCase();
  if (!(ZONE_RECORD_TYPES as readonly string[]).includes(type)) {
    throw new Error("Record type must be A, AAAA, CNAME, or TXT");
  }
  return type as ZoneRecordType;
}

function validateValue(type: ZoneRecordType, value: string): void {
  if (type === "A" && !IPV4_RE.test(value)) {
    throw new Error(`"${value}" is not a valid IPv4 address`);
  }
  if (type === "AAAA" && !isIPv6(value)) {
    throw new Error(`"${value}" is not a valid IPv6 address`);
  }
  if (type === "CNAME" && (value.length > 253 || !CNAME_RE.test(value))) {
    throw new Error(`"${value}" is not a valid CNAME target`);
  }
  if (type === "TXT" && value.length > 255) {
    throw new Error("TXT values must be 255 characters or fewer");
  }
}

export function normalizeZoneInput(input: ZoneInput): LocalDnsZone {
  const domain = normalizeDomain(input?.domain);
  const base = domain.startsWith("*.") ? domain.slice(2) : domain;
  if (!base.endsWith(".lan")) {
    throw new Error("Local DNS names must end in .lan, e.g. nas.lan or *.home.lan");
  }

  const recordType = normalizeRecordType(input?.recordType);

  const rawValues = Array.isArray(input?.values) ? input.values : String(input?.values ?? "").split(/[,\n]/);
  const values = [...new Set(rawValues.map((value) => String(value).trim()).filter(Boolean))];
  if (values.length === 0) throw new Error("Add at least one answer value");
  if (values.length > 8) throw new Error("Add at most 8 answer values");
  for (const value of values) validateValue(recordType, value);

  const ttl = Math.min(86_400, Math.max(1, Math.floor(Number(input?.ttl) || 300)));
  return { domain, recordType, values, ttl };
}

export function zoneKey(zone: Pick<LocalDnsZone, "domain" | "recordType">): string {
  return `${zone.domain}|${zone.recordType}`;
}

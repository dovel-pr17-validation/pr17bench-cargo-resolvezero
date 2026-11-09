export interface AgentConfig {
  profileId: string;
  token: string;
  dohUrl: string;
  bindHost: string;
  dnsPort: number;
  timeoutMs: number;
  healthPort: number;
  healthHost: string;
  devices: Map<string, string>;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const profileId = (env.PROFILE_ID ?? env.RESOLVEZERO_PROFILE_ID ?? "").trim();
  if (!profileId) throw new Error("PROFILE_ID is required");

  const token = (env.DOH_TOKEN ?? env.RESOLVEZERO_DOH_TOKEN ?? "").trim();
  if (!token) throw new Error("DOH_TOKEN is required");

  const dohUrl = (env.DOH_URL ?? "https://resolvezero-edge.fly.dev").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(dohUrl)) throw new Error("DOH_URL must start with http:// or https://");

  const dnsPort = numberEnv(env.DNS_PORT, 53);
  const healthPort = numberEnv(env.HEALTH_PORT, 0);
  const timeoutMs = numberEnv(env.DOH_TIMEOUT_MS, 5_000);

  return {
    profileId,
    token,
    dohUrl,
    bindHost: (env.BIND_HOST ?? "0.0.0.0").trim() || "0.0.0.0",
    dnsPort,
    timeoutMs,
    healthPort,
    healthHost: (env.HEALTH_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    devices: parseDeviceMap(env.DEVICE_MAP ?? ""),
  };
}

function numberEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`invalid port/timeout value: ${raw}`);
  }
  return value;
}

/**
 * DEVICE_MAP format:
 *   192.168.1.20=macbook,192.168.1.21=iphone
 * Newlines and semicolons are accepted too.
 */
export function parseDeviceMap(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of raw.split(/[\n,;]+/)) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const ip = trimmed.slice(0, eq).trim();
    const label = trimmed.slice(eq + 1).trim();
    if (ip && label) out.set(ip, label);
  }
  return out;
}

/** URL-safe stable device slug. Falls back to the source IP. */
export function deviceSlug(ip: string, label?: string): string {
  const source = label?.trim() || `ip-${ip}`;
  const slug = source
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || `ip-${ip.replace(/[^a-z0-9]+/gi, "-").slice(0, 32)}`;
}

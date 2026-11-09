export * from "./localNames";

// Shape of the `profile_updates` NOTIFY payload emitted by the
// notify_rule_change() trigger (see readme.md §5).
export type RuleOp = "INSERT" | "UPDATE" | "DELETE";

export interface RuleUpdateEvent {
  op: RuleOp;
  profile_id: string;
  domain: string;
  // NULL on DELETE => the edge must remove the rule.
  action: "block" | "allow" | null;
}

export function isRuleUpdateEvent(value: unknown): value is RuleUpdateEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.op === "INSERT" || v.op === "UPDATE" || v.op === "DELETE") &&
    typeof v.profile_id === "string" &&
    typeof v.domain === "string" &&
    (v.action === "block" || v.action === "allow" || v.action === null)
  );
}

// Shape of the `ip_updates` NOTIFY payload (notify_ip_change trigger).
export interface IpUpdateEvent {
  op: RuleOp;
  ip_address: string;
  profile_id: string;
}

interface ProcessLike {
  env: Record<string, string | undefined>;
  getuid?: () => number;
  setuid?: (uid: number) => void;
  getgid?: () => number;
  setgid?: (gid: number) => void;
}

function hostProcess(): ProcessLike | undefined {
  return (globalThis as unknown as { process?: ProcessLike }).process;
}

/**
 * Drops root privileges after privileged sockets have been bound.
 *
 * The edge must start as root to bind UDP/TCP 53, then immediately become
 * unprivileged. Sockets bound before setuid remain usable. Returns true when
 * a drop happened; false when already non-root / disabled / unsupported.
 *
 * Env: DROP_UID (default 1000), DROP_GID (default 1000), DROP_PRIVILEGES=0
 * disables the drop entirely.
 */
export function dropPrivileges(opts: {
  uid?: number;
  gid?: number;
  enabled?: boolean;
  onDrop?: (uid: number, gid: number) => void;
} = {}): boolean {
  const proc = hostProcess();
  if (!proc) return false;
  const enabled = opts.enabled ?? proc.env.DROP_PRIVILEGES !== "0";
  if (!enabled) return false;
  if (typeof proc.setuid !== "function" || typeof proc.setgid !== "function") return false;
  if (proc.getuid?.() !== 0) return false;

  const uid = opts.uid ?? Number(proc.env.DROP_UID ?? 1000);
  const gid = opts.gid ?? Number(proc.env.DROP_GID ?? 1000);
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) {
    throw new Error(`invalid privilege-drop target uid=${uid} gid=${gid}`);
  }

  // Group first: once the UID changes we can no longer setgid.
  proc.setgid(gid);
  proc.setuid(uid);
  opts.onDrop?.(uid, gid);
  return true;
}

export function isIpUpdateEvent(value: unknown): value is IpUpdateEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.op === "INSERT" || v.op === "UPDATE" || v.op === "DELETE") &&
    typeof v.ip_address === "string" &&
    typeof v.profile_id === "string"
  );
}

// Shape of the `zone_updates` NOTIFY payload (notify_zone_change trigger).
export type ZoneRecordType = "A" | "AAAA" | "CNAME" | "TXT";

export interface ZoneUpdateEvent {
  op: RuleOp;
  profile_id: string;
  domain: string; // 'nas.lan' exact | '*.home.example.com' wildcard (suffix)
  record_type: ZoneRecordType;
  values: string[] | null; // null on DELETE
  ttl: number | null;
}

export function isZoneUpdateEvent(value: unknown): value is ZoneUpdateEvent {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.op === "INSERT" || v.op === "UPDATE" || v.op === "DELETE") &&
    typeof v.profile_id === "string" &&
    typeof v.domain === "string" &&
    typeof v.record_type === "string" &&
    ["A", "AAAA", "CNAME", "TXT"].includes(v.record_type) &&
    (v.values === null || (Array.isArray(v.values) && v.values.every((x) => typeof x === "string"))) &&
    (v.ttl === null || typeof v.ttl === "number")
  );
}

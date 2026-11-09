import type { StatsTopEntry } from "@resolvezero/db/schema";

export function merge(map: Map<string, number>, entries: StatsTopEntry[] | null): void {
  for (const entry of entries ?? []) {
    const key = entry.domain ?? entry.device ?? entry.clientIp;
    if (key) map.set(key, (map.get(key) ?? 0) + (entry.count || 0));
  }
}

export function top(map: Map<string, number>, limit: number): [string, number][] {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

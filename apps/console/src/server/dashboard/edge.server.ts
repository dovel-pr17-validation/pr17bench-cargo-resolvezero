import type { EdgeHealth } from "./types";

export function edgeBaseUrl(): string {
  return (process.env.EDGE_URL ?? "https://resolvezero-edge.fly.dev").replace(/\/+$/, "");
}

export async function loadEdgeHealth(): Promise<EdgeHealth> {
  try {
    const res = await fetch(`${edgeBaseUrl()}/readyz`, { signal: AbortSignal.timeout(2_500) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      ok: body.ok === true,
      region: typeof body.region === "string" ? body.region : null,
      rulesLoaded: body.rulesLoaded === true,
      blocklistsLoaded: body.blocklistsLoaded === true,
      dns53Bound: body.dns53Bound === true,
      configPollAgeMs: typeof body.configPollAgeMs === "number" ? body.configPollAgeMs : null,
      failedBlocklists: typeof body.failedBlocklists === "number" ? body.failedBlocklists : 0,
    };
  } catch {
    return {
      ok: false,
      region: null,
      rulesLoaded: false,
      blocklistsLoaded: false,
      dns53Bound: false,
      configPollAgeMs: null,
      failedBlocklists: 0,
    };
  }
}

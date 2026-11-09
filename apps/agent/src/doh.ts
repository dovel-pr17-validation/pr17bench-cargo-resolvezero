import type { AgentConfig } from "./config";
import { deviceSlug } from "./config";

export class DohError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DohError";
  }
}

/** Forward a DNS wire query to the edge and return the raw DNS response. */
export async function resolveDoh(
  config: AgentConfig,
  query: Uint8Array,
  sourceIp: string,
  fetchImpl: typeof fetch = fetch,
): Promise<Uint8Array> {
  const device = deviceSlug(sourceIp, config.devices.get(sourceIp));
  const url = `${config.dohUrl}/v1/${encodeURIComponent(config.profileId)}/${encodeURIComponent(device)}/${encodeURIComponent(config.token)}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/dns-message",
        accept: "application/dns-message",
        "user-agent": "resolvezero-agent/0.1",
      },
      body: query as unknown as BodyInit,
      redirect: "error",
      signal: AbortSignal.timeout(config.timeoutMs),
    });
  } catch (err) {
    throw new DohError(err instanceof Error ? err.message : "DoH request failed");
  }

  if (!response.ok) {
    throw new DohError(`edge returned HTTP ${response.status}`, response.status);
  }

  const body = new Uint8Array(await response.arrayBuffer());
  if (body.length < 12) throw new DohError("edge returned an empty/invalid DNS response");
  return body;
}

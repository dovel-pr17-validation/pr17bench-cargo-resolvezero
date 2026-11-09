import { decode, encode, type Packet } from "dns-packet";

const DEFAULT_UDP_PAYLOAD = 512;
const MAX_UDP_PAYLOAD = 4096;

export function maxUdpPayload(query: Uint8Array): number {
  try {
    const packet = decode(Buffer.from(query));
    const opt = (packet.additionals ?? []).find((r) => r.type === "OPT") as
      | { udpPayloadSize?: number }
      | undefined;
    const advertised = opt?.udpPayloadSize ?? DEFAULT_UDP_PAYLOAD;
    return Math.max(DEFAULT_UDP_PAYLOAD, Math.min(MAX_UDP_PAYLOAD, advertised));
  } catch {
    return DEFAULT_UDP_PAYLOAD;
  }
}

/** Build a minimal SERVFAIL response for a valid query. */
export function servfailResponse(query: Uint8Array): Uint8Array | null {
  let packet: Packet;
  try {
    packet = decode(Buffer.from(query));
  } catch {
    return null;
  }
  if (!packet.questions?.length) return null;
  return new Uint8Array(
    encode({
      id: packet.id,
      type: "response",
      flags: 0x8182 | ((packet.flags ?? 0) & 0x0100), // QR + RA + SERVFAIL, preserve RD
      questions: packet.questions,
    } as never),
  );
}

/** Build a TC response so the client retries over TCP through the agent. */
export function truncatedResponse(query: Uint8Array): Uint8Array | null {
  let packet: Packet;
  try {
    packet = decode(Buffer.from(query));
  } catch {
    return null;
  }
  if (!packet.questions?.length) return null;
  return new Uint8Array(
    encode({
      id: packet.id,
      type: "response",
      flags: 0x8380 | ((packet.flags ?? 0) & 0x0100), // QR + TC + RA
      questions: packet.questions,
    } as never),
  );
}

export function sameTransactionId(query: Uint8Array, response: Uint8Array): boolean {
  return query.length >= 2 && response.length >= 2 && query[0] === response[0] && query[1] === response[1];
}

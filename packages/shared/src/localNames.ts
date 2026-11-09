import { decode, encode, type Packet } from "dns-packet";

export interface LocalNameOptions {
  /** Domains where IP-encoded names are answered locally (e.g. lan). */
  localDomains: readonly string[];
  localTtl: number;
  /** Allow synthetic answers for public IPs. Off by default. */
  allowPublicIpEncoding?: boolean;
}

/**
 * Answer IP-encoded names locally:
 *
 *   192.168.1.20.lan       -> 192.168.1.20
 *   app.192.168.1.20.lan   -> 192.168.1.20
 *   192-168-1-20.lan       -> 192.168.1.20
 *
 * This is nip.io/sslip.io-style behaviour, scoped to local domains.
 * Unmatched names return null and can be handled by the caller (edge zones,
 * upstream forwarding, etc.).
 */
export function localNameAnswer(query: Uint8Array, opts: LocalNameOptions): Uint8Array<ArrayBuffer> | null {
  let packet: Packet;
  try {
    packet = decode(Buffer.from(query));
  } catch {
    return null;
  }
  const question = packet.questions?.[0];
  if (!question) return null;

  const name = String(question.name).toLowerCase().replace(/\.+$/, "");
  if (!opts.localDomains.some((domain) => name === domain || name.endsWith(`.${domain}`))) {
    return null;
  }

  const ip = extractIpv4(name, opts.localDomains);
  if (!ip) return null;
  if (!opts.allowPublicIpEncoding && !isPrivateIpv4(ip)) return null;

  const flags = 0x8480 | ((packet.flags ?? 0) & 0x0100); // QR + AA + RA (+RD)
  const type = String(question.type).toUpperCase();
  if (type === "AAAA") {
    return wireBytes(
      encode({
        id: packet.id,
        type: "response",
        flags,
        questions: packet.questions,
        answers: [],
      } as never),
    );
  }
  if (type !== "A" && type !== "ANY") return null;

  return wireBytes(
    encode({
      id: packet.id,
      type: "response",
      flags,
      questions: packet.questions,
      answers: [
        {
          name: question.name,
          type: "A",
          class: "IN",
          ttl: opts.localTtl,
          data: ip,
        },
      ],
    } as never),
  );
}

function wireBytes(encoded: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(encoded.length);
  out.set(encoded);
  return out;
}

export function parseLocalDomains(raw: string): string[] {
  return raw
    .split(/[\n,;]+/)
    .map((d) => d.trim().toLowerCase().replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);
}

export function extractIpv4(name: string, localDomains: readonly string[]): string | null {
  const lower = name.toLowerCase().replace(/\.+$/, "");
  for (const domain of localDomains) {
    if (!lower.endsWith(`.${domain}`)) continue;
    const prefix = lower.slice(0, -(domain.length + 1));
    if (!prefix) continue;

    const labels = prefix.split(".");
    const last = labels.at(-1) ?? "";
    const candidates = [labels.slice(-4), last.split("-")];
    for (const candidate of candidates) {
      if (candidate.length !== 4 || candidate.some((part) => !/^\d{1,3}$/.test(part))) continue;
      const octets = candidate.map(Number);
      if (octets.every((part) => part >= 0 && part <= 255)) return octets.join(".");
    }
  }
  return null;
}

export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127)
  );
}

import net from "node:net";

import { moduleLogger } from "./logger";
import { positiveInt, Semaphore } from "./limits";
import type { RuleStore } from "./ruleStore";

const log = moduleLogger("dot");

const DOT_PORT = positiveInt(process.env.DOT_PORT, 853);
const DOT_SUFFIX = (process.env.DOT_SUFFIX ?? ".dot.resolvezero.com").toLowerCase();
const DOT_MAX_CONNECTIONS = positiveInt(process.env.DOT_MAX_CONNECTIONS, 512);
const DOT_MAX_CONNECTIONS_PER_SOURCE = positiveInt(process.env.DOT_MAX_CONNECTIONS_PER_SOURCE, 16);
const DOT_MAX_INFLIGHT = positiveInt(process.env.DOT_MAX_INFLIGHT, 128);
const DOT_MAX_BUFFER_BYTES = positiveInt(process.env.DOT_MAX_BUFFER_BYTES, 65_536);
const DOT_IDLE_TIMEOUT_MS = positiveInt(process.env.DOT_IDLE_TIMEOUT_MS, 120_000);
const DOT_MAX_LIFETIME_MS = positiveInt(process.env.DOT_MAX_LIFETIME_MS, 600_000);

const PROXY_V2_MAGIC = new Uint8Array([
  0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a,
]);
const TLV_AUTHORITY = 0x02;

export interface ProxyV2Info {
  sourceIp: string | null;
  sourcePort: number | null;
  destinationIp: string | null;
  destinationPort: number | null;
  /** SNI hostname from the PP2_TYPE_AUTHORITY TLV, if present. */
  authority: string | null;
}

export type ProxyV2Result =
  | { status: "ok"; info: ProxyV2Info; length: number }
  | { status: "need-more" }
  | { status: "invalid" };

function ipv4(buf: Uint8Array, at: number): string {
  return `${buf[at]}.${buf[at + 1]}.${buf[at + 2]}.${buf[at + 3]}`;
}

function ipv6(buf: Uint8Array, at: number): string {
  const groups: string[] = [];
  for (let i = 0; i < 8; i += 1) {
    groups.push(((buf[at + i * 2]! << 8) | buf[at + i * 2 + 1]!).toString(16));
  }
  // RFC 5952: compress the longest run of zero groups.
  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  for (let i = 0; i <= 8; i += 1) {
    if (i < 8 && groups[i] === "0") {
      if (runStart < 0) runStart = i;
    } else if (runStart >= 0) {
      const length = i - runStart;
      if (length > bestLength && length > 1) {
        bestStart = runStart;
        bestLength = length;
      }
      runStart = -1;
    }
  }
  if (bestStart < 0) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/**
 * Parse a PROXY protocol v2 header as sent by Fly's proxy in front of the TLS
 * handler. Returns `need-more` until the whole header has arrived.
 */
export function parseProxyV2(buf: Uint8Array): ProxyV2Result {
  if (buf.length < 12) {
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] !== PROXY_V2_MAGIC[i]) return { status: "invalid" };
    }
    return { status: "need-more" };
  }
  for (let i = 0; i < PROXY_V2_MAGIC.length; i += 1) {
    if (buf[i] !== PROXY_V2_MAGIC[i]) return { status: "invalid" };
  }
  if (buf.length < 16) return { status: "need-more" };

  const versionCommand = buf[12]!;
  if (versionCommand >> 4 !== 2) return { status: "invalid" };
  const command = versionCommand & 0x0f; // 0 = LOCAL, 1 = PROXY
  const familyProtocol = buf[13]!;
  const family = familyProtocol >> 4; // 1 = IPv4, 2 = IPv6, 0 = UNSPEC
  const payloadLength = (buf[14]! << 8) | buf[15]!;
  const total = 16 + payloadLength;
  if (buf.length < total) return { status: "need-more" };

  const info: ProxyV2Info = {
    sourceIp: null,
    sourcePort: null,
    destinationIp: null,
    destinationPort: null,
    authority: null,
  };

  let offset = 16;
  let headerEnd = total;

  if (command === 1) {
    if (family === 1) {
      if (offset + 12 > total) return { status: "invalid" };
      info.sourceIp = ipv4(buf, offset);
      info.destinationIp = ipv4(buf, offset + 4);
      info.sourcePort = (buf[offset + 8]! << 8) | buf[offset + 9]!;
      info.destinationPort = (buf[offset + 10]! << 8) | buf[offset + 11]!;
      offset += 12;
    } else if (family === 2) {
      if (offset + 36 > total) return { status: "invalid" };
      info.sourceIp = ipv6(buf, offset);
      info.destinationIp = ipv6(buf, offset + 16);
      info.sourcePort = (buf[offset + 32]! << 8) | buf[offset + 33]!;
      info.destinationPort = (buf[offset + 34]! << 8) | buf[offset + 35]!;
      offset += 36;
    }
  }

  while (offset + 3 <= headerEnd) {
    const type = buf[offset]!;
    const length = (buf[offset + 1]! << 8) | buf[offset + 2]!;
    const valueStart = offset + 3;
    if (valueStart + length > headerEnd) return { status: "invalid" };
    if (type === TLV_AUTHORITY) {
      info.authority = new TextDecoder().decode(buf.subarray(valueStart, valueStart + length)).toLowerCase();
    }
    offset = valueStart + length;
  }

  return { status: "ok", info, length: total };
}

/** `<label>.dot.resolvezero.com` → `label`; anything else → null. */
export function dotLabel(hostname: string, suffix = DOT_SUFFIX): string | null {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!host.endsWith(suffix)) return null;
  const label = host.slice(0, -suffix.length);
  if (!label || label.includes(".")) return null;
  return /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(label) ? label : null;
}

export interface DotDeps {
  store: RuleStore;
  /** Policy pipeline shared with UDP/TCP/DoH. */
  resolve(wire: Uint8Array, sourceIp: string, profileId: string): Promise<Uint8Array | null>;
  port?: number;
}

export interface DotHandle {
  port: number;
  stop(): Promise<void>;
}

interface ConnectionState {
  buffer: Uint8Array;
  headerParsed: boolean;
  profileId: string | null;
  sourceIp: string;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/**
 * DNS-over-TLS ingress. TLS is terminated by Fly's proxy (the `tls` handler),
 * which prepends a PROXY v2 header carrying the client address and the SNI
 * authority TLV. We map `<label>.dot.resolvezero.com` → profile and run the
 * same policy pipeline as the other transports.
 */
export async function createDotService(deps: DotDeps): Promise<DotHandle | null> {
  const port = deps.port ?? DOT_PORT;
  const inflight = new Semaphore(DOT_MAX_INFLIGHT);
  const perSource = new Map<string, number>();
  let active = 0;

  const server = net.createServer((socket) => {
    if (active >= DOT_MAX_CONNECTIONS) {
      socket.destroy();
      return;
    }
    active += 1;

    const state: ConnectionState = {
      buffer: new Uint8Array(0),
      headerParsed: false,
      profileId: null,
      sourceIp: socket.remoteAddress ?? "",
    };

    const lifetime = setTimeout(() => socket.destroy(), DOT_MAX_LIFETIME_MS);
    socket.setTimeout(DOT_IDLE_TIMEOUT_MS, () => socket.destroy());
    socket.on("close", () => {
      clearTimeout(lifetime);
      active -= 1;
      if (state.sourceIp) {
        const current = perSource.get(state.sourceIp) ?? 0;
        if (current <= 1) perSource.delete(state.sourceIp);
        else perSource.set(state.sourceIp, current - 1);
      }
    });
    socket.on("error", () => socket.destroy());

    socket.on("data", (chunk) => {
      state.buffer = concat(state.buffer, new Uint8Array(chunk));
      if (state.buffer.length > DOT_MAX_BUFFER_BYTES) {
        socket.destroy();
        return;
      }

      if (!state.headerParsed) {
        const parsed = parseProxyV2(state.buffer);
        if (parsed.status === "need-more") return;
        if (parsed.status === "invalid") {
          log.warn("closing DoT connection without a valid PROXY v2 header");
          socket.destroy();
          return;
        }

        const suffix = DOT_SUFFIX;
        const label = parsed.info.authority ? dotLabel(parsed.info.authority, suffix) : null;
        const profileId = label ? deps.store.authorizeDotId(label) : undefined;
        if (!profileId) {
          log.warn({ authority: parsed.info.authority }, "closing DoT connection with unknown hostname");
          socket.destroy();
          return;
        }

        state.profileId = profileId;
        state.sourceIp = parsed.info.sourceIp ?? state.sourceIp;
        state.buffer = state.buffer.slice(parsed.length);
        state.headerParsed = true;

        const current = perSource.get(state.sourceIp) ?? 0;
        if (current >= DOT_MAX_CONNECTIONS_PER_SOURCE) {
          socket.destroy();
          return;
        }
        if (perSource.size > 10_000) perSource.clear();
        perSource.set(state.sourceIp, current + 1);
      }

      for (;;) {
        if (state.buffer.length < 2) return;
        const expected = (state.buffer[0]! << 8) | state.buffer[1]!;
        if (expected === 0) {
          socket.destroy();
          return;
        }
        if (state.buffer.length < expected + 2) return;

        const wire = state.buffer.slice(2, 2 + expected);
        state.buffer = state.buffer.slice(2 + expected);
        const profileId = state.profileId;
        if (!profileId) return;

        if (!inflight.tryAcquire()) {
          socket.destroy();
          return;
        }

        void deps
          .resolve(wire, state.sourceIp, profileId)
          .then((reply) => {
            if (!reply) return;
            const frame = new Uint8Array(reply.length + 2);
            frame[0] = reply.length >> 8;
            frame[1] = reply.length & 0xff;
            frame.set(reply, 2);
            if (socket.writableLength > DOT_MAX_BUFFER_BYTES) {
              socket.destroy();
              return;
            }
            socket.write(frame);
          })
          .catch((err) => log.warn({ err }, "DoT query failed"))
          .finally(() => inflight.release());
      }
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "0.0.0.0", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (err) {
    log.error({ err }, "DoT listener failed to bind");
    return null;
  }

  server.on("error", (err) => log.warn({ err }, "DoT server error"));
  log.info({ port }, "DoT listening");

  return {
    port,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    },
  };
}

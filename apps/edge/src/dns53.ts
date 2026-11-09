import { decode } from "dns-packet";
import dgram from "node:dgram";
import net from "node:net";
import type { QueryLogEntry, Upstream } from "./doh";
import type { DnsCache } from "./dnsCache";
import type { Recorder } from "./metrics";
import type { RuleStore } from "./ruleStore";
import {
  UDP_MAX_PAYLOAD,
  blockedResponse,
  cnameResponse,
  decodeQuestion,
  noDataResponse,
  normalizeIp,
  nxdomainResponse,
  servfailResponse,
  refusedResponse,
  truncatedResponse,
  zoneAnswer,
} from "./wire";
import { moduleLogger } from "./logger";
import { localNameAnswer } from "@resolvezero/shared";
import { matchProbeNonce } from "./probe";
import { safeSearchTarget } from "./safeSearch";
import { createRateLimiter, positiveInt, Semaphore } from "./limits";
import type { Transport } from "./metrics";

const log = moduleLogger("dns53");

const TCP_MAX_BUFFER_BYTES = Math.max(4096, Number(process.env.TCP_MAX_BUFFER_BYTES ?? 65_536) || 65_536);
const TCP_IDLE_TIMEOUT_MS = Math.max(5_000, Number(process.env.TCP_IDLE_TIMEOUT_MS ?? 30_000) || 30_000);
const TCP_MAX_LIFETIME_MS = positiveInt(process.env.TCP_MAX_LIFETIME_MS, 120_000);
const TCP_MAX_CONNECTIONS = Math.max(1, Number(process.env.TCP_MAX_CONNECTIONS ?? 512) || 512);
const TCP_MAX_CONNECTIONS_PER_SOURCE = positiveInt(process.env.TCP_MAX_CONNECTIONS_PER_SOURCE, 8);
const TCP_MAX_INFLIGHT = positiveInt(process.env.TCP_MAX_INFLIGHT, 128);
const UDP_RATE_LIMIT_PER_MIN = positiveInt(process.env.UDP_RATE_LIMIT_PER_MIN, 600);
const UDP_MAX_INFLIGHT = positiveInt(process.env.UDP_MAX_INFLIGHT, 1024);

interface TcpState {
  buffer: Uint8Array;
  headerParsed: boolean;
  sourceIp: string;
  counted: boolean;
}

export interface Dns53Deps {
  store: RuleStore;
  dnsCache: DnsCache;
  upstream: Upstream;
  logQuery(entry: QueryLogEntry): void;
  recorder?: Recorder;
  /** Bind hostname — "fly-global-services" on Fly (mandatory for UDP there). */
  host?: string;
  port?: number;
  tcp?: boolean;
  /** Local suffixes for IP-encoded names (default: lan). */
  localDomains?: readonly string[];
  localTtl?: number;
  allowPublicIpEncoding?: boolean;
  /** Resolver-presence canary suffix; no public record should exist for it. */
  probeDomain?: string | null;
  /** Called for a valid probe lookup, after source-IP auth. */
  onProbeSeen?(nonce: string, transport: "doh" | "udp" | "tcp" | "dot"): void;
}

export interface Dns53Handle {
  stop(): Promise<void>;
  udpPort: number;
  tcpPort?: number;
  /** Run the policy pipeline for a caller already authenticated by another transport (DoT). */
  resolve(wire: Uint8Array, sourceIp: string, transport: Transport, profileId: string): Promise<Uint8Array | null>;
}

/**
 * Port-53 DNS ingress (readme §6.4, the Deco/router path):
 *  - UDP bound to `fly-global-services` (mandatory on Fly; define [[services]]
 *    udp 53 in fly.toml) + TCP for oversized/TC-fallback queries.
 *  - Auth = profile via source-IP whitelist (profile_source_ips). Unknown or
 *    unauthorized senders get REFUSED by default (UDP_UNKNOWN_SOURCE=refused)
 *    or silence with =silent (open-resolver defense, readme §4).
 * - Same pipeline as DoH: zone override → blocklist → LRU → upstream.
 */
/** PROXY protocol v1 signature ("PROXY "). */
const PROXY_SIGNATURE = new TextEncoder().encode("PROXY ");

function matchesPrefix(buf: Uint8Array, signature: Uint8Array): boolean {
  const n = Math.min(buf.length, signature.length);
  for (let i = 0; i < n; i++) {
    if (buf[i] !== signature[i]) return false;
  }
  return true;
}

function indexOfCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 1 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) return i;
  }
  return -1;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export async function createDns53Service(deps: Dns53Deps): Promise<Dns53Handle | null> {
  const host = deps.host ?? process.env.UDP_HOST ?? "fly-global-services";
  const port = deps.port ?? Number(process.env.UDP_PORT ?? 53);
  const tcpStates = new WeakMap<object, TcpState>();
  const udpRateLimit = createRateLimiter(UDP_RATE_LIMIT_PER_MIN, 60_000, 20_000);
  const udpSlots = new Semaphore(UDP_MAX_INFLIGHT);
  const tcpSlots = new Semaphore(TCP_MAX_INFLIGHT);
  const tcpSourceCounts = new Map<string, number>();

  /** Refresh a cached entry before it expires (no client-visible latency). */
  const refresh = async (queryWire: Uint8Array, upstreamUrl?: string | null): Promise<void> => {
    const result = await deps.upstream.resolveWire(queryWire, upstreamUrl ?? undefined);
    deps.dnsCache.set(queryWire, result.wire, upstreamUrl);
    deps.recorder?.recordRtt(result.rttMs);
  };

  let udp: dgram.Socket | undefined;
  let tcp: net.Server | undefined;

  try {
    udp = dgram.createSocket("udp4");
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      udp!.once("error", onError);
      udp!.bind({ address: host, port }, () => {
        udp!.off("error", onError);
        resolve();
      });
    });
    udp.on("error", (err) => log.error({ err }, "udp socket error"));
    udp.on("message", (data, rinfo) => {
      const started = performance.now();
      const sourceIp = normalizeIp(rinfo.address);
      if (!udpRateLimit(sourceIp)) {
        deps.recorder?.recordDrop("udp_rate_limited");
        return;
      }
      if (!udpSlots.tryAcquire()) {
        deps.recorder?.recordDrop("udp_inflight_limit");
        return;
      }
      void handleUdp(new Uint8Array(data), sourceIp)
        .then((reply) => {
          if (!reply) return;
          udp!.send(reply, rinfo.port, rinfo.address, (err) => {
            if (err) log.warn({ err }, "udp send failed");
          });
        })
        .catch((err) => log.error({ err }, "udp handler failed"))
        .finally(() => {
          udpSlots.release();
          deps.recorder?.recordDuration("udp", performance.now() - started);
        });
    });
    log.info({ host, port }, "UDP 53 listening");
  } catch (err) {
    log.warn({ err, host, port }, "UDP 53 unavailable (local dev? port in use?) — continuing without DNS ingress");
    try { udp?.close(); } catch { /* not bound */ }
    return null;
  }

  if (deps.tcp ?? true) {
    // Fly's TCP service proxy connects to the instance's wildcard address,
    // while `fly-global-services` is UDP-specific. Binding TCP there makes it
    // unreachable (proxy: "is your app listening on 0.0.0.0:53?").
    const tcpHost = process.env.TCP_HOST ?? (host === "fly-global-services" ? "0.0.0.0" : host);
    try {
      tcp = net.createServer((socket) => {
        const deadline = setTimeout(() => {
          log.warn({ lifetimeMs: TCP_MAX_LIFETIME_MS }, "closing long-lived TCP DNS connection");
          socket.destroy();
        }, TCP_MAX_LIFETIME_MS);
        deadline.unref?.();
        socket.setTimeout(TCP_IDLE_TIMEOUT_MS, () => {
          log.warn({ timeoutMs: TCP_IDLE_TIMEOUT_MS }, "closing idle TCP DNS connection");
          socket.destroy();
        });
        socket.on("data", (chunk) => tcpData(socket, new Uint8Array(chunk)));
        socket.on("error", (err) => log.warn({ err }, "tcp socket error"));
        socket.on("close", () => {
          clearTimeout(deadline);
          const state = tcpStates.get(socket);
          if (state?.counted) {
            const current = tcpSourceCounts.get(state.sourceIp) ?? 0;
            if (current <= 1) tcpSourceCounts.delete(state.sourceIp);
            else tcpSourceCounts.set(state.sourceIp, current - 1);
          }
          tcpStates.delete(socket);
        });
      });
      tcp.maxConnections = TCP_MAX_CONNECTIONS;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        tcp!.once("error", onError);
        tcp!.listen({ host: tcpHost, port }, () => {
          tcp!.off("error", onError);
          resolve();
        });
      });
      tcp.on("error", (err) => log.warn({ err }, "tcp listener error"));
      log.info({ host: tcpHost, port }, "TCP 53 listening");
    } catch (err) {
      log.warn({ err }, "TCP 53 unavailable — TC-flag fallback still works; oversized queries fail");
      try { tcp?.close(); } catch { /* not bound */ }
      tcp = undefined;
    }
  }

  const udpPort = udp.address().port;
  return {
    udpPort,
    tcpPort: tcp ? port : undefined,
    resolve: (wire, sourceIp, transport, profileId) =>
      handlePacket(wire, sourceIp, transport, profileId),
    async stop() {
      await new Promise<void>((resolve) => udp!.close(() => resolve()));
      if (tcp) {
        tcp.close();
        (tcp as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      }
    },
  };

  // ---- UDP path ----
  async function handleUdp(wire: Uint8Array, sourceIp: string): Promise<Uint8Array | null> {
    const reply = await handlePacket(wire, sourceIp, "udp");
    if (reply && reply.length > UDP_MAX_PAYLOAD) {
      // TC bit — real clients will retry over TCP
      const q = decodeQuestion(wire);
      return truncatedResponse(q);
    }
    return reply;
  }

  // ---- TCP framing path (2-byte length prefix per RFC 1035) ----
  // Fly's TCP proxy hides the client address; the `proxy_proto` handler
  // prepends a v1 header ("PROXY TCP4 src dst sport dport\r\n"). Parse it
  // when present, otherwise fall back to the socket peer address (local /
  // direct deployments). Also buffers partial writes and multiple frames.
  function tcpData(socket: net.Socket, chunk: Uint8Array): void {
    let state = tcpStates.get(socket);
    if (!state) {
      state = {
        buffer: new Uint8Array(0),
        headerParsed: false,
        sourceIp: normalizeIp(socket.remoteAddress ?? ""),
        counted: false,
      };
      tcpStates.set(socket, state);
    }
    if (state.buffer.length + chunk.length > TCP_MAX_BUFFER_BYTES) {
      log.warn({ bytes: state.buffer.length + chunk.length }, "closing oversized TCP DNS buffer");
      socket.destroy();
      return;
    }
    state.buffer = concatBytes(state.buffer, chunk);

    if (!state.headerParsed) {
      const couldBeProxy = matchesPrefix(state.buffer, PROXY_SIGNATURE);
      if (couldBeProxy && state.buffer.length < PROXY_SIGNATURE.length) return; // wait for full signature
      if (couldBeProxy) {
        const end = indexOfCrlf(state.buffer);
        if (end < 0) return; // wait for the header terminator
        const line = new TextDecoder().decode(state.buffer.slice(0, end));
        const parts = line.split(" ");
        // "PROXY TCP4 1.2.3.4 5.6.7.8 1234 53" — UNKNOWN has no addresses.
        if (parts[1] && parts[1] !== "UNKNOWN" && parts[2]) {
          state.sourceIp = normalizeIp(parts[2]);
        }
        state.buffer = state.buffer.slice(end + 2);
      }
      state.headerParsed = true;
    }

    if (!state.counted) {
      const active = tcpSourceCounts.get(state.sourceIp) ?? 0;
      if (active >= TCP_MAX_CONNECTIONS_PER_SOURCE) {
        log.warn({ sourceIp: state.sourceIp, active }, "closing TCP DNS connection over per-source cap");
        socket.destroy();
        return;
      }
      if (tcpSourceCounts.size > 10_000) tcpSourceCounts.clear();
      tcpSourceCounts.set(state.sourceIp, active + 1);
      state.counted = true;
    }

    // Process every complete DNS frame in the buffer.
    for (;;) {
      if (state.buffer.length < 2) return;
      const expected = (state.buffer[0]! << 8) | state.buffer[1]!;
      if (expected === 0) {
        log.warn("closing TCP DNS connection with zero-length frame");
        socket.destroy();
        return;
      }
      if (state.buffer.length < expected + 2) return;
      const wire = state.buffer.slice(2, 2 + expected);
      state.buffer = state.buffer.slice(2 + expected);
      const sourceIp = state.sourceIp;
      const started = performance.now();
      if (!tcpSlots.tryAcquire()) {
        deps.recorder?.recordDrop("tcp_inflight_limit");
        socket.destroy();
        return;
      }
      void handlePacket(wire, sourceIp, "tcp")
        .then((reply) => {
          if (!reply) return;
          const frame = new Uint8Array(reply.length + 2);
          frame[0] = reply.length >> 8;
          frame[1] = reply.length & 0xff;
          frame.set(reply, 2);
          if (socket.writableLength > TCP_MAX_BUFFER_BYTES) {
            log.warn({ pending: socket.writableLength }, "closing TCP DNS connection with backed-up writes");
            socket.destroy();
            return;
          }
          socket.write(frame);
        })
        .catch((err) => log.error({ err }, "tcp handler failed"))
        .finally(() => {
          tcpSlots.release();
          deps.recorder?.recordDuration("tcp", performance.now() - started);
        });
    }
  }

  /** Core decision pipeline shared by UDP+TCP. Pure enough for tests. */
  async function handlePacket(
    wire: Uint8Array,
    sourceIp: string,
    transport: Transport,
    profileOverride?: string,
  ): Promise<Uint8Array | null> {
    // 1. Source-IP auth — unknown source: REFUSED (default) or silent drop.
    //    DoT passes a profile resolved from the SNI hostname instead.
    //    QueryLog events are NEVER emitted for unauthorized sources (privacy).
    const profileId = profileOverride ?? deps.store.authorizeSourceIp(sourceIp);
    if (!profileId) {
      deps.recorder?.recordDrop("unauthorized_source");
      if ((process.env.UDP_UNKNOWN_SOURCE ?? "refused") === "refused") {
        try {
          return refusedResponse(decodeQuestion(wire));
        } catch {
          return null; // unparseable packet stays silent even in refused mode
        }
      }
      return null;
    }

    // 2. Parse question — broken packet also gets silence
    let question;
    try {
      question = decodeQuestion(wire);
    } catch {
      return null;
    }

    // 3. Resolver-presence canary. The random hostname has no public record;
    //    only clients using this resolver reach this point. Record it and
    //    answer NXDOMAIN so no wildcard certificate is needed.
    const probeNonce = matchProbeNonce(question.name, deps.probeDomain ?? null);
    if (probeNonce) {
      deps.onProbeSeen?.(probeNonce, transport);
      return nxdomainResponse(question);
    }

    // 4. Zone override (split-horizon; user config wins, AAA/CNAME/etc.)
    const zone = deps.store.resolveZone(profileId, question.name, question.type as never);
    if (zone) {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "override",
        rttMs: null,
        clientIp: sourceIp,
        device: null,
        reason: "zone",
        transport,
      });
      deps.recorder?.recordQuery("forward");
      try {
        return zoneAnswer(question, zone);
      } catch {
        return servfailResponse(question);
      }
    }

    // 4b. Local name exists but not for this type: local NODATA.
    if (deps.store.hasZoneName(profileId, question.name)) {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "override",
        rttMs: null,
        clientIp: sourceIp,
        device: null,
        reason: "zone",
        transport,
      });
      deps.recorder?.recordQuery("forward");
      return noDataResponse(question);
    }

    // 4. Blocklist (explicit rules first, then remote subscriptions w/ @@ allow precedence)
    //    Explicit ALLOW must also short-circuit remote blocks — parity with DoH.
    const explicit = deps.store.resolve(profileId, question.name);
    if (explicit === "block") {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "block",
        rttMs: null,
        clientIp: sourceIp,
        device: null,
        reason: "manual",
        transport,
      });
      deps.recorder?.recordQuery("block");
      return blockedResponse(question, deps.store.blockAnswer(profileId));
    }

    // SafeSearch rewrites: CNAME the search host to the provider's safe endpoint.
    const safeTarget = safeSearchTarget(deps.store.safeSearchSettings(profileId), question.name);
    if (safeTarget) {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "override",
        rttMs: null,
        clientIp: sourceIp,
        device: null,
        reason: "safesearch",
        transport,
      });
      deps.recorder?.recordQuery("forward");
      return cnameResponse(question, safeTarget);
    }

    const remote = explicit ? undefined : deps.store.resolveRemoteDetailed(profileId, question.name);
    if (remote?.action === "block") {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "block",
        rttMs: null,
        clientIp: sourceIp,
        device: null,
        reason: "blocklist",
        listId: remote.listId,
        transport,
      });
      deps.recorder?.recordQuery("block");
      return blockedResponse(question, deps.store.blockAnswer(profileId));
    }

    // 5. Synthetic local names (nip.io-style, scoped to .lan/.home.arpa)
    const local = localNameAnswer(wire, {
      localDomains: deps.localDomains ?? ["lan"],
      localTtl: deps.localTtl ?? 60,
      allowPublicIpEncoding: deps.allowPublicIpEncoding === true,
    });
    if (local) {
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "override",
        rttMs: null,
        clientIp: sourceIp,
        device: null,
        reason: "zone",
        transport,
      });
      deps.recorder?.recordQuery("forward");
      return local;
    }

    // 6. Cache (keyed by question + upstream)
    const upstreamUrl = deps.store.profileUpstream(profileId) ?? undefined;
    const upstream = deps.store.profileUpstreamLabel(profileId);
    const cached = deps.dnsCache.get(wire, upstreamUrl, () => refresh(wire, upstreamUrl));
    if (cached) {
      deps.recorder?.recordCacheHit(transport);
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "forward",
        rttMs: null,
        clientIp: sourceIp,
        device: null,
        transport,
        upstream,
      });
      deps.recorder?.recordQuery("forward");
      return cached;
    }

    // 6. Forward upstream (per-profile choice)
    deps.recorder?.recordCacheMiss(transport);
    try {
      const { wire: responseWire, rttMs } = await deps.upstream.resolveWire(
        wire,
        upstreamUrl,
      );
      deps.dnsCache.set(wire, responseWire, upstreamUrl);
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "forward",
        rttMs,
        clientIp: sourceIp,
        device: null,
        transport,
        upstream,
      });
      deps.recorder?.recordQuery("forward");
      deps.recorder?.recordRtt(rttMs);
      return responseWire;
    } catch (err) {
      log.warn({ err, domain: question.name }, "upstream failed over UDP client");
      deps.logQuery({
        profileId,
        domain: question.name,
        action: "forward",
        rttMs: null,
        clientIp: sourceIp,
        device: null,
        transport,
        upstream,
      });
      deps.recorder?.recordQuery("forward");
      return servfailResponse(question);
    }
  }
}


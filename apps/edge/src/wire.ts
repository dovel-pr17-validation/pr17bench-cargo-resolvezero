import {
  AUTHORITATIVE_ANSWER,
  RECURSION_AVAILABLE,
  RECURSION_DESIRED,
  decode,
  encode,
  TRUNCATED_RESPONSE,
  type Question } from "dns-packet";
import type { ZoneAnswer } from "./ruleStore";

export const RESPONSE = 0x8000; // QR header bit (dns-packet exposes named flags only)
export const SINKHOLE_TTL = 300; // 5 min is plenty for filtering churn
/** CNAME rewrites (SafeSearch) are stable, so they can live a little longer. */
export const SAFE_SEARCH_TTL = 600;

/** How a profile's blocked answers are shaped. */
export type BlockMode = "null" | "nxdomain" | "refused" | "custom";

export interface BlockAnswer {
  mode: BlockMode;
  ipv4: string | null;
  ipv6: string | null;
  ttl: number;
}

export const DEFAULT_BLOCK_ANSWER: BlockAnswer = {
  mode: "null",
  ipv4: null,
  ipv6: null,
  ttl: SINKHOLE_TTL,
};

export interface QuestionInfo {
  id: number;
  name: string;
  type: string;
}

/** Parses the wire query's question history; canonicalizes name. */
export function decodeQuestion(wire: Uint8Array): QuestionInfo {
  const packet = decode(Buffer.from(wire));
  const q = packet.questions![0] as Question | undefined;
  if (!q) throw new Error("no question section");
  return {
    id: wire[0]! << 8 | wire[1]!,
    // lowercase + strip FQDN root dot so policy matching is canonical
    name: String(q.name).toLowerCase().replace(/\.+$/, ""),
    type: String(q.type),
  };
}

/**
 * Sinkhole (blocked): A → 0.0.0.0 (or a custom address), AAAA → ::, other
 * qtypes → empty NOERROR.
 */
export function sinkholeResponse(
  question: QuestionInfo,
  opts?: { ttl?: number; ipv4?: string | null; ipv6?: string | null },
): WireBytes {
  const ttl = opts?.ttl ?? SINKHOLE_TTL;
  const ipv4 = opts?.ipv4 ?? "0.0.0.0";
  const ipv6 = opts?.ipv6 ?? "::";
  const answers =
    question.type === "A"
      ? [{ name: question.name, type: "A" as const, class: "IN" as const, ttl, data: ipv4 }]
      : question.type === "AAAA"
        ? [{ name: question.name, type: "AAAA" as const, class: "IN" as const, ttl, data: ipv6 }]
        : [];

  return wireEncode({
    id: question.id,
    type: "response",
    flags: RESPONSE | AUTHORITATIVE_ANSWER | RECURSION_DESIRED | RECURSION_AVAILABLE,
    questions: [{ name: question.name, type: question.type }],
    answers,
  });
}

/**
 * Blocked answer in the profile's configured shape. `null` keeps the classic
 * sinkhole, `nxdomain` makes clients fail fast, `refused` is explicit policy,
 * and `custom` points at an address the operator controls (block page).
 */
export function blockedResponse(question: QuestionInfo, answer: BlockAnswer): WireBytes {
  switch (answer.mode) {
    case "nxdomain":
      return nxdomainResponse(question);
    case "refused":
      return refusedResponse(question);
    case "custom":
      return sinkholeResponse(question, { ttl: answer.ttl, ipv4: answer.ipv4 ?? "0.0.0.0", ipv6: answer.ipv6 ?? "::" });
    default:
      return sinkholeResponse(question, { ttl: answer.ttl });
  }
}

/** CNAME rewrite (SafeSearch): answer the query with a canonical target. */
export function cnameResponse(question: QuestionInfo, target: string, ttl = SAFE_SEARCH_TTL): WireBytes {
  return wireEncode({
    id: question.id,
    type: "response",
    flags: RESPONSE | AUTHORITATIVE_ANSWER | RECURSION_DESIRED | RECURSION_AVAILABLE,
    questions: [{ name: question.name, type: question.type }],
    answers: [{ name: question.name, type: "CNAME" as const, class: "IN" as const, ttl, data: target }],
  });
}

export interface WirePacket {
  id: number;
  type: string;
  flags: number;
  questions: unknown;
  answers: unknown;
}

/** Wire-format byte width we hand to/in from helpers — TS>=5.7 generics need
 *  an explicit ArrayBuffer backing to satisfy BodyInit-style overloads. */
export type WireBytes = Uint8Array<ArrayBuffer>;

export function wireEncode(packet: object): WireBytes {
  const raw = encode(packet as never);
  const out = new ArrayBuffer(raw.length);
  new Uint8Array(out).set(raw);
  return new Uint8Array(out);
}

/** NXDOMAIN: used for the resolver-presence canary (and other absent names). */
export function nxdomainResponse(question: QuestionInfo): WireBytes {
  return wireEncode({
    id: question.id,
    type: "response",
    flags: RESPONSE | AUTHORITATIVE_ANSWER | RECURSION_DESIRED | RECURSION_AVAILABLE | 0x0003,
    questions: [{ name: question.name, type: question.type }],
  });
}

/** NODATA: the local name exists, but not for this record type. */
export function noDataResponse(question: QuestionInfo): WireBytes {
  return wireEncode({
    id: question.id,
    type: "response",
    flags: RESPONSE | AUTHORITATIVE_ANSWER | RECURSION_DESIRED | RECURSION_AVAILABLE,
    questions: [{ name: question.name, type: question.type }],
  });
}

/** SERVFAIL: upstream unavailable — the client stub resolver will retry. */
export function servfailResponse(question: QuestionInfo): WireBytes {
  return wireEncode({
    id: question.id,
    type: "response",
    // RCODE 2 = SERVFAIL
    flags: RESPONSE | RECURSION_DESIRED | RECURSION_AVAILABLE | 0x0002,
    questions: [{ name: question.name, type: question.type }],
  });
}

/** REFUSED (RCODE 5): unauthorized source — standard "not serving you"; debuggable. */
export function refusedResponse(question: QuestionInfo): WireBytes {
  return wireEncode({
    id: question.id,
    type: "response",
    flags: RESPONSE | RECURSION_DESIRED | RECURSION_AVAILABLE | 0x0005,
    questions: [{ name: question.name, type: question.type }],
  });
}

/** Truncated-cue response (UDP > ~1232 bytes): TC set, client retries via TCP. */
export function truncatedResponse(question: QuestionInfo): WireBytes {
  return wireEncode({
    id: question.id,
    type: "response",
    flags: RESPONSE | TRUNCATED_RESPONSE | RECURSION_DESIRED | RECURSION_AVAILABLE,
    questions: [{ name: question.name, type: question.type }],
  });
}

/** Builds a wire answer from a local zone record (A/AAAA/CNAME/TXT). */
export function zoneAnswer(
  question: QuestionInfo,
  zone: ZoneAnswer,
): WireBytes {
  const answers = zone.values.map((value) => {
    const base = { name: question.name, class: "IN" as const, ttl: zone.ttl };
    switch (zone.recordType) {
      case "A": return { ...base, type: "A" as const, data: value };
      case "AAAA": return { ...base, type: "AAAA" as const, data: value };
      case "CNAME": return { ...base, type: "CNAME" as const, data: value };
      case "TXT": return { ...base, type: "TXT" as const, data: [value] };
    }
  });

  return wireEncode({
    id: question.id,
    type: "response",
    // AA bit: the profile zone is authoritative for its overrides
    flags: RESPONSE | AUTHORITATIVE_ANSWER | RECURSION_DESIRED | RECURSION_AVAILABLE,
    questions: [{ name: question.name, type: question.type }],
    answers,
  });
}

/** "::ffff:9.9.9.9" → "9.9.9.9"; strips v6-mapped+zone and trims brackets. */
export function normalizeIp(addr: string): string {
  const stripped = addr.replace(/^\[|\]$/g, "").split("%")[0];
  return stripped.startsWith("::ffff:") ? stripped.slice("::ffff:".length) : stripped;
}

/** Max payload we answer over UDP before flipping the TC bit (DNS-safe size). */
export const UDP_MAX_PAYLOAD = 1232;

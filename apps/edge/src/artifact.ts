import { createHash } from "node:crypto";

/**
 * Content-addressed rule artifact (shared with the Rust compiler).
 *
 * Header (little-endian):
 *   0  4  magic "RZA1"
 *   4  1  version
 *   5  1  flags (bit0 = allow table present)
 *   6  2  header bytes (24)
 *   8  4  allow count
 *  12  4  block count
 *  16  4  total rules
 *  20  4  reserved
 *  24 …  allow u64s, sorted ascending, then block u64s
 *
 * The file bytes are deterministic for the same rule set, so the id is
 * `sha256(file)`. Fingerprints are xxhash64 seed 0 in both runtimes.
 */
export const ARTIFACT_MAGIC = 0x31415a52;
export const ARTIFACT_VERSION = 1;
export const ARTIFACT_HEADER_BYTES = 24;

export interface ArtifactTables {
  allow: BigUint64Array;
  block: BigUint64Array;
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

export function encodeArtifact({ allow, block }: ArtifactTables): Uint8Array {
  if (!LITTLE_ENDIAN) throw new Error("artifact encoding assumes a little-endian host");
  const total = allow.length + block.length;
  const bytes = new Uint8Array(ARTIFACT_HEADER_BYTES + total * 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, ARTIFACT_MAGIC, true);
  bytes[4] = ARTIFACT_VERSION;
  bytes[5] = allow.length > 0 ? 1 : 0;
  view.setUint16(6, ARTIFACT_HEADER_BYTES, true);
  view.setUint32(8, allow.length, true);
  view.setUint32(12, block.length, true);
  view.setUint32(16, total, true);
  view.setUint32(20, 0, true);

  const payload = bytes.subarray(ARTIFACT_HEADER_BYTES);
  const payloadWords = new BigUint64Array(payload.buffer, payload.byteOffset, total);
  payloadWords.set(allow, 0);
  payloadWords.set(block, allow.length);
  return bytes;
}

export function decodeArtifact(bytes: Uint8Array): ArtifactTables {
  if (!LITTLE_ENDIAN) throw new Error("artifact decoding assumes a little-endian host");
  if (bytes.length < ARTIFACT_HEADER_BYTES) throw new Error("artifact shorter than header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== ARTIFACT_MAGIC) throw new Error("bad artifact magic");
  if (bytes[4] !== ARTIFACT_VERSION) throw new Error(`unsupported artifact version ${bytes[4]}`);
  const headerBytes = view.getUint16(6, true);
  if (headerBytes !== ARTIFACT_HEADER_BYTES) throw new Error(`unexpected header size ${headerBytes}`);
  const allowCount = view.getUint32(8, true);
  const blockCount = view.getUint32(12, true);
  const total = allowCount + blockCount;
  if (bytes.length !== headerBytes + total * 8) {
    throw new Error("artifact length does not match header");
  }
  // Copy once so the typed array starts at an 8-byte-aligned offset.
  const payload = new Uint8Array(total * 8);
  payload.set(bytes.subarray(headerBytes));
  const words = new BigUint64Array(payload.buffer);
  return {
    allow: words.subarray(0, allowCount),
    block: words.subarray(allowCount),
  };
}

export function artifactId(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isArtifact(bytes: Uint8Array): boolean {
  return (
    bytes.length >= ARTIFACT_HEADER_BYTES &&
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) === ARTIFACT_MAGIC
  );
}

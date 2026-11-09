import { describe, expect, test } from "vitest";

import {
  ARTIFACT_HEADER_BYTES,
  ARTIFACT_MAGIC,
  artifactId,
  decodeArtifact,
  encodeArtifact,
} from "./artifact";

// Produced by `rz-compile` (Rust) from "ads.example\ntracker.example\n".
// Keeping the exact bytes here pins cross-runtime hash/format parity.
const FIXTURE = Buffer.from(
  "525a413101001800000000000200000002000000000000007ef291794e62555e6715fcebabd47d62",
  "hex",
);

describe("artifact", () => {
  test("encodes exactly what the Rust compiler produced", () => {
    const bytes = encodeArtifact({
      allow: new BigUint64Array(0),
      block: new BigUint64Array([0x5e55624e7991f27en, 0x627dd4abebfc1567n]),
    });
    expect(Buffer.from(bytes).toString("hex")).toBe(FIXTURE.toString("hex"));
    expect(bytes.length).toBe(ARTIFACT_HEADER_BYTES + 2 * 8);
  });

  test("powers match the Rust runtime", () => {
    const view = new DataView(FIXTURE.buffer, FIXTURE.byteOffset, FIXTURE.byteLength);
    expect(view.getUint32(0, true)).toBe(ARTIFACT_MAGIC);
    expect(FIXTURE[4]).toBe(1);
    expect(view.getUint32(8, true)).toBe(0);
    expect(view.getUint32(12, true)).toBe(2);
    expect(view.getUint32(16, true)).toBe(2);
  });

  test("roundtrips allow + block arrays", () => {
    const allow = new BigUint64Array([1n, 2n, 3n]);
    const block = new BigUint64Array([0xffffffffffffffffn]);
    const decoded = decodeArtifact(encodeArtifact({ allow, block }));
    expect([...decoded.allow]).toEqual([1n, 2n, 3n]);
    expect([...decoded.block]).toEqual([0xffffffffffffffffn]);
  });

  test("ids are stable and content addressed", () => {
    const bytes = encodeArtifact({ allow: new BigUint64Array([]), block: new BigUint64Array([7n]) });
    expect(artifactId(bytes)).toBe(artifactId(new Uint8Array(bytes)));
    expect(artifactId(bytes)).toHaveLength(64);
  });

  test("rejects malformed artifacts", () => {
    expect(() => decodeArtifact(new Uint8Array(10))).toThrow();
    const badMagic = new Uint8Array(encodeArtifact({ allow: new BigUint64Array([]), block: new BigUint64Array([]) }));
    badMagic[0] = 0;
    expect(() => decodeArtifact(badMagic)).toThrow(/magic/);
  });
});

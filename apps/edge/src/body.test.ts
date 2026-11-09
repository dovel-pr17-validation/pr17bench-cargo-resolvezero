import { describe, expect, test } from "vitest";
import { readBytesBounded, readTextBounded } from "./body";

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("readBytesBounded", () => {
  test("reads a body under the cap", async () => {
    const body = await readBytesBounded(streamOf(new Uint8Array([1, 2]), new Uint8Array([3])), 10);
    expect([...body]).toEqual([1, 2, 3]);
  });

  test("rejects an oversized declared length before reading", async () => {
    await expect(readBytesBounded(streamOf(new Uint8Array([1])), 10, 11)).rejects.toThrow(/too large/);
  });

  test("rejects a stream that crosses the cap", async () => {
    await expect(readBytesBounded(streamOf(new Uint8Array(8), new Uint8Array(8)), 10)).rejects.toThrow(/too large/);
  });

  test("reads text with the same cap", async () => {
    expect(await readTextBounded(streamOf(new TextEncoder().encode("hello")), 10)).toBe("hello");
  });
});

import { describe, expect, test } from "vitest";
import { encode } from "dns-packet";
import { validateUpstreamResponse } from "./upstream";

function query(name = "example.com", id = 0x1234): Uint8Array {
  return new Uint8Array(
    encode({
      id,
      type: "query",
      flags: 0x0100,
      questions: [{ name, type: "A", class: "IN" }],
    } as never),
  );
}

function response(name = "example.com", id = 0x1234, flags = 0x8180): Uint8Array {
  return new Uint8Array(
    encode({
      id,
      type: "response",
      flags,
      questions: [{ name, type: "A", class: "IN" }],
      answers: [{ name, type: "A", class: "IN", ttl: 60, data: "192.0.2.1" }],
    } as never),
  );
}

describe("validateUpstreamResponse", () => {
  test("accepts a matching response", () => {
    expect(() => validateUpstreamResponse(query(), response())).not.toThrow();
  });

  test("rejects an ID mismatch", () => {
    expect(() => validateUpstreamResponse(query(), response("example.com", 0x9999))).toThrow(/ID mismatch/);
  });

  test("rejects a question mismatch", () => {
    expect(() => validateUpstreamResponse(query("example.com"), response("evil.example"))).toThrow(
      /question mismatch/,
    );
  });

  test("rejects a query-shaped packet (no QR bit)", () => {
    expect(() => validateUpstreamResponse(query(), query())).toThrow(/QR bit/);
  });
});

import { describe, expect, test, vi } from "vitest";
import { decode, encode } from "dns-packet";
import type { AgentConfig } from "../src/config";
import { deviceSlug, parseDeviceMap } from "../src/config";
import { resolveDoh } from "../src/doh";

function config(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    profileId: "profile-id",
    token: "secret-token",
    dohUrl: "https://edge.example",
    bindHost: "127.0.0.1",
    dnsPort: 0,
    timeoutMs: 5_000,
    healthPort: 0,
    healthHost: "127.0.0.1",
    devices: new Map([["192.168.1.20", "MacBook Pro"]]),
    ...overrides,
  };
}

function query(): Uint8Array {
  return new Uint8Array(
    encode({
      id: 0x1234,
      type: "query",
      flags: 0x0100,
      questions: [{ name: "example.com", type: "A", class: "IN" }],
    } as never),
  );
}

describe("agent configuration", () => {
  test("parses device maps from comma/newline/semicolon forms", () => {
    const map = parseDeviceMap("192.168.1.20=macbook, 192.168.1.21=iphone\n192.168.1.22=tv");
    expect(map.get("192.168.1.20")).toBe("macbook");
    expect(map.get("192.168.1.21")).toBe("iphone");
    expect(map.get("192.168.1.22")).toBe("tv");
    expect(map.size).toBe(3);
  });

  test("sanitizes device labels and falls back to the IP", () => {
    expect(deviceSlug("192.168.1.20", "MacBook Pro")).toBe("macbook-pro");
    expect(deviceSlug("192.168.1.20")).toBe("ip-192-168-1-20");
    expect(deviceSlug("192.168.1.20", "!!!")).toMatch(/^ip-/);
  });
});

describe("resolveDoh", () => {
  test("posts wire query to the device-tagged edge path", async () => {
    const response = new Uint8Array(
      encode({
        id: 0x1234,
        type: "response",
        flags: 0x8180,
        questions: [{ name: "example.com", type: "A", class: "IN" }],
      } as never),
    );
    const fetchMock = vi.fn(async () => new Response(response, { status: 200 }));

    const out = await resolveDoh(config(), query(), "192.168.1.20", fetchMock as typeof fetch);

    expect(out).toEqual(response);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://edge.example/v1/profile-id/macbook-pro/secret-token");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({ "content-type": "application/dns-message" });
  });

  test("rejects an HTTP error", async () => {
    const fetchMock = vi.fn(async () => new Response("no", { status: 502 }));
    await expect(resolveDoh(config(), query(), "192.168.1.20", fetchMock as typeof fetch)).rejects.toThrow(/502/);
  });
});

describe("returned response", () => {
  test("is a valid DNS packet with the original id", () => {
    const response = new Uint8Array(
      encode({
        id: 0x1234,
        type: "response",
        flags: 0x8180,
        questions: [{ name: "example.com", type: "A", class: "IN" }],
      } as never),
    );
    expect(decode(Buffer.from(response)).id).toBe(0x1234);
  });
});

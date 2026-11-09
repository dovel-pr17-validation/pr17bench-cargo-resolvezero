import { describe, expect, test } from "vitest";
import dgram from "node:dgram";
import net from "node:net";
import { decode, encode } from "dns-packet";

import type { AgentConfig } from "../src/config";
import { startAgent } from "../src/server";

function query(name = "example.com"): Uint8Array {
  return new Uint8Array(
    encode({
      id: 0x4242,
      type: "query",
      flags: 0x0100,
      questions: [{ name, type: "A", class: "IN" }],
    } as never),
  );
}

function answer(name: string): Uint8Array {
  return new Uint8Array(
    encode({
      id: 0x4242,
      type: "response",
      flags: 0x8180,
      questions: [{ name, type: "A", class: "IN" }],
      answers: [{ name, type: "A", class: "IN", ttl: 60, data: "1.2.3.4" }],
    } as never),
  );
}

const config: AgentConfig = {
  profileId: "profile-id",
  token: "secret-token",
  dohUrl: "https://edge.example",
  bindHost: "127.0.0.1",
  dnsPort: 0,
  timeoutMs: 5_000,
  healthPort: 0,
  healthHost: "127.0.0.1",
  devices: new Map(),
};

function udpQuery(port: number, wire: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error("udp timeout"));
    }, 2_000);
    socket.once("message", (msg) => {
      clearTimeout(timer);
      socket.close();
      resolve(new Uint8Array(msg));
    });
    socket.send(wire, port, "127.0.0.1");
  });
}

function tcpQuery(port: number, wire: Uint8Array): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("tcp timeout"));
    }, 2_000);
    socket.on("connect", () => {
      const frame = Buffer.alloc(wire.length + 2);
      frame.writeUInt16BE(wire.length, 0);
      frame.set(wire, 2);
      socket.write(frame);
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 2) return;
      const len = buffer.readUInt16BE(0);
      if (buffer.length < len + 2) return;
      clearTimeout(timer);
      socket.end();
      resolve(new Uint8Array(buffer.subarray(2, len + 2)));
    });
    socket.on("error", reject);
  });
}

describe("agent listeners", () => {
  test("serves UDP and TCP through the injected resolver", async () => {
    const seen: string[] = [];
    const agent = await startAgent(config, async (wire, sourceIp) => {
      seen.push(sourceIp);
      return answer("example.com");
    });

    try {
      const udp = await udpQuery(agent.udpPort, query());
      expect(decode(Buffer.from(udp)).id).toBe(0x4242);
      expect((decode(Buffer.from(udp)).answers?.[0] as { data?: string }).data).toBe("1.2.3.4");

      const tcp = await tcpQuery(agent.tcpPort, query());
      expect(decode(Buffer.from(tcp)).id).toBe(0x4242);
      expect((decode(Buffer.from(tcp)).answers?.[0] as { data?: string }).data).toBe("1.2.3.4");
      expect(seen.length).toBe(2);
      expect(seen[0]).toBeTruthy();
    } finally {
      await agent.close();
    }
  });

  test("returns SERVFAIL when the resolver throws", async () => {
    const agent = await startAgent(config, async () => {
      throw new Error("edge down");
    });
    try {
      const reply = await udpQuery(agent.udpPort, query());
      const packet = decode(Buffer.from(reply));
      expect((packet.flags ?? 0) & 0xf).toBe(2);
    } finally {
      await agent.close();
    }
  });
});

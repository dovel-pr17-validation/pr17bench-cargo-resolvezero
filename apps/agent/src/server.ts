import dgram from "node:dgram";
import http from "node:http";
import net from "node:net";

import type { AgentConfig } from "./config";
import { maxUdpPayload, sameTransactionId, servfailResponse, truncatedResponse } from "./dns";
import { resolveDoh } from "./doh";

export type Resolver = (query: Uint8Array, sourceIp: string) => Promise<Uint8Array>;

export interface AgentHandle {
  udpPort: number;
  tcpPort: number;
  close(): Promise<void>;
}

function log(level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));
}

function normalizeIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

export async function startAgent(
  config: AgentConfig,
  resolver: Resolver = (query, sourceIp) => resolveDoh(config, query, sourceIp),
): Promise<AgentHandle> {
  const udp = dgram.createSocket("udp4");
  await bindUdp(udp, config.bindHost, config.dnsPort);

  udp.on("error", (err) => log("error", "UDP socket error", { err: err.message }));
  udp.on("message", (data, rinfo) => {
    const wire = new Uint8Array(data);
    const sourceIp = normalizeIp(rinfo.address);
    void handleQuery(wire, sourceIp)
      .then((reply) => {
        if (!reply) return;
        const max = maxUdpPayload(wire);
        const out = reply.length > max ? (truncatedResponse(wire) ?? reply) : reply;
        udp.send(out, rinfo.port, rinfo.address, (err) => {
          if (err) log("warn", "UDP send failed", { err: err.message });
        });
      })
      .catch((err) => log("error", "UDP handler failed", { err: err instanceof Error ? err.message : String(err) }));
  });

  const tcp = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    const sourceIp = normalizeIp(socket.remoteAddress ?? "");

    socket.on("error", (err) => log("warn", "TCP socket error", { err: err.message }));
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 2) {
        const len = buffer.readUInt16BE(0);
        if (buffer.length < len + 2) return;
        const wire = new Uint8Array(buffer.subarray(2, len + 2));
        buffer = buffer.subarray(len + 2);
        void handleQuery(wire, sourceIp)
          .then((reply) => {
            if (!reply) return;
            const frame = Buffer.alloc(reply.length + 2);
            frame.writeUInt16BE(reply.length, 0);
            frame.set(reply, 2);
            socket.write(frame);
          })
          .catch((err) => log("error", "TCP handler failed", { err: err instanceof Error ? err.message : String(err) }));
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    tcp.once("error", reject);
    tcp.listen(config.dnsPort, config.bindHost, () => {
      tcp.off("error", reject);
      resolve();
    });
  });
  tcp.on("error", (err) => log("warn", "TCP listener error", { err: err.message }));

  const udpPort = udp.address().port;
  const tcpPort = (tcp.address() as net.AddressInfo).port;
  let health: http.Server | undefined;

  if (config.healthPort > 0) {
    health = http.createServer((req, res) => {
      if (req.url === "/healthz" || req.url === "/readyz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, profileId: config.profileId, dohUrl: config.dohUrl }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve, reject) => {
      health!.once("error", reject);
      health!.listen(config.healthPort, config.healthHost, () => {
        health!.off("error", reject);
        resolve();
      });
    });
  }

  log("info", "agent listening", {
    udpPort,
    tcpPort,
    healthPort: config.healthPort || null,
    profileId: config.profileId,
    dohUrl: config.dohUrl,
    devices: config.devices.size,
  });

  return {
    udpPort,
    tcpPort,
    async close() {
      await new Promise<void>((resolve) => udp.close(() => resolve()));
      await new Promise<void>((resolve) => {
        tcp.close(() => resolve());
        (tcp as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      });
      if (health) {
        await new Promise<void>((resolve) => health!.close(() => resolve()));
      }
    },
  };

  async function handleQuery(wire: Uint8Array, sourceIp: string): Promise<Uint8Array | null> {
    if (wire.length < 12) return null;
    try {
      const response = await resolver(wire, sourceIp);
      if (!sameTransactionId(wire, response)) {
        log("warn", "upstream transaction ID mismatch", { sourceIp });
        return servfailResponse(wire);
      }
      return response;
    } catch (err) {
      log("warn", "upstream resolution failed", {
        sourceIp,
        err: err instanceof Error ? err.message : String(err),
      });
      return servfailResponse(wire);
    }
  }
}

async function bindUdp(socket: dgram.Socket, host: string, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    socket.once("error", onError);
    socket.bind({ address: host, port }, () => {
      socket.off("error", onError);
      resolve();
    });
  });
}

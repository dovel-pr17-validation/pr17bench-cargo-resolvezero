/**
 * Quick Node-vs-Bun edge comparison. Read-only apart from normal query logs.
 *
 *   node --env-file=.env --import tsx apps/edge/scripts/bench-node-vs-bun.ts
 */
import dgram from "node:dgram";
import net from "node:net";
import { encode, decode } from "dns-packet";
import { db } from "@resolvezero/db/client";
import { profiles } from "@resolvezero/db/schema";

const PROD_IP = process.env.PROD_IP ?? "37.16.24.46";
const NODE_IP = process.env.NODE_IP ?? "213.188.210.31";
const PROD_DOH = process.env.PROD_DOH ?? "https://resolvezero-edge.fly.dev";
const NODE_DOH = process.env.NODE_DOH ?? "https://resolvezero-edge-staging.fly.dev";

const N_CACHED = Number(process.env.N_CACHED ?? 200);
const N_UPSTREAM = Number(process.env.N_UPSTREAM ?? 50);

function wire(name: string, id: number): Uint8Array {
  return new Uint8Array(
    encode({
      id,
      type: "query",
      flags: 0x0100,
      questions: [{ name, type: "A", class: "IN" }],
    } as never),
  );
}

function stats(label: string, values: number[]): void {
  const sorted = [...values].sort((a, b) => a - b);
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
  const avg = sorted.reduce((a, b) => a + b, 0) / Math.max(sorted.length, 1);
  console.log(
    `${label.padEnd(24)} n=${String(sorted.length).padStart(3)}  p50=${pct(50).toFixed(1)}ms  p95=${pct(95).toFixed(1)}ms  avg=${avg.toFixed(1)}ms`,
  );
}

async function udpBench(ip: string, label: string, names: () => string, n: number): Promise<void> {
  const sock = dgram.createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    sock.once("error", reject);
    sock.connect(53, ip, () => resolve());
  });
  const lat: number[] = [];
  for (let i = 0; i < n; i++) {
    const q = wire(names(), i + 1);
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        sock.off("message", onMessage);
        reject(new Error("timeout"));
      }, 1500);
      const onMessage = () => {
        clearTimeout(timer);
        sock.off("message", onMessage);
        resolve();
      };
      sock.on("message", onMessage);
      sock.send(q);
    });
    lat.push(performance.now() - started);
  }
  sock.close();
  stats(label, lat);
}

async function tcpBench(ip: string, label: string, name: string, n: number): Promise<void> {
  const lat: number[] = [];
  for (let i = 0; i < n; i++) {
    const q = wire(name, i + 1);
    const started = performance.now();
    await new Promise<void>((resolve, reject) => {
      const sock = net.connect({ host: ip, port: 53 });
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error("timeout"));
      }, 1500);
      sock.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      sock.on("connect", () => {
        const len = Buffer.alloc(2);
        len.writeUInt16BE(q.length);
        sock.write(Buffer.concat([len, Buffer.from(q)]));
      });
      sock.on("data", () => {
        clearTimeout(timer);
        sock.end();
        resolve();
      });
    });
    lat.push(performance.now() - started);
  }
  stats(label, lat);
}

async function dohBench(base: string, path: string, label: string, name: string, n: number): Promise<void> {
  const url = `${base}/v1/${path}`;
  const body = wire(name, 1);
  const call = () =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/dns-message", "fly-prefer-region": "fra" },
      body,
    });
  // Warm the connection / edge route.
  await (await call()).arrayBuffer();
  const lat: number[] = [];
  for (let i = 0; i < n; i++) {
    const started = performance.now();
    const res = await call();
    const buf = await res.arrayBuffer();
    if (res.status !== 200) throw new Error(`DoH ${res.status}`);
    decode(Buffer.from(buf)); // ensure it is a valid DNS response
    lat.push(performance.now() - started);
  }
  stats(label, lat);
}

const rows = await db
  .select({ id: profiles.id, token: profiles.dohToken })
  .from(profiles)
  .limit(20);
const profile = rows.find((p) => p.token) ?? rows[0];
if (!profile) throw new Error("no profile in DB");
const dohPath = `${encodeURIComponent(profile.id)}${profile.token ? `/${encodeURIComponent(profile.token)}` : ""}`;

console.log(`profile=${profile.id} cached=${N_CACHED} upstream=${N_UPSTREAM}`);
console.log("\n--- UDP 53 (cache hit path) ---");
await udpBench(PROD_IP, "Bun  (prod) udp cached", () => "example.com", N_CACHED);
await udpBench(NODE_IP, "Node (staging) udp cached", () => "example.com", N_CACHED);

console.log("\n--- UDP 53 (upstream miss / NXDOMAIN) ---");
let seq = 0;
const unique = () => `bench-${Date.now()}-${seq++}.example.com`;
await udpBench(PROD_IP, "Bun  (prod) udp upstream", unique, N_UPSTREAM);
await udpBench(NODE_IP, "Node (staging) udp upstream", unique, N_UPSTREAM);

console.log("\n--- TCP 53 (cache hit path, new connection) ---");
await tcpBench(PROD_IP, "Bun  (prod) tcp", "example.com", N_UPSTREAM);
await tcpBench(NODE_IP, "Node (staging) tcp", "example.com", N_UPSTREAM);

console.log("\n--- DoH (cache hit path, prefer fra) ---");
await dohBench(PROD_DOH, dohPath, "Bun  (prod) doh", "example.com", N_CACHED);
await dohBench(NODE_DOH, dohPath, "Node (staging) doh", "example.com", N_CACHED);

process.exit(0);

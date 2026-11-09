// no node_modules imports — /tmp files run with the image's nearest
// node_modules unavailable; DNS packet for our question shape is trivial.
const enc = new TextEncoder();
const q = encodeWire("self-probe.lan");
function encodeWire(name: string): Uint8Array {
  const id = (globalThis.crypto.getRandomValues(new Uint8Array(2)));
  const labels = name.split(".");
  let n = 12;
  for (const l of labels) n += 1 + l.length;
  const out = new Uint8Array(n + 4);
  out[0] = id[0]!; out[1] = id[1]!;
  out[2] = 0x01; out[3] = 0x00; // RD
  out[5] = 1;
  let ptr = 12;
  for (const l of labels) {
    out[ptr++] = l.length;
    out.set(enc.encode(l), ptr);
    ptr += l.length;
  }
  out[ptr++] = 0; out[ptr++] = 0; out[ptr++] = 1; out[ptr++] = 0; out[ptr++] = 1; // type A class IN
  return out;
}
import { readFileSync } from "node:fs";
import dgram from "node:dgram";
/**
 * Machine-local UDP-53 self-probe: answers "is MY dns53 socket bound and
 * serving on fly-global-services?" from inside the VM — exactly what you
 * want during an incident like the proxy-refused one on lhr (2026-10-13).
 *
 * Run on a machine:  fly ssh sftp shell ... (put this file to /tmp)
 *                    fly ssh console ... --machine <id> --command "bun /tmp/self-udp-probe.ts"
 * Exit 0 + "reply"  = listener is alive.
 * Exit 0 + no reply = listener dead/absent — send for fly logs.
 * Note: the reply is usually REFUSED (rcode 5) because the machine's own
 * source IP isn't whitelisted — refused STILL proves the listener works.
 *
 * CAVEAT (seen 2026-10-13): on LONG-LIVED machines the in-VM packet to
 * fly-global-services may never return a reply even while the listener is
 * perfectly healthy for real anycast traffic (external dig fine,
 * rz_queries_total climbing). Treat "no reply" as SUSPICIOUS, not proof of
 * an outage — cross-check external dig + per-machine rz counters before
 * declaring a socket dead. Freshly booted machines.reply reliably.
 */
const text = readFileSync("/etc/hosts", "utf8");
const line = text.split("\n").find((l) => l.includes("fly-global-services") && !l.startsWith("#"));
if (!line) {
  console.error("fly-global-services not found in /etc/hosts");
  process.exit(2);
}
const ip = line.trim().split(/\s+/)[0]!;
// built above via encodeWire()

const s = dgram.createSocket("udp4");
s.on("message", (d) => {
  const rcode = d[3]! % 16;
  const qr = (d[2]! & 0x80) !== 0;
  console.log(`reply from ${ip}: qr=${qr ? "1" : "0"} rcode=${rcode} (5=REFUSED expected — source not whitelisted, but listener is ALIVE)`);
  s.close();
  process.exit(0);
});
s.on("error", () => {
  console.error("socket error");
  process.exit(1);
});
s.bind(0, () => s.send(q, 53, ip));
await new Promise((resolve) => setTimeout(resolve, 3000));
console.log(`no reply from ${ip}:53 — dns53 listener NOT answering on this machine`);
process.exit(1);

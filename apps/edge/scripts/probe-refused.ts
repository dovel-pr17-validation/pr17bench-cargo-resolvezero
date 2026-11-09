// unauthorized-source probe: query our own UDP 53 from the machine itself
// (machine IP is not whitelisted → expect REFUSED, rcode 5)
const q = new Uint8Array([
  0, 7, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0,
  4, 112, 114, 111, 98, // "prob"
  1, 108, 2, 108, 110, // "l.ln" — name shape irrelevant for rcode test
  0, 0, 1, 0, 1,
]);
import dgram from "node:dgram";
const s = dgram.createSocket("udp4");
s.on("message", (d) => {
  console.log("reply bytes:", d.length, "rcode:", d[3]! & 15);
  s.close();
  process.exit(0);
});
s.on("error", (err) => {
  console.log("socket error", err.message);
  process.exit(1);
});
s.bind(0, () => s.send(q, 53, "fly-global-services"));
await new Promise((resolve) => setTimeout(resolve, 2000));
console.log("no reply");
process.exit(1);

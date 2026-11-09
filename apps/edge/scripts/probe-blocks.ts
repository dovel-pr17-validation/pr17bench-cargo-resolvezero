import { encode, decode } from "dns-packet";

/**
 * Usage:
 *   node --env-file=.env node_modules/tsx/dist/cli.mjs apps/edge/scripts/probe-blocks.ts
 *
 * Requires PROBE_PROFILE_ID and PROBE_DOH_TOKEN. Never commit real values.
 */
const P = process.env.PROBE_PROFILE_ID?.trim();
const TOKEN = process.env.PROBE_DOH_TOKEN?.trim();

if (!P || !TOKEN) {
  throw new Error("PROBE_PROFILE_ID and PROBE_DOH_TOKEN must be set (see .env.example)");
}

const probe = async (name: string) => {
  const q = encode({ id: 1, type: "query", flags: 0x0100, questions: [{ name, type: "A" }] });
  const dns = Buffer.from(q).toString("base64url");
  const res = await fetch(`https://resolvezero-edge.fly.dev/v1/${P}/${TOKEN}?dns=${dns}`);
  const body = new Uint8Array(await res.arrayBuffer());
  let info = `rcode=?`;
  try {
    const p: any = decode(Buffer.from(body));
    const rcode = p.flags & 15;
    const answers = (p.answers ?? []).map((a: any) => a.data).join(",");
    info = `rcode=${rcode} answers=${answers || "-"}`;
  } catch {}
  return `${name} → ${info}`;
};
console.log(await probe("ads.collector-github-clone.co"));  // blocked by hagezi/adguard-family sets
console.log(await probe("0--0.winluckycloud.buzz"));        // hagezi scam NXDOMAIN
console.log(await probe("github.com"));                     // MUST forward (regression probe)
console.log(await probe("gitlab.com"));                     // MUST forward
console.log(await probe("ad.doubleclick.net"));             // manual rule → 0.0.0.0
process.exit(0);

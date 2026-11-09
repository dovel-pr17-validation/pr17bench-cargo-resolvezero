// Simulates the prod boot path on the REAL AdGuard list: parse + build +
// seal, measuring RSS peak (the OOM scenario on 256MB VMs).
import { fetchListText, parseList } from "../src/blocklists";
import { SuffixFingerprintBuilder } from "../src/fingerprint";

const url = "https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt";
const rss = () => (process.memoryUsage.rss() / 1024 / 1024).toFixed(0);
console.log("rss before:", rss(), "MB");
const text = await fetchListText(url);
console.log("rss after fetch:", rss(), "MB (text", (text.length / 1024 / 1024).toFixed(1), "MB)");
const parsed = parseList(text, "abp");
console.log("rss after parse:", rss(), "MB", "blocks:", parsed.blocks.size, "allows:", parsed.allows.size);
const builder = new SuffixFingerprintBuilder();
for (const d of parsed.blocks) builder.add(d, "block");
for (const d of parsed.allows) builder.add(d, "allow");
const table = builder.seal(parsed.blocks.size + parsed.allows.size);
console.log("rss after build+seal:", rss(), "MB, entries:", table.entryCount);
// sanity probes
console.log("probe doubleclick:", table.resolve("ad.doubleclick.net"), "github:", table.resolve("github.com"));
process.exit(0);

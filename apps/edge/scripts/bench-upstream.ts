/**
 * Upstream transport benchmark (readme §2): DoH-h1 vs DoH-h2 vs UDP 53 vs
 * TCP 53, per provider. Run as a real file (never `bun -e` — Bun.udpSocket
 * hangs in eval mode) on fra/lhr Fly machines for the decision-relevant
 * vantage, plus locally for the ratio sanity check.
 *
 * Method per cell:
 *   - 30 warm-up queries (excluded) + N measured (default 300)
 *   - warm mode: one session reused for all queries (prod steady-state)
 *   - cold mode: fresh transport per query (post-restart burst realism)
 *   - one query in flight at a time; response matched by transaction id;
 *     2s deadline counts as error (client stub owns retransmission)
 *
 * Fully injectable (BenchRuntime factories) for unit tests without network.
 */

import { encode, decode, type Packet } from "dns-packet";
import http2 from "node:http2";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Providers / matrix ----

export interface BenchProvider {
  name: string;
  /** UDP/TCP resolver endpoint */
  ip: string;
  /** DoH URL; null = not offered over a transport Bun handles well */
  dohUrl: string | null;
  /** provider requires HTTP/2 for DoH (Quad9 505s h1) */
  dohViaH2: boolean;
}

export const BENCH_PROVIDERS: BenchProvider[] = [
  { name: "cloudflare", ip: "1.1.1.1", dohUrl: "https://cloudflare-dns.com/dns-query", dohViaH2: false },
  { name: "google", ip: "8.8.8.8", dohUrl: "https://dns.google/dns-query", dohViaH2: false },
  { name: "quad9", ip: "9.9.9.9", dohUrl: "https://dns.quad9.net/dns-query", dohViaH2: true },
  { name: "mullvad", ip: "193.138.218.74", dohUrl: "https://dns.mullvad.net/dns-query", dohViaH2: false },
];

export function benchProvidersByName(name: string): BenchProvider | undefined {
  return BENCH_PROVIDERS.find((p) => p.name === name);
}

export const DOMAINS = ["google.com", "cloudflare.com", "github.com", "apple.com", "wikipedia.org"];
export const QUERY_TIMEOUT_MS = 2_000;

export type TransportKind = "doh-h1" | "doh-h2" | "udp" | "tcp";

/** available transports per provider (matrix) */
export function transportsFor(p: BenchProvider): TransportKind[] {
  const list: TransportKind[] = [];
  if (p.dohUrl) list.push(p.dohViaH2 ? "doh-h2" : "doh-h1");
  list.push("udp", "tcp");
  return list;
}

// ---- Transport session ----

export interface TransportSession {
  /** resolves to elapsed ms, or null on deadline/parse/CODEC error */
  query(name: string): Promise<number | null>;
  close(): void | Promise<void>;
}

/** One measured cell: times + error count across N queries. */
export interface CellTimes {
  times: number[];
  errors: number;
}

export interface BenchResult {
  provider: string;
  transport: TransportKind;
  mode: "warm" | "cold";
  p50: number;
  p95: number;
  p99: number;
  mean: number;
  errors: number;
  n: number;
}

export interface BenchRuntime {
  udpSession(ip: string): Promise<TransportSession>;
  tcpSession(ip: string): Promise<TransportSession>;
  h1Session(url: string): Promise<TransportSession>;
  h2Session(url: string): Promise<TransportSession>;
}

// ---- Packet helpers ----

export function queryWire(name: string, id: number): Uint8Array {
  return encode({ id, type: "query", flags: 0x0100, questions: [{ name, type: "A" }] });
}

export function decodeWire(data: Uint8Array): Packet | undefined {
  try {
    return decode(Buffer.from(data));
  } catch {
    return undefined;
  }
}

function deadlineRace<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, sleep(ms).then(() => null)]);
}

// ---- Real runtime transports (used by the CLI run) ----

export class UdpTransport implements TransportSession {
  private pending: ((p: Packet | undefined) => void) | null = null;
  private wantId = -1;
  private sock: { send(data: Uint8Array, port: number, addr: string): number; stop(): void } | null = null;

  static async open(ip: string): Promise<UdpTransport> {
    const t = new UdpTransport();
    t.sock = await Bun.udpSocket({
      hostname: "0.0.0.0",
      port: 0,
      socket: {
        data(_s: unknown, data: Uint8Array) {
          t.onData(data);
        },
        error() {
          t.onError();
        },
      },
    } as never);
    t.ip = ip;
    return t;
  }

  private ip = "";
  onData(data: Uint8Array): void {
    if (!this.pending) return;
    const p = decodeWire(data);
    if (p && p.id === this.wantId) {
      const resolve = this.pending;
      this.pending = null;
      resolve(p);
    }
  }
  onError(): void {
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve(undefined);
    }
  }

  async query(name: string): Promise<number | null> {
    const id = (1_000 + Math.floor(Math.random() * 60_000)) | 0;
    const wire = queryWire(name, id);
    const t0 = performance.now();
    const r = await deadlineRace(
      new Promise<Packet | undefined>((resolve) => {
        this.wantId = id;
        this.pending = resolve;
        this.sock?.send(wire, 53, this.ip);
      }),
      QUERY_TIMEOUT_MS,
    );
    if (r != null) return Math.round(performance.now() - t0);
    this.pending = null;
    return null;
  }

  close(): void {
    try {
      this.sock?.stop();
    } catch {
      /* already closed */
    }
  }
}

class TcpTransport implements TransportSession {
  private pending: ((buf: Uint8Array | undefined) => void) | null = null;
  private acc = new Uint8Array(0);
  private frameLen = -1;
  private write!: (d: Uint8Array) => void;
  private end!: () => void;

  static async open(ip: string): Promise<TcpTransport> {
    const t = new TcpTransport();
    const socket = await Bun.connect({
      hostname: ip,
      port: 53,
      socket: {
        data(_s: unknown, data: Uint8Array) {
          t.onData(data);
        },
        error() {
          t.onError();
        },
      },
    });
    t.write = (d: Uint8Array) => socket.write(framed(d));
    t.end = () => {
      try {
        socket.end();
      } catch {
        /* closed */
      }
    };
    return t;
  }

  onData(data: Uint8Array): void {
    this.acc = concat(this.acc, data);
    if (!this.pending) return;
    if (this.frameLen < 0 && this.acc.length >= 2) {
      this.frameLen = (this.acc[0]! << 8) | this.acc[1]!;
    }
    if (this.frameLen >= 0 && this.acc.length >= 2 + this.frameLen) {
      const body = this.acc.subarray(2, 2 + this.frameLen);
      this.acc = this.acc.subarray(2 + this.frameLen);
      this.frameLen = -1;
      const resolve = this.pending;
      this.pending = null;
      resolve(body.slice());
    }
  }
  onError(): void {
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve(undefined);
    }
  }

  async query(name: string): Promise<number | null> {
    const id = (1_000 + Math.floor(Math.random() * 60_000)) | 0;
    const wire = queryWire(name, id);
    const t0 = performance.now();
    const buf = await deadlineRace(
      new Promise<Uint8Array | undefined>((resolve) => {
        this.pending = resolve;
        this.write(wire);
      }),
      QUERY_TIMEOUT_MS,
    );
    if (buf != null) {
      const p = decodeWire(buf);
      if (p && p.id === id) return Math.round(performance.now() - t0);
      return null;
    }
    this.pending = null;
    return null;
  }

  close(): void {
    this.end();
  }
}

class H1Transport implements TransportSession {
  constructor(private url: string) {}
  async query(name: string): Promise<number | null> {
    const t0 = performance.now();
    try {
      const res = await deadlineRace(
        fetch(this.url, {
          method: "POST",
          headers: { "content-type": "application/dns-message" },
          body: queryWire(name, 0), // id irrelevant over HTTP; matched by HTTP round trip
        }) as unknown as Promise<Response>,
        QUERY_TIMEOUT_MS,
      );
      if (!res || !res.ok) return null;
      await res.arrayBuffer();
      return Math.round(performance.now() - t0);
    } catch {
      return null;
    }
  }
  close(): void {
    /* fetch pooling holds the conn; nothing to close */
  }
}

class H2Transport implements TransportSession {
  private client: http2.ClientHttp2Session | null = null;
  private path = "/dns-query";

  static async open(url: string): Promise<H2Transport> {
    const t = new H2Transport();
    t.path = new URL(url).pathname + new URL(url).search;
    t.client = http2.connect(new URL(url).origin);
    await sleep(0); // let ALPN/TLS settle (session events settle lazily)
    return t;
  }

  async query(name: string): Promise<number | null> {
    if (!this.client) return null;
    const t0 = performance.now();
    const wire = queryWire(name, 0);
    try {
      const out = await deadlineRace(
        new Promise<{ status: number; body: Uint8Array }>((resolve, reject) => {
          const req = this.client!.request({
            ":method": "POST",
            ":path": this.path,
            "content-type": "application/dns-message",
          });
          const chunks: Uint8Array[] = [];
          req.on(
            "response",
            (h) => {
              req.on("data", (c: Uint8Array) => chunks.push(c));
              req.on("end", () => resolve({ status: +((h[":status"] as number) ?? 0), body: concat(...chunks) }));
            },
          );
          req.on("error", reject);
          req.end(wire);
        }),
        QUERY_TIMEOUT_MS,
      );
      if (!out || out.status !== 200) return null;
      const p = decodeWire(out.body);
      if (!p) return null;
      return Math.round(performance.now() - t0);
    } catch {
      return null;
    }
  }

  close(): void {
    try {
      this.client?.close();
    } catch {
      /* closed */
    }
  }
}

// ---- Injectable fake runtime (unit tests) ----

export function runtime(): BenchRuntime {
  return {
    udpSession: async (ip) => await UdpTransport.open(ip),
    tcpSession: async (ip) => await TcpTransport.open(ip),
    h1Session: (url) => Promise.resolve(new H1Transport(url)),
    h2Session: async (url) => await H2Transport.open(url),
  };
}

// ---- Runner ----

async function runCell(
  rt: BenchRuntime,
  provider: BenchProvider,
  transport: TransportKind,
  mode: "warm" | "cold",
  opts: MeasureOpts,
): Promise<CellTimes> {
  const measured: string[] = [];
  for (let i = 0; i < opts.measure; i++) measured.push(DOMAINS[i % DOMAINS.length]);
  const times: number[] = [];
  let errors = 0;

  if (mode === "warm") {
    let session: TransportSession | null = null;
    try {
      session = await openSession(rt, provider, transport);
      // warm-up doubles as a liveness probe: a majority-failing transport
      // (blocked TCP, wrong IP, burned-out resolver) aborts the cell instead
      // of burning 300 × 2s timeouts.
      let warmupFails = 0;
      for (let i = 0; i < opts.warmup; i++) {
        const ms = await session.query(DOMAINS[i % DOMAINS.length]);
        if (ms == null) warmupFails++;
      }
      if (warmupFails * 2 >= opts.warmup) {
        return { times: [], errors: opts.measure };
      }
      for (const name of measured) {
        const ms = await session.query(name);
        if (ms == null) errors++;
        else times.push(ms);
      }
    } catch {
      // open timeout / transport error = dead cell
      return { times, errors: errors + opts.measure - errors };
    } finally {
      try { await session?.close(); } catch { /* ignore */ }
    }
    return { times, errors };
  }

  // cold: fresh transport per query (bounded at 50 samples)
  const coldN = Math.min(opts.measure, 50);
  for (let i = 0; i < coldN; i++) {
    const session = await openSession(rt, provider, transport);
    try {
      const ms = await session.query(measured[i]);
      if (ms == null) errors++;
      else times.push(ms);
    } finally {
      await session.close();
    }
  }
  return { times, errors };
}

const OPEN_TIMEOUT_MS = 5_000;

/** Session creation with deadline — Bun.connect/TLS can blackhole forever. */
async function openSession(rt: BenchRuntime, p: BenchProvider, t: TransportKind): Promise<TransportSession> {
  const SENTINEL = Symbol("open-timeout");
  const arm = () => Promise.race([sleep(OPEN_TIMEOUT_MS)].map((x) => x.then(() => SENTINEL)));
  let promise: Promise<TransportSession | typeof SENTINEL> | null = null;
  if (t === "udp") promise = Promise.race([rt.udpSession(p.ip), arm()]);
  else if (t === "tcp") promise = Promise.race([rt.tcpSession(p.ip), arm()]);
  else if (t === "doh-h2") promise = Promise.race([rt.h2Session(p.dohUrl!), arm()]);
  else return rt.h1Session(p.dohUrl!);
  const r = await promise;
  if (r === SENTINEL) throw new Error(`open timeout (${t})`);
  return r;
}

export interface MeasureOpts {
  warmup: number;
  measure: number;
  includeCold: boolean;
}

export function summarize(
  provider: string,
  transport: TransportKind,
  mode: "warm" | "cold",
  cell: CellTimes,
): BenchResult {
  const s = [...cell.times].sort((a, b) => a - b);
  const pl = (q: number) => s[Math.floor(s.length * q)]! ?? NaN;
  const mean = s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : NaN;
  return {
    provider,
    transport,
    mode,
    p50: pl(0.5),
    p95: pl(0.95),
    p99: pl(0.99),
    mean,
    errors: cell.errors,
    n: cell.times.length + cell.errors,
  };
}

export async function runBench(
  rt: BenchRuntime,
  providers: BenchProvider[],
  opts: MeasureOpts,
): Promise<BenchResult[]> {
  const out: BenchResult[] = [];
  for (const p of providers) {
    for (const t of transportsFor(p)) {
      const cell = await runCell(rt, p, t, "warm", opts);
      out.push(summarize(p.name, t, "warm", cell));
      if (opts.includeCold) {
        const cold = await runCell(rt, p, t, "cold", opts);
        out.push(summarize(p.name, t, "cold", cold));
      }
    }
  }
  return out;
}

export function formatReport(results: BenchResult[], env: { region?: string; bun?: string }): string {
  const rows: string[] = [];
  rows.push(
    ["provider", "transport", "mode", "p50(ms)", "p95(ms)", "p99(ms)", "mean(ms)", "err/n"].join("\t"),
  );
  for (const r of results) {
    rows.push(
      [
        r.provider,
        r.transport,
        r.mode,
        r.p50,
        r.p95,
        r.p99,
        r.mean,
        `${r.errors}/${r.n}`,
      ].join("\t"),
    );
  }
  return `# region=${env.region ?? "local"} bun=${env.bun ?? process.version}\n${rows.join("\n")}\n`;
}

const WARMUP_DEFAULT = 30;
const MEASURE_DEFAULT = 300;

const CELL_CAP_MS = 120_000;

/** Per-cell hard cap — a hung transport (blocked handshake, blackholing
 *  ISP) marks the cell aborted instead of stalling the whole bench. */
async function runCellGuarded(
  rt: BenchRuntime,
  p: BenchProvider,
  t: TransportKind,
  mode: "warm" | "cold",
  opts: MeasureOpts,
): Promise<CellTimes | null> {
  const SENTINEL = Symbol("cell-hang");
  const r = await Promise.race([
    runCell(rt, p, t, mode, opts),
    sleep(CELL_CAP_MS).then(() => SENTINEL),
  ]);
  return r === SENTINEL ? null : (r as CellTimes);
}

// ---- CLI entry ----
async function main(this: void): Promise<void> {
  const args = process.argv.slice(2);
  const includeCold = !args.includes("--warm-only");
  const transportFilter = args.find((a) => a.startsWith("--transports="));
  const transports = transportFilter ? (transportFilter.split("=")[1]!.split(",") as TransportKind[]) : null;
  const providerFilter = args.find((a) => a.startsWith("--providers="));
  const selected = providerFilter
    ? (providerFilter.split("=")[1]!.split(",").map((n) => BENCH_PROVIDERS.find((p) => p.name === n)).filter((p): p is BenchProvider => !!p))
    : BENCH_PROVIDERS;
  const opts: MeasureOpts = { warmup: WARMUP_DEFAULT, measure: MEASURE_DEFAULT, includeCold };
  const rt = runtime();
  const results: BenchResult[] = [];
  for (const p of selected) {
    for (const t of transportsFor(p)) {
      if (transports && !transports.includes(t)) continue;
      const warm = await runCellGuarded(rt, p, t, "warm", opts);
      if (warm === null) {
        console.log(`${p.name}\t${t}\twarm\tABORTED (hang — likely blocked upstream)`);
        continue;
      }
      results.push(summarize(p.name, t, "warm", warm));
      console.log(`${p.name}\t${t}\twarm\tp50=${results.at(-1)!.p50}ms p95=${results.at(-1)!.p95}ms mean=${results.at(-1)!.mean}ms err=${results.at(-1)!.errors}/${results.at(-1)!.n}`);
      if (includeCold) {
        const cold = await runCellGuarded(rt, p, t, "cold", opts);
        if (cold === null) {
          console.log(`${p.name}\t${t}\tcold\tABORTED (hang)`);
          continue;
        }
        results.push(summarize(p.name, t, "cold", cold));
        const c = results.at(-1)!;
        console.log(`${p.name}\t${t}\tcold\tp50=${c.p50}ms p95=${c.p95}ms mean=${c.mean}ms err=${c.errors}/${c.n}`);
      }
    }
  }
  console.log(formatReport(results, { region: process.env.FLY_REGION ?? "local" }));
  process.exit(0);
}

function framed(body: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + body.length);
  out[0] = body.length >> 8;
  out[1] = body.length & 0xff;
  out.set(body, 2);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

if (import.meta.main) {
  await main().catch((err) => {
    console.error("bench failed:", err);
    process.exit(1);
  });
}

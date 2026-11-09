import { describe, expect, test } from "vitest";

import { dotLabel, parseProxyV2 } from "./dot";

// Captured from a real Fly `tls` + `proxy_proto` v2 connection:
// SNI rz-dot-probe.fly.dev, client 92.239.82.78:51945 -> 66.241.124.37:853.
const CAPTURED =
  "0d0a0d0a000d0a515549540a211100585cef524e42f17c25cae90355020014727a2d646f742d70726f62652e666c792e646576" +
  "2000320100000001210007544c5376312e332500054543445341230018544c5331335f4145535f3235365f47434d5f534841333834";

describe("parseProxyV2", () => {
  test("reads addresses, ports and the SNI authority TLV", () => {
    const result = parseProxyV2(Buffer.from(CAPTURED, "hex"));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.length).toBe(104);
    expect(result.info.sourceIp).toBe("92.239.82.78");
    expect(result.info.destinationIp).toBe("66.241.124.37");
    expect(result.info.sourcePort).toBe(51945);
    expect(result.info.destinationPort).toBe(853);
    expect(result.info.authority).toBe("rz-dot-probe.fly.dev");
  });

  test("returns need-more until the whole header has arrived", () => {
    const full = Buffer.from(CAPTURED, "hex");
    for (const cut of [4, 12, 15, 40, 103]) {
      expect(parseProxyV2(full.subarray(0, cut)).status).toBe("need-more");
    }
    expect(parseProxyV2(full).status).toBe("ok");
  });

  test("rejects non-PROXY traffic", () => {
    expect(parseProxyV2(Buffer.from("GET / HTTP/1.1\r\n\r\n")).status).toBe("invalid");
    const notV2 = Buffer.from(CAPTURED, "hex");
    notV2[12] = 0x11; // version 1
    expect(parseProxyV2(notV2).status).toBe("invalid");
  });

  test("handles a v2 IPv6 header with an authority TLV", () => {
    const src = Buffer.alloc(16, 0);
    src[15] = 1;
    const dst = Buffer.alloc(16, 0);
    dst[15] = 2;
    const host = Buffer.from("abc123.dot.resolvezero.com");
    const tlv = Buffer.alloc(3 + host.length);
    tlv[0] = 0x02;
    tlv.writeUInt16BE(host.length, 1);
    host.copy(tlv, 3);

    const payload = Buffer.concat([src, dst, Buffer.from([0x01, 0xbb, 0x03, 0x55]), tlv]);
    const header = Buffer.alloc(16);
    Buffer.from("0d0a0d0a000d0a515549540a", "hex").copy(header, 0);
    header[12] = 0x21;
    header[13] = 0x21; // IPv6, STREAM
    header.writeUInt16BE(payload.length, 14);

    const result = parseProxyV2(Buffer.concat([header, payload]));
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.info.sourceIp).toBe("::1");
    expect(result.info.destinationIp).toBe("::2");
    expect(result.info.sourcePort).toBe(443);
    expect(result.info.destinationPort).toBe(853);
    expect(result.info.authority).toBe("abc123.dot.resolvezero.com");
  });
});

describe("dotLabel", () => {
  test("extracts a single lowercase label", () => {
    expect(dotLabel("abc123.dot.resolvezero.com")).toBe("abc123");
    expect(dotLabel("ABC123.dot.resolvezero.com")).toBe("abc123");
    expect(dotLabel("abc123.dot.resolvezero.com.")).toBe("abc123");
  });

  test("rejects bare, nested and foreign hostnames", () => {
    expect(dotLabel("dot.resolvezero.com")).toBeNull();
    expect(dotLabel("a.b.dot.resolvezero.com")).toBeNull();
    expect(dotLabel("abc123.example.com")).toBeNull();
    expect(dotLabel("")).toBeNull();
  });
});

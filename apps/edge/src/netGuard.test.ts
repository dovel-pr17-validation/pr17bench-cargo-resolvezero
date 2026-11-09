import { describe, expect, test } from "vitest";
import http from "node:http";
import { assertSafeRemoteUrl, fetchWithSafeRedirects, isPrivateIp, resolveSafeTarget } from "./netGuard";

describe("isPrivateIp", () => {
  test("blocks loopback/private/link-local/CGNAT/reserved (v4)", () => {
    for (const ip of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.0.1",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test("allows public v4", () => {
    for (const ip of ["1.1.1.1", "8.8.8.8", "172.32.0.1", "93.184.216.34"]) {
      expect(isPrivateIp(ip)).toBe(false);
    }
  });

  test("blocks v6 loopback/ULA/link-local/mapped (v6)", () => {
    for (const ip of ["::1", "fc00::1", "fd00:ec2::254", "fe80::1", "::ffff:127.0.0.1"]) {
      expect(isPrivateIp(ip)).toBe(true);
    }
  });

  test("allows public v6", () => {
    expect(isPrivateIp("2606:4700:4700::1111")).toBe(false);
  });
});

describe("assertSafeRemoteUrl", () => {
  test("rejects http where https is required", async () => {
    await expect(
      assertSafeRemoteUrl("http://example.com/list", { protocols: ["https:"] }),
    ).rejects.toThrow(/protocol/);
  });

  test("rejects credentials in the URL", async () => {
    await expect(assertSafeRemoteUrl("https://user:pass@1.1.1.1/")).rejects.toThrow(/credentials/);
  });

  test("rejects metadata and private IP literals", async () => {
    for (const url of [
      "https://169.254.169.254/latest/meta-data",
      "https://metadata.google.internal/",
      "https://127.0.0.1/",
      "https://10.0.0.5/",
      "https://[::1]/",
      "https://[fd00:ec2::254]/",
    ]) {
      await expect(assertSafeRemoteUrl(url)).rejects.toThrow();
    }
  });

  test("ALLOW_PRIVATE_TARGETS permits private literals but not metadata", async () => {
    await expect(assertSafeRemoteUrl("https://127.0.0.1/", { allowPrivate: true })).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeRemoteUrl("https://169.254.169.254/", { allowPrivate: true }),
    ).rejects.toThrow(/metadata/);
  });

  test("resolves and pins an explicit address", async () => {
    const target = await resolveSafeTarget("http://127.0.0.1:8080/list", { allowPrivate: true });
    expect(target.address).toBe("127.0.0.1");
    expect(target.family).toBe(4);
  });

  test("pinned fetch works while preserving Host", async () => {
    const server = http.createServer((req, res) => {
      res.end(req.headers.host ?? "missing-host");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no test port");
      const { response } = await fetchWithSafeRedirects(
        `http://127.0.0.1:${address.port}/list`,
        {},
        { allowPrivate: true },
      );
      expect(await response.text()).toBe(`127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("follows redirects through the pinned transport", async () => {
    const server = http.createServer((req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { location: "/final" });
        res.end();
        return;
      }
      res.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("no test port");
      const { response } = await fetchWithSafeRedirects(
        `http://127.0.0.1:${address.port}/start`,
        {},
        { allowPrivate: true },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("trustedHosts skips the private-range check but still pins", async () => {
    await expect(
      assertSafeRemoteUrl("https://localhost/", { trustedHosts: ["localhost"] }),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeRemoteUrl("https://metadata.google.internal/", {
        trustedHosts: ["metadata.google.internal"],
      }),
    ).rejects.toThrow(/metadata/);
  });
});

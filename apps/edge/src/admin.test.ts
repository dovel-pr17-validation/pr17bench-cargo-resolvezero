import { describe, expect, test } from "vitest";

import { createAdminApp } from "./admin";
import { RuleStore, type SourceIpRow } from "./ruleStore";

function makeStore(sourceIps: SourceIpRow[] = []): RuleStore {
  const store = new RuleStore();
  store.replaceAll(
    [],
    sourceIps,
    [{ id: "p1", dohToken: "tok", logQueries: true, upstream: null }],
  );
  return store;
}

function appFor(sourceIps: SourceIpRow[] = []) {
  return createAdminApp({ store: makeStore(sourceIps) });
}

describe("whoami", () => {
  test("returns the caller IP and whether it is linked to this profile", async () => {
    const app = appFor([{ ipAddress: "203.0.113.9", profileId: "p1" }]);
    const res = await app.request("/v1/p1/whoami", {
      headers: { authorization: "Bearer tok", "fly-client-ip": "203.0.113.9" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ip: "203.0.113.9",
      profileId: "p1",
      linked: true,
    });
  });

  test("reports an unlinked IP", async () => {
    const app = appFor();
    const res = await app.request("/v1/p1/whoami", {
      headers: { authorization: "Bearer tok", "fly-client-ip": "203.0.113.9" },
    });
    expect(await res.json()).toMatchObject({ ip: "203.0.113.9", linked: false });
  });

  test("requires the profile token", async () => {
    const app = appFor();
    expect((await app.request("/v1/p1/whoami")).status).toBe(404);
    const wrong = await app.request("/v1/p1/whoami", {
      headers: { authorization: "Bearer nope", "fly-client-ip": "203.0.113.9" },
    });
    expect(wrong.status).toBe(404);
  });

  test("rejects a missing caller IP", async () => {
    const app = appFor();
    const res = await app.request("/v1/p1/whoami", {
      headers: { authorization: "Bearer tok" },
    });
    expect(res.status).toBe(400);
  });
});

describe("browser CORS", () => {
  test("allows the console origins on the linking routes", async () => {
    const app = appFor();
    const res = await app.request("/v1/p1/whoami", {
      headers: {
        authorization: "Bearer tok",
        "fly-client-ip": "203.0.113.9",
        origin: "http://localhost:3100",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3100");
    expect(res.headers.get("vary")).toBe("Origin");
  });

  test("answers preflight for the linking routes", async () => {
    const app = appFor();
    const res = await app.request("/v1/p1/update-ip", {
      method: "OPTIONS",
      headers: { origin: "https://my.resolvezero.com" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://my.resolvezero.com");
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
  });

  test("does not echo unknown origins and leaves admin routes alone", async () => {
    const app = appFor();
    const res = await app.request("/v1/p1/whoami", {
      headers: { authorization: "Bearer tok", "fly-client-ip": "203.0.113.9", origin: "https://evil.example" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();

    const logs = await app.request("/v1/p1/cache/purge", {
      headers: { origin: "http://localhost:3100" },
    });
    expect(logs.headers.get("access-control-allow-origin")).toBeNull();
  });
});

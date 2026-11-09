import { describe, expect, test } from "vitest";
import { RuleStore, type RuleRow, type SourceIpRow } from "./ruleStore";

const rows: RuleRow[] = [
  { profileId: "p1", domain: "evil.com", action: "block" },
  { profileId: "p1", domain: "bad.io", action: "allow" },
  { profileId: "p2", domain: "p2-only.dev", action: "block" },
];

const profiles = [
  { id: "p1", dohToken: null, logQueries: true, upstream: null },
  { id: "p2", dohToken: null, logQueries: true, upstream: null },
];

const sourceIps: SourceIpRow[] = [
  { ipAddress: "10.0.0.1", profileId: "p1" },
  { ipAddress: "10.0.0.2", profileId: "p2" },
];

describe("RuleStore", () => {
  test("resolves exact rules per profile", () => {
    const store = new RuleStore();
    store.replaceAll(rows, sourceIps, profiles);

    expect(store.resolve("p1", "evil.com")).toBe("block");
    expect(store.resolve("p1", "bad.io")).toBe("allow");
    expect(store.resolve("p2", "p2-only.dev")).toBe("block");
  });

  test("does not leak rules across profiles", () => {
    const store = new RuleStore();
    store.replaceAll(rows, sourceIps, profiles);

    expect(store.resolve("p2", "evil.com")).toBeUndefined();
    expect(store.resolve("unknown", "evil.com")).toBeUndefined();
  });

  test("suffix wildcard matches subdomains (longest-suffix semantics)", () => {
    const store = new RuleStore();
    store.replaceAll(
      [...rows, { profileId: "p1", domain: "corp.example.com", action: "block" }],
      sourceIps,
      profiles,
    );

    expect(store.resolve("p1", "a.corp.example.com")).toBe("block");
    expect(store.resolve("p1", "x.y.z.corp.example.com")).toBe("block");
    expect(store.resolve("p1", "corp.example.com")).toBe("block");
    // "example.com" itself is NOT covered by a corp.example.com rule
    expect(store.resolve("p1", "example.com")).toBeUndefined();
    expect(store.resolve("p1", "other.example.com")).toBeUndefined();
  });

  test("doubleclick.net behaves as *.doubleclick.net (label-boundary safe)", () => {
    const store = new RuleStore();
    store.replaceAll(
      [{ profileId: "p1", domain: "doubleclick.net", action: "block" }],
      sourceIps,
      profiles,
    );

    // exact + all subdomains
    expect(store.resolve("p1", "doubleclick.net")).toBe("block");
    expect(store.resolve("p1", "ads.doubleclick.net")).toBe("block");
    expect(store.resolve("p1", "stats.g.doubleclick.net")).toBe("block");
    // label boundary: raw-string suffix must NOT match
    expect(store.resolve("p1", "notdoubleclick.net")).toBeUndefined();
    expect(store.resolve("p1", "doubleclick.com")).toBeUndefined();
    expect(store.resolve("p1", "net")).toBeUndefined();
    expect(store.resolve("p1", "click.net")).toBeUndefined();
    // one-way: block rule never matches the parent domain
    expect(store.resolve("p1", "com")).toBeUndefined();
    // empty-root must not blow up or over-match; FQDN trailing dot is canonicalized
    expect(store.resolve("p1", "")).toBeUndefined();
    expect(store.resolve("p1", "doubleclick.net.")).toBe("block");
  });

  test("authorizes source IP to profile", () => {
    const store = new RuleStore();
    store.replaceAll(rows, sourceIps, profiles);

    expect(store.authorizeSourceIp("10.0.0.1")).toBe("p1");
    expect(store.authorizeSourceIp("10.0.0.2")).toBe("p2");
    expect(store.authorizeSourceIp("1.2.3.4")).toBeUndefined();
  });

  test("applyEvent INSERT/UPDATE upserts a rule", () => {
    const store = new RuleStore();
    store.replaceAll(rows, sourceIps, profiles);

    store.applyEvent({ op: "INSERT", profile_id: "p2", domain: "fresh.net", action: "allow" });
    expect(store.resolve("p2", "fresh.net")).toBe("allow");

    store.applyEvent({ op: "UPDATE", profile_id: "p2", domain: "fresh.net", action: "block" });
    expect(store.resolve("p2", "fresh.net")).toBe("block");
  });

  test("applyEvent DELETE removes the rule (and its wildcard reach)", () => {
    const store = new RuleStore();
    store.replaceAll(
      [...rows, { profileId: "p1", domain: "corp.example.com", action: "block" }],
      sourceIps,
      profiles,
    );

    store.applyEvent({ op: "DELETE", profile_id: "p1", domain: "corp.example.com", action: null });
    expect(store.resolve("p1", "corp.example.com")).toBeUndefined();
    expect(store.resolve("p1", "a.corp.example.com")).toBeUndefined();
  });
});

describe("shouldLog (opt-out)", () => {
  test("returns true when logQueries enabled / unknown profile", () => {
    const store = new RuleStore();
    store.replaceAll(rows, sourceIps, [
      { id: "p1", dohToken: null, logQueries: true, upstream: null },
      { id: "p2", dohToken: null, logQueries: false, upstream: null },
    ]);
    expect(store.shouldLog("p1")).toBe(true);
    expect(store.shouldLog("p2")).toBe(false);
    expect(store.shouldLog("unknown")).toBe(true); // default "log the lot"
  });
});

describe("zone overrides", () => {
  const ZP = "33333333-3333-3333-3333-333333333333";
  const zp = [{ id: ZP, dohToken: null, logQueries: true, upstream: null }];

  test("exact A record resolves (case-insensitive)", () => {
    const store = new RuleStore();
    store.replaceAll(
      [], [], zp,
      [{ profileId: ZP, domain: "NAS.LAN", recordType: "A", values: ["192.168.1.24"], ttl: 60 }],
    );
    expect(store.resolveZone(ZP, "nas.lan", "A")).toEqual({ values: ["192.168.1.24"], ttl: 60, recordType: "A" });
    expect(store.resolveZone(ZP, "nas.lan", "AAAA")).toBeUndefined(); // per-type
    expect(store.hasZoneName(ZP, "nas.lan")).toBe(true);
    expect(store.hasZoneName(ZP, "other.lan")).toBe(false);
  });

  test("A query for a local CNAME returns the CNAME, and unknown types get local NODATA", () => {
    const store = new RuleStore();
    store.replaceAll(
      [], [], zp,
      [{ profileId: ZP, domain: "www.lan", recordType: "CNAME", values: ["nas.lan"], ttl: 60 }],
    );
    expect(store.resolveZone(ZP, "www.lan", "A")).toEqual({
      values: ["nas.lan"],
      ttl: 60,
      recordType: "CNAME",
    });
    expect(store.resolveZone(ZP, "www.lan", "CNAME")).toEqual({
      values: ["nas.lan"],
      ttl: 60,
      recordType: "CNAME",
    });
    expect(store.hasZoneName(ZP, "www.lan")).toBe(true);
  });

  test("*. wildcard zones match subdomains, not the base", () => {
    const store = new RuleStore();
    store.replaceAll(
      [], [], zp,
      [{ profileId: ZP, domain: "*.home.example.com", recordType: "A", values: ["10.0.0.5"], ttl: 300 }],
    );
    expect(store.resolveZone(ZP, "printer.home.example.com", "A")).toEqual({
      values: ["10.0.0.5"], ttl: 300, recordType: "A",
    });
    expect(store.resolveZone(ZP, "home.example.com", "A")).toBeUndefined();
  });

  test("applyZoneEvent INSERT/UPDATE/DELETE keeps snapshots live", () => {
    const store = new RuleStore();
    store.replaceAll([], [], zp);

    store.applyZoneEvent({ op: "INSERT", profile_id: ZP, domain: "cam.lan", record_type: "A", values: ["192.168.1.50"], ttl: 60 });
    expect(store.resolveZone(ZP, "cam.lan", "A")).toBeDefined();

    store.applyZoneEvent({ op: "UPDATE", profile_id: ZP, domain: "cam.lan", record_type: "A", values: ["192.168.1.51"], ttl: 60 });
    expect(store.resolveZone(ZP, "cam.lan", "A")!.values).toEqual(["192.168.1.51"]);

    store.applyZoneEvent({ op: "DELETE", profile_id: ZP, domain: "cam.lan", record_type: "A", values: null, ttl: null });
    expect(store.resolveZone(ZP, "cam.lan", "A")).toBeUndefined();
  });

  test("profileUpstream returns per-profile selection", () => {
    const store = new RuleStore();
    store.replaceAll([], [], [
      { id: ZP, dohToken: null, logQueries: true, upstream: "google" },
    ]);
    expect(store.profileUpstream(ZP)).toBe("google");
    expect(store.profileUpstream("unknown")).toBeNull();
  });

  test("applyDeviceSeen: first sighting true, repeats false (per profile)", () => {
    const store = new RuleStore();
    expect(store.applyDeviceSeen("p1", "phone")).toBe(true);
    expect(store.applyDeviceSeen("p1", "phone")).toBe(false);
    expect(store.applyDeviceSeen("p1", "tablet")).toBe(true);
    expect(store.applyDeviceSeen("p2", "phone")).toBe(true); // other profile isolated
  });

  test("hasToken: token-bearing vs token-free vs unknown", () => {
    const store = new RuleStore();
    store.replaceAll([], [], [
      { id: "11111111-1111-1111-1111-111111111111", dohToken: "s3cret", logQueries: true, upstream: null },
      { id: "22222222-2222-2222-2222-222222222222", dohToken: null, logQueries: true, upstream: null },
    ]);
    expect(store.hasToken("11111111-1111-1111-1111-111111111111")).toBe(true);
    expect(store.hasToken("22222222-2222-2222-2222-222222222222")).toBe(false);
    expect(store.hasToken("unknown-profile")).toBe(false);
    expect(store.tokenlessProfileIds()).toEqual(["22222222-2222-2222-2222-222222222222"]);
  });

  test("applyDeviceSeen: hard cap prevents unlimited device rows", () => {
    const store = new RuleStore();
    for (let i = 0; i < 200; i++) expect(store.applyDeviceSeen("p1", `device-${i}`)).toBe(true);
    expect(store.applyDeviceSeen("p1", "device-overflow")).toBe(false);
    expect(store.applyDeviceSeen("p1", "device-0")).toBe(false);
    expect(store.applyDeviceSeen("p2", "device-0")).toBe(true);
  });
});

describe("blocked services and filtering settings", () => {
  test("expands blocked services into suffix rules", () => {
    const store = new RuleStore();
    store.replaceAll([], [], profiles, [], [{ profileId: "p1", service: "tiktok" }]);

    expect(store.resolve("p1", "www.tiktok.com")).toBe("block");
    expect(store.resolve("p1", "api2.tiktokv.com")).toBe("block");
    expect(store.resolve("p1", "example.com")).toBeUndefined();
    expect(store.resolve("p2", "www.tiktok.com")).toBeUndefined();
  });

  test("an explicit allow carves a host out of a blocked service", () => {
    const store = new RuleStore();
    store.replaceAll(
      [{ profileId: "p1", domain: "ads.tiktok.com", action: "allow" }],
      [],
      profiles,
      [],
      [{ profileId: "p1", service: "tiktok" }],
    );

    expect(store.resolve("p1", "ads.tiktok.com")).toBe("allow");
    expect(store.resolve("p1", "www.tiktok.com")).toBe("block");
  });

  test("returns the profile's block answer and SafeSearch settings", () => {
    const store = new RuleStore();
    store.replaceAll([], [], [
      {
        id: "p1",
        dohToken: null,
        logQueries: true,
        upstream: null,
        blockMode: "nxdomain",
        blockTtl: 60,
        safeSearch: { google: true },
      },
      { id: "p2", dohToken: null, logQueries: true, upstream: null },
    ]);

    expect(store.blockAnswer("p1")).toMatchObject({ mode: "nxdomain", ttl: 60 });
    expect(store.blockAnswer("p2").mode).toBe("null");
    expect(store.blockAnswer("unknown").mode).toBe("null");
    expect(store.safeSearchSettings("p1")).toEqual({ google: true });
    expect(store.safeSearchSettings("p2")).toEqual({});
  });
});

import { describe, expect, test } from "vitest";

import { createOtpGuard, WindowLimiter } from "./otp-guard";

describe("WindowLimiter", () => {
  test("allows up to max inside the window, then blocks", () => {
    const limiter = new WindowLimiter({ windowMs: 60_000, max: 3 }, () => 0);
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
  });

  test("keys are independent", () => {
    const limiter = new WindowLimiter({ windowMs: 60_000, max: 1 }, () => 0);
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("b")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
  });

  test("resets once the window elapses", () => {
    let now = 0;
    const limiter = new WindowLimiter({ windowMs: 1_000, max: 1 }, () => now);
    expect(limiter.hit("a")).toBe(true);
    expect(limiter.hit("a")).toBe(false);
    now = 1_000;
    expect(limiter.hit("a")).toBe(true);
  });
});

describe("createOtpGuard", () => {
  const config = {
    perEmail: { windowMs: 15 * 60_000, max: 3 },
    global: { windowMs: 60 * 60_000, max: 5 },
  };

  test("caps one address independently of others", () => {
    const guard = createOtpGuard(config, () => 0);
    for (let i = 0; i < 3; i += 1) expect(guard.allow("a@example.com").allowed).toBe(true);
    expect(guard.allow("a@example.com")).toEqual({ allowed: false, reason: "email" });
    expect(guard.allow("b@example.com").allowed).toBe(true);
  });

  test("normalises case and whitespace into one bucket", () => {
    const guard = createOtpGuard(config, () => 0);
    expect(guard.allow("  Foo@Example.COM ").allowed).toBe(true);
    expect(guard.allow("foo@example.com").allowed).toBe(true);
    expect(guard.allow("FOO@example.com").allowed).toBe(true);
    expect(guard.allow("foo@example.com")).toEqual({ allowed: false, reason: "email" });
  });

  test("enforces the global cap across many addresses", () => {
    const guard = createOtpGuard(config, () => 0);
    for (let i = 0; i < 5; i += 1) expect(guard.allow(`u${i}@example.com`).allowed).toBe(true);
    expect(guard.allow("late@example.com")).toEqual({ allowed: false, reason: "global" });
  });

  test("does not spend global budget on an already-blocked address", () => {
    const guard = createOtpGuard(config, () => 0);
    for (let i = 0; i < 3; i += 1) guard.allow("spam@example.com");
    for (let i = 0; i < 10; i += 1) guard.allow("spam@example.com");
    // five global slots, three consumed by real sends only
    expect(guard.allow("a@example.com").allowed).toBe(true);
    expect(guard.allow("b@example.com").allowed).toBe(true);
  });

  test("global window recovers after it elapses", () => {
    let now = 0;
    const guard = createOtpGuard(config, () => now);
    for (let i = 0; i < 5; i += 1) guard.allow(`u${i}@example.com`);
    expect(guard.allow("next@example.com").allowed).toBe(false);
    now = 60 * 60_000;
    expect(guard.allow("next@example.com").allowed).toBe(true);
  });
});

import { describe, expect, test, vi, afterEach } from "vitest";
import { createRateLimiter, positiveInt, Semaphore } from "./limits";

afterEach(() => {
  vi.useRealTimers();
});

describe("createRateLimiter", () => {
  test("allows up to the limit per fixed window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const allow = createRateLimiter(2, 1_000);
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
    expect(allow("b")).toBe(true);

    vi.setSystemTime(1_001);
    expect(allow("a")).toBe(true);
  });

  test("caps key memory and recovers after the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const allow = createRateLimiter(1, 100, 2);
    expect(allow("a")).toBe(true);
    expect(allow("b")).toBe(true);
    expect(allow("c")).toBe(true); // map clears at the cap rather than growing
    vi.setSystemTime(101);
    expect(allow("a")).toBe(true);
  });
});

describe("Semaphore", () => {
  test("never exceeds capacity", () => {
    const sem = new Semaphore(2);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(true);
    expect(sem.tryAcquire()).toBe(false);
    expect(sem.inFlight).toBe(2);
    sem.release();
    expect(sem.tryAcquire()).toBe(true);
    sem.release();
    sem.release();
    expect(sem.inFlight).toBe(0);
  });
});

describe("positiveInt", () => {
  test("falls back on invalid or non-positive values", () => {
    expect(positiveInt("12", 5)).toBe(12);
    expect(positiveInt("0", 5)).toBe(5);
    expect(positiveInt("-1", 5)).toBe(5);
    expect(positiveInt("nope", 5)).toBe(5);
    expect(positiveInt(undefined, 5)).toBe(5);
  });
});

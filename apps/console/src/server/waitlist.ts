import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";

import { db } from "@resolvezero/db/client";
import { waitlist } from "@resolvezero/db/schema";

import { normalizeWaitlistEmail } from "../lib/waitlist";

/**
 * Public, unauthenticated waitlist endpoint. Abuse controls are deliberately
 * cheap and in-memory: the console runs one machine and the cost of a junk row
 * is negligible; the goal is only to stop trivial scripted floods.
 */
const WINDOW_MS = 10 * 60_000;
const PER_IP = 5;
const GLOBAL = 100;

const perIp = new Map<string, number[]>();
let globalHits: number[] = [];

function allowAttempt(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;
  globalHits = globalHits.filter((t) => t > cutoff);
  if (globalHits.length >= GLOBAL) return false;

  const hits = (perIp.get(ip) ?? []).filter((t) => t > cutoff);
  if (hits.length >= PER_IP) {
    perIp.set(ip, hits);
    return false;
  }
  hits.push(now);
  perIp.set(ip, hits);
  globalHits.push(now);

  // Keep the map from growing unbounded across deploys/idle IPs.
  if (perIp.size > 10_000) {
    for (const [key, value] of perIp) {
      if (value.every((t) => t <= cutoff)) perIp.delete(key);
    }
  }
  return true;
}

function callerIp(): string {
  const headers = getRequestHeaders();
  const fly = headers.get("fly-client-ip")?.trim();
  if (fly) return fly;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "local";
}

/** Best-effort client IP for the limiter; exported for tests. */
export function _resetWaitlistLimiter(): void {
  perIp.clear();
  globalHits = [];
}

export const joinWaitlist = createServerFn({ method: "POST" })
  .validator((data: { email?: string; website?: string }) => {
    const email = normalizeWaitlistEmail(data?.email);
    if (!email) throw new Error("Enter a valid email address.");
    // Honeypot: real people never see or fill this field.
    return { email, website: String(data?.website ?? "") };
  })
  .handler(async ({ data }) => {
    if (data.website) return { ok: true, already: false };
    if (!allowAttempt(callerIp())) {
      throw new Error("Too many attempts. Try again in a few minutes.");
    }

    const inserted = await db
      .insert(waitlist)
      .values({ email: data.email })
      .onConflictDoNothing({ target: waitlist.email })
      .returning({ email: waitlist.email });

    return { ok: true, already: inserted.length === 0 };
  });

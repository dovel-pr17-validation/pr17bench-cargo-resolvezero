import "@tanstack/react-start/server-only";

import { createOtpGuard } from "../lib/otp-guard";

function positive(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * Per-address and per-instance caps on sign-in emails. The per-IP cap lives in
 * Better Auth's rate limiter; this one protects the recipient and the bill.
 */
const guard = createOtpGuard({
  perEmail: {
    windowMs: positive(process.env.EMAIL_OTP_PER_EMAIL_WINDOW_MS, 15 * 60_000),
    max: positive(process.env.EMAIL_OTP_PER_EMAIL_MAX, 3),
  },
  global: {
    windowMs: positive(process.env.EMAIL_OTP_GLOBAL_WINDOW_MS, 60 * 60_000),
    max: positive(process.env.EMAIL_OTP_GLOBAL_MAX, 100),
  },
});

export function allowOtpSend(email: string): boolean {
  const result = guard.allow(email);
  if (!result.allowed) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "otp send suppressed",
        reason: result.reason,
        email: email.toLowerCase(),
      }),
    );
    return false;
  }
  return true;
}

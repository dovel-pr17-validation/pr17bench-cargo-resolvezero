import "@tanstack/react-start/server-only";

import nodemailer, { type Transporter } from "nodemailer";

import { otpEmail, type OtpType } from "../lib/otp-email";

let cached: Transporter | null | undefined;

/** True when an SMTP endpoint is configured (production requirement). */
export function mailConfigured(): boolean {
  return Boolean(process.env.SMTP_URL?.trim());
}

/**
 * Loud startup warning when a production build would be unable to deliver any
 * OTP. The send path throws per request, but the sign-in screen answers 200 to
 * avoid leaking account existence, so without this the failure is invisible.
 */
export function warnIfMailMisconfigured(): void {
  const production = process.env.NODE_ENV === "production";
  if (!production) return;
  if (!mailConfigured()) {
    console.error(
      JSON.stringify({
        level: "warn",
        msg: "SMTP_URL is not set; email OTP sign-in cannot deliver codes",
      }),
    );
    return;
  }
  if (!process.env.EMAIL_FROM?.trim()) {
    console.error(
      JSON.stringify({
        level: "warn",
        msg: "EMAIL_FROM is not set; falling back to no-reply@resolvezero.local, which most providers reject",
      }),
    );
  }
}

function devLoggingEnabled(): boolean {
  return process.env.EMAIL_OTP_DEV_LOG === "1" || process.env.NODE_ENV !== "production";
}

function transporter(): Transporter | null {
  if (cached !== undefined) return cached;

  // Explicit local/test escape hatch: log codes instead of sending even when
  // SMTP is configured (documented in .env.example).
  if (process.env.EMAIL_OTP_DEV_LOG === "1") {
    cached = null;
    return null;
  }

  const url = process.env.SMTP_URL?.trim();
  if (!url) {
    if (!devLoggingEnabled()) {
      throw new Error(
        "SMTP_URL is required in production: email OTP is the only human sign-in method",
      );
    }
    cached = null;
    return null;
  }

  cached = nodemailer.createTransport(url);
  return cached;
}

/**
 * Send an OTP email. In development without SMTP the code is logged instead, so
 * the flow is testable without a mail server. Production refuses to send (and
 * fails loudly) when SMTP is missing.
 */
export async function sendOtpEmail(
  to: string,
  otp: string,
  type: OtpType,
  expiresMinutes = 10,
): Promise<void> {
  const message = otpEmail(otp, type, expiresMinutes);
  const from = process.env.EMAIL_FROM?.trim() || "ResolveZero <no-reply@resolvezero.local>";
  const transport = transporter();

  if (!transport) {
    console.info(
      JSON.stringify({ level: "info", msg: "otp email (dev, not sent)", to, code: otp }),
    );
    return;
  }

  await transport.sendMail({
    from,
    to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

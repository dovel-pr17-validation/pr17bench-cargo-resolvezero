import "@tanstack/react-start/server-only";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { apiKey } from "@better-auth/api-key";
import { emailOTP } from "better-auth/plugins";
import { db } from "@resolvezero/db/client";
import { account, apikey, session, user, verification } from "@resolvezero/db/schema";

import { requiredEnv } from "./env.server";
import { sendOtpEmail, warnIfMailMisconfigured } from "./mail.server";
import { allowOtpSend } from "./otp-guard.server";

export type SessionUser = {
  id: string;
  name: string;
  email: string | null;
  image: string | null;
};

const isProduction = process.env.NODE_ENV === "production";
/** Shared by Better Auth's expiry and the copy shown in the email. */
const OTP_TTL_SECONDS = Number(process.env.EMAIL_OTP_TTL_SECONDS ?? 600);

warnIfMailMisconfigured();

export const auth = betterAuth({
  appName: "ResolveZero",
  secret: requiredEnv("BETTER_AUTH_SECRET"),
  baseURL:
    process.env.BETTER_AUTH_URL ??
    (isProduction ? requiredEnv("BETTER_AUTH_URL") : "http://localhost:3000"),
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification, apikey },
  }),
  socialProviders: {
    github: {
      clientId: requiredEnv("GITHUB_CLIENT_ID"),
      clientSecret: requiredEnv("GITHUB_CLIENT_SECRET"),
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
  },
  // Fly's proxy sets Fly-Client-IP authoritatively; without an explicit header
  // Better Auth cannot resolve a client IP behind the platform and rate limits
  // collapse into one shared per-path bucket.
  advanced: {
    ipAddress: {
      ipAddressHeaders: ["fly-client-ip", "x-forwarded-for"],
    },
  },
  // Per-IP throttling for the auth endpoints. The per-address and global email
  // caps live in otp-guard.server.ts (this limiter cannot see recipients).
  rateLimit: {
    enabled: process.env.AUTH_RATE_LIMIT === "0" ? false : true,
    window: 60,
    max: 100,
    customRules: {
      "/email-otp/send-verification-otp": { window: 60, max: 5 },
      "/sign-in/email-otp": { window: 60, max: 10 },
    },
  },
  plugins: [
    // Email OTP is the only human sign-in method: no passwords to steal, reuse,
    // or reset. The code is stored hashed and expires quickly.
    emailOTP({
      otpLength: 6,
      expiresIn: OTP_TTL_SECONDS,
      allowedAttempts: 5,
      storeOTP: "hashed",
      // Hosted can close signup (AUTH_ALLOW_SIGNUP=0) and stay invite-only.
      disableSignUp: process.env.AUTH_ALLOW_SIGNUP === "0",
      async sendVerificationOTP({ email, otp, type }) {
        // Per-address + global caps: never spend money on an abusive request.
        // The endpoint still answers normally, so this leaks nothing about
        // whether an account exists.
        if (!allowOtpSend(email)) return;
        // Fire-and-forget: keeps the endpoint response time independent of SMTP.
        void sendOtpEmail(email, otp, type, Math.max(1, Math.round(OTP_TTL_SECONDS / 60))).catch((err) =>
          console.error(
            JSON.stringify({
              level: "error",
              msg: "otp email failed",
              err: err instanceof Error ? err.message : String(err),
            }),
          ),
        );
      },
    }),
    // Machine-to-machine keys for the control-plane API. The bound profile and
    // scope live in `metadata`; ownership is always re-checked against the key's
    // user before any query runs.
    apiKey({
      enableMetadata: true,
      defaultPrefix: "rz_",
      // Plugin defaults are 10 requests per DAY — far too low for an API.
      rateLimit: {
        enabled: true,
        maxRequests: Number(process.env.API_KEY_RATE_MAX ?? 60),
        timeWindow: Number(process.env.API_KEY_RATE_WINDOW_MS ?? 60_000),
      },
    }),
    // Must be the last plugin: it forwards better-auth's Set-Cookie headers
    // through TanStack Start's response helpers.
    tanstackStartCookies(),
  ],
});

/** Read the current session inside a server function/route handler. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const result = await auth.api.getSession({ headers: getRequestHeaders() });
  if (!result?.user) return null;
  return {
    id: result.user.id,
    name: result.user.name || "Account",
    email: result.user.email ?? null,
    image: result.user.image ?? null,
  };
}

/** The data boundary: every private server function calls this. */
export async function requireSessionUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}

export function toViewer(user: SessionUser): { name: string; image: string | null; email: string | null } {
  return { name: user.name, image: user.image, email: user.email };
}

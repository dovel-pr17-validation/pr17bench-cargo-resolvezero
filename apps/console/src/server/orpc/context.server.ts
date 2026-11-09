import "@tanstack/react-start/server-only";

import { ORPCError } from "@orpc/server";

import { db } from "@resolvezero/db/client";
import { user } from "@resolvezero/db/schema";
import { eq } from "drizzle-orm";

import { auth } from "../auth.server";
import { findProfile } from "../dashboard/profile.server";

/** `read-write` implies `read`; keys are either read-only or read-write. */
export type Scope = "read" | "read-write";

export type Principal =
  | { via: "session"; userId: string; keyId: null; scope: Scope }
  | { via: "key"; userId: string; keyId: string; scope: Scope };

/** Resolved once per request and passed to every procedure. */
export interface ApiContext {
  principal: Principal;
  profileId: string;
  profileName: string;
  viewer: { name: string; email: string | null; image: string | null };
  request: {
    ip: string | null;
    userAgent: string | null;
  };
}

function requestMeta(headers: Headers): ApiContext["request"] {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return {
    ip: headers.get("fly-client-ip")?.trim() || forwarded || null,
    userAgent: headers.get("user-agent"),
  };
}

/**
 * Resolve the caller from either a Better Auth session cookie or a long-lived
 * API key. Both paths end at exactly one profile: keys are bound to a profile,
 * and the session path keeps the `rz_profile_id` switcher working.
 */
export async function resolveContext(headers: Headers): Promise<ApiContext> {
  const bearer = headers.get("authorization");
  if (bearer?.toLowerCase().startsWith("bearer ")) {
    return resolveKeyContext(bearer.slice(7).trim(), headers);
  }

  const session = await auth.api.getSession({ headers });

  if (session?.user) {
    const profile = await findProfile(session.user.id, null, headers.get("cookie") ?? undefined);
    return {
      principal: { via: "session", userId: session.user.id, keyId: null, scope: "read-write" },
      profileId: profile.id,
      profileName: profile.name,
      viewer: {
        name: session.user.name || "Account",
        email: session.user.email ?? null,
        image: session.user.image ?? null,
      },
      request: requestMeta(headers),
    };
  }

  throw new ORPCError("UNAUTHORIZED", { message: "Sign in or supply an API key." });
}

/**
 * A key resolves to `{ profileId, scope }` from its metadata, and to its owner
 * through `referenceId`. The profile is then re-checked against that owner, so a
 * key can never reach a profile the user does not own.
 */
async function resolveKeyContext(rawKey: string, headers: Headers): Promise<ApiContext> {
  if (!rawKey) throw new ORPCError("UNAUTHORIZED", { message: "Empty API key." });

  const result = await auth.api.verifyApiKey({ body: { key: rawKey } });
  if (!result.valid || !result.key) {
    const reason = result.error?.message;
    throw new ORPCError("UNAUTHORIZED", {
      message: typeof reason === "string" ? reason : "Invalid or expired API key.",
    });
  }

  const metadata = (result.key.metadata ?? {}) as Record<string, unknown>;
  const profileId = typeof metadata.profileId === "string" ? metadata.profileId : null;
  const scope: Scope | null =
    metadata.scope === "read" ? "read" : metadata.scope === "read-write" ? "read-write" : null;
  if (!profileId || !scope) {
    throw new ORPCError("UNAUTHORIZED", { message: "API key is missing its profile binding." });
  }

  const userId = result.key.referenceId;
  const profile = await findProfile(userId, profileId);
  const viewer = await db
    .select({ name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1)
    .then((rows) => rows[0]);

  return {
    principal: { via: "key", userId, keyId: result.key.id, scope },
    profileId: profile.id,
    profileName: profile.name,
    viewer: {
      name: viewer?.name || "Account",
      email: viewer?.email ?? null,
      image: viewer?.image ?? null,
    },
    request: requestMeta(headers),
  };
}

export function requireScope(context: ApiContext, scope: Scope): void {
  const allowed = context.principal.scope === "read-write" || context.principal.scope === scope;
  if (!allowed) {
    throw new ORPCError("FORBIDDEN", { message: `This key is read-only.` });
  }
}

/** Internal procedures are session-only: an API key can never reach them. */
export function requireSession(context: ApiContext): void {
  if (context.principal.via !== "session") {
    throw new ORPCError("FORBIDDEN", { message: "This operation is not available to API keys." });
  }
}

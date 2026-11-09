import { createServerFn } from "@tanstack/react-start";

export type ApiKeyScope = "read" | "read-write";

export interface ApiKeySummary {
  id: string;
  name: string;
  start: string | null;
  scope: ApiKeyScope;
  createdAt: string;
  lastRequest: string | null;
  enabled: boolean;
}

/**
 * API keys are session-only by design: they are never exposed through the
 * public oRPC router, so a key can never mint or revoke another key.
 *
 * Server-only imports stay dynamic so this module can be imported by the route.
 */
async function serverDeps() {
  const [{ auth }, { requireSessionUser }, { findProfile }, { getRequestHeaders }, { recordAudit }] =
    await Promise.all([
      import("./auth.server"),
      import("./auth.server"),
      import("./dashboard/profile.server"),
      import("@tanstack/react-start/server"),
      import("./orpc/audit.server"),
    ]);
  const user = await requireSessionUser();
  const profile = await findProfile(user.id);
  const headers = getRequestHeaders();
  const ip =
    headers.get("fly-client-ip")?.trim() ||
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    null;

  const audit = (procedure: string, summary: string) =>
    recordAudit({
      profileId: profile.id,
      userId: user.id,
      keyId: null,
      via: "session",
      procedure,
      summary,
      ip,
      userAgent: headers.get("user-agent"),
    });

  return { auth, headers, user, profile, audit };
}

function scopeOf(metadata: unknown): ApiKeyScope | null {
  const value = (metadata as Record<string, unknown> | null)?.scope;
  return value === "read" || value === "read-write" ? value : null;
}

function profileOf(metadata: unknown): string | null {
  const value = (metadata as Record<string, unknown> | null)?.profileId;
  return typeof value === "string" ? value : null;
}

export const listApiKeys = createServerFn({ method: "GET" }).handler(async (): Promise<ApiKeySummary[]> => {
  const { auth, headers, profile } = await serverDeps();
  const result = await auth.api.listApiKeys({ headers, query: { limit: 100 } });
  return result.apiKeys
    .filter((key) => profileOf(key.metadata) === profile.id)
    .map((key) => ({
      id: key.id,
      name: key.name ?? "Untitled key",
      start: key.start ?? null,
      scope: scopeOf(key.metadata) ?? "read",
      createdAt: key.createdAt.toISOString(),
      lastRequest: key.lastRequest ? key.lastRequest.toISOString() : null,
      enabled: key.enabled ?? true,
    }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
});

export const createApiKey = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    if (!data || typeof data !== "object") throw new Error("Invalid key input");
    const input = data as Record<string, unknown>;
    if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 60) {
      throw new Error("Name must be 1–60 characters");
    }
    if (input.scope !== "read" && input.scope !== "read-write") {
      throw new Error("Scope must be read or read-write");
    }
    return { name: input.name.trim(), scope: input.scope as ApiKeyScope };
  })
  .handler(async ({ data }) => {
    const { auth, headers, user, profile, audit } = await serverDeps();
    const created = await auth.api.createApiKey({
      body: {
        userId: user.id,
        name: data.name,
        metadata: { profileId: profile.id, scope: data.scope },
      },
      headers,
    });
    await audit("apiKeys.create", `key ${data.name} (${data.scope}) created`);
    // The raw key is returned exactly once; it is stored hashed.
    return { id: created.id, key: created.key, start: created.start ?? null, name: data.name, scope: data.scope };
  });

export const revokeApiKey = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    if (!data || typeof data !== "object") throw new Error("Invalid key id");
    const id = (data as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length < 8 || id.length > 64) throw new Error("Invalid key id");
    return { id };
  })
  .handler(async ({ data }) => {
    const { auth, headers, profile, audit } = await serverDeps();
    const result = await auth.api.listApiKeys({ headers, query: { limit: 100 } });
    const owned = result.apiKeys.filter((key) => profileOf(key.metadata) === profile.id);
    if (!owned.some((key) => key.id === data.id)) {
      throw new Error("API key not found.");
    }
    const revoked = owned.find((key) => key.id === data.id);
    await auth.api.deleteApiKey({ body: { keyId: data.id }, headers });
    await audit("apiKeys.revoke", `key ${revoked?.name ?? data.id} revoked`);
    return { ok: true as const };
  });

import { createFileRoute } from "@tanstack/react-router";

import { APPLE_PROFILE_MIME, buildAppleProfile, normalizeDeviceSlug } from "../../../lib/apple-profile";

const DOT_SUFFIX = (process.env.DOT_SUFFIX ?? ".dot.resolvezero.com").toLowerCase();
const DOH_BASE = (process.env.DOH_PUBLIC_URL ?? "https://doh.resolvezero.com").replace(/\/+$/, "");

/**
 * Apple DNS profile download: /api/profile/<device>[?kind=tls]
 * Session-scoped and never cached — the payload embeds the profile's DoH token.
 */
export const Route = createFileRoute("/api/profile/$device")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const deviceParam = url.pathname.split("/").filter(Boolean).pop() ?? "";
        const kind = url.searchParams.get("kind") === "tls" ? "tls" : "https";

        let device: string;
        try {
          device = normalizeDeviceSlug(deviceParam);
        } catch {
          return new Response("Invalid device name", { status: 400 });
        }

        const [{ auth }, { findProfile }, { db }, { eq }, { profiles }] = await Promise.all([
          import("../../../server/auth.server"),
          import("../../../server/dashboard/profile.server"),
          import("@resolvezero/db/client"),
          import("drizzle-orm"),
          import("@resolvezero/db/schema"),
        ]);

        const session = await auth.api.getSession({ headers: request.headers });
        if (!session?.user) return new Response("Unauthorized", { status: 401 });

        const profile = await findProfile(session.user.id, null, request.headers.get("cookie") ?? undefined);
        const [row] = await db
          .select({ token: profiles.dohToken, dotId: profiles.dotId })
          .from(profiles)
          .where(eq(profiles.id, profile.id))
          .limit(1);
        if (!row?.token) return new Response("Profile has no DoH token", { status: 400 });

        if (kind === "tls" && !row.dotId) {
          return new Response("DoT is not enabled for this profile", { status: 400 });
        }

        const xml = buildAppleProfile({
          profileName: profile.name,
          device,
          kind,
          dohUrl: `${DOH_BASE}/v1/${profile.id}/${device}/${row.token}`,
          serverName: row.dotId ? `${row.dotId}${DOT_SUFFIX}` : undefined,
        });

        return new Response(xml, {
          headers: {
            "content-type": `${APPLE_PROFILE_MIME}; charset=utf-8`,
            "content-disposition": `attachment; filename="resolvezero-${device}.mobileconfig"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          },
        });
      },
    },
  },
});

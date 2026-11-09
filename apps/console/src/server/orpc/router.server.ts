import "@tanstack/react-start/server-only";

import { z } from "zod";

import { base } from "./router-base.server";
import { blocklists } from "./procedures/blocklists.server";
import { cache, localDns } from "./procedures/local-dns.server";
import { reads } from "./procedures/read.server";
import { rules } from "./procedures/rules.server";
import { settings } from "./procedures/settings.server";

/** Identity probe: lets a client confirm its key and profile binding. */
const whoami = base
  .route({ method: "GET", path: "/whoami", tags: ["Account"], summary: "Who is calling?" })
  .output(
    z.object({
      via: z.enum(["session", "key"]),
      scope: z.enum(["read", "read-write"]),
      userId: z.string(),
      keyId: z.string().nullable(),
      profileId: z.string(),
      profileName: z.string(),
    }),
  )
  .handler(({ context }) => ({
    via: context.principal.via,
    scope: context.principal.scope,
    userId: context.principal.userId,
    keyId: context.principal.keyId,
    profileId: context.profileId,
    profileName: context.profileName,
  }));

/**
 * Public control-plane router. Mounted at /rpc and exposed in /openapi.json.
 * Internal procedures (API key management, account ops) are not mounted here.
 */
export const router = {
  whoami,
  overview: reads.overview,
  queryVolume: reads.queryVolume,
  analytics: reads.analytics,
  logs: reads.logs,
  settings,
  edge: reads.edge,
  rules,
  blocklists,
  localDns,
  cache,
};

export type ApiRouter = typeof router;

import "@tanstack/react-start/server-only";

import { z } from "zod";
import { ORPCError } from "@orpc/server";

import { base } from "../router-base.server";
import { requireScope } from "../context.server";
import { auditWrite } from "../audit.server";
import { loadSettings, unlinkSourceIp, updateSettings } from "../../dashboard/settings.server";
import { normalizeSettingsInput, UPSTREAM_PRESETS } from "../../../lib/settings";
import { settingsSchema } from "../schemas.server";

const settingsInput = z.object({
  upstream: z.enum(UPSTREAM_PRESETS).nullable(),
  upstreamUrl: z.string().max(255).nullable(),
  logQueries: z.boolean(),
  logRetentionDays: z.number().int().min(1).max(365),
  blockMode: z.enum(["null", "nxdomain", "refused", "custom"]),
  blockIpv4: z.string().max(45).nullable(),
  blockIpv6: z.string().max(45).nullable(),
  blockTtl: z.number().int().min(0).max(86_400),
  safeSearch: z.object({
    google: z.boolean().optional(),
    bing: z.boolean().optional(),
    duckduckgo: z.boolean().optional(),
    youtube: z.boolean().optional(),
  }),
  blockedServices: z.array(z.string().max(32)),
});

export const settings = {
  get: base
    .route({ method: "GET", path: "/settings", tags: ["Settings"], summary: "Profile settings and capacity" })
    .output(settingsSchema)
    .handler(({ context }) => {
      requireScope(context, "read");
      return loadSettings(context.principal.userId, context.profileId);
    }),

  unlinkSourceIp: base
    .route({ method: "POST", path: "/settings/source-ips/unlink", tags: ["Settings"], summary: "Remove a linked source IP" })
    .input(z.object({ ip: z.string().min(2).max(45) }))
    .output(z.object({ ok: z.boolean(), ip: z.string() }))
    .handler(async ({ input, context }) => {
      requireScope(context, "read-write");
      try {
        const result = await unlinkSourceIp(context.principal.userId, input.ip, context.profileId);
        await auditWrite(context, { procedure: "settings.unlinkSourceIp", summary: `unlink ${result.ip}` });
        return result;
      } catch (err) {
        throw new ORPCError("BAD_REQUEST", {
          message: err instanceof Error ? err.message : "Could not unlink IP",
        });
      }
    }),

  update: base
    .route({ method: "PATCH", path: "/settings", tags: ["Settings"], summary: "Update resolver and logging settings" })
    .input(settingsInput)
    .output(settingsSchema)
    .handler(async ({ input, context }) => {
      requireScope(context, "read-write");
      try {
        const normalized = normalizeSettingsInput(input);
        const updated = await updateSettings(context.principal.userId, normalized, context.profileId);
        await auditWrite(context, {
          procedure: "settings.update",
          summary: `settings upstream=${normalized.upstreamUrl ?? normalized.upstream ?? "default"} logs=${normalized.logQueries ? "on" : "off"} retention=${normalized.logRetentionDays}d`,
        });
        return updated;
      } catch (err) {
        throw new ORPCError("BAD_REQUEST", {
          message: err instanceof Error ? err.message : "Invalid settings",
        });
      }
    }),
};

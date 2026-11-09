import "@tanstack/react-start/server-only";

import { z } from "zod";

import { DEVICE_TAG_RE } from "../../../lib/device";

import { base } from "../router-base.server";
import { requireScope } from "../context.server";
import { loadAnalytics } from "../../dashboard/analytics.server";
import { loadLogs } from "../../dashboard/logs.server";
import { loadOverview } from "../../dashboard/overview.server";
import { loadQueryVolume } from "../../dashboard/query-volume.server";
import { loadEdgeHealth } from "../../dashboard/edge.server";
import {
  analyticsSchema,
  edgeHealthSchema,
  logsSchema,
  overviewSchema,
  queryVolumeSchema,
} from "../schemas.server";

/**
 * Read procedures. Output schemas are intentionally loose for the aggregate
 * views (they mirror the UI payloads); tightening them is a follow-up.
 */
export const reads = {
  overview: base
    .route({ method: "GET", path: "/overview", tags: ["Insights"], summary: "Dashboard overview" })
    .input(z.object({ device: z.string().regex(DEVICE_TAG_RE).optional() }).optional())
    .output(overviewSchema)
    .handler(async ({ input, context }) => {
      requireScope(context, "read");
      return loadOverview(context.principal.userId, context.viewer, context.profileId, input?.device);
    }),

  queryVolume: base
    .route({ method: "GET", path: "/overview/query-volume", tags: ["Insights"], summary: "Query volume series" })
    .input(
      z.object({
        range: z.enum(["1h", "24h", "7d", "30d"]).default("24h"),
        device: z.string().regex(DEVICE_TAG_RE).optional(),
      }),
    )
    .output(queryVolumeSchema)
    .handler(async ({ input, context }) => {
      requireScope(context, "read");
      return loadQueryVolume(context.principal.userId, input.range, context.profileId, input.device);
    }),

  analytics: base
    .route({ method: "GET", path: "/analytics", tags: ["Insights"], summary: "Analytics rollups" })
    .input(
      z
        .object({ tz: z.string().max(64).describe("IANA time zone for day bucketing (default UTC)").optional() })
        .optional(),
    )
    .output(analyticsSchema)
    .handler(async ({ input, context }) => {
      requireScope(context, "read");
      return loadAnalytics(context.principal.userId, context.profileId, input?.tz);
    }),

  logs: base
    .route({ method: "GET", path: "/logs", tags: ["Insights"], summary: "Recent query log entries" })
    .output(logsSchema)
    .handler(async ({ context }) => {
      requireScope(context, "read");
      return loadLogs(context.principal.userId, context.profileId);
    }),

  edge: base
    .route({ method: "GET", path: "/edge", tags: ["Insights"], summary: "Edge health for this profile" })
    .output(edgeHealthSchema)
    .handler(async ({ context }) => {
      requireScope(context, "read");
      return loadEdgeHealth();
    }),
};

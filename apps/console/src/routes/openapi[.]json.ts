import { createFileRoute } from "@tanstack/react-router";
import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";

import { router } from "../server/orpc/router.server";

const generator = new OpenAPIGenerator({
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

export const Route = createFileRoute("/openapi.json")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const origin = new URL(request.url).origin;
        const spec = await generator.generate(router, {
          info: { title: "ResolveZero API", version: "0.1.0" },
          // Procedures are served under /rpc, so the base URL carries the prefix.
          servers: [{ url: `${origin}/rpc` }],
        });
        // Declaring the tag order here keeps the Scalar sidebar grouped in a
        // predictable order instead of first-appearance order.
        return Response.json({
          ...spec,
          tags: [
            { name: "Insights", description: "Dashboards, query log, analytics, and edge health." },
            { name: "Policy", description: "Block/allow rules and blocklist subscriptions." },
            { name: "Local DNS", description: "Split-horizon records answered before policy." },
            { name: "Settings", description: "Resolver, logging, filtering, and linked-IP settings." },
            { name: "Account", description: "Identity and scope of the calling credential." },
          ],
        });
      },
    },
  },
});

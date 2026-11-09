import { createFileRoute } from "@tanstack/react-router";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";

import { resolveContext } from "../../server/orpc/context.server";
import { router } from "../../server/orpc/router.server";

const handler = new OpenAPIHandler(router);

async function handle(request: Request): Promise<Response> {
  let context;
  try {
    context = await resolveContext(request.headers);
  } catch (err) {
    const status = err instanceof ORPCError ? err.status : 401;
    const message = err instanceof Error ? err.message : "Unauthorized";
    return Response.json({ error: message }, { status });
  }

  const { matched, response } = await handler.handle(request, { prefix: "/rpc", context });
  if (!matched) return new Response("Not found", { status: 404 });
  return response;
}

export const Route = createFileRoute("/rpc/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
      PUT: ({ request }) => handle(request),
      PATCH: ({ request }) => handle(request),
      DELETE: ({ request }) => handle(request),
    },
  },
});

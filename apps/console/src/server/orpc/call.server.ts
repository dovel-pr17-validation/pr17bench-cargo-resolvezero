import "@tanstack/react-start/server-only";

import { getRequestHeaders } from "@tanstack/react-start/server";
import { createRouterClient } from "@orpc/server";

import { resolveContext } from "./context.server";
import { router } from "./router.server";

/**
 * In-process client for the console. The UI goes through the exact same
 * procedures (and therefore the same validation, scoping, and audit) as the
 * public API — only the transport differs.
 */
export async function sessionClient() {
  const context = await resolveContext(getRequestHeaders());
  return createRouterClient(router, { context });
}

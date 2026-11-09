import { createServerFn } from "@tanstack/react-start";

export type { SessionUser } from "./auth.server";

/** Session lookup for navigation guards. Private data still checks auth in its own handler. */
export const getSession = createServerFn({ method: "GET" }).handler(async () => {
  const { getSessionUser } = await import("./auth.server");
  return getSessionUser();
});

import { os } from "@orpc/server";

import type { ApiContext } from "./context.server";

/** Root builder: every procedure receives the resolved ApiContext. */
export const base = os.$context<ApiContext>();

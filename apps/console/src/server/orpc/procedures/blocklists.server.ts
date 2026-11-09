import "@tanstack/react-start/server-only";

import { z } from "zod";
import { ORPCError } from "@orpc/server";

import { base } from "../router-base.server";
import { requireScope } from "../context.server";
import { auditWrite } from "../audit.server";
import {
  createBlocklist,
  loadBlocklists,
  removeBlocklist,
  setBlocklistEnabled,
} from "../../dashboard/blocklists.server";
import { normalizeBlocklistFormat, normalizeBlocklistUrl } from "../../../lib/policy";
import { blocklistsSchema } from "../schemas.server";

const listInput = z.object({
  url: z.string().min(8).max(1024).describe("Raw list URL (http or https)."),
  format: z
    .enum(["auto", "hosts", "domains", "abp"])
    .default("auto")
    .describe("Leave as `auto` to let the edge detect the syntax."),
});

const listKey = z.object({ id: z.string().uuid() });
const listToggle = listKey.extend({ enabled: z.boolean() });

const listOutput = z.object({
  id: z.string(),
  url: z.string(),
  format: z.string(),
  enabled: z.boolean(),
});

function badRequest(err: unknown): never {
  throw new ORPCError("BAD_REQUEST", {
    message: err instanceof Error ? err.message : "Invalid blocklist",
  });
}

export const blocklists = {
  list: base
    .route({ method: "GET", path: "/blocklists", tags: ["Policy"], summary: "List blocklist subscriptions" })
    .output(blocklistsSchema)
    .handler(({ context }) => {
      requireScope(context, "read");
      return loadBlocklists(context.principal.userId, context.profileId);
    }),

  create: base
    .route({ method: "POST", path: "/blocklists", tags: ["Policy"], summary: "Subscribe to a blocklist" })
    .input(listInput)
    .output(listOutput)
    .handler(async ({ input, context }) => {
      requireScope(context, "read-write");
      try {
        const list = await createBlocklist(context.principal.userId, {
          url: normalizeBlocklistUrl(input.url),
          format: normalizeBlocklistFormat(input.format),
          profileId: context.profileId,
        });
        await auditWrite(context, {
          procedure: "blocklists.create",
          summary: `list ${new URL(list.url).host}${new URL(list.url).pathname} (${list.format})`,
        });
        return list;
      } catch (err) {
        badRequest(err);
      }
    }),

  setEnabled: base
    .route({ method: "POST", path: "/blocklists/enabled", tags: ["Policy"], summary: "Enable or disable a blocklist" })
    .input(listToggle)
    .output(z.object({ id: z.string(), enabled: z.boolean() }))
    .handler(async ({ input, context }) => {
      requireScope(context, "read-write");
      try {
        const row = await setBlocklistEnabled(
          context.principal.userId,
          input.id,
          input.enabled,
          context.profileId,
        );
        await auditWrite(context, {
          procedure: "blocklists.setEnabled",
          summary: `list ${row.id} → ${row.enabled ? "enabled" : "disabled"}`,
        });
        return row;
      } catch (err) {
        badRequest(err);
      }
    }),

  delete: base
    .route({ method: "DELETE", path: "/blocklists", tags: ["Policy"], summary: "Remove a blocklist" })
    .input(listKey)
    .output(z.object({ ok: z.literal(true) }))
    .handler(async ({ input, context }) => {
      requireScope(context, "read-write");
      try {
        const result = await removeBlocklist(context.principal.userId, input.id, context.profileId);
        await auditWrite(context, {
          procedure: "blocklists.delete",
          summary: `list ${input.id} → removed`,
        });
        return result;
      } catch (err) {
        badRequest(err);
      }
    }),
};

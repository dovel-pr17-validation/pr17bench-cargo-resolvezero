import "@tanstack/react-start/server-only";

import { z } from "zod";
import { ORPCError } from "@orpc/server";

import { base } from "../router-base.server";
import { requireScope } from "../context.server";
import { auditWrite } from "../audit.server";
import { purgeCache } from "../../dashboard/settings.server";
import {
  loadLocalDns,
  removeLocalDnsZone,
  upsertLocalDnsZone,
} from "../../dashboard/rules.server";
import { normalizeDomain, normalizeZoneInput } from "../../../lib/zone";
import { localDnsSchema } from "../schemas.server";

const zoneInput = z.object({
  domain: z.string().min(1).max(253).describe("Must end in .lan"),
  recordType: z.enum(["A", "AAAA", "CNAME", "TXT"]),
  values: z.union([z.string(), z.array(z.string())]),
  ttl: z.union([z.number(), z.string()]).optional(),
});

const zoneKey = z.object({
  domain: z.string().min(1).max(253),
  recordType: z.enum(["A", "AAAA", "CNAME", "TXT"]),
});

const purgeInput = z.object({
  domain: z.string().min(1).max(253),
  type: z.string().max(16).optional(),
});

function badRequest(err: unknown): never {
  throw new ORPCError("BAD_REQUEST", {
    message: err instanceof Error ? err.message : "Invalid request",
  });
}

export const localDns = {
  list: base
    .route({ method: "GET", path: "/local-dns", tags: ["Local DNS"], summary: "List local DNS records" })
    .output(localDnsSchema)
    .handler(({ context }) => {
      requireScope(context, "read");
      return loadLocalDns(context.principal.userId, context.profileId);
    }),

  upsert: base
    .route({ method: "PUT", path: "/local-dns", tags: ["Local DNS"], summary: "Create or update a local DNS record" })
    .input(zoneInput)
    .output(
      z.object({
        domain: z.string(),
        recordType: z.string(),
        values: z.array(z.string()),
        ttl: z.number(),
      }),
    )
    .handler(async ({ input, context }) => {
      requireScope(context, "read-write");
      try {
        const zone = normalizeZoneInput(input);
        const saved = await upsertLocalDnsZone(context.principal.userId, zone, context.profileId);
        await auditWrite(context, {
          procedure: "localDns.upsert",
          summary: `zone ${saved.domain} ${saved.recordType} → ${saved.values.join(", ")}`,
        });
        return saved;
      } catch (err) {
        badRequest(err);
      }
    }),

  delete: base
    .route({ method: "DELETE", path: "/local-dns", tags: ["Local DNS"], summary: "Delete a local DNS record" })
    .input(zoneKey)
    .output(z.object({ ok: z.literal(true) }))
    .handler(async ({ input, context }) => {
      requireScope(context, "read-write");
      try {
        const result = await removeLocalDnsZone(
          context.principal.userId,
          normalizeDomain(input.domain),
          input.recordType,
          context.profileId,
        );
        await auditWrite(context, {
          procedure: "localDns.delete",
          summary: `zone ${input.domain} ${input.recordType} → deleted`,
        });
        return result;
      } catch (err) {
        badRequest(err);
      }
    }),
};

export const cache = {
  purge: base
    .route({ method: "POST", path: "/cache/purge", tags: ["Settings"], summary: "Purge one name from the edge cache" })
    .input(purgeInput)
    .output(
      z.object({
        ok: z.boolean(),
        name: z.string(),
        type: z.string().nullable(),
      }),
    )
    .handler(async ({ input, context }) => {
      requireScope(context, "read-write");
      try {
        const result = await purgeCache(
          context.principal.userId,
          normalizeDomain(input.domain),
          input.type,
          context.profileId,
        );
        await auditWrite(context, {
          procedure: "cache.purge",
          summary: `cache ${input.domain}${input.type ? ` ${input.type}` : ""} → purged`,
        });
        return result;
      } catch (err) {
        badRequest(err);
      }
    }),
};

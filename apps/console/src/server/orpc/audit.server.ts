import "@tanstack/react-start/server-only";

import { db } from "@resolvezero/db/client";
import { apiAuditLog } from "@resolvezero/db/schema";

import type { ApiContext } from "./context.server";

export interface AuditEntry {
  procedure: string;
  /** Short human description, never the raw payload. */
  summary: string;
  status?: "ok" | "error";
}

export interface AuditRecord {
  profileId: string;
  userId: string;
  keyId: string | null;
  via: "session" | "key";
  procedure: string;
  summary: string;
  status?: "ok" | "error";
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Record a mutating call. Auditing must never fail the operation it describes,
 * so write failures are logged and swallowed.
 */
export async function recordAudit(record: AuditRecord): Promise<void> {
  try {
    await db.insert(apiAuditLog).values({
      profileId: record.profileId,
      userId: record.userId,
      keyId: record.keyId,
      via: record.via,
      procedure: record.procedure,
      summary: record.summary.slice(0, 255),
      status: record.status ?? "ok",
      ip: record.ip ?? null,
      userAgent: record.userAgent?.slice(0, 255) ?? null,
    });
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: "warn",
        msg: "api audit write failed",
        procedure: record.procedure,
        err: err instanceof Error ? err.message : String(err),
      }),
    );
  }
}

/** Convenience wrapper for procedures that already hold an ApiContext. */
export async function auditWrite(context: ApiContext, entry: AuditEntry): Promise<void> {
  await recordAudit({
    profileId: context.profileId,
    userId: context.principal.userId,
    keyId: context.principal.keyId,
    via: context.principal.via,
    procedure: entry.procedure,
    summary: entry.summary,
    status: entry.status,
    ip: context.request.ip,
    userAgent: context.request.userAgent,
  });
}

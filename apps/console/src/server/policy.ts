import { createServerFn } from "@tanstack/react-start";

import { sessionClient } from "./orpc/call.server";

const MAX_DOMAIN_LENGTH = 253;
const MAX_URL_LENGTH = 1024;
const MAX_ACTION_LENGTH = 16;
const MAX_ID_LENGTH = 64;

function validateProfileId(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") throw new Error("Invalid profile id");
  const value = raw.trim();
  if (!/^[0-9a-f-]{12,64}$/i.test(value)) throw new Error("Invalid profile id");
  return value;
}

function validateEnabled(raw: unknown): boolean {
  if (typeof raw !== "boolean") throw new Error("Invalid enabled state");
  return raw;
}

/** Structural only — full domain/URL validation runs in the authenticated handler. */
function validateRuleInput(data: unknown): { domain: string; action: string; profileId?: string } {
  if (!data || typeof data !== "object") throw new Error("Invalid rule input");
  const input = data as Record<string, unknown>;
  if (typeof input.domain !== "string" || input.domain.length > MAX_DOMAIN_LENGTH) {
    throw new Error("Invalid domain");
  }
  if (typeof input.action !== "string" || input.action.length > MAX_ACTION_LENGTH) {
    throw new Error("Invalid action");
  }
  return {
    domain: input.domain,
    action: input.action,
    profileId: validateProfileId(input.profileId),
  };
}

function validateRuleKey(data: unknown): { domain: string; profileId?: string } {
  if (!data || typeof data !== "object") throw new Error("Invalid rule input");
  const input = data as Record<string, unknown>;
  if (typeof input.domain !== "string" || input.domain.length > MAX_DOMAIN_LENGTH) {
    throw new Error("Invalid domain");
  }
  return { domain: input.domain, profileId: validateProfileId(input.profileId) };
}

function validateRuleToggle(data: unknown): { domain: string; enabled: boolean; profileId?: string } {
  const key = validateRuleKey(data);
  return { ...key, enabled: validateEnabled((data as Record<string, unknown>).enabled) };
}

function validateBlocklistInput(data: unknown): { url: string; format: string; profileId?: string } {
  if (!data || typeof data !== "object") throw new Error("Invalid blocklist input");
  const input = data as Record<string, unknown>;
  if (typeof input.url !== "string" || input.url.length > MAX_URL_LENGTH) {
    throw new Error("Invalid blocklist URL");
  }
  if (typeof input.format !== "string" || input.format.length > MAX_ACTION_LENGTH) {
    throw new Error("Invalid blocklist format");
  }
  return { url: input.url, format: input.format, profileId: validateProfileId(input.profileId) };
}

function validateListId(data: unknown): { id: string; profileId?: string } {
  if (!data || typeof data !== "object") throw new Error("Invalid blocklist input");
  const input = data as Record<string, unknown>;
  if (typeof input.id !== "string" || input.id.length > MAX_ID_LENGTH) {
    throw new Error("Invalid blocklist id");
  }
  return { id: input.id, profileId: validateProfileId(input.profileId) };
}

function validateListToggle(data: unknown): { id: string; enabled: boolean; profileId?: string } {
  const key = validateListId(data);
  return { ...key, enabled: validateEnabled((data as Record<string, unknown>).enabled) };
}

export const createRule = createServerFn({ method: "POST" })
  .validator(validateRuleInput)
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.rules.create({ domain: data.domain, action: data.action as "block" | "allow" });
  });

export const setRuleEnabled = createServerFn({ method: "POST" })
  .validator(validateRuleToggle)
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.rules.setEnabled({ domain: data.domain, enabled: data.enabled });
  });

export const deleteRule = createServerFn({ method: "POST" })
  .validator(validateRuleKey)
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.rules.delete({ domain: data.domain });
  });

export const createBlocklist = createServerFn({ method: "POST" })
  .validator(validateBlocklistInput)
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.blocklists.create({
      url: data.url,
      format: data.format as "auto" | "hosts" | "domains" | "abp",
    });
  });

export const setBlocklistEnabled = createServerFn({ method: "POST" })
  .validator(validateListToggle)
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.blocklists.setEnabled({ id: data.id, enabled: data.enabled });
  });

export const deleteBlocklist = createServerFn({ method: "POST" })
  .validator(validateListId)
  .handler(async ({ data }) => {
    const client = await sessionClient();
    return client.blocklists.delete({ id: data.id });
  });

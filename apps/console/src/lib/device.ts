/**
 * Device tags are the slugs carried in device-tagged DoH paths
 * (`/v1/:profile/:device`). The edge accepts `[a-zA-Z0-9_-]{1,32}` and stores
 * the slug verbatim, so the console must not normalise case or trim characters
 * the edge would have rejected anyway.
 */
export const DEVICE_TAG_RE = /^[a-zA-Z0-9_-]{1,32}$/;

/** Returns the tag when valid, undefined for "no filter", else throws. */
export function parseDeviceTag(raw: unknown): string | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || !DEVICE_TAG_RE.test(raw)) throw new Error("Invalid device tag");
  return raw;
}

/** Turns a human device name into a valid edge device tag. */
export function slugifyDevice(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

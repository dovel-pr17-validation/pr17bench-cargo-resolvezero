export const MAX_WAITLIST_EMAIL_LENGTH = 254;

/** Pragmatic shape check; Better Auth validates properly when the invite is used. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trim + lowercase, reject obviously malformed addresses. */
export function normalizeWaitlistEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length < 5 || email.length > MAX_WAITLIST_EMAIL_LENGTH) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

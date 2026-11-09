/**
 * Resolver-presence canary.
 *
 * The console asks the browser to look up `<nonce>.probe.<domain>`. The
 * hostname intentionally has no public DNS record. Only a client whose
 * resolver is this edge will send the query here; the edge records the nonce
 * and returns NXDOMAIN. The console then checks the database for the nonce.
 *
 * Keeping the lookup NXDOMAIN means we do not need a wildcard TLS certificate:
 * the browser only has to make the DNS query, not complete an HTTPS request.
 */

const NONCE_RE = /^[a-z0-9]{16,64}$/;

/** Canonicalize `PROBE_DOMAIN` (`probe.resolvezero.com`, `.probe...`, trailing dot). */
export function normalizeProbeDomain(raw: string | undefined): string | null {
  const domain = raw?.trim().toLowerCase().replace(/^\.+|\.+$/g, "") ?? "";
  return domain || null;
}

/**
 * Returns the nonce when `name` is exactly `<nonce>.<probeDomain>`.
 * Deeper labels are rejected so a crafted name cannot smuggle arbitrary
 * labels into the probe namespace.
 */
export function matchProbeNonce(name: string, probeDomain: string | null): string | null {
  if (!probeDomain) return null;
  const lower = name.toLowerCase().replace(/\.+$/, "");
  const suffix = `.${probeDomain}`;
  if (!lower.endsWith(suffix)) return null;
  const nonce = lower.slice(0, -suffix.length);
  if (!nonce || nonce.includes(".") || !NONCE_RE.test(nonce)) return null;
  return nonce;
}

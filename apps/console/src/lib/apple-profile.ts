export interface AppleProfileInput {
  /** Profile display name, e.g. "Home". */
  profileName: string;
  /** Device label used in the DoH path and the file name. */
  device: string;
  /** DoH URL (https) or DoT server name, depending on `kind`. */
  kind: "https" | "tls";
  /** DoH endpoint for kind=https. */
  dohUrl?: string;
  /** DoT hostname for kind=tls. */
  serverName?: string;
  /** Test seam; defaults to random UUIDs. */
  uuids?: { root: string; dns: string };
}

export const APPLE_PROFILE_MIME = "application/x-apple-aspen-config";

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Apple DNS settings profile (iOS 14+, iPadOS 14+, macOS 11+).
 * Unsigned profiles install with an "Unverified" badge; signing needs an Apple
 * Developer certificate.
 */
export function buildAppleProfile(input: AppleProfileInput): string {
  const rootUuid = input.uuids?.root ?? crypto.randomUUID();
  const dnsUuid = input.uuids?.dns ?? crypto.randomUUID();
  const suffix = `${escapeXml(input.profileName)} — ${escapeXml(input.device)}`;

  const dnsSettings =
    input.kind === "https"
      ? `        <key>DNSProtocol</key>
        <string>HTTPS</string>
        <key>ServerURL</key>
        <string>${escapeXml(input.dohUrl ?? "")}</string>`
      : `        <key>DNSProtocol</key>
        <string>TLS</string>
        <key>ServerName</key>
        <string>${escapeXml(input.serverName ?? "")}</string>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>PayloadType</key>
      <string>com.apple.dnsSettings.managed</string>
      <key>PayloadIdentifier</key>
      <string>com.resolvezero.dns.${escapeXml(input.device)}</string>
      <key>PayloadUUID</key>
      <string>${dnsUuid}</string>
      <key>PayloadDisplayName</key>
      <string>ResolveZero DNS</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
      <key>DNSSettings</key>
      <dict>
${dnsSettings}
      </dict>
      <key>ProhibitDisablement</key>
      <false/>
    </dict>
  </array>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadIdentifier</key>
  <string>com.resolvezero.profile.${escapeXml(input.device)}</string>
  <key>PayloadUUID</key>
  <string>${rootUuid}</string>
  <key>PayloadDisplayName</key>
  <string>ResolveZero — ${escapeXml(input.device)}</string>
  <key>PayloadDescription</key>
  <string>Encrypted DNS (${suffix} · ${input.kind === "https" ? "DoH" : "DoT"}).</string>
  <key>PayloadOrganization</key>
  <string>ResolveZero</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>PayloadRemovalDisallowed</key>
  <false/>
</dict>
</plist>
`;
}

/** Safe, lowercase device label for URLs and file names. */
export function normalizeDeviceSlug(raw: unknown): string {
  const slug = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  if (!slug) throw new Error("Device name is required");
  return slug;
}

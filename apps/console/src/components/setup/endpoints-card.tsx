import { Cable } from 'lucide-react'

import { CopyRow } from './shared'

export function EndpointsCard({
  profileId,
  dohUrl,
  dotHost,
  dnsIps,
  onGenerateDot,
  generatingDot,
}: {
  profileId: string
  dohUrl: string
  dotHost: string | null
  dnsIps: string[]
  onGenerateDot: () => void
  generatingDot: boolean
}) {
  return (
    <div className="rz-card flex flex-col p-5">
      <div>
        <h2 className="rz-section-title">
          <Cable size={14} className="mr-2 inline text-[var(--brand)]" />
          Endpoints
        </h2>
        <p className="mt-1.5 text-[11px] text-[var(--muted)]">
          Set up this profile with one of these addresses. The DoH URL is the shared, untagged form.
        </p>
      </div>

      <div className="mt-4 space-y-3">
        <CopyRow label="Profile ID" value={profileId} />
        <CopyRow label="DNS-over-HTTPS" value={dohUrl} note="Add /<device> before the token to tag a device." />
        {dotHost ? (
          <CopyRow label="DNS-over-TLS" value={dotHost} note="One hostname for the whole profile." />
        ) : (
          <div className="space-y-1.5">
            <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">DNS-over-TLS</p>
            <div className="flex items-center justify-between gap-3 rounded-[var(--radius-sm)] border border-dashed border-[var(--line-strong)] px-3 py-2">
              <span className="text-[11px] text-[var(--muted)]">No hostname yet</span>
              <button
                type="button"
                onClick={onGenerateDot}
                disabled={generatingDot}
                className="text-[11px] font-medium text-[var(--brand)] hover:underline disabled:opacity-50"
              >
                {generatingDot ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </div>
        )}
        <CopyRow
          label="IPv4 DNS servers (linked IP)"
          value={dnsIps.join('  ·  ')}
          note="Point a router or OS at both addresses for plain DNS."
        />
      </div>
    </div>
  )
}

import { MonitorSmartphone } from 'lucide-react'

import { CopyRow } from './shared'

export function IdentifyDevicesCard({
  dohBase,
  token,
  dotHost,
}: {
  dohBase: string
  token: string
  dotHost: string | null
}) {
  return (
    <div className="rz-card p-5">
      <h2 className="rz-section-title">
        <MonitorSmartphone size={14} className="mr-2 inline text-[var(--brand)]" />
        Identify your devices
      </h2>
      <p className="mt-1.5 text-[11px] text-[var(--muted)]">
        Per-device logs and stats come from naming the device in the URL. Each device should get its own name.
      </p>

      <div className="mt-4 space-y-4">
        <CopyRow
          label="DNS-over-HTTPS — device is a path segment"
          value={`${dohBase}/living-room-tv/${token}`}
          note="Use any lowercase name (letters, digits, dashes) in place of living-room-tv."
          mono
        />
        <div className="space-y-1">
          <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">DNS-over-TLS</p>
          <p className="text-[11px] leading-5 text-[var(--muted)]">
            {dotHost ? (
              <>
                <code className="font-mono">{dotHost}</code> is one hostname for the whole profile — DoT clients share
                attribution. Use DoH when you need per-device numbers.
              </>
            ) : (
              'DoT is one hostname per profile. Generate it above to use private DNS on Android, Linux, or a router.'
            )}
          </p>
        </div>
        <p className="text-[10px] leading-5 text-[var(--muted)]">
          No app reports a device name automatically yet. Browsers with their own DoH (Chrome, Firefox) also bypass the
          operating system resolver, so configure DoH at the OS or router to keep attribution.
        </p>
      </div>
    </div>
  )
}

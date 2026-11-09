import { Apple, Globe, Laptop, Router, Smartphone, SquareTerminal } from 'lucide-react'
import { useState } from 'react'

import { slugifyDevice } from '../../lib/device'
import { SetupMethod, type SetupTab } from './setup-methods'

const TABS: { key: SetupTab; label: string; icon: typeof Router }[] = [
  { key: 'router', label: 'Routers', icon: Router },
  { key: 'ios', label: 'iOS', icon: Smartphone },
  { key: 'android', label: 'Android', icon: Smartphone },
  { key: 'windows', label: 'Windows', icon: Laptop },
  { key: 'macos', label: 'macOS', icon: Apple },
  { key: 'linux', label: 'Linux', icon: SquareTerminal },
  { key: 'browsers', label: 'Browsers', icon: Globe },
]

export function SetupTabs({
  dohBase,
  token,
  dotHost,
  dnsIps,
  onGenerateDot,
  generatingDot,
}: {
  dohBase: string
  token: string
  dotHost: string | null
  dnsIps: string[]
  onGenerateDot: () => void
  generatingDot: boolean
}) {
  const [tab, setTab] = useState<SetupTab>('router')
  const [device, setDevice] = useState('')

  const slug = slugifyDevice(device)
  // Untagged form is `<base>/<token>`; naming the device adds the tag segment.
  const dohUrl = slug ? `${dohBase}/${slug}/${token}` : `${dohBase}/${token}`

  return (
    <div className="rz-card overflow-hidden">
      <div className="border-b border-[var(--line)] p-5">
        <h2 className="rz-section-title">Setup guide</h2>
        <p className="mt-1.5 text-[11px] text-[var(--muted)]">
          Follow the instructions for the device or router that should use this profile.
        </p>

        <div className="mt-4 max-w-[420px] space-y-1.5">
          <label
            htmlFor="setup-device"
            className="block text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]"
          >
            Device name
          </label>
          <input
            id="setup-device"
            value={device}
            onChange={(event) => setDevice(event.target.value)}
            placeholder="living room tv"
            autoComplete="off"
            spellCheck={false}
            className="rz-input w-full"
          />
          <p className="text-[10px] leading-5 text-[var(--muted)]">
            Optional. The name becomes the device tag used in logs and per-device stats. Leave it empty for one shared,
            untagged URL.
          </p>
        </div>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-[var(--line)] px-5 py-3">
        {TABS.map((option) => {
          const Icon = option.icon
          return (
            <button
              key={option.key}
              type="button"
              aria-pressed={tab === option.key}
              onClick={() => setTab(option.key)}
              className={[
                'flex shrink-0 items-center gap-1.5 rounded-[var(--radius-sm)] px-2.5 py-1.5 text-[11px] transition-colors',
                tab === option.key
                  ? 'bg-[var(--brand)] text-white'
                  : 'text-[var(--muted)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]',
              ].join(' ')}
            >
              <Icon size={12} />
              {option.label}
            </button>
          )
        })}
      </div>

      <div className="space-y-5 p-5">
        <SetupMethod
          tab={tab}
          dohUrl={dohUrl}
          dotHost={dotHost}
          dnsIps={dnsIps}
          slug={slug}
          onGenerateDot={onGenerateDot}
          generatingDot={generatingDot}
        />
        <p className="border-t border-[var(--line)] pt-3 text-[10px] leading-5 text-[var(--muted)]">
          Treat these addresses as credentials — anyone with the URL or hostname can resolve through this profile. Name
          a device above to give it its own DoH URL.
        </p>
      </div>
    </div>
  )
}

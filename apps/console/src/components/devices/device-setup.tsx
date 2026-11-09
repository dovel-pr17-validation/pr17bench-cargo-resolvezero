import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Check, Copy, Download } from 'lucide-react'

import { slugifyDevice } from '../../lib/device'
import { getDeviceSetup, ensureDotId } from '../../server/device-setup'
import { Button } from '../ui/button'

const TABS = ['Apple', 'Android', 'Other'] as const
type Tab = (typeof TABS)[number]

export function DeviceSetup({ onDone }: { onDone: () => void }) {
  const queryClient = useQueryClient()
  const [device, setDevice] = useState('')
  const [tab, setTab] = useState<Tab>('Apple')
  const [copied, setCopied] = useState<string | null>(null)

  const { data, isPending, isError } = useQuery({
    queryKey: ['device-setup'],
    queryFn: () => getDeviceSetup(),
  })

  const dot = useMutation({
    mutationFn: () => ensureDotId(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['device-setup'] }),
  })

  const slug = slugifyDevice(device)
  const dohUrl = data && slug ? `${data.dohBase}/${slug}/${data.token}` : ''
  const dotHost = dot.data?.hostname ?? data?.dotHostname ?? null

  async function copy(key: string, value: string) {
    await navigator.clipboard.writeText(value)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="border-b border-[var(--line)] bg-[var(--paper)]/40 p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          autoFocus
          value={device}
          onChange={(event) => setDevice(event.target.value)}
          placeholder="Device name, e.g. living room tv"
          aria-label="Device name"
          className="rz-input min-w-0 flex-1 font-mono"
        />
        <div className="flex items-center border border-[var(--line-strong)]">
          {TABS.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={tab === option}
              onClick={() => setTab(option)}
              className={[
                'px-3 py-2 text-[10px] font-medium uppercase tracking-[0.06em] transition-colors',
                tab === option ? 'bg-[var(--ink)] text-[var(--paper)]' : 'text-[var(--muted)] hover:text-[var(--ink)]',
              ].join(' ')}
            >
              {option}
            </button>
          ))}
        </div>
        <Button type="button" variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>

      {isPending ? <p className="mt-3 text-[11px] text-[var(--muted)]">Loading profile details…</p> : null}
      {isError ? (
        <p role="alert" className="mt-3 text-[11px] text-[var(--danger)]">
          Could not load the profile's DoH token.
        </p>
      ) : null}

      {data ? (
        <div className="mt-3 space-y-3 text-[11px] leading-5 text-[var(--muted)]">
          {tab === 'Apple' ? (
            <>
              <p>
                Download the profile, then open <span className="font-medium text-[var(--ink)]">Settings → Profile Downloaded</span> to
                install it. iOS shows an “Unverified” badge because the profile is unsigned.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild disabled={!slug}>
                  <a href={`/api/profile/${slug || 'device'}`} download>
                    <Download size={13} /> Download .mobileconfig
                  </a>
                </Button>
                {!slug ? <span className="text-[10px]">Name the device first</span> : null}
              </div>
            </>
          ) : null}

          {tab === 'Android' ? (
            <>
              <p>
                Settings → Network &amp; internet → Private DNS → <span className="font-medium text-[var(--ink)]">Private DNS provider
                hostname</span>, then paste:
              </p>
              {dotHost ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <code className="min-w-0 flex-1 overflow-x-auto border border-[var(--line-strong)] bg-[var(--card)] px-3 py-2 font-mono text-[11px] text-[var(--ink)]">
                    {dotHost}
                  </code>
                  <Button variant="secondary" onClick={() => void copy('dot', dotHost)}>
                    {copied === 'dot' ? <Check size={13} /> : <Copy size={13} />}
                    {copied === 'dot' ? 'Copied' : 'Copy'}
                  </Button>
                </div>
              ) : (
                <Button onClick={() => dot.mutate()} disabled={dot.isPending}>
                  {dot.isPending ? 'Generating…' : 'Enable DoT and generate hostname'}
                </Button>
              )}
              {dot.isError ? (
                <p role="alert" className="text-[11px] text-[var(--danger)]">
                  {dot.error.message}
                </p>
              ) : null}
            </>
          ) : null}

          {tab === 'Other' ? (
            <>
              <p>Use this DoH URL in a browser, router, or any app that accepts a custom resolver:</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 overflow-x-auto border border-[var(--line-strong)] bg-[var(--card)] px-3 py-2 font-mono text-[11px] text-[var(--ink)]">
                  {dohUrl || 'Name the device first'}
                </code>
                {dohUrl ? (
                  <Button variant="secondary" onClick={() => void copy('doh', dohUrl)}>
                    {copied === 'doh' ? <Check size={13} /> : <Copy size={13} />}
                    {copied === 'doh' ? 'Copied' : 'Copy'}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

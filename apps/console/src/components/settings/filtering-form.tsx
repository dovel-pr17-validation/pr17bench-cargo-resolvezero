import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { BLOCKED_SERVICES } from '@resolvezero/db/services'
import { BLOCK_MODES, SAFE_SEARCH_KEYS, type BlockMode, type SafeSearchKey } from '../../lib/settings'
import { updateSettings } from '../../server/dashboard'
import type { SettingsData } from '../../server/dashboard/types'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'

const BLOCK_MODE_LABELS: Record<BlockMode, string> = {
  null: 'Null address (0.0.0.0 / ::)',
  nxdomain: 'NXDOMAIN (name does not exist)',
  refused: 'Refused',
  custom: 'Custom address',
}

const SAFE_SEARCH_LABELS: Record<SafeSearchKey, { label: string; detail: string }> = {
  google: { label: 'Google', detail: 'forcesafesearch.google.com' },
  bing: { label: 'Bing', detail: 'strict.bing.com' },
  duckduckgo: { label: 'DuckDuckGo', detail: 'safe.duckduckgo.com' },
  youtube: { label: 'YouTube', detail: 'restrict.youtube.com · best effort' },
}

export function FilteringForm({ initial }: { initial: SettingsData }) {
  const queryClient = useQueryClient()
  const [blockMode, setBlockMode] = useState<BlockMode>(initial.blockMode)
  const [blockIpv4, setBlockIpv4] = useState(initial.blockIpv4 ?? '')
  const [blockIpv6, setBlockIpv6] = useState(initial.blockIpv6 ?? '')
  const [blockTtl, setBlockTtl] = useState(String(initial.blockTtl))
  const [safeSearch, setSafeSearch] = useState<Record<string, boolean>>(initial.safeSearch ?? {})
  const [services, setServices] = useState<string[]>(initial.blockedServices)

  const save = useMutation({
    mutationFn: () =>
      updateSettings({
        data: {
          upstream: initial.upstream as 'cloudflare' | 'google' | 'quad9' | null,
          upstreamUrl: initial.upstreamUrl,
          logQueries: initial.logQueries,
          logRetentionDays: initial.logRetentionDays,
          blockMode,
          blockIpv4: blockMode === 'custom' ? blockIpv4.trim() || null : null,
          blockIpv6: blockMode === 'custom' ? blockIpv6.trim() || null : null,
          blockTtl: Number(blockTtl),
          safeSearch,
          blockedServices: services,
        },
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  })

  function toggleService(id: string) {
    setServices((current) => (current.includes(id) ? current.filter((value) => value !== id) : [...current, id]))
  }

  return (
    <form
      className="space-y-5 p-5"
      onSubmit={(event) => {
        event.preventDefault()
        save.mutate()
      }}
    >
      <div className="space-y-1.5">
        <label className="block text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">
          Blocked answer
        </label>
        <Select value={blockMode} onValueChange={(value) => setBlockMode(value as BlockMode)}>
          <SelectTrigger className="w-full" aria-label="Blocked answer mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BLOCK_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {BLOCK_MODE_LABELS[mode]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] leading-5 text-[var(--muted)]">
          NXDOMAIN makes blocked sites fail instantly; the default null address can leave apps retrying until they time out.
        </p>
      </div>

      {blockMode === 'custom' ? (
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label className="block text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">IPv4</label>
            <input
              value={blockIpv4}
              onChange={(event) => setBlockIpv4(event.target.value)}
              placeholder="0.0.0.0"
              aria-label="Custom block IPv4"
              spellCheck={false}
              className="rz-input w-full font-mono"
            />
          </div>
          <div className="space-y-1.5">
            <label className="block text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">IPv6</label>
            <input
              value={blockIpv6}
              onChange={(event) => setBlockIpv6(event.target.value)}
              placeholder="::"
              aria-label="Custom block IPv6"
              spellCheck={false}
              className="rz-input w-full font-mono"
            />
          </div>
        </div>
      ) : null}

      <div className="space-y-1.5">
        <label className="block text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">
          Block TTL (seconds)
        </label>
        <input
          value={blockTtl}
          onChange={(event) => setBlockTtl(event.target.value)}
          inputMode="numeric"
          aria-label="Blocked answer TTL"
          className="rz-input w-[120px] font-mono"
        />
      </div>

      <div className="border-t border-[var(--line)] pt-4">
        <p className="text-[12px] font-semibold">SafeSearch</p>
        <p className="mt-0.5 text-[10px] text-[var(--muted)]">Rewrites the search host to the provider&apos;s safe endpoint.</p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {SAFE_SEARCH_KEYS.map((key) => (
            <label key={key} className="flex items-center justify-between gap-3">
              <span>
                <span className="block text-[11px] font-medium">{SAFE_SEARCH_LABELS[key].label}</span>
                <span className="block text-[10px] text-[var(--muted)]">{SAFE_SEARCH_LABELS[key].detail}</span>
              </span>
              <Switch
                checked={safeSearch[key] === true}
                onCheckedChange={(checked) => setSafeSearch((current) => ({ ...current, [key]: checked }))}
                aria-label={`Force SafeSearch on ${SAFE_SEARCH_LABELS[key].label}`}
              />
            </label>
          ))}
        </div>
      </div>

      <div className="border-t border-[var(--line)] pt-4">
        <p className="text-[12px] font-semibold">Blocked services</p>
        <p className="mt-0.5 text-[10px] text-[var(--muted)]">Blocks every domain the service needs. Explicit allow rules still win.</p>
        <div className="mt-3 flex flex-wrap gap-2">
          {BLOCKED_SERVICES.map((service) => {
            const active = services.includes(service.id)
            return (
              <button
                key={service.id}
                type="button"
                aria-pressed={active}
                onClick={() => toggleService(service.id)}
                className={[
                  'rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-[11px] transition-colors',
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]'
                    : 'border-[var(--line-strong)] text-[var(--muted)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]',
                ].join(' ')}
              >
                {service.label}
              </button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-[var(--line)] pt-4">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save filtering'}
        </Button>
        {save.isSuccess ? <span className="text-[10px] text-[var(--green)]">Saved</span> : null}
      </div>

      {save.isError ? (
        <p role="alert" className="text-[11px] text-[var(--danger)]">
          {save.error.message}
        </p>
      ) : null}
    </form>
  )
}

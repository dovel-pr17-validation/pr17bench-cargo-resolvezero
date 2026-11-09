import { RefreshCw, Search } from 'lucide-react'

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Switch } from '../ui/switch'
import { Button } from '../ui/button'
import type { Pop } from '../../lib/pops'
import { formatZoned } from '../../lib/time'
import { useTimeZone } from '../../lib/use-timezone'

export const ALL_DEVICES = '__all_devices__'
export const ALL_POPS = '__all_pops__'

export function LogFilters({
  search,
  onSearch,
  blockedOnly,
  onBlockedOnly,
  device,
  onDevice,
  devices,
  pop,
  onPop,
  pops,
  live,
  fetching,
  updatedAt,
  added,
  total,
  onRefresh,
}: {
  search: string
  onSearch: (value: string) => void
  blockedOnly: boolean
  onBlockedOnly: (value: boolean) => void
  device: string
  onDevice: (value: string) => void
  devices: { device: string }[]
  pop: string
  onPop: (value: string) => void
  pops: Pop[]
  live: boolean
  fetching: boolean
  updatedAt: number | null
  added: number
  total: number
  onRefresh: () => void
}) {
  const { zone } = useTimeZone()
  return (
    <div className="flex flex-col gap-3 border-b border-[var(--line)] bg-[var(--paper)]/50 px-4 py-3 xl:flex-row xl:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-transparent px-3 py-1.5 text-[11px] text-[var(--muted)]">
        <Search size={13} />
        <input
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="Filter by domain"
          className="w-full bg-transparent text-[11px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="w-[170px]">
          <Select value={device} onValueChange={onDevice}>
            <SelectTrigger aria-label="Device" className="h-8 py-0 text-[12px] font-medium">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_DEVICES}>All devices</SelectItem>
              {devices.map((option) => (
                <SelectItem key={option.device} value={option.device}>
                  {option.device}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="w-[170px]">
          <Select value={pop} onValueChange={onPop}>
            <SelectTrigger aria-label="POP" className="h-8 py-0 text-[12px] font-medium">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_POPS}>All POPs</SelectItem>
              {pops.map((option) => (
                <SelectItem key={option.code} value={option.code}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <label
          htmlFor="blocked-only"
          className="flex cursor-pointer items-center gap-2 text-[12px] font-medium text-[var(--muted)]"
        >
          <Switch id="blocked-only" checked={blockedOnly} onCheckedChange={onBlockedOnly} />
          <span className={blockedOnly ? 'text-[var(--accent)]' : undefined}>Blocked only</span>
        </label>

        <Button type="button" variant="secondary" size="sm" onClick={onRefresh} disabled={fetching}>
          <RefreshCw size={12} className={fetching ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--muted)] xl:ml-2">
        <span className="flex items-center gap-1.5">
          <span className={['size-1.5 rounded-full', live ? 'bg-[var(--green)]' : 'bg-[var(--warning)]'].join(' ')} />
          {live ? 'Live · appends' : 'Paused'}
        </span>
        {updatedAt ? (
          <>
            <span className="text-[var(--line-strong)]">·</span>
            <span className="rz-mono text-[var(--ink)]">
              {formatZoned(updatedAt, 'HH:mm:ss', zone)}
            </span>
          </>
        ) : null}
        {added > 0 ? <span className="text-[var(--green)]">+{added} new</span> : null}
        <span className="text-[var(--line-strong)]">·</span>
        <span className="rz-mono text-[var(--ink)]">{total}</span>
        <span>rows</span>
      </div>
    </div>
  )
}

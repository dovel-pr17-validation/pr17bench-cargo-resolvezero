import { Clock3 } from 'lucide-react'

import type { TimeZonePref } from '../../lib/time'
import { useTimeZone } from '../../lib/use-timezone'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu'

/**
 * Compact timezone switch, PlanetScale-style: browser-local or UTC. The
 * preference is per browser (localStorage), not per profile — it changes how
 * timestamps are displayed, not what is stored.
 */
export function TimeZoneMenu() {
  const { pref, label, browserLabel, setPref } = useTimeZone()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Time zone: ${label}`}
          title={`Timestamps are shown in ${pref === 'utc' ? 'UTC' : 'browser time'}. Change it here.`}
          className="flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--card)] px-2.5 text-[11px] font-medium text-[var(--muted)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
        >
          <Clock3 size={12} />
          <span className="hidden sm:inline">{label}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={10} className="w-[252px]">
        <DropdownMenuLabel>Timezone display preference</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={pref}
          onValueChange={(value) => setPref(value as TimeZonePref)}
        >
          <DropdownMenuRadioItem value="browser">Browser time ({browserLabel})</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="utc">Coordinated Universal Time (UTC)</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

import { formatInTimeZone } from 'date-fns-tz'

/** How the viewer wants absolute timestamps rendered. Stored per browser. */
export type TimeZonePref = 'browser' | 'utc'

const STORAGE_KEY = 'rz_timezone'
const CHANGE_EVENT = 'rz:timezone'

/** Reject anything Intl does not recognise instead of throwing on render. */
export function normalizeTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return 'UTC'
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value })
    return value
  } catch {
    return 'UTC'
  }
}

/** The IANA zone the browser reports, falling back to UTC. */
export function browserTimeZone(): string {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
  } catch {
    return 'UTC'
  }
}

export function resolveTimeZone(pref: TimeZonePref): string {
  return pref === 'utc' ? 'UTC' : browserTimeZone()
}

/** "UTC" or the zone's current offset, e.g. "GMT+1". */
export function zoneLabel(zone: string): string {
  if (zone === 'UTC') return 'UTC'
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      timeZoneName: 'shortOffset',
    }).formatToParts(new Date())
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? zone
  } catch {
    return zone
  }
}

/** Format an instant (ISO string, epoch ms or Date) in an explicit zone. */
export function formatZoned(value: string | number | Date, pattern: string, zone: string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  try {
    return formatInTimeZone(date, zone, pattern)
  } catch {
    return formatInTimeZone(date, 'UTC', pattern)
  }
}

export function readTimeZonePref(): TimeZonePref {
  if (typeof window === 'undefined') return 'browser'
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'utc' ? 'utc' : 'browser'
  } catch {
    return 'browser'
  }
}

export function writeTimeZonePref(pref: TimeZonePref): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, pref)
  } catch {
    // Private mode / blocked storage: keep the in-memory selection working.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT))
}

export function subscribeTimeZonePref(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  window.addEventListener(CHANGE_EVENT, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(CHANGE_EVENT, listener)
    window.removeEventListener('storage', listener)
  }
}

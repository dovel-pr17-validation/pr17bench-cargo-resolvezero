import { useSyncExternalStore } from 'react'

import {
  browserTimeZone,
  formatZoned,
  readTimeZonePref,
  resolveTimeZone,
  subscribeTimeZonePref,
  writeTimeZonePref,
  zoneLabel,
  type TimeZonePref,
} from './time'

/**
 * Reactive timezone preference.
 *
 * The server snapshot is pinned to UTC so the hydrating render matches the
 * SSR HTML (Fly runs in UTC); the stored browser preference takes over
 * immediately after hydration. Without that pin the header label would
 * differ between server and client and React would warn.
 */
export function useTimeZone() {
  const pref = useSyncExternalStore(
    subscribeTimeZonePref,
    readTimeZonePref,
    () => 'utc' as TimeZonePref,
  )
  const zone = resolveTimeZone(pref)

  return {
    pref,
    zone,
    /** Label for the active zone, e.g. "GMT+1" or "UTC". */
    label: zoneLabel(zone),
    /** Label for the browser's own zone, regardless of the active choice. */
    browserLabel: zoneLabel(browserTimeZone()),
    setPref: writeTimeZonePref,
  }
}

/** Bound formatter: `const fmt = useZonedFormat(); fmt(iso, 'HH:mm')`. */
export function useZonedFormat() {
  const { zone } = useTimeZone()
  return (value: string | number | Date, pattern: string) => formatZoned(value, pattern, zone)
}

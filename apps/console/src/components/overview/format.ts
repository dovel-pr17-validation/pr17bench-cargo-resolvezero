const REGION_NAMES: Record<string, string> = {
  fra: 'Frankfurt',
  lhr: 'London',
  iad: 'Ashburn',
  sjc: 'San José',
  nrt: 'Tokyo',
  syd: 'Sydney',
  gru: 'São Paulo',
}

export function regionLabel(region: string | null): string {
  if (!region) return '—'
  return REGION_NAMES[region] ?? region.toUpperCase()
}

export function ageLabel(ms: number | null): string {
  if (ms == null) return '—'
  const seconds = Math.max(0, Math.round(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  return `${Math.round(seconds / 60)}m`
}

export function greetingForHour(hour: number): string {
  if (hour < 12) return 'Good morning'
  if (hour < 18) return 'Good afternoon'
  if (hour < 22) return 'Good evening'
  return 'Good night'
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-GB').format(n)
}

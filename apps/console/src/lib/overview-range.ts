export type OverviewRangeKey = '1h' | '24h' | '7d' | '30d'

export interface OverviewRangeConfig {
  key: OverviewRangeKey
  label: string
  description: string
  ms: number
  bucketMs: number
  source: 'minute' | 'hour'
}

const HOUR = 3_600_000
const DAY = 24 * HOUR

export const OVERVIEW_RANGES: OverviewRangeConfig[] = [
  { key: '1h', label: '1H', description: 'Last hour', ms: HOUR, bucketMs: 5 * 60_000, source: 'minute' },
  { key: '24h', label: '24H', description: 'Last 24 hours', ms: DAY, bucketMs: HOUR, source: 'hour' },
  { key: '7d', label: '7D', description: 'Last 7 days', ms: 7 * DAY, bucketMs: 6 * HOUR, source: 'hour' },
  { key: '30d', label: '30D', description: 'Last 30 days', ms: 30 * DAY, bucketMs: DAY, source: 'hour' },
]

export const DEFAULT_OVERVIEW_RANGE: OverviewRangeKey = '24h'

const byKey = new Map(OVERVIEW_RANGES.map((range) => [range.key, range]))

export function overviewRange(key: string | undefined): OverviewRangeConfig {
  return byKey.get(key as OverviewRangeKey) ?? byKey.get(DEFAULT_OVERVIEW_RANGE)!
}

export function isOverviewRange(key: string): key is OverviewRangeKey {
  return byKey.has(key as OverviewRangeKey)
}

import { createFileRoute, Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { getHours } from 'date-fns'
import { useEffect, useState } from 'react'
import { Ban, Clock3, FileText, Globe2, Monitor, ShieldCheck } from 'lucide-react'

import { PageError } from '../components/data-state'
import { PageHeader } from '../components/page-header'
import { DevicesCard, LocalDnsCard, TopBlockedCard } from '../components/overview/breakdown'
import { ageLabel, formatNumber, greetingForHour, regionLabel } from '../components/overview/format'
import { OverviewSkeleton, PulseMetric } from '../components/overview/pulse'
import { QueryChart } from '../components/overview/query-chart'
import { LiveTrafficCard, PostureCard } from '../components/overview/traffic'
import { Button } from '../components/ui/button'
import { DEVICE_TAG_RE } from '../lib/device'
import { OVERVIEW_RANGES, overviewRange, type OverviewRangeKey } from '../lib/overview-range'
import { formatZoned } from '../lib/time'
import { useTimeZone } from '../lib/use-timezone'
import { getOverview, getQueryVolume } from '../server/dashboard'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'

const ALL_DEVICES = '__all__'

export const Route = createFileRoute('/')({
  // The device filter lives in the URL so a scoped view can be bookmarked and
  // shared; the server re-validates the same regex.
  validateSearch: (search: Record<string, unknown>) => {
    const device = typeof search.device === 'string' && DEVICE_TAG_RE.test(search.device) ? search.device : undefined
    return device ? { device } : {}
  },
  component: Overview,
})

function Overview() {
  const { device: deviceParam } = Route.useSearch()
  const navigate = Route.useNavigate()
  const { zone } = useTimeZone()
  const device = deviceParam ?? ALL_DEVICES
  const deviceFilter = deviceParam

  function chooseDevice(next: string) {
    void navigate({ search: next === ALL_DEVICES ? {} : { device: next } })
  }
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['overview', device],
    queryFn: () => getOverview({ data: { device: deviceFilter } }),
  })
  const [range, setRange] = useState<OverviewRangeKey>('24h')
  const { data: volume, isPending: volumePending } = useQuery({
    queryKey: ['query-volume', range, device],
    queryFn: () => getQueryVolume({ data: { range, device: deviceFilter } }),
  })
  const [greeting, setGreeting] = useState('Hello')

  // Resolve in the browser so the greeting matches the viewer's local time,
  // not the SSR/Fly machine timezone. Starting with "Hello" avoids hydration
  // mismatches when the server and browser are in different zones.
  useEffect(() => {
    setGreeting(greetingForHour(getHours(new Date())))
  }, [])

  const profileLabel = data ? data.profileName.charAt(0).toUpperCase() + data.profileName.slice(1) : ''
  const firstName = data ? data.viewer.name.split(/\s+/)[0] || 'there' : ''
  const region = data ? regionLabel(data.edge.region) : ''
  const updateAge = data ? ageLabel(data.edge.configPollAgeMs) : ''
  const deviceOptions = data
    ? data.devices.length > 0
      ? data.devices
      : data.device
        ? [{ device: data.device, queries: data.totalQueries }]
        : []
    : []
  // Per-device rollups only exist from their deploy onward; say so instead of
  // letting a partial window look like the device went quiet.
  const windowStart = data?.series[0]?.bucket
  const deviceHistoryStart =
    data?.device && data.deviceSince && windowStart && new Date(data.deviceSince).getTime() - new Date(windowStart).getTime() > 3_600_000
      ? formatZoned(data.deviceSince, 'd MMM HH:mm', zone)
      : null

  const header = (
    <div className="relative">
      <div aria-hidden="true" className="rz-dot-grid pointer-events-none absolute -inset-x-3 -top-6 h-36 opacity-60" />
      <PageHeader
        eyebrow={data ? `Network · ${profileLabel} profile` : 'Network'}
        title={data ? `${greeting}, ${firstName}` : greeting}
        description={
          data?.device
            ? `Scoped to ${data.device} · device-tagged DoH only${deviceHistoryStart ? ` · history since ${deviceHistoryStart}` : ''} · last 24 hours.`
            : 'Here’s how your network is doing over the last 24 hours.'
        }
        meta={
          data ? (
            <>
              <span className={['rz-pill', data.edge.ok ? 'rz-pill-positive' : 'rz-pill-warning'].join(' ')}>
                <ShieldCheck size={11} />
                {data.edge.ok ? 'Protected' : 'Attention needed'}
              </span>
              <span className="rz-pill">
                <Clock3 size={11} /> Updated {updateAge} ago
              </span>
              <span className="rz-pill">
                <Globe2 size={11} /> {region}
              </span>
            </>
          ) : undefined
        }
        actions={
          <div className="flex items-center gap-2">
            {data ? (
              <div className="w-[168px]">
                <Select value={device} onValueChange={chooseDevice}>
                  <SelectTrigger className="h-8 py-0 text-[12px] font-medium">
                    <SelectValue aria-label="Device" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_DEVICES}>All devices</SelectItem>
                    {deviceOptions.map((option) => (
                      <SelectItem key={option.device} value={option.device}>
                        {option.device}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <Button asChild variant="secondary">
              <Link to="/logs">
                <FileText size={13} />
                Open query log
              </Link>
            </Button>
          </div>
        }
      />
    </div>
  )

  if (isPending) return <div className="space-y-7">{header}<OverviewSkeleton /></div>
  if (isError || !data) return <div className="space-y-7">{header}<PageError title="Could not load live stats." onRetry={() => void refetch()} /></div>

  const chartSource =
    volume?.range === range && (volume.device ?? null) === (deviceFilter ?? null)
      ? volume.series
      : range === '24h'
        ? data.series
        : []
  const chartData = chartSource.map((point, index) => ({
    key: point.bucket,
    time: formatZoned(point.bucket, range === '7d' || range === '30d' ? 'd MMM' : 'HH:mm', zone),
    day: formatZoned(point.bucket, 'd MMM', zone),
    full: formatZoned(point.bucket, 'EEE d MMM, HH:mm', zone),
    total: point.total,
    blocked: point.blocked,
    // The final bucket is the current hour/day and is still filling up.
    partial: index === chartSource.length - 1,
  }))
  const rangeConfig = overviewRange(range)
  const maxBlocked = Math.max(...data.topBlocked.map((d) => d.count), 1)
  const topBlocked = data.topBlocked.map((d) => ({
    domain: d.domain,
    count: formatNumber(d.count),
    share: Math.round((d.count / maxBlocked) * 100),
  }))
  const devices = data.topDevices.map((d) => ({
    name: d.device,
    detail: 'DoH device tag',
    queries: formatNumber(d.count),
  }))
  const clients = data.topClients.slice(0, 4).map((c) => ({
    ip: c.clientIp,
    queries: formatNumber(c.count),
  }))
  const totalQueries = data.totalQueries
  const blocked = data.blocked
  const activeSources = Math.max(data.activeDevices, data.topClients.length)
  const qps = totalQueries / 86_400
  const qpsLabel = qps >= 10 ? formatNumber(Math.round(qps)) : qps.toFixed(1)

  return (
    <div className="space-y-7">
      {header}

      <section className="grid gap-4 xl:grid-cols-[1.65fr_1fr]">
        <div className="rz-card flex flex-col p-5 xl:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="rz-section-title">Query volume</h2>
              <p className="mt-1.5 text-[11px] text-[var(--muted)]">
                Total vs blocked queries · {rangeConfig.description.toLowerCase()} · hover for exact date
              </p>
            </div>
            <div className="flex items-center gap-2">
              {volumePending ? (
                <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">Loading…</span>
              ) : null}
              <div className="flex items-center border border-[var(--line-strong)]">
                {OVERVIEW_RANGES.map((option) => (
                  <button
                    key={option.key}
                    type="button"
                    onClick={() => setRange(option.key)}
                    aria-pressed={range === option.key}
                    className={[
                      'px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-[0.06em] transition-colors',
                      range === option.key
                        ? 'bg-[var(--brand)] text-white'
                        : 'text-[var(--muted)] hover:bg-[var(--paper-2)] hover:text-[var(--ink)]',
                    ].join(' ')}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-5 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">
            <span className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-[var(--ink)]" /> Queries
            </span>
            <span className="flex items-center gap-2">
              <span className="size-1.5 rounded-full bg-[var(--accent)]" /> Blocked
            </span>
          </div>
          <QueryChart data={chartData} />
        </div>

        <div className="flex flex-col gap-4">
          <LiveTrafficCard qpsLabel={qpsLabel} totalQueries={totalQueries} blocked={blocked} blockRatio={data.blockRatio} />
          <PostureCard
            edge={data.edge}
            updateAge={updateAge}
            region={region}
            ruleCount={data.ruleCount}
            activeSources={activeSources}
          />
        </div>
      </section>

      <section className="grid grid-cols-2 divide-y divide-[var(--line)] border-y border-[var(--line)] sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <PulseMetric index="01" icon={<Globe2 size={15} />} label="Queries / 24h" value={formatNumber(totalQueries)} delta="last 24 hours" />
        <PulseMetric
          index="02"
          icon={<Ban size={15} />}
          label="Blocked"
          value={formatNumber(blocked)}
          delta={`${(data.blockRatio * 100).toFixed(1)}% of total`}
        />
        <PulseMetric
          index="03"
          icon={<Clock3 size={15} />}
          label="Avg upstream"
          value={data.avgRttMs != null ? `${data.avgRttMs} ms` : '—'}
          delta="upstream queries"
          positive
        />
        <PulseMetric
          index="04"
          icon={<Monitor size={15} />}
          label="Active sources"
          value={String(activeSources)}
          delta={data.device ? 'selected device' : 'client IPs / DoH tags'}
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)_minmax(0,0.9fr)]">
        <TopBlockedCard items={topBlocked} />
        <DevicesCard devices={devices} clients={clients} />
        <LocalDnsCard count={data.zoneCount} />
      </section>
    </div>
  )
}

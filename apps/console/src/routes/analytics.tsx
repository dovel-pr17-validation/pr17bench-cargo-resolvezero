import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BarChart3, TrendingUp } from 'lucide-react'
import { useState } from 'react'
import { getAnalyticsData } from '../server/dashboard'
import { DomainLabel } from '../components/domain-label'
import { PageError, PageLoading } from '../components/data-state'
import { PageHeader } from '../components/page-header'
import { useTimeZone } from '../lib/use-timezone'

export const Route = createFileRoute('/analytics')({ component: Analytics })

type Range = '24h' | '7d' | '30d'

function Analytics() {
  const [range, setRange] = useState<Range>('7d')
  const { zone } = useTimeZone()
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['analytics', zone],
    queryFn: () => getAnalyticsData({ data: { tz: zone } }),
  })

  const header = (
    <PageHeader
      eyebrow="Observe"
      title="Analytics"
      description={`${data?.profileName ?? 'Profile'} · long-range rollups from Postgres.`}
      actions={
        <div className="flex items-center rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--paper)] p-0.5 text-[11px]">
          {(['24h', '7d', '30d'] as Range[]).map((value) => (
            <button
              key={value}
              onClick={() => setRange(value)}
              className={['rounded-[var(--radius-sm)] px-2.5 py-1.5', range === value ? 'bg-[var(--card)] font-medium' : 'text-[var(--muted)]'].join(' ')}
            >
              {value}
            </button>
          ))}
        </div>
      }
    />
  )

  if (isPending) return <div className="space-y-6">{header}<PageLoading label="Loading analytics…" /></div>
  if (isError || !data) return <div className="space-y-6">{header}<PageError title="Could not load analytics." onRetry={() => void refetch()} /></div>

  const series = data.series[range]
  const total = series.reduce((sum, point) => sum + point.total, 0)
  const blocked = series.reduce((sum, point) => sum + point.blocked, 0)
  const ratio = total > 0 ? (blocked / total) * 100 : 0

  return (
    <div className="space-y-6">
      {header}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={`Queries · ${range}`} value={new Intl.NumberFormat('en-GB').format(total)} detail="Rollup total" />
        <Stat label={`Blocked · ${range}`} value={new Intl.NumberFormat('en-GB').format(blocked)} detail={`${ratio.toFixed(1)}% of queries`} />
        <Stat label="30 day total" value={new Intl.NumberFormat('en-GB').format(data.total30d)} detail={`${new Intl.NumberFormat('en-GB').format(data.blocked30d)} blocked`} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.55fr_1fr]">
        <div className="rz-card min-w-0 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Query volume</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Total vs blocked queries · {range}</p>
            </div>
            <BarChart3 size={18} className="text-[var(--muted)]" />
          </div>
          <AnalyticsChart series={series} range={range} />
        </div>

        <div className="rz-card min-w-0 p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Top blocked</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Last 30 days</p>
            </div>
            <TrendingUp size={17} className="text-[var(--muted)]" />
          </div>
          <div className="mt-5 space-y-4">
            {data.topBlocked.length === 0 ? <p className="py-8 text-center text-[12px] text-[var(--muted)]">No blocked domains yet.</p> : null}
            {data.topBlocked.map((item) => {
              const max = Math.max(...data.topBlocked.map((d) => d.count), 1)
              return (
                <div key={item.domain}>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 font-mono text-[12px]">
                      <DomainLabel domain={item.domain} />
                    </span>
                    <span className="shrink-0 font-mono text-[11px] text-[var(--muted)]">{new Intl.NumberFormat('en-GB').format(item.count)}</span>
                  </div>
                  <div className="h-1 overflow-hidden rounded-full bg-[var(--paper-2)]">
                    <div className="h-full bg-[var(--accent)]" style={{ width: `${(item.count / max) * 100}%` }} />
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

function AnalyticsChart({
  series,
  range,
}: {
  series: { label: string; total: number; blocked: number }[]
  range: Range
}) {
  const width = 760
  const height = 240
  const padX = 4
  const padY = 16
  const max = Math.max(...series.map((p) => p.total), 1)
  const last = series.length - 1
  const x = (index: number) => padX + (index / Math.max(last, 1)) * (width - padX * 2)
  const y = (value: number) => height - padY - (value / max) * (height - padY * 2)
  const line = (key: 'total' | 'blocked', from: number, to: number) => {
    let path = ''
    for (let index = from; index <= to; index += 1) {
      const point = series[index]
      if (!point) continue
      path += `${index === from ? 'M' : 'L'} ${x(index).toFixed(1)} ${y(point[key]).toFixed(1)} `
    }
    return path.trim()
  }

  if (series.length === 0) {
    return <p className="mt-5 py-16 text-center text-[12px] text-[var(--muted)]">No data for this range yet.</p>
  }

  // The current bucket is still filling up: end the filled area before it and
  // draw the final segment dashed, so a partial hour/day never reads as a drop.
  const settled = Math.max(last - 1, 0)
  const area = `${line('total', 0, settled)} L ${x(settled).toFixed(1)} ${height - padY} L ${padX} ${height - padY} Z`
  const ticks = [...new Set([0, Math.round(last / 4), Math.round(last / 2), Math.round((last * 3) / 4), last])]

  return (
    <div className="mt-5">
      <div className="h-[240px]">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-full w-full"
          role="img"
          aria-label={`Query volume for the last ${range}`}
        >
          <defs>
            <linearGradient id="rz-analytics-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ink)" stopOpacity="0.1" />
              <stop offset="100%" stopColor="var(--ink)" stopOpacity="0" />
            </linearGradient>
          </defs>
          {[0.2, 0.4, 0.6, 0.8].map((f) => (
            <line key={f} x1="0" x2={width} y1={height * f} y2={height * f} stroke="var(--line)" strokeDasharray="2 5" />
          ))}
          <path d={area} fill="url(#rz-analytics-area)" />
          <path d={line('total', 0, settled)} fill="none" stroke="var(--ink)" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
          <path d={line('blocked', 0, last)} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="4 4" strokeLinejoin="round" strokeLinecap="round" />
          {last > 0 ? (
            <>
              <path d={line('total', settled, last)} fill="none" stroke="var(--ink)" strokeWidth="1.8" strokeDasharray="3 4" strokeLinecap="round" />
              <path d={line('blocked', settled, last)} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeDasharray="3 4" strokeLinecap="round" opacity="0.8" />
            </>
          ) : null}
          {last >= 0 ? (
            <>
              <circle cx={x(last)} cy={y(series[last]!.total)} r="2.6" fill="var(--card)" stroke="var(--ink)" strokeWidth="1.4" />
              <circle cx={x(last)} cy={y(series[last]!.blocked)} r="2.6" fill="var(--card)" stroke="var(--accent)" strokeWidth="1.4" />
            </>
          ) : null}
        </svg>
      </div>
      <div className="mt-1 flex justify-between gap-2 font-mono text-[10px] text-[var(--muted)]">
        {ticks.map((index) => (
          <span key={index}>{series[index]?.label}</span>
        ))}
      </div>
      <p className="mt-2 text-[10px] text-[var(--muted)]">
        Dashed tail is the current {range === '24h' ? 'hour' : 'day'} and may be incomplete.
      </p>
    </div>
  )
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rz-card p-5">
      <p className="text-[11px] text-[var(--muted)]">{label}</p>
      <p className="mt-2 rz-font-display text-[26px] font-semibold tracking-[-0.045em]">{value}</p>
      <p className="mt-1 text-[10px] text-[var(--muted)]">{detail}</p>
    </div>
  )
}

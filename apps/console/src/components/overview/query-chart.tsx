import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

export interface QueryChartPoint {
  key: string
  time: string
  day: string
  full: string
  total: number
  blocked: number
  /** The current bucket is still filling up. */
  partial?: boolean
}

/** Compact request counts for the Y axis: 950, 1.2k, 48k, 1.6M. */
function axisNumber(value: number): string {
  if (value >= 1_000_000) return `${short(value / 1_000_000)}M`
  if (value >= 1_000) return `${short(value / 1_000)}k`
  return String(Math.round(value))
}

function short(value: number): string {
  const rounded = value >= 10 ? Math.round(value) : Number(value.toFixed(1))
  return String(rounded)
}

const count = new Intl.NumberFormat('en-GB')

/**
 * The last bucket is the in-progress hour. It is drawn dashed and detached
 * from the filled area so a partial hour cannot look like a real drop in
 * traffic.
 */
export function QueryChart({ data }: { data: QueryChartPoint[] }) {
  const last = data.length - 1
  const series = data.map((point, index) => ({
    ...point,
    solidTotal: index === last && last > 0 ? null : point.total,
    solidBlocked: index === last && last > 0 ? null : point.blocked,
    tailTotal: index >= last - 1 ? point.total : null,
    tailBlocked: index >= last - 1 ? point.blocked : null,
  }))

  return (
    <div className="mt-5 min-h-[300px] w-full flex-1" role="img" aria-label="Query volume over the last 24 hours">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={series} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="rz-query-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--ink)" stopOpacity={0.06} />
              <stop offset="100%" stopColor="var(--ink)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--line)" strokeDasharray="3 5" />
          <XAxis
            dataKey="key"
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: 'var(--muted)' }}
            interval="preserveStartEnd"
            minTickGap={32}
            tickFormatter={(value: string) => {
              const point = data.find((entry) => entry.key === value)
              if (!point) return value
              return point.time === '00:00' ? point.day : point.time
            }}
          />
          <YAxis
            width={42}
            tickLine={false}
            axisLine={false}
            tick={{ fontSize: 10, fill: 'var(--muted)' }}
            tickFormatter={(value: number) => axisNumber(value)}
            allowDecimals={false}
            tickCount={4}
          />
          <Tooltip
            cursor={{ stroke: 'var(--line)', strokeWidth: 1 }}
            content={<ChartTooltip />}
          />
          <Area
            type="monotone"
            dataKey="solidTotal"
            stroke="var(--ink)"
            strokeWidth={1.6}
            fill="url(#rz-query-area)"
            dot={false}
            activeDot={false}
            isAnimationActive
            animationDuration={250}
          />
          <Area
            type="monotone"
            dataKey="solidBlocked"
            stroke="var(--accent)"
            strokeWidth={1.4}
            fill="transparent"
            dot={false}
            activeDot={false}
            isAnimationActive
            animationDuration={250}
          />
          {data.length > 1 ? (
            <>
              <Area
                type="monotone"
                dataKey="tailTotal"
                stroke="var(--ink)"
                strokeWidth={1.6}
                strokeDasharray="3 4"
                fill="transparent"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
              <Area
                type="monotone"
                dataKey="tailBlocked"
                stroke="var(--accent)"
                strokeWidth={1.4}
                strokeDasharray="3 4"
                fill="transparent"
                dot={false}
                activeDot={false}
                isAnimationActive={false}
                connectNulls={false}
              />
            </>
          ) : null}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: Array<{ payload?: QueryChartPoint }>
}) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null

  return (
    <div className="min-w-[164px] rounded-[10px] border border-[var(--line-strong)] bg-[var(--card)] px-2.5 py-2 text-[11px] shadow-[var(--shadow-pop)]">
      <p className="text-[10px] text-[var(--muted)]">
        {point.full}
        {point.partial ? ' · in progress' : ''}
      </p>
      <div className="mt-1.5 space-y-1">
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-[var(--ink)]" />
            Queries
          </span>
          <span className="rz-mono tabular-nums">{count.format(point.total)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-[var(--accent)]" />
            Blocked
          </span>
          <span className="rz-mono tabular-nums">{count.format(point.blocked)}</span>
        </div>
      </div>
    </div>
  )
}

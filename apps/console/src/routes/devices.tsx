import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getOverview } from '../server/dashboard'
import { PageError, PageLoading } from '../components/data-state'
import { DeviceSetup } from '../components/devices/device-setup'
import { PageHeader } from '../components/page-header'
import { Button } from '../components/ui/button'
import { Info, Monitor, Plus, Router, Smartphone } from 'lucide-react'

export const Route = createFileRoute('/devices')({ component: Devices })

function Devices() {
  const [setup, setSetup] = useState(false)
  const { data, isPending, isError, refetch } = useQuery({ queryKey: ['overview'], queryFn: () => getOverview() })

  const header = (
    <PageHeader
      eyebrow="Network"
      title="Devices"
      description="Know what is talking to your resolver, and how much."
      actions={
        <Button onClick={() => setSetup((open) => !open)} aria-expanded={setup}>
          <Plus size={14} />
          Set up a device
        </Button>
      }
    />
  )

  if (isPending) return <div className="space-y-6">{header}<PageLoading label="Loading devices…" /></div>
  if (isError || !data) return <div className="space-y-6">{header}<PageError title="Could not load devices." onRetry={() => void refetch()} /></div>

  const count = new Intl.NumberFormat('en-GB')
  const dohDevices = data.devices.map((d) => ({ name: d.device, tag: d.device, queries: count.format(d.queries) }))
  const clientIps = data.topClients.map((c, index) => ({ name: index === 0 ? 'Primary source' : 'Source IP', ip: c.clientIp, queries: count.format(c.count) }))

  return (
    <div className="space-y-6">
      {header}

      {setup ? (
        <div className="rz-card overflow-hidden">
          <DeviceSetup onDone={() => setSetup(false)} />
        </div>
      ) : null}

      <div className="rz-card flex items-center gap-3 border-[var(--line)] bg-[var(--sage)] p-4">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-white text-[var(--ink)] ring-1 ring-[var(--line)]"><Info size={14} /></span>
        <p className="text-[12px] leading-5 text-[var(--muted)]">
          Client IPs are shared by UDP and DoH traffic. Downstream devices are opaque, so queries from the same public IP are grouped together. Use the device-tagged DoH URL for per-device attribution.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.35fr_1fr]">
        <div className="rz-card overflow-hidden">
          <div className="flex items-center justify-between p-5 pb-4">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">DoH devices</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">Identified by device tag in the DoH URL</p>
            </div>
            <span className="rounded-full bg-[var(--green-soft)] px-2.5 py-1 text-[10px] font-medium text-[var(--green)]">{dohDevices.length} active</span>
          </div>
          <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
            {dohDevices.length === 0 ? <p className="px-5 py-10 text-center text-[12px] text-[var(--muted)]">No DoH device tags in the last 24h.</p> : null}
            {dohDevices.map((device) => (
              <div key={device.tag} className="flex items-center gap-3 px-5 py-4">
                <span className="flex size-9 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--paper-2)] text-[var(--muted)]">
                  {device.tag === 'iphone' ? <Smartphone size={16} /> : <Monitor size={16} />}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-medium">{device.name}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">/v1/.../{device.tag}/••••</p>
                </div>
                <div className="ml-auto text-right">
                  <p className="font-mono text-[11px]">{device.queries}</p>
                  <p className="text-[10px] text-[var(--muted)]">queries · 24h</p>
                </div>
                <span className="size-1.5 rounded-full bg-[var(--green)]" />
              </div>
            ))}
          </div>
        </div>

        <div className="rz-card overflow-hidden">
          <div className="flex items-center justify-between p-5 pb-4">
            <div>
              <h2 className="text-[15px] font-semibold tracking-[-0.02em]">Client IPs</h2>
              <p className="mt-1 text-[12px] text-[var(--muted)]">UDP + DoH sources — downstream devices are opaque</p>
            </div>
            <Router size={17} className="text-[var(--muted)]" />
          </div>
          <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
            {clientIps.length === 0 ? <p className="px-5 py-10 text-center text-[12px] text-[var(--muted)]">No client IPs in the last 24h.</p> : null}
            {clientIps.map((source) => (
              <div key={source.name} className="flex items-center gap-3 px-5 py-4">
                <span className="flex size-9 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--paper-2)] text-[var(--muted)]"><Router size={16} /></span>
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-medium">{source.name}</p>
                  <p className="mt-0.5 font-mono text-[10px] text-[var(--muted)]">{source.ip}</p>
                </div>
                <div className="ml-auto text-right">
                  <p className="font-mono text-[11px]">{source.queries}</p>
                  <p className="text-[10px] text-[var(--muted)]">queries · 24h</p>
                </div>
                <span className={['size-1.5 rounded-full', source.name === 'Unknown device' ? 'bg-[var(--warning)]' : 'bg-[var(--green)]'].join(' ')} />
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rz-card overflow-hidden">
        <div className="grid gap-px bg-[var(--line)] sm:grid-cols-3">
          <DeviceStat label="DoH devices" value={String(dohDevices.length)} detail="Attributed" />
          <DeviceStat label="Client IPs" value={String(clientIps.length)} detail="UDP + DoH" />
          <DeviceStat label="Queries / 24h" value={new Intl.NumberFormat('en-GB', { notation: 'compact' }).format(data.totalQueries)} detail="Across all devices" />
        </div>
      </div>
    </div>
  )
}

function DeviceStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="bg-white p-5">
      <p className="text-[11px] text-[var(--muted)]">{label}</p>
      <p className="mt-2 rz-font-display text-[26px] font-semibold tracking-[-0.045em]">{value}</p>
      <p className="mt-1 text-[10px] text-[var(--muted)]">{detail}</p>
    </div>
  )
}

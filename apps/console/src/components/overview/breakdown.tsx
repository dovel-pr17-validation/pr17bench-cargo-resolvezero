import { Link } from '@tanstack/react-router'
import { ArrowUpRight, Ban, House, Monitor, Router } from 'lucide-react'

import { Button } from '../ui/button'
import { DomainLabel } from '../domain-label'

export function TopBlockedCard({ items }: { items: { domain: string; count: string; share: number }[] }) {
  return (
    <div className="rz-card min-w-0 p-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="rz-section-title">Top blocked</h2>
          <p className="mt-1.5 text-[11px] text-[var(--muted)]">Last 24 hours</p>
        </div>
        <Ban size={16} className="text-[var(--accent)]" />
      </div>
      <div className="mt-5 space-y-3.5">
        {items.length === 0 ? (
          <p className="py-6 text-center text-[11px] text-[var(--muted)]">No blocked domains in this window.</p>
        ) : null}
        {items.map((item) => (
          <div key={item.domain}>
            <div className="mb-1.5 flex min-w-0 items-center justify-between gap-3">
              <span className="min-w-0 font-mono text-[10px] text-[var(--ink)]">
                <DomainLabel domain={item.domain} />
              </span>
              <span className="shrink-0 font-mono text-[9px] text-[var(--muted)]">{item.count}</span>
            </div>
            <div className="h-1 overflow-hidden rounded-full bg-[var(--paper-2)]">
              <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${item.share}%` }} />
            </div>
          </div>
        ))}
      </div>
      <Link
        to="/logs"
        className="mt-5 inline-flex items-center gap-1 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--ink)] hover:text-[var(--brand)]"
      >
        Open query log <ArrowUpRight size={12} />
      </Link>
    </div>
  )
}

export function DevicesCard({
  devices,
  clients,
}: {
  devices: { name: string; detail: string; queries: string }[]
  clients: { ip: string; queries: string }[]
}) {
  return (
    <div className="rz-card min-w-0 overflow-hidden">
      <div className="flex items-start justify-between p-5 pb-4">
        <div>
          <h2 className="rz-section-title">Devices</h2>
          <p className="mt-1.5 text-[11px] text-[var(--muted)]">Most active on this profile</p>
        </div>
        <Button asChild variant="secondary" size="sm">
          <Link to="/devices">Manage</Link>
        </Button>
      </div>
      <div className="divide-y divide-[var(--line)] border-t border-[var(--line)]">
        {devices.length === 0 ? (
          <p className="px-5 py-6 text-center text-[11px] text-[var(--muted)]">No tagged DoH devices in this window.</p>
        ) : null}
        {devices.map((device) => (
          <div key={device.name} className="flex items-center gap-3 px-5 py-3">
            <span className="flex size-8 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--paper-2)] text-[var(--muted)]">
              <Monitor size={14} />
            </span>
            <div className="min-w-0">
              <p className="truncate text-[11px] font-medium">{device.name}</p>
              <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-[0.06em] text-[var(--muted)]">{device.detail}</p>
            </div>
            <span className="ml-auto font-mono text-[10px] text-[var(--muted)]">{device.queries}</span>
          </div>
        ))}
        {clients.length > 0 ? (
          <>
            <p className="px-5 pb-1 pt-3 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">Client IPs</p>
            {clients.map((client) => (
              <div key={client.ip} className="flex items-center gap-3 px-5 py-3">
                <span className="flex size-8 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--paper-2)] text-[var(--muted)]">
                  <Router size={14} />
                </span>
                <div className="min-w-0">
                  <p className="truncate font-mono text-[11px]">{client.ip}</p>
                  <p className="mt-0.5 text-[10px] uppercase tracking-[0.06em] text-[var(--muted)]">UDP + DoH source</p>
                </div>
                <span className="ml-auto font-mono text-[10px] text-[var(--muted)]">{client.queries}</span>
              </div>
            ))}
          </>
        ) : null}
      </div>
    </div>
  )
}

export function LocalDnsCard({ count }: { count: number }) {
  return (
    <div className="rz-card flex min-w-0 flex-col p-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="rz-section-title">Local DNS</h2>
          <p className="mt-1.5 text-[11px] text-[var(--muted)]">Split-horizon names</p>
        </div>
        <House size={16} className="text-[var(--brand)]" />
      </div>
      <p className="mt-5 rz-font-display text-[3rem] font-extrabold leading-none tracking-[-0.055em]">
        {count}
        <span className="ml-2 font-sans text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">
          {count === 1 ? 'record' : 'records'}
        </span>
      </p>
      <p className="mt-3 text-[10px] leading-5 text-[var(--muted)]">Answer .lan names before blocklists and upstream.</p>
      <Link
        to="/local-dns"
        className="mt-auto inline-flex items-center gap-1 pt-5 text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--ink)] hover:text-[var(--brand)]"
      >
        Manage records <ArrowUpRight size={12} />
      </Link>
    </div>
  )
}

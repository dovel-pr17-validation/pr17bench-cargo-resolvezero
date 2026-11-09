import { FileText } from 'lucide-react'

import type { LogEntry } from '../../server/dashboard/types'
import { logEntryKey } from '../../lib/log-tail'
import { popLabel } from '../../lib/pops'
import { formatZoned } from '../../lib/time'
import { useTimeZone } from '../../lib/use-timezone'
import { DomainLabel } from '../domain-label'

function reasonLabel(entry: { reason: string | null; listLabel: string | null }): string {
  if (entry.reason === 'manual') return 'Manual rule'
  if (entry.reason === 'blocklist') return entry.listLabel ?? 'Blocklist'
  if (entry.reason === 'zone') return 'Local zone'
  if (entry.reason === 'safesearch') return 'SafeSearch'
  return '—'
}

function popDetail(entry: { region: string | null; transport: string | null; upstream: string | null }): string {
  return [
    entry.region ? popLabel(entry.region) : 'Unknown POP',
    entry.transport ? entry.transport.toUpperCase() : null,
    entry.upstream ? `upstream: ${entry.upstream}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function LogTable({ entries }: { entries: LogEntry[] }) {
  const { zone } = useTimeZone()
  return (
    <div className="overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1060px] text-left">
          <thead>
            <tr className="border-b border-[var(--line)] text-[10px] font-medium text-[var(--muted)]">
              <th className="px-4 py-2.5 font-medium">Time</th>
              <th className="px-4 py-2.5 font-medium">Domain</th>
              <th className="px-4 py-2.5 font-medium">Action</th>
              <th className="px-4 py-2.5 font-medium">Reason</th>
              <th className="px-4 py-2.5 font-medium">POP</th>
              <th className="px-4 py-2.5 font-medium">Client IP</th>
              <th className="px-4 py-2.5 font-medium">Device</th>
              <th className="px-4 py-2.5 font-medium">RTT</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--line)]">
            {entries.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-5 py-12 text-center text-[12px] text-[var(--muted)]">
                  No log entries found.
                </td>
              </tr>
            ) : null}
            {entries.map((entry) => (
              <tr key={logEntryKey(entry)} className="hover:bg-[var(--paper)]/60">
                <td
                  className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-[var(--muted)]"
                  title={entry.time ? new Date(entry.time).toISOString() : undefined}
                >
                  {entry.time ? formatZoned(entry.time, 'dd MMM, HH:mm:ss', zone) : '—'}
                </td>
                <td className="max-w-[360px] px-4 py-2.5 font-mono text-[11px]">
                  <DomainLabel domain={entry.domain} />
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={[
                      'inline-flex items-center gap-1.5 text-[10px] font-medium capitalize tracking-[0.02em]',
                      entry.action === 'block' ? 'text-[var(--danger)]' : 'text-[var(--green)]',
                    ].join(' ')}
                  >
                    <span className={['size-1.5 rounded-full', entry.action === 'block' ? 'bg-[var(--accent)]' : 'bg-[var(--green)]'].join(' ')} />
                    {entry.action}
                  </span>
                </td>
                <td className="max-w-[260px] truncate px-4 py-2.5 text-[11px] text-[var(--muted)]" title={entry.listLabel ?? undefined}>
                  {reasonLabel(entry)}
                </td>
                <td className="px-4 py-2.5 font-mono text-[10px] uppercase text-[var(--muted)]" title={popDetail(entry)}>
                  {entry.region ?? '—'}
                </td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-[var(--muted)]">{entry.clientIp ?? '—'}</td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-[var(--muted)]">{entry.device ?? '—'}</td>
                <td className="whitespace-nowrap px-4 py-2.5 font-mono text-[10px] text-[var(--muted)]">{entry.rttMs != null ? `${entry.rttMs} ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 border-t border-[var(--line)] px-4 py-2.5 text-[10px] text-[var(--muted)]">
        <FileText size={12} /> Archived on the edge; older objects remain in S3.
      </div>
    </div>
  )
}

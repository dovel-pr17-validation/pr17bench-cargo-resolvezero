import { Pencil, Router, Trash2 } from 'lucide-react'

import { zoneKey, type LocalDnsZone } from '../../lib/zone'

export function ZoneTable({
  zones,
  onEdit,
  onDelete,
}: {
  zones: LocalDnsZone[]
  onEdit: (zone: LocalDnsZone) => void
  onDelete: (zone: LocalDnsZone) => void
}) {
  return (
    <div className="rz-card overflow-hidden">
      <div className="flex items-center justify-between border-b border-[var(--line)] p-5">
        <div>
          <h2 className="text-[14px] font-semibold">Local records</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">
            {zones.length} {zones.length === 1 ? 'record' : 'records'} · answered by ResolveZero
          </p>
        </div>
        <Router size={17} className="text-[var(--muted)]" />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-left">
          <thead>
            <tr className="border-b border-[var(--line)] bg-[var(--paper)]/60 text-[11px] font-medium text-[var(--muted)]">
              <th className="px-5 py-3 font-medium">Name</th>
              <th className="px-4 py-3 font-medium">Type</th>
              <th className="px-4 py-3 font-medium">Answer</th>
              <th className="px-4 py-3 font-medium">TTL</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--line)]">
            {zones.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-5 py-10 text-center text-[12px] text-[var(--muted)]">
                  No local records yet. Add <span className="font-mono">nas.lan</span> →{' '}
                  <span className="font-mono">192.168.1.24</span>.
                </td>
              </tr>
            ) : null}
            {zones.map((zone) => (
              <tr key={zoneKey(zone)} className="group hover:bg-white/60">
                <td className="px-5 py-3.5 font-mono text-[12px]">{zone.domain}</td>
                <td className="px-4 py-3.5">
                  <span className="inline-flex items-center rounded-[var(--radius-sm)] bg-[var(--sage)] px-2 py-1 text-[10px] font-semibold text-[var(--ink)] ring-1 ring-[var(--line)]">
                    {zone.recordType}
                  </span>
                </td>
                <td className="max-w-[320px] px-4 py-3.5">
                  <p className="truncate font-mono text-[11px] text-[var(--muted)]" title={zone.values.join(', ')}>
                    {zone.values.join(', ')}
                  </p>
                </td>
                <td className="px-4 py-3.5 font-mono text-[11px] text-[var(--muted)]">{zone.ttl}s</td>
                <td className="px-4 py-3.5">
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => onEdit(zone)}
                      className="rounded-[var(--radius-sm)] p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
                      aria-label={`Edit ${zone.domain} ${zone.recordType}`}
                      title="Edit"
                    >
                      <Pencil size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(zone)}
                      className="rounded-[var(--radius-sm)] p-1.5 text-[var(--muted)] transition-colors hover:bg-[var(--accent-soft)] hover:text-[#b74716]"
                      aria-label={`Delete ${zone.domain} ${zone.recordType}`}
                      title="Delete"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-t border-[var(--line)] px-5 py-3 text-[11px] text-[var(--muted)]">
        Local answers take precedence over blocklists, cache, and upstream.
      </div>
    </div>
  )
}

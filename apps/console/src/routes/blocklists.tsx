import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { AlertCircle, CheckCircle2, ExternalLink, Layers3, Plus, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { getBlocklistsData } from '../server/dashboard'
import { AddListForm } from '../components/blocklists/add-list-form'
import { BlocklistRowActions } from '../components/blocklists/blocklist-row-actions'
import { PageError, PageLoading } from '../components/data-state'
import { PageHeader } from '../components/page-header'
import { Button } from '../components/ui/button'
import { formatZoned } from '../lib/time'
import { useTimeZone } from '../lib/use-timezone'

export const Route = createFileRoute('/blocklists')({ component: Blocklists })

function Blocklists() {
  const { zone } = useTimeZone()
  const [adding, setAdding] = useState(false)
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['blocklists'],
    queryFn: () => getBlocklistsData(),
  })

  const header = (
    <PageHeader
      eyebrow="Protection"
      title="Blocklists"
      description={`${data?.profileName ?? 'Profile'} · public lists and sync health across the edge fleet.`}
      actions={
        <>
          <Button variant="secondary" onClick={() => void refetch()}>
            <RefreshCw size={13} /> Refresh
          </Button>
          <Button onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
            <Plus size={14} /> Add list
          </Button>
        </>
      }
    />
  )

  if (isPending) return <div className="space-y-6">{header}<PageLoading label="Loading blocklists…" /></div>
  if (isError || !data) return <div className="space-y-6">{header}<PageError title="Could not load blocklists." onRetry={() => void refetch()} /></div>

  const totalEntries = data.lists.reduce((sum, list) => sum + (list.enabled ? list.entries : 0), 0)
  const enabledCount = data.lists.filter((list) => list.enabled).length
  const healthy = data.lists.filter((list) => list.enabled && list.lastStatus === 'ok').length

  return (
    <div className="space-y-6">
      {header}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Subscriptions" value={String(data.lists.length)} detail={`${enabledCount} enabled`} />
        <Stat label="Compiled entries" value={new Intl.NumberFormat('en-GB').format(totalEntries)} detail="Across enabled lists" />
        <Stat label="Healthy" value={`${healthy}/${data.lists.length}`} detail="Last sync status" />
      </div>

      <div className="rz-card overflow-hidden">
        {adding ? <AddListForm profileId={data.profileId} onDone={() => setAdding(false)} /> : null}
        <div className="flex items-center gap-2 border-b border-[var(--line)] p-4 text-[11px] text-[var(--muted)]">
          <Layers3 size={14} /> Parsed once per URL and shared across profiles on each edge.
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--paper)]/60 text-[11px] font-medium text-[var(--muted)]">
                <th className="px-5 py-3 font-medium">Source</th>
                <th className="px-4 py-3 font-medium">Format</th>
                <th className="px-4 py-3 font-medium">Entries</th>
                <th className="px-4 py-3 font-medium">Last sync</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {data.lists.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-12 text-center text-[12px] text-[var(--muted)]">No blocklists subscribed.</td></tr>
              ) : null}
              {data.lists.map((list) => (
                <tr key={list.id} className={['transition-opacity hover:bg-white/60', list.enabled ? '' : 'opacity-55'].join(' ')}>
                  <td className="max-w-[430px] px-5 py-4">
                    <a href={list.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 truncate font-mono text-[12px] hover:underline">
                      <span className="truncate">{list.url}</span>
                      <ExternalLink size={11} className="shrink-0 text-[var(--muted)]" />
                    </a>
                  </td>
                  <td className="px-4 py-4 text-[11px] uppercase text-[var(--muted)]">
                    {list.format === 'auto' ? (
                      <span className="flex items-center gap-1.5">
                        auto
                        {list.detectedFormat ? (
                          <span className="rounded-[var(--radius-sm)] bg-[var(--paper-2)] px-1.5 py-0.5 font-mono text-[9px] normal-case text-[var(--ink)]">
                            {list.detectedFormat}
                          </span>
                        ) : null}
                      </span>
                    ) : (
                      list.format
                    )}
                  </td>
                  <td className="px-4 py-4 font-mono text-[12px]">{new Intl.NumberFormat('en-GB').format(list.entries)}</td>
                  <td className="px-4 py-4 font-mono text-[10px] text-[var(--muted)]">{list.lastSyncedAt ? formatZoned(list.lastSyncedAt, 'dd MMM yyyy, HH:mm', zone) : 'never'}</td>
                  <td className="px-4 py-4">
                    <StatusPill enabled={list.enabled} status={list.lastStatus} />
                  </td>
                  <td className="px-4 py-4">
                    <BlocklistRowActions id={list.id} url={list.url} enabled={list.enabled} profileId={data.profileId} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

function StatusPill({ enabled, status }: { enabled: boolean; status: string | null }) {
  if (!enabled) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--sage)] px-2 py-1 text-[10px] font-medium text-[var(--muted)]">
        <AlertCircle size={11} /> disabled
      </span>
    )
  }
  const ok = status === 'ok'
  return (
    <span className={['inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] px-2 py-1 text-[10px] font-medium', ok ? 'bg-[var(--green-soft)] text-[var(--green)]' : 'bg-[var(--accent-soft)] text-[var(--warning)]'].join(' ')}>
      {ok ? <CheckCircle2 size={11} /> : <AlertCircle size={11} />}
      {status ?? 'pending'}
    </span>
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

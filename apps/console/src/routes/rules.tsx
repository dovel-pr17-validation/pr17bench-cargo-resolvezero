import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { Plus, Search } from 'lucide-react'
import { useState } from 'react'

import { PageError, PageLoading } from '../components/data-state'
import { PageHeader } from '../components/page-header'
import { AddRuleForm } from '../components/rules/add-rule-form'
import { RuleRowActions } from '../components/rules/rule-row-actions'
import { Button } from '../components/ui/button'
import { getRulesData } from '../server/dashboard'

export const Route = createFileRoute('/rules')({ component: Rules })

function Rules() {
  const [adding, setAdding] = useState(false)
  const [search, setSearch] = useState('')
  const { data, isPending, isError, refetch } = useQuery({ queryKey: ['rules'], queryFn: () => getRulesData() })

  const header = (
    <PageHeader
      eyebrow="Protection"
      title="Rules"
      description="Block or allow individual names. Allow beats every blocklist; rules match subdomains too."
      actions={
        <Button onClick={() => setAdding((open) => !open)} aria-expanded={adding}>
          <Plus size={14} />
          Add rule
        </Button>
      }
    />
  )

  if (isPending) return <div className="space-y-6">{header}<PageLoading label="Loading rules…" /></div>
  if (isError || !data) return <div className="space-y-6">{header}<PageError title="Could not load rules." onRetry={() => void refetch()} /></div>

  const query = search.trim().toLowerCase()
  const visible = query ? data.rules.filter((rule) => rule.domain.includes(query)) : data.rules

  return (
    <div className="space-y-6">
      {header}

      <div className="rz-card overflow-hidden">
        {adding ? <AddRuleForm profileId={data.profileId} onDone={() => setAdding(false)} /> : null}

        <div className="flex flex-col gap-3 border-b border-[var(--line)] p-4 sm:flex-row sm:items-center">
          <label className="flex flex-1 items-center gap-2 border border-[var(--line-strong)] bg-transparent px-3 py-2">
            <Search size={14} className="text-[var(--muted)]" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by domain"
              aria-label="Filter rules"
              spellCheck={false}
              className="w-full bg-transparent text-[11px] text-[var(--ink)] outline-none placeholder:text-[var(--muted)]"
            />
          </label>
          <span className="font-mono text-[11px] font-medium text-[var(--muted)]">
            {data.counts.block} block · {data.counts.allow} allow
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--paper)]/60 text-[11px] font-medium text-[var(--muted)]">
                <th className="px-5 py-3 font-medium">Domain</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium text-right">Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-5 py-10 text-center text-[12px] text-[var(--muted)]">
                    {data.rules.length === 0
                      ? 'No rules yet. Add one to block or allow a name.'
                      : `No rules match “${search.trim()}”.`}
                  </td>
                </tr>
              ) : null}
              {visible.map((rule) => (
                <tr
                  key={rule.domain}
                  className={['transition-opacity hover:bg-white/60', rule.enabled ? '' : 'opacity-55'].join(' ')}
                >
                  <td className="px-5 py-3.5 font-mono text-[12px]">{rule.domain}</td>
                  <td className="px-4 py-3.5">
                    <ActionPill action={rule.action} />
                  </td>
                  <td className="px-4 py-3.5">
                    <RuleRowActions
                      domain={rule.domain}
                      enabled={rule.enabled}
                      profileId={data.profileId}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-3 text-[11px] text-[var(--muted)]">
          <span>
            {visible.length} {visible.length === 1 ? 'rule' : 'rules'}
            {query && visible.length !== data.rules.length ? ` of ${data.rules.length}` : ''}
          </span>
          <span className="font-mono">synced to edge</span>
        </div>
      </div>
    </div>
  )
}

function ActionPill({ action }: { action: string }) {
  const style =
    action === 'block'
      ? 'bg-[var(--accent-soft)] text-[#b74716] ring-[var(--line)]'
      : 'bg-[var(--green-soft)] text-[var(--green)] ring-[var(--line)]'
  return (
    <span className={`inline-flex items-center rounded-[var(--radius-sm)] px-2 py-1 text-[10px] font-medium capitalize tracking-[0.02em] ring-1 ${style}`}>
      {action}
    </span>
  )
}

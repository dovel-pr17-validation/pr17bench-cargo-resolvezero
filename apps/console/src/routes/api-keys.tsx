import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createFileRoute } from '@tanstack/react-router'
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'

import { PageError, PageLoading } from '../components/data-state'
import { PageHeader } from '../components/page-header'
import { Button } from '../components/ui/button'
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyScope } from '../server/api-keys'
import { formatZoned } from '../lib/time'
import { useTimeZone } from '../lib/use-timezone'

export const Route = createFileRoute('/api-keys')({ component: ApiKeys })

const SCOPES: { value: ApiKeyScope; label: string; hint: string; active: string }[] = [
  { value: 'read', label: 'Read only', hint: 'Reads every resource, cannot change anything.', active: 'bg-[var(--ink)] text-[var(--paper)]' },
  { value: 'read-write', label: 'Read + write', hint: 'Full control of this profile.', active: 'bg-[var(--brand)] text-white' },
]

function ApiKeys() {
  const { zone } = useTimeZone()
  const queryClient = useQueryClient()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<ApiKeyScope>('read')
  const [issued, setIssued] = useState<{ key: string; name: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const { data, isPending, isError, refetch } = useQuery({ queryKey: ['api-keys'], queryFn: () => listApiKeys() })

  const create = useMutation({
    mutationFn: () => createApiKey({ data: { name: name.trim(), scope } }),
    onSuccess: async (result) => {
      setIssued({ key: result.key, name: result.name })
      setName('')
      setCreating(false)
      await queryClient.invalidateQueries({ queryKey: ['api-keys'] })
    },
  })

  const revoke = useMutation({
    mutationFn: (id: string) => revokeApiKey({ data: { id } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['api-keys'] }),
  })

  const header = (
    <PageHeader
      eyebrow="Account"
      title="API keys"
      description="Machine credentials for this profile. Everything the console can do is available at /rpc — see /docs for the OpenAPI specification."
      actions={
        <Button onClick={() => setCreating((open) => !open)} aria-expanded={creating}>
          <Plus size={14} />
          Create key
        </Button>
      }
    />
  )

  if (isPending) return <div className="space-y-6">{header}<PageLoading label="Loading API keys…" /></div>
  if (isError || !data) return <div className="space-y-6">{header}<PageError title="Could not load API keys." onRetry={() => void refetch()} /></div>

  return (
    <div className="space-y-6">
      {header}

      {issued ? (
        <div className="rz-card border-l-4 border-l-[var(--brand)] p-5">
          <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--brand)]">
            Copy this key now — it is shown once
          </p>
          <p className="mt-1.5 text-[11px] text-[var(--muted)]">
            {issued.name} · stored hashed, so it cannot be recovered later.
          </p>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 overflow-x-auto border border-[var(--line-strong)] bg-[var(--paper)] px-3 py-2 font-mono text-[11px]">
              {issued.key}
            </code>
            <Button
              variant="secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(issued.key)
                setCopied(true)
                setTimeout(() => setCopied(false), 1500)
              }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button variant="secondary" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </div>
      ) : null}

      <div className="rz-card overflow-hidden">
        {creating ? (
          <form
            className="border-b border-[var(--line)] bg-[var(--paper)]/40 p-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (name.trim()) create.mutate()
            }}
          >
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. home-assistant"
                aria-label="Key name"
                className="rz-input min-w-0 flex-1"
              />
              <div className="flex items-center border border-[var(--line-strong)]">
                {SCOPES.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    aria-pressed={scope === option.value}
                    onClick={() => setScope(option.value)}
                    className={[
                      'px-3 py-2 text-[10px] font-medium uppercase tracking-[0.06em] transition-colors',
                      scope === option.value ? option.active : 'text-[var(--muted)] hover:text-[var(--ink)]',
                    ].join(' ')}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? 'Creating…' : 'Create'}
              </Button>
              <Button type="button" variant="secondary" onClick={() => setCreating(false)}>
                Cancel
              </Button>
            </div>
            <p className="mt-2 text-[10px] leading-4 text-[var(--muted)]">
              {SCOPES.find((option) => option.value === scope)?.hint}
            </p>
            {create.isError ? (
              <p role="alert" className="mt-2 text-[11px] text-[var(--danger)]">
                {create.error.message}
              </p>
            ) : null}
          </form>
        ) : null}

        <div className="overflow-x-auto">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="border-b border-[var(--line)] bg-[var(--paper)]/60 text-[11px] font-medium text-[var(--muted)]">
                <th className="px-5 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Key</th>
                <th className="px-4 py-3 font-medium">Scope</th>
                <th className="px-4 py-3 font-medium">Created</th>
                <th className="px-4 py-3 font-medium">Last used</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {data.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center text-[12px] text-[var(--muted)]">
                    No API keys yet.
                  </td>
                </tr>
              ) : null}
              {data.map((key) => (
                <tr key={key.id} className="hover:bg-white/60">
                  <td className="px-5 py-4 text-[12px] font-medium">{key.name}</td>
                  <td className="px-4 py-4 font-mono text-[11px] text-[var(--muted)]">{key.start ?? '—'}…</td>
                  <td className="px-4 py-4">
                    <span
                      className={[
                        'inline-flex items-center rounded-[var(--radius-sm)] px-2 py-1 text-[10px] font-medium uppercase tracking-[0.06em]',
                        key.scope === 'read-write'
                          ? 'bg-[var(--accent-soft)] text-[#b74716]'
                          : 'bg-[var(--sage)] text-[var(--ink)]',
                      ].join(' ')}
                    >
                      {key.scope}
                    </span>
                  </td>
                  <td className="px-4 py-4 font-mono text-[10px] text-[var(--muted)]">
                    {formatZoned(key.createdAt, 'dd MMM yyyy', zone)}
                  </td>
                  <td className="px-4 py-4 font-mono text-[10px] text-[var(--muted)]">
                    {key.lastRequest ? formatZoned(key.lastRequest, 'dd MMM HH:mm', zone) : 'never'}
                  </td>
                  <td className="px-4 py-4 text-right">
                    <button
                      type="button"
                      disabled={revoke.isPending}
                      onClick={() => {
                        if (window.confirm(`Revoke "${key.name}"? Clients using it will stop working immediately.`)) {
                          revoke.mutate(key.id)
                        }
                      }}
                      aria-label={`Revoke ${key.name}`}
                      className="text-[var(--muted)] transition-colors hover:text-[var(--danger)] disabled:opacity-50"
                    >
                      <Trash2 size={14} className="ml-auto" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-[var(--line)] px-5 py-3 text-[11px] text-[var(--muted)]">
          <span className="flex items-center gap-2">
            <KeyRound size={13} /> {data.length} {data.length === 1 ? 'key' : 'keys'}
          </span>
          <a href="/docs" className="font-mono hover:text-[var(--ink)]">
            /docs ↗
          </a>
        </div>
      </div>
    </div>
  )
}

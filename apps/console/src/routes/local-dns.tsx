import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Info } from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { PageError, PageLoading } from '../components/data-state'
import { PageHeader } from '../components/page-header'
import { emptyZoneForm, ZoneForm, type ZoneFormState } from '../components/local-dns/zone-form'
import { ZoneTable } from '../components/local-dns/zone-table'
import { zoneKey, type LocalDnsZone } from '../lib/zone'
import { deleteLocalDnsZone, getLocalDnsData, saveLocalDnsZone } from '../server/dashboard'

export const Route = createFileRoute('/local-dns')({ component: LocalDnsPage })

function LocalDnsPage() {
  const queryClient = useQueryClient()
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['local-dns'],
    queryFn: () => getLocalDnsData(),
  })
  const [form, setForm] = useState<ZoneFormState>(emptyZoneForm)
  const [editingKey, setEditingKey] = useState<string | null>(null)

  function invalidate() {
    for (const key of ['local-dns', 'rules', 'overview', 'settings']) {
      void queryClient.invalidateQueries({ queryKey: [key] })
    }
  }

  const save = useMutation({
    mutationFn: () =>
      saveLocalDnsZone({
        data: {
          domain: form.domain,
          recordType: form.recordType,
          values: form.values,
          ttl: Number(form.ttl),
          profileId: data?.profileId,
        },
      }),
    onSuccess: () => {
      setForm(emptyZoneForm)
      setEditingKey(null)
      invalidate()
    },
  })

  const remove = useMutation({
    mutationFn: (zone: LocalDnsZone) =>
      deleteLocalDnsZone({
        data: { domain: zone.domain, recordType: zone.recordType, profileId: data?.profileId },
      }),
    onSuccess: invalidate,
  })

  const error = save.isError ? save.error.message : remove.isError ? remove.error.message : null

  function startEdit(zone: LocalDnsZone) {
    setEditingKey(zoneKey(zone))
    setForm({
      domain: zone.domain,
      recordType: zone.recordType,
      values: zone.values.join(', '),
      ttl: String(zone.ttl),
    })
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function cancelEdit() {
    setEditingKey(null)
    setForm(emptyZoneForm)
    save.reset()
    remove.reset()
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!save.isPending) save.mutate()
  }

  function confirmDelete(zone: LocalDnsZone) {
    if (window.confirm(`Delete ${zone.domain} (${zone.recordType})?`)) remove.mutate(zone)
  }

  const header = (
    <PageHeader
      eyebrow="Network"
      title="Local DNS"
      description={
        <>
          {data?.profileName ?? 'Profile'} profile · answer <span className="font-mono">.lan</span> names before blocklists and upstream.
        </>
      }
    />
  )

  if (isPending) return <div className="space-y-6">{header}<PageLoading label="Loading local DNS records…" /></div>
  if (isError || !data) return <div className="space-y-6">{header}<PageError title="Could not load local DNS records." onRetry={() => void refetch()} /></div>

  return (
    <div className="space-y-6">
      {header}

      <div className="rz-card flex items-start gap-3 border-[var(--line)] bg-[var(--sage)] p-4">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-white text-[var(--ink)] ring-1 ring-[var(--line)]">
          <Info size={14} />
        </span>
        <div className="text-[12px] leading-5 text-[var(--ink)]">
          <p>
            Only names ending in <span className="font-mono">.lan</span> are accepted. Exact names match only themselves.
            Use <span className="font-mono">*.home.lan</span> for wildcard subdomains — the apex{' '}
            <span className="font-mono">home.lan</span> is not included.
          </p>
          <p className="mt-1 text-[var(--muted)]">
            A/AAAA/CNAME answers can be comma-separated. Use new lines for multiple TXT values. Local records win before
            blocklists, cache, and upstream.
          </p>
        </div>
      </div>

      <div className="grid items-start gap-4 xl:grid-cols-[360px_1fr]">
        <ZoneForm
          form={form}
          editing={editingKey !== null}
          saving={save.isPending}
          error={error}
          onChange={setForm}
          onSubmit={submit}
          onCancel={cancelEdit}
        />
        <ZoneTable zones={data.zones} onEdit={startEdit} onDelete={confirmDelete} />
      </div>
    </div>
  )
}

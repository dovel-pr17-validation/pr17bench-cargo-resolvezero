import { createFileRoute } from '@tanstack/react-router'
import { useMutation, useQuery } from '@tanstack/react-query'
import { CheckCircle2, Copy, KeyRound, Network, ShieldCheck, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { getOverview, getSettingsData, purgeCache } from '../server/dashboard'
import { formatZoned } from '../lib/time'
import { useTimeZone } from '../lib/use-timezone'
import { PageError, PageLoading } from '../components/data-state'
import { PageHeader } from '../components/page-header'
import { DeleteProfileButton } from '../components/settings/delete-profile'
import { FilteringForm } from '../components/settings/filtering-form'
import { ResolverForm } from '../components/settings/resolver-form'
import { Button } from '../components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select'

const PURGE_TYPES = [
  { value: 'all', label: 'All types' },
  { value: 'A', label: 'A' },
  { value: 'AAAA', label: 'AAAA' },
  { value: 'CNAME', label: 'CNAME' },
  { value: 'TXT', label: 'TXT' },
  { value: 'MX', label: 'MX' },
  { value: 'NS', label: 'NS' },
  { value: 'HTTPS', label: 'HTTPS' },
] as const

export const Route = createFileRoute('/settings')({ component: SettingsPage })

function SettingsPage() {
  const { zone } = useTimeZone()
  const { data, isPending, isError, refetch } = useQuery({
    queryKey: ['settings'],
    queryFn: () => getSettingsData(),
  })
  // Cached from the app shell; used to disable deleting the last profile.
  const { data: overview } = useQuery({ queryKey: ['overview'], queryFn: () => getOverview() })
  const [domain, setDomain] = useState('')
  const [recordType, setRecordType] = useState('')
  const purge = useMutation({
    mutationFn: () =>
      purgeCache({ data: { domain, type: recordType || undefined, profileId: data?.profileId } }),
  })

  const header = (
    <PageHeader
      eyebrow="Account"
      title="Settings"
      description={`${data?.profileName ?? 'Profile'} · profile and resolver configuration.`}
    />
  )

  if (isPending) return <div className="space-y-6">{header}<PageLoading label="Loading settings…" /></div>
  if (isError || !data) return <div className="space-y-6">{header}<PageError title="Could not load settings." onRetry={() => void refetch()} /></div>


  return (
    <div className="space-y-6">
      {header}

      <div className="grid gap-4 xl:grid-cols-2">
        <Section title="Profile" icon={<ShieldCheck size={16} />}>
          <Row label="Name" value={data.profileName} />
          <Row label="Profile ID" value={data.profileId} mono />
          <Row label="Created" value={formatZoned(data.createdAt, 'dd MMM yyyy', zone)} />
          <Row label="DoH token" value={data.hasDohToken ? 'configured' : 'not set'} />
        </Section>

        <Section title="Upstream" icon={<Network size={16} />}>
          <ResolverForm initial={data} />
        </Section>
      </div>

      <Section title="Filtering" icon={<ShieldCheck size={16} />}>
        <FilteringForm initial={data} />
      </Section>

      <div className="rz-card p-5">
        <div className="flex items-center gap-2">
          <Trash2 size={16} className="text-[var(--muted)]" />
          <div>
            <h2 className="text-[14px] font-semibold">Purge cache</h2>
            <p className="mt-0.5 text-[11px] text-[var(--muted)]">Evict one name from the ResolveZero edge cache.</p>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={domain}
            onChange={(event) => setDomain(event.target.value)}
            placeholder="example.com"
            className="rz-input min-w-0 flex-1 font-mono"
          />
          <Select
            value={recordType || 'all'}
            onValueChange={(value) => setRecordType(value === 'all' ? '' : value)}
          >
            <SelectTrigger className="w-full sm:w-[136px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PURGE_TYPES.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            disabled={!domain.trim() || purge.isPending}
            onClick={() => purge.mutate()}
          >
            {purge.isPending ? 'Purging…' : 'Purge'}
          </Button>
        </div>
        {purge.isError ? <p className="mt-2 text-[11px] text-[var(--danger)]">{purge.error.message}</p> : null}
        {purge.isSuccess ? <p className="mt-2 text-[11px] text-[var(--green)]">Queued for {purge.data.name}{purge.data.type ? ` (${purge.data.type})` : ''}.</p> : null}
        <p className="mt-2 text-[10px] text-[var(--muted)]">
          Edge caches are purged within a few seconds. Upstream resolvers may still serve cached records until their TTL expires.
        </p>
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
        <div className="rz-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-[var(--line)] p-5">
            <Network size={16} className="text-[var(--muted)]" />
            <div>
              <h2 className="text-[14px] font-semibold">Linked source IPs</h2>
              <p className="mt-0.5 text-[11px] text-[var(--muted)]">UDP clients authorized for this profile.</p>
            </div>
          </div>
          <div className="divide-y divide-[var(--line)]">
            {data.sourceIps.length === 0 ? <p className="p-6 text-center text-[12px] text-[var(--muted)]">No linked IPs.</p> : null}
            {data.sourceIps.map((ip) => (
              <div key={ip} className="flex items-center gap-3 px-5 py-3.5">
                <CheckCircle2 size={14} className="text-[var(--green)]" />
                <span className="font-mono text-[12px]">{ip}</span>
                <span className="ml-auto text-[10px] text-[var(--muted)]">linked</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rz-card p-5">
          <div className="flex items-center gap-2">
            <KeyRound size={16} className="text-[var(--muted)]" />
            <h2 className="text-[14px] font-semibold">Capacity</h2>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-3">
            <Metric label="Rules" value={data.counts.rules} />
            <Metric label="Zones" value={data.counts.zones} />
            <Metric label="Lists" value={data.counts.lists} />
          </div>
          <p className="mt-5 flex items-center gap-2 text-[11px] text-[var(--muted)]">
            <Copy size={12} /> API key management lands with the public API.
          </p>
        </div>

        <div className="rz-card border-[#e7b4ae] p-5">
          <div className="flex items-center gap-2">
            <Trash2 size={16} className="text-[var(--danger)]" />
            <h2 className="text-[14px] font-semibold">Delete profile</h2>
          </div>
          <p className="mt-2 text-[11px] leading-5 text-[var(--muted)]">
            Permanently removes <span className="font-medium text-[var(--ink)]">{data.profileName}</span> with its rules,
            blocklists, local records, devices and stats. Linked devices stop resolving immediately.
          </p>
          <div className="mt-4">
            <DeleteProfileButton
              profile={{ id: data.profileId, name: data.profileName }}
              canDelete={(overview?.profiles.length ?? 0) > 1}
            />
          </div>
        </div>

      </div>
    </div>
  )
}

function Section({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rz-card p-5">
      <div className="mb-4 flex items-center gap-2"><span className="text-[var(--muted)]">{icon}</span><h2 className="rz-section-title">{title}</h2></div>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function Row({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--line)] pb-3 last:border-0 last:pb-0">
      <span className="text-[11px] text-[var(--muted)]">{label}</span>
      <span className={['text-right text-[11px]', mono ? 'max-w-[260px] truncate font-mono' : ''].join(' ')}>{value}</span>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[var(--radius-sm)] bg-[var(--sage)] p-3">
      <p className="text-[10px] text-[var(--muted)]">{label}</p>
      <p className="mt-1 rz-font-display text-[22px] font-semibold tracking-[-0.04em]">{value}</p>
    </div>
  )
}

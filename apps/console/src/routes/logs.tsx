import { createFileRoute } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'

import { PageError, PageLoading } from '../components/data-state'
import { PageHeader } from '../components/page-header'
import { LogFilters, ALL_DEVICES, ALL_POPS } from '../components/logs/log-filters'
import { LogTable } from '../components/logs/log-table'
import { useLogTail } from '../components/logs/use-log-tail'
import { popOptions } from '../lib/pops'
import { getOverview } from '../server/dashboard'

export const Route = createFileRoute('/logs')({ component: Logs })

function Logs() {
  const [search, setSearch] = useState('')
  const [blockedOnly, setBlockedOnly] = useState(false)
  const [device, setDevice] = useState(ALL_DEVICES)
  const [pop, setPop] = useState(ALL_POPS)
  const tail = useLogTail()
  // Shares the app-shell's cached overview call; used for the 24h device list.
  const { data: overview } = useQuery({ queryKey: ['overview'], queryFn: () => getOverview() })

  const devices = overview?.devices ?? []
  const pops = useMemo(() => popOptions(tail.entries.map((entry) => entry.region)), [tail.entries])

  const filtered = tail.entries.filter((entry) => {
    if (blockedOnly && entry.action !== 'block') return false
    if (device !== ALL_DEVICES && entry.device !== device) return false
    if (pop !== ALL_POPS && entry.region !== pop) return false
    return search.trim() ? entry.domain.toLowerCase().includes(search.toLowerCase()) : true
  })

  const header = (
    <PageHeader
      eyebrow="Observe"
      title="Query log"
      description={`${tail.profileName || overview?.profileName || 'Profile'} · live tail · appends every 30s · 1-minute archive flush`}
    />
  )

  if (tail.pending) return <div className="space-y-6">{header}<PageLoading label="Loading recent queries…" /></div>
  if (tail.error && tail.entries.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <PageError title="Could not load query logs." onRetry={() => void tail.refresh()} />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {header}

      <div className="rz-card overflow-hidden">
        <LogFilters
          search={search}
          onSearch={setSearch}
          blockedOnly={blockedOnly}
          onBlockedOnly={setBlockedOnly}
          device={device}
          onDevice={setDevice}
          devices={devices}
          pop={pop}
          onPop={setPop}
          pops={pops}
          live={!tail.error}
          fetching={tail.fetching}
          updatedAt={tail.updatedAt}
          added={tail.added}
          total={filtered.length}
          onRefresh={() => void tail.refresh()}
        />
        <LogTable entries={filtered} />
      </div>
    </div>
  )
}

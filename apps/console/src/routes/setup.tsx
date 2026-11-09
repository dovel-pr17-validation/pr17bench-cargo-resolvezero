import { createFileRoute, Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, RefreshCw } from 'lucide-react'
import { useState } from 'react'

import { PageError, PageLoading } from '../components/data-state'
import { DnsProbeBadge } from '../components/dns-probe-badge'
import { PageHeader } from '../components/page-header'
import { EndpointsCard } from '../components/setup/endpoints-card'
import { IdentifyDevicesCard } from '../components/setup/identify-devices'
import { LinkedIpCard } from '../components/setup/linked-ip-card'
import { SetupTabs } from '../components/setup/setup-tabs'
import { Button } from '../components/ui/button'
import { ensureDotId, getDeviceSetup } from '../server/device-setup'
import { getSettingsData } from '../server/dashboard'

export const Route = createFileRoute('/setup')({ component: SetupPage })

function SetupPage() {
  const queryClient = useQueryClient()
  const [probeKey, setProbeKey] = useState(0)

  const setup = useQuery({ queryKey: ['device-setup'], queryFn: () => getDeviceSetup() })
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => getSettingsData() })

  const dot = useMutation({
    mutationFn: () => ensureDotId(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['device-setup'] }),
  })

  const header = (
    <PageHeader
      eyebrow="Network"
      title="Setup"
      description="Set this profile up on a router, phone, or computer. DoH/DoT work anywhere; plain DNS needs this network’s public IP linked first."
    />
  )

  if (setup.isPending || settings.isPending) {
    return (
      <div className="space-y-6">
        {header}
        <PageLoading label="Loading setup details…" />
      </div>
    )
  }

  if (setup.isError || settings.isError || !setup.data || !settings.data) {
    return (
      <div className="space-y-6">
        {header}
        <PageError
          title="Could not load setup details."
          onRetry={() => {
            void setup.refetch()
            void settings.refetch()
          }}
        />
      </div>
    )
  }

  const data = setup.data
  const dotHost = dot.data?.hostname ?? data.dotHostname
  const edgeOrigin = new URL(data.dohBase).origin
  const untaggedDohUrl = `${data.dohBase}/${data.token}`

  return (
    <div className="space-y-6">
      {header}

      <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
        <EndpointsCard
          profileId={data.profileId}
          dohUrl={untaggedDohUrl}
          dotHost={dotHost}
          dnsIps={data.dnsIps}
          onGenerateDot={() => dot.mutate()}
          generatingDot={dot.isPending}
        />
        <LinkedIpCard
          profileId={data.profileId}
          token={data.token}
          edgeOrigin={edgeOrigin}
          linkedIps={settings.data.sourceIps}
        />
      </div>

      <SetupTabs
        dohBase={data.dohBase}
        token={data.token}
        dotHost={dotHost}
        dnsIps={data.dnsIps}
        onGenerateDot={() => dot.mutate()}
        generatingDot={dot.isPending}
      />

      <IdentifyDevicesCard dohBase={data.dohBase} token={data.token} dotHost={dotHost} />

      <div className="rz-card p-5">
        <h2 className="rz-section-title">Verify</h2>
        <p className="mt-1.5 text-[11px] text-[var(--muted)]">
          After saving the new DNS settings, reload this page. The check below only tests the device you are on.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <DnsProbeBadge key={probeKey} profileId={data.profileId} />
          <Button type="button" variant="secondary" size="sm" onClick={() => setProbeKey((value) => value + 1)}>
            <RefreshCw size={12} /> Check again
          </Button>
          <Button asChild variant="secondary" size="sm">
            <Link to="/logs">
              <FileText size={12} /> Open query log
            </Link>
          </Button>
        </div>
      </div>
    </div>
  )
}

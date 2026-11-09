import { Download } from 'lucide-react'

import { Button } from '../ui/button'
import { CopyRow, LinkedIpHint, Method, Or, Steps } from './shared'

export type SetupTab = 'router' | 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'browsers'

export function SetupMethod({
  tab,
  dohUrl,
  dotHost,
  dnsIps,
  slug,
  onGenerateDot,
  generatingDot,
}: {
  tab: SetupTab
  dohUrl: string
  dotHost: string | null
  dnsIps: string[]
  slug: string
  onGenerateDot: () => void
  generatingDot: boolean
}) {
  const plain = dnsIps.join('  ·  ')

  if (tab === 'router') {
    return (
      <>
        <Method title="DNS over HTTPS" badge="Recommended">
          <Steps
            items={[
              'Open the router’s DNS settings (usually Internet → DNS, or WAN → DNS).',
              'Choose DNS-over-HTTPS / DoH and paste the URL below.',
              'Save, then reconnect Wi-Fi clients so they pick up the new resolver.',
            ]}
          />
          <CopyRow label="DoH URL" value={dohUrl} />
        </Method>
        <Or />
        <Method title="DNS over TLS">
          <Steps
            items={[
              'Choose DNS-over-TLS / DoT in the router’s DNS settings.',
              'Paste the hostname below (port 853).',
              'DoT is one hostname for the whole profile — devices share attribution.',
            ]}
          />
          {dotHost ? (
            <CopyRow label="DoT hostname" value={dotHost} />
          ) : (
            <Button type="button" size="sm" onClick={onGenerateDot} disabled={generatingDot}>
              {generatingDot ? 'Generating…' : 'Generate DoT hostname'}
            </Button>
          )}
        </Method>
        <Or />
        <Method title="Plain DNS (IPv4)">
          <Steps
            items={[
              'Set the router’s DNS servers to the two addresses below.',
              'Link this network’s public IP on the right so the resolver accepts it.',
              'Keep both addresses configured so a POP outage does not take DNS down.',
            ]}
          />
          <CopyRow label="DNS servers" value={plain} />
          <LinkedIpHint />
        </Method>
      </>
    )
  }

  if (tab === 'ios') {
    return (
      <>
        <Method title="Configuration profile" badge="Recommended">
          <Steps
            items={[
              'Download the profile, then open Settings — “Profile Downloaded” appears at the top.',
              'Tap Install, enter the passcode, and confirm.',
              'Reload this page on the device to confirm it is using ResolveZero.',
            ]}
          />
          {slug ? (
            <Button asChild>
              <a href={`/api/profile/${slug}`} download>
                <Download size={13} /> Download .mobileconfig
              </a>
            </Button>
          ) : (
            <p className="text-[10px] text-[var(--muted)]">Name the device above to enable the download.</p>
          )}
        </Method>
        <Or />
        <Method title="Plain DNS (IPv4)">
          <Steps
            items={[
              'Open Settings → Wi-Fi, tap (i) next to the network, then Configure DNS → Manual.',
              'Add both addresses below and remove the automatic servers.',
              'Link this network’s public IP first — plain DNS is rejected otherwise.',
            ]}
          />
          <CopyRow label="DNS servers" value={plain} />
          <LinkedIpHint />
        </Method>
      </>
    )
  }

  if (tab === 'android') {
    return (
      <>
        <Method title="Private DNS (DoT)" badge="Recommended">
          <Steps
            items={[
              'Open Settings → Network & internet → Private DNS.',
              'Choose “Private DNS provider hostname”.',
              'Paste the hostname below and save.',
            ]}
          />
          {dotHost ? (
            <CopyRow label="Private DNS hostname" value={dotHost} />
          ) : (
            <Button type="button" size="sm" onClick={onGenerateDot} disabled={generatingDot}>
              {generatingDot ? 'Generating…' : 'Generate DoT hostname'}
            </Button>
          )}
        </Method>
        <Or />
        <Method title="Plain DNS (IPv4)">
          <Steps
            items={[
              'Open the Wi-Fi network → Advanced → IP settings → Static (or Private DNS off).',
              'Set DNS 1 and DNS 2 to the addresses below.',
              'Link this network’s public IP first.',
            ]}
          />
          <CopyRow label="DNS servers" value={plain} />
          <LinkedIpHint />
        </Method>
      </>
    )
  }

  if (tab === 'windows') {
    return (
      <>
        <Method title="DNS over HTTPS (Windows 11)" badge="Recommended">
          <Steps
            items={[
              'Settings → Network & internet → Wi-Fi/Ethernet → Hardware properties → DNS server assignment → Edit.',
              'Set DNS to Manual, enable IPv4, and enter a resolver address (37.16.24.24).',
              'Set “DNS over HTTPS” to On (manual template) and paste the URL below.',
            ]}
          />
          <CopyRow label="DoH template" value={dohUrl} />
        </Method>
        <Or />
        <Method title="Plain DNS (IPv4)">
          <Steps
            items={[
              'Same DNS screen, but leave “DNS over HTTPS” off.',
              'Preferred DNS 37.16.24.24, alternate DNS 37.16.24.46.',
              'Link this network’s public IP first.',
            ]}
          />
          <CopyRow label="DNS servers" value={plain} />
          <LinkedIpHint />
        </Method>
      </>
    )
  }

  if (tab === 'macos') {
    return (
      <>
        <Method title="Configuration profile" badge="Recommended">
          <Steps
            items={[
              'Download the profile and open it — macOS asks to install it under Privacy & Security → Profiles.',
              'Approve it in System Settings, then verify DNS is set to ResolveZero.',
              'The same profile works on iOS and macOS.',
            ]}
          />
          {slug ? (
            <Button asChild>
              <a href={`/api/profile/${slug}`} download>
                <Download size={13} /> Download .mobileconfig
              </a>
            </Button>
          ) : (
            <p className="text-[10px] text-[var(--muted)]">Name the device above to enable the download.</p>
          )}
        </Method>
        <Or />
        <Method title="Plain DNS (IPv4)">
          <Steps
            items={[
              'System Settings → Network → your connection → Details → DNS.',
              'Add both addresses below and remove the existing servers.',
              'Link this network’s public IP first.',
            ]}
          />
          <CopyRow label="DNS servers" value={plain} />
          <LinkedIpHint />
        </Method>
      </>
    )
  }

  if (tab === 'linux') {
    return (
      <>
        <Method title="DNS over TLS (systemd-resolved)" badge="Recommended">
          <Steps
            items={[
              'Edit /etc/systemd/resolved.conf and set DNSOverTLS=yes.',
              'Set DNS to the resolver IP with the DoT hostname: 37.16.24.24#<hostname>.',
              'Restart the service: sudo systemctl restart systemd-resolved.',
            ]}
          />
          {dotHost ? (
            <CopyRow label="resolved DNS line" value={`DNS=37.16.24.24#${dotHost}`} />
          ) : (
            <Button type="button" size="sm" onClick={onGenerateDot} disabled={generatingDot}>
              {generatingDot ? 'Generating…' : 'Generate DoT hostname'}
            </Button>
          )}
        </Method>
        <Or />
        <Method title="Plain DNS (IPv4)">
          <Steps
            items={[
              'Set DNS in NetworkManager, netplan, or /etc/resolv.conf.',
              'Use both addresses below.',
              'Link this network’s public IP first.',
            ]}
          />
          <CopyRow label="DNS servers" value={plain} />
          <LinkedIpHint />
        </Method>
      </>
    )
  }

  return (
    <>
      <Method title="Firefox">
        <Steps
          items={[
            'Settings → Privacy & Security → DNS over HTTPS → Max Protection.',
            'Choose “Custom” and paste the URL below.',
            'Firefox then ignores the operating system’s resolver for lookups.',
          ]}
        />
        <CopyRow label="DoH URL" value={dohUrl} />
      </Method>
      <Or />
      <Method title="Chrome / Edge">
        <Steps
          items={[
            'Settings → Privacy and security → Security → Use secure DNS.',
            'Choose “Custom” and paste the URL below.',
            'Remember that browser DoH bypasses router-level filtering and per-device attribution at the OS level.',
          ]}
        />
        <CopyRow label="DoH URL" value={dohUrl} />
      </Method>
    </>
  )
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link2, LoaderCircle, RefreshCw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { unlinkSourceIp } from '../../server/dashboard'
import { Button } from '../ui/button'

type Phase = 'checking' | 'ready' | 'linking' | 'unavailable'

export function LinkedIpCard({
  profileId,
  token,
  edgeOrigin,
  linkedIps,
}: {
  profileId: string
  token: string
  edgeOrigin: string
  linkedIps: string[]
}) {
  const queryClient = useQueryClient()
  const [ip, setIp] = useState<string | null>(null)
  const [linked, setLinked] = useState(false)
  const [phase, setPhase] = useState<Phase>('checking')
  const [error, setError] = useState<string | null>(null)

  const check = useCallback(async () => {
    setPhase('checking')
    setError(null)
    try {
      const res = await fetch(`${edgeOrigin}/v1/${encodeURIComponent(profileId)}/whoami`, {
        headers: { authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`The edge returned HTTP ${res.status}.`)
      const body = (await res.json()) as { ip: string; linked: boolean }
      setIp(body.ip)
      setLinked(body.linked)
      setPhase('ready')
    } catch (err) {
      setPhase('unavailable')
      setError(err instanceof Error ? err.message : 'Could not reach the edge')
    }
  }, [edgeOrigin, profileId, token])

  useEffect(() => {
    void check()
  }, [check])

  async function link() {
    setPhase('linking')
    setError(null)
    try {
      const res = await fetch(`${edgeOrigin}/v1/${encodeURIComponent(profileId)}/update-ip`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
      const body = (await res.json().catch(() => ({}))) as { ip?: string; error?: string }
      if (!res.ok) throw new Error(body.error ?? `The edge returned HTTP ${res.status}.`)
      if (body.ip) setIp(body.ip)
      setLinked(true)
      setPhase('ready')
      await queryClient.invalidateQueries({ queryKey: ['settings'] })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not link this IP')
      setPhase('ready')
    }
  }

  const remove = useMutation({
    mutationFn: (address: string) => unlinkSourceIp({ data: { ip: address } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['settings'] }),
  })

  return (
    <div className="rz-card flex flex-col p-5">
      <div>
        <h2 className="rz-section-title">
          <Link2 size={14} className="mr-2 inline text-[var(--brand)]" />
          Linked IP
        </h2>
        <p className="mt-1.5 text-[11px] text-[var(--muted)]">
          Plain DNS over UDP/TCP only answers for a linked public IP. Encrypted DNS (DoH/DoT) does not need this.
        </p>
      </div>

      <div className="mt-4 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)]/60 p-3">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">Your public IP</span>
          {phase === 'checking' || phase === 'linking' ? (
            <LoaderCircle size={13} className="animate-spin text-[var(--muted)]" />
          ) : ip ? (
            <span className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.06em]">
              <span className={['size-1.5 rounded-full', linked ? 'bg-[var(--green)]' : 'bg-[var(--warning)]'].join(' ')} />
              {linked ? 'Linked' : 'Not linked'}
            </span>
          ) : null}
        </div>
        <p className="mt-1.5 font-mono text-[14px]">{ip ?? (phase === 'unavailable' ? 'Unknown' : 'Checking…')}</p>
        {ip && linkedIps.length > 0 && !linkedIps.includes(ip) ? (
          <p className="mt-1 text-[10px] text-[var(--warning)]">
            This address is not in the linked list yet — link it below.
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={() => void link()} disabled={!ip || linked || phase === 'linking'}>
            {phase === 'linking' ? 'Linking…' : linked ? 'Linked' : 'Link this IP'}
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => void check()}>
            <RefreshCw size={12} /> Refresh
          </Button>
        </div>
        {error ? (
          <p role="alert" className="mt-2 text-[10px] text-[var(--danger)]">
            {error}
          </p>
        ) : null}
      </div>

      <div className="mt-4 space-y-2 border-t border-[var(--line)] pt-3">
        <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">
          Linked addresses ({linkedIps.length})
        </p>
        {linkedIps.length === 0 ? (
          <p className="text-[11px] text-[var(--muted)]">No addresses linked for this profile yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {linkedIps.map((address) => (
              <li key={address} className="flex items-center justify-between gap-2 font-mono text-[11px]">
                <span>{address}</span>
                <button
                  type="button"
                  aria-label={`Unlink ${address}`}
                  onClick={() => remove.mutate(address)}
                  disabled={remove.isPending}
                  className="p-1 text-[var(--muted)] transition-colors hover:text-[var(--danger)] disabled:opacity-50"
                >
                  <Trash2 size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="mt-3 text-[10px] leading-5 text-[var(--muted)]">
        Dynamic IP? Relink whenever your ISP changes it. A router can call{' '}
        <code className="font-mono">/v1/&lt;profile&gt;/update-ip</code> on a schedule with the DoH token.
      </p>
    </div>
  )
}

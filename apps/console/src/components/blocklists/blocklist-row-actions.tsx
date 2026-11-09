import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'

import { deleteBlocklist, setBlocklistEnabled } from '../../server/policy'
import { Switch } from '../ui/switch'

export function BlocklistRowActions({
  id,
  url,
  enabled,
  profileId,
}: {
  id: string
  url: string
  enabled: boolean
  profileId: string
}) {
  const queryClient = useQueryClient()
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: ['blocklists'] })
    await queryClient.invalidateQueries({ queryKey: ['rules'] })
  }

  const toggle = useMutation({
    mutationFn: (next: boolean) => setBlocklistEnabled({ data: { id, enabled: next, profileId } }),
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: () => deleteBlocklist({ data: { id, profileId } }),
    onSuccess: invalidate,
  })

  const label = url.split('/').slice(-1)[0] || url

  return (
    <div className="flex items-center justify-end gap-3">
      <Switch
        checked={enabled}
        disabled={toggle.isPending || remove.isPending}
        onCheckedChange={(next) => toggle.mutate(next)}
        aria-label={enabled ? `Disable ${label}` : `Enable ${label}`}
      />
      <button
        type="button"
        disabled={remove.isPending}
        onClick={() => {
          if (window.confirm(`Remove ${label} from this profile?`)) remove.mutate()
        }}
        aria-label={`Remove ${label}`}
        className="text-[var(--muted)] transition-colors hover:text-[var(--danger)] disabled:opacity-50"
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'

import { deleteRule, setRuleEnabled } from '../../server/policy'
import { Switch } from '../ui/switch'

export function RuleRowActions({
  domain,
  enabled,
  profileId,
}: {
  domain: string
  enabled: boolean
  profileId: string
}) {
  const queryClient = useQueryClient()

  const toggle = useMutation({
    mutationFn: (next: boolean) => setRuleEnabled({ data: { domain, enabled: next, profileId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rules'] }),
  })

  const remove = useMutation({
    mutationFn: () => deleteRule({ data: { domain, profileId } }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['rules'] }),
  })

  return (
    <div className="flex items-center justify-end gap-3">
      <Switch
        checked={enabled}
        disabled={toggle.isPending || remove.isPending}
        onCheckedChange={(next) => toggle.mutate(next)}
        aria-label={enabled ? `Disable rule for ${domain}` : `Enable rule for ${domain}`}
      />
      <button
        type="button"
        disabled={remove.isPending}
        onClick={() => {
          if (window.confirm(`Delete the rule for ${domain}?`)) remove.mutate()
        }}
        aria-label={`Delete rule for ${domain}`}
        className="text-[var(--muted)] transition-colors hover:text-[var(--danger)] disabled:opacity-50"
      >
        <Trash2 size={14} />
      </button>
    </div>
  )
}

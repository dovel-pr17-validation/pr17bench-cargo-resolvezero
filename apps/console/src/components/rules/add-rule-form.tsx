import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import type { RuleAction } from '../../lib/policy'
import { createRule } from '../../server/policy'
import { Button } from '../ui/button'

const ACTIONS: { value: RuleAction; label: string; active: string }[] = [
  { value: 'block', label: 'Block', active: 'bg-[var(--accent)] text-white' },
  { value: 'allow', label: 'Allow', active: 'bg-[var(--green)] text-white' },
]

export function AddRuleForm({ profileId, onDone }: { profileId: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [domain, setDomain] = useState('')
  const [action, setAction] = useState<RuleAction>('block')

  const mutation = useMutation({
    mutationFn: () => createRule({ data: { domain: domain.trim(), action, profileId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['rules'] })
      setDomain('')
      onDone()
    },
  })

  return (
    <form
      className="border-b border-[var(--line)] bg-[var(--paper)]/40 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (domain.trim()) mutation.mutate()
      }}
    >
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          autoFocus
          value={domain}
          onChange={(event) => setDomain(event.target.value)}
          placeholder="ads.example.com"
          aria-label="Domain"
          spellCheck={false}
          autoCapitalize="none"
          className="rz-input min-w-0 flex-1 font-mono"
        />
        <div className="flex items-center border border-[var(--line-strong)]">
          {ACTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={action === option.value}
              onClick={() => setAction(option.value)}
              className={[
                'px-3 py-2 text-[10px] font-medium uppercase tracking-[0.06em] transition-colors',
                action === option.value
                  ? option.active
                  : 'text-[var(--muted)] hover:text-[var(--ink)]',
              ].join(' ')}
            >
              {option.label}
            </button>
          ))}
        </div>
        <Button type="submit" disabled={!domain.trim() || mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save rule'}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-[var(--muted)]">
        Matches the name and every subdomain. An <span className="font-semibold text-[var(--green)]">allow</span> rule
        overrides every blocklist.
      </p>
      {mutation.isError ? (
        <p role="alert" className="mt-2 text-[11px] text-[var(--danger)]">
          {mutation.error.message}
        </p>
      ) : null}
    </form>
  )
}

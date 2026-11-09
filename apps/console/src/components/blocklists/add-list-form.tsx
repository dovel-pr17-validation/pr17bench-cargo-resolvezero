import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { BLOCKLIST_FORMATS, type BlocklistFormat } from '../../lib/policy'
import { createBlocklist } from '../../server/policy'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

/** Curated starting points; the URL stays editable after picking one. */
const SUGGESTED = [
  { label: 'Adult content', url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn/hosts' },
  { label: 'Gambling', url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/gambling/hosts' },
  { label: 'Fake news', url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/fakenews/hosts' },
  { label: 'Social', url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/social/hosts' },
]

export function AddListForm({ profileId, onDone }: { profileId: string; onDone: () => void }) {
  const queryClient = useQueryClient()
  const [url, setUrl] = useState('')
  const [format, setFormat] = useState<BlocklistFormat>('auto')

  const mutation = useMutation({
    mutationFn: () => createBlocklist({ data: { url: url.trim(), format, profileId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['blocklists'] })
      await queryClient.invalidateQueries({ queryKey: ['rules'] })
      setUrl('')
      onDone()
    },
  })

  return (
    <form
      className="border-b border-[var(--line)] bg-[var(--paper)]/40 p-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (url.trim()) mutation.mutate()
      }}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">Suggested</span>
        {SUGGESTED.map((preset) => (
          <button
            key={preset.label}
            type="button"
            onClick={() => setUrl(preset.url)}
            className="rounded-[var(--radius-sm)] border border-[var(--line-strong)] px-2.5 py-1 text-[11px] text-[var(--muted)] transition-colors hover:bg-[var(--paper-2)] hover:text-[var(--ink)]"
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          autoFocus
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/hosts.txt"
          aria-label="Blocklist URL"
          spellCheck={false}
          autoCapitalize="none"
          className="rz-input min-w-0 flex-1 font-mono"
        />
        <Select value={format} onValueChange={(value) => setFormat(value as BlocklistFormat)}>
          <SelectTrigger className="w-full sm:w-[210px]" aria-label="List format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {BLOCKLIST_FORMATS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={!url.trim() || mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save list'}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
      <p className="mt-2 text-[10px] leading-4 text-[var(--muted)]">
        https only. Auto-detect sniffs hosts, domains, and adblock syntax from the file; override it only if a list
        mixes formats. The edge fetches it on its next sync — usually within seconds.
      </p>
      {mutation.isError ? (
        <p role="alert" className="mt-2 text-[11px] text-[var(--danger)]">
          {mutation.error.message}
        </p>
      ) : null}
    </form>
  )
}

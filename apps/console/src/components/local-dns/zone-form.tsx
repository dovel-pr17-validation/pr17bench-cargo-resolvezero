import { Plus } from 'lucide-react'
import type { FormEvent } from 'react'

import { ZONE_RECORD_TYPES, type ZoneRecordType } from '../../lib/zone'
import { Button } from '../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

export type ZoneFormState = {
  domain: string
  recordType: ZoneRecordType
  values: string
  ttl: string
}

export const emptyZoneForm: ZoneFormState = { domain: '', recordType: 'A', values: '', ttl: '300' }

function valuePlaceholder(type: ZoneRecordType): string {
  if (type === 'A') return '192.168.1.24, 192.168.1.25'
  if (type === 'AAAA') return 'fd00::24'
  if (type === 'CNAME') return 'nas.local'
  return 'v=spf1 -all'
}

export function ZoneForm({
  form,
  editing,
  saving,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  form: ZoneFormState
  editing: boolean
  saving: boolean
  error: string | null
  onChange: (form: ZoneFormState) => void
  onSubmit: (event: FormEvent) => void
  onCancel: () => void
}) {
  return (
    <form onSubmit={onSubmit} className="rz-card h-fit p-5">
      <div className="flex items-center gap-2">
        <Plus size={16} className="text-[var(--muted)]" />
        <div>
          <h2 className="text-[14px] font-semibold">{editing ? 'Edit local record' : 'Add local record'}</h2>
          <p className="mt-0.5 text-[11px] text-[var(--muted)]">Changes reach every edge in seconds.</p>
        </div>
      </div>

      <label htmlFor="zone-domain" className="rz-field-label mt-5">
        Name
      </label>
      <input
        id="zone-domain"
        value={form.domain}
        onChange={(event) => onChange({ ...form, domain: event.target.value })}
        placeholder="nas.lan"
        autoComplete="off"
        spellCheck={false}
        className="rz-input mt-1.5 font-mono"
      />
      <p className="mt-1.5 text-[10px] text-[var(--muted)]">Must end in .lan.</p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="zone-type" className="rz-field-label">
            Type
          </label>
          <Select
            value={form.recordType}
            onValueChange={(value) => onChange({ ...form, recordType: value as ZoneRecordType })}
          >
            <SelectTrigger id="zone-type" className="mt-1.5">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ZONE_RECORD_TYPES.map((type) => (
                <SelectItem key={type} value={type}>
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label htmlFor="zone-ttl" className="rz-field-label">
            TTL (seconds)
          </label>
          <input
            id="zone-ttl"
            type="number"
            min={1}
            max={86400}
            value={form.ttl}
            onChange={(event) => onChange({ ...form, ttl: event.target.value })}
            className="rz-input mt-1.5 font-mono"
          />
        </div>
      </div>

      <label htmlFor="zone-values" className="rz-field-label mt-3">
        Answer
      </label>
      <textarea
        id="zone-values"
        rows={2}
        value={form.values}
        onChange={(event) => onChange({ ...form, values: event.target.value })}
        placeholder={valuePlaceholder(form.recordType)}
        spellCheck={false}
        className="rz-input mt-1.5 resize-y font-mono"
      />
      <p className="mt-1.5 text-[10px] leading-4 text-[var(--muted)]">
        Up to 8 values. Separate A/AAAA/CNAME values with commas; TXT values can be one per line.
      </p>

      {error ? (
        <p role="alert" className="mt-3 rounded-[var(--radius-sm)] border border-[#e7b4ae] bg-[var(--accent-soft)] px-3 py-2 text-[11px] leading-5 text-[var(--danger)]">
          {error}
        </p>
      ) : null}

      <div className="mt-4 flex gap-2">
        <Button
          type="submit"
          disabled={saving || !form.domain.trim() || !form.values.trim()}
          className="flex-1"
        >
          {saving ? 'Saving…' : editing ? 'Update record' : 'Add record'}
        </Button>
        {editing ? (
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  )
}

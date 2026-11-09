import { Check, Copy } from 'lucide-react'
import type { ReactNode } from 'react'
import { useState } from 'react'

export function CopyRow({
  label,
  value,
  placeholder,
  note,
  mono = true,
}: {
  label: string
  value: string
  placeholder?: string
  note?: string
  mono?: boolean
}) {
  const [copied, setCopied] = useState(false)

  async function copy() {
    if (!value) return
    await navigator.clipboard.writeText(value)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.06em] text-[var(--muted)]">{label}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <code
          className={[
            'min-w-0 flex-1 overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--card)] px-3 py-2 text-[11px]',
            mono ? 'font-mono' : '',
            value ? 'text-[var(--ink)]' : 'text-[var(--muted)]',
          ].join(' ')}
        >
          {value || placeholder || '—'}
        </code>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={!value}
          className="inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--line-strong)] bg-[var(--card)] px-3 text-[11px] text-[var(--ink)] transition-colors hover:bg-[var(--paper-2)] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {note ? <p className="text-[10px] leading-5 text-[var(--muted)]">{note}</p> : null}
    </div>
  )
}

export function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2">
      {items.map((item, index) => (
        <li key={item} className="flex gap-3 text-[11px] leading-5 text-[var(--muted)]">
          <span className="rz-mono mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--paper-2)] text-[9px] text-[var(--ink)]">
            {index + 1}
          </span>
          <span>{item}</span>
        </li>
      ))}
    </ol>
  )
}

export function Method({ title, badge, children }: { title: string; badge?: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[12px] font-semibold">{title}</p>
        {badge ? (
          <span className="rounded-[4px] bg-[var(--brand-soft)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.06em] text-[var(--brand)]">
            {badge}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  )
}

export function Or() {
  return (
    <div className="flex items-center gap-3">
      <span className="h-px flex-1 bg-[var(--line)]" />
      <span className="text-[9px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">or</span>
      <span className="h-px flex-1 bg-[var(--line)]" />
    </div>
  )
}

export function LinkedIpHint() {
  return (
    <p className="text-[10px] leading-5 text-[var(--muted)]">
      Plain DNS only answers for a linked public IP — link this network in the Linked IP card above first.
    </p>
  )
}

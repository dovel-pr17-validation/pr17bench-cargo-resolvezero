import type { ReactNode } from 'react'

export function PagePlaceholder({
  eyebrow,
  title,
  description,
  icon,
  children,
}: {
  eyebrow: string
  title: string
  description: string
  icon: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--muted)]">{eyebrow}</p>
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-[var(--radius-sm)] bg-[var(--brand-soft)] text-[var(--brand)] ring-1 ring-[var(--line)]">{icon}</span>
          <div>
            <h1 className="text-[28px] font-semibold tracking-[-0.045em]">{title}</h1>
            <p className="mt-1 text-[13px] text-[var(--muted)]">{description}</p>
          </div>
        </div>
      </div>
      <div className="rz-card p-6">
        {children ?? (
          <div className="flex min-h-[280px] flex-col items-center justify-center text-center">
            <span className="flex size-12 items-center justify-center rounded-2xl bg-[var(--paper-2)] text-[var(--muted)]">{icon}</span>
            <p className="mt-4 text-[13px] font-medium">This view is next.</p>
            <p className="mt-1 max-w-[320px] text-[12px] leading-5 text-[var(--muted)]">
              The shell and visual language are in place. The live data and actions land in the next implementation phase.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

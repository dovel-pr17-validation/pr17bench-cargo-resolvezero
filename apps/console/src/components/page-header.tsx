import type { ReactNode } from 'react'

export function PageHeader({
  eyebrow,
  title,
  description,
  icon,
  actions,
  meta,
}: {
  eyebrow?: string
  title: string
  description?: ReactNode
  icon?: ReactNode
  actions?: ReactNode
  meta?: ReactNode
}) {
  return (
    <div className="border-b border-[var(--line)] pb-6">
      <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-end">
        <div className="min-w-0">
          {eyebrow ? <p className="rz-eyebrow mb-4">{eyebrow}</p> : null}
          <div className="flex items-start gap-4">
            {icon ? <span className="rz-page-icon mt-1 hidden sm:flex">{icon}</span> : null}
            <div className="min-w-0">
              <h1 className="rz-page-title">{title}</h1>
              {description ? (
                <p className="mt-3 max-w-2xl text-[12px] leading-6 text-[var(--muted)]">{description}</p>
              ) : null}
            </div>
          </div>
          {meta ? <div className="mt-5 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  )
}

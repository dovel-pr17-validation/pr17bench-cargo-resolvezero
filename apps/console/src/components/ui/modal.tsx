import type { ReactNode } from 'react'

export function Modal({
  title,
  description,
  onClose,
  children,
}: {
  title: string
  description: string
  onClose: () => void
  children: ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/35 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
    >
      <div
        className="w-full max-w-[420px] rounded-[var(--radius)] border border-[var(--line)] bg-[var(--card)] p-5 shadow-[var(--shadow-pop)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold">{title}</h2>
        <p className="mt-1.5 text-[11px] leading-5 text-[var(--muted)]">{description}</p>
        {children}
      </div>
    </div>
  )
}

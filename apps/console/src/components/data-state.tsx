import { Button } from './ui/button'

export function PageLoading({ label = "Loading live data…" }: { label?: string }) {
  return (
    <div className="rz-card flex min-h-[280px] items-center justify-center p-8" aria-busy="true">
      <div className="text-center">
        <span className="mx-auto block size-5 animate-spin rounded-full border-2 border-[var(--line)] border-t-[var(--brand)]" />
        <p className="mt-3 text-[12px] text-[var(--muted)]">{label}</p>
      </div>
    </div>
  )
}

export function PageError({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <div className="rz-card mx-auto mt-16 max-w-[520px] p-8 text-center">
      <span className="rz-pill rz-pill-danger mx-auto">Data unavailable</span>
      <h1 className="rz-page-title mt-4">{title}</h1>
      <p className="mt-2 text-[13px] leading-6 text-[var(--muted)]">
        Check the console server logs for the Postgres or edge error.
      </p>
      <Button className="mt-5" onClick={onRetry}>Try again</Button>
    </div>
  )
}

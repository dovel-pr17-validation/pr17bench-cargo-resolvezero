import { splitDomain } from '../lib/domain'

/**
 * Renders a DNS name with a middle ellipsis: the head truncates, the tail
 * (registrable domain) always stays visible, and the full name is on `title`.
 * Needs a width-constrained parent (`min-w-0`, `max-w-*`) to clip.
 */
export function DomainLabel({ domain, className }: { domain: string; className?: string }) {
  const { head, tail } = splitDomain(domain)
  if (!head) {
    return (
      <span title={domain} className={['block truncate', className].filter(Boolean).join(' ')}>
        {domain}
      </span>
    )
  }
  return (
    <span title={domain} className={['flex min-w-0 items-baseline', className].filter(Boolean).join(' ')}>
      <span className="truncate">{head}</span>
      <span className="shrink-0">{tail}</span>
    </span>
  )
}

/**
 * Middle ellipsis for DNS names: keep the beginning and the registrable end
 * visible, truncate the middle. CSS can only clip the end, so the name is
 * split into a shrinking head and a fixed tail and the head does the clipping.
 *
 *   b79c66077e27a1c1…a2z.com   (head truncates, tail stays)
 *
 * Pure — unit-tested.
 */
export function splitDomain(domain: string): { head: string; tail: string } {
  const labels = domain.split('.');
  if (labels.length < 2) return { head: '', tail: domain };
  // Keep the last two labels (example.com) when there is a subdomain to clip;
  // for two-label names keep the TLD and let the name itself truncate.
  const tailLabels = labels.length >= 3 ? 2 : 1;
  return {
    head: `${labels.slice(0, -tailLabels).join('.')}.`,
    tail: labels.slice(-tailLabels).join('.'),
  };
}

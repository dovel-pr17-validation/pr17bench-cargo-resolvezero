/**
 * POP catalog. The filter should offer every POP the resolver can answer
 * from, not just the ones present in the current log window, so a region is
 * listed even when it has no recent traffic. Add a row here when the edge
 * fleet grows; unknown codes seen in logs are appended automatically.
 */
export interface Pop {
  code: string;
  name: string;
}

export const POPS: Pop[] = [
  { code: 'fra', name: 'Frankfurt' },
  { code: 'lhr', name: 'London' },
  { code: 'iad', name: 'Ashburn' },
  { code: 'sjc', name: 'San José' },
  { code: 'nrt', name: 'Tokyo' },
  { code: 'syd', name: 'Sydney' },
  { code: 'gru', name: 'São Paulo' },
];

export function popLabel(code: string | null): string {
  if (!code) return '—';
  return POPS.find((pop) => pop.code === code)?.name ?? code.toUpperCase();
}

/** Catalog plus any region observed in the data, sorted by code. */
export function popOptions(seen: (string | null)[] = []): Pop[] {
  const merged = new Map(POPS.map((pop) => [pop.code, pop]));
  for (const code of seen) {
    if (code && !merged.has(code)) merged.set(code, { code, name: code.toUpperCase() });
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

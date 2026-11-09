/**
 * PlanetScale Postgres URLs carry libpq-only params (`sslrootcert=system`)
 * that node-side drivers mishandle:
 *   - postgres.js forwards them as server options → server rejects them
 * This helper parses non-portable params out while preserving TLS intent
 * (Bun/Node verify certificate chains by default when ssl is on).
 */
export function sanitizePgUrl(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    if (url.searchParams.has("sslrootcert")) {
      url.searchParams.delete("sslrootcert");
      return url.toString();
    }
    return connectionString;
  } catch {
    return connectionString;
  }
}

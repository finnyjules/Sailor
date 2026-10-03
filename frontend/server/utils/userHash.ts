/**
 * A stable, non-reversible per-user path segment: the first 12 hex chars of
 * sha256(userId). Deterministic (same user → same subfolder across restarts)
 * and carries no PII into the output directory name. 12 hex = 48 bits, ample
 * to keep tenants apart on a shared disk. The runner saves a person's files
 * under `u_<hash>/` (runner/results.ts userSubfolder); engineGate's
 * ownUserFolder names the same folder. (Moved here from meterGraphRun.ts,
 * step 4 C5, when the engine's /prompt gate went.)
 */
import { createHash } from 'node:crypto'

export function shortUserHash(userId: string): string {
  return createHash('sha256').update(userId).digest('hex').slice(0, 12)
}

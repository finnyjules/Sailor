/**
 * Pure request-guard decisions for hosted mode (accounts spec §5.1). The
 * middleware (server/middleware/auth.ts) supplies path/mode/userId and acts
 * on the decision; this module never reads env or the event so it stays
 * unit-testable without a Nitro harness.
 *
 * PROXY_PREFIXES is THE canonical list of engine paths — comfyui-proxy.ts
 * imports it from here so the guard and the proxy can never drift.
 */

// Prefixes to proxy (without trailing slashes — matching uses boundary-aware startsWith)
export const PROXY_PREFIXES = [
  '/comfyui',
  '/extensions',
  '/api',
  '/queue',
  '/prompt',
  '/interrupt',
  '/history',
  '/system_stats',
  '/view',
  '/upload',
  '/object_info',
  '/global_subgraphs',
  '/gate',
  '/sailor',
]

/** API paths reachable without a session: signed webhooks only. */
export const PUBLIC_API_PATHS = ['/api/webhooks/clerk', '/api/webhooks/stripe', '/api/webhooks/fal']

export type GuardDecision =
  | { kind: 'pass' }
  | { kind: 'attach'; userId: string }
  | { kind: 'reject' }

function matchesPrefix(path: string, prefix: string): boolean {
  return path === prefix
    || path.startsWith(prefix + '/')
    || path.startsWith(prefix + '?')
}

export function guardDecision(
  path: string,
  mode: 'local' | 'hosted',
  userId: string | null,
): GuardDecision {
  if (mode === 'local') return { kind: 'pass' }
  if (PUBLIC_API_PATHS.some(p => matchesPrefix(path, p))) return { kind: 'pass' }
  const guarded = PROXY_PREFIXES.some(p => matchesPrefix(path, p))
  if (!guarded) return { kind: 'pass' }
  if (userId) return { kind: 'attach', userId }
  return { kind: 'reject' }
}

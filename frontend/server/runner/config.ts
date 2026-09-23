/**
 * The runner's switch and the public address fal calls back.
 *
 * Read from process.env (not runtimeConfig) so request handlers, background
 * polls and unit tests all see the same value — the same reason deployMode()
 * reads process.env.
 *   NUXT_RUNNER_ENABLED=true                 server side on (routes, engine, plugin)
 *   NUXT_PUBLIC_RUNNER_ENABLED=true          browser routing on (runtimeConfig.public)
 *   NUXT_RUNNER_WEBHOOK_BASE_URL=https://…   public origin fal can reach; unset locally
 */
function truthy(v: string | undefined): boolean {
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export function runnerEnabled(): boolean {
  return truthy(process.env.NUXT_RUNNER_ENABLED)
}

export function webhookBaseUrl(): string | null {
  const v = process.env.NUXT_RUNNER_WEBHOOK_BASE_URL?.trim()
  if (!v) return null
  return v.replace(/\/+$/, '')
}

/** Provider calls one user may have in flight at once; the rest wait in order. */
export const RUNNER_PER_USER_LIMIT = 4

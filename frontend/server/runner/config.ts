/**
 * The runner's switch and the public address fal calls back.
 *
 * Read from process.env (not runtimeConfig) so request handlers, background
 * polls and unit tests all see the same value — the same reason deployMode()
 * reads process.env.
 *   NUXT_RUNNER_ENABLED=true                 server side on (routes, engine, plugin)
 *   NUXT_PUBLIC_RUNNER_ENABLED=true          browser routing on (runtimeConfig.public)
 *   NUXT_RUNNER_WEBHOOK_BASE_URL=https://…   public origin fal can reach; unset locally
 *   NUXT_RUNNER_FAMILIES=fal-edit,…          families the server takes (the authority)
 *   NUXT_RUNNER_BACKUP=off                   never switch a job to its backup service (live checks)
 *   NUXT_RUNNER_BACKUP_STALL_MS=120000       how long a job may wait to start before it is switched; 0 = never for a slow start
 */
import { NO_FAMILIES, parseFamilies, type RunnerFamily } from '#shared/runner/families'

function truthy(v: string | undefined): boolean {
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export function runnerEnabled(): boolean {
  return truthy(process.env.NUXT_RUNNER_ENABLED)
}

/** The families switched on, server side. None while the runner itself is off. */
export function runnerFamilies(): ReadonlySet<RunnerFamily> {
  if (!runnerEnabled()) return NO_FAMILIES
  return parseFamilies(process.env.NUXT_RUNNER_FAMILIES)
}

export function webhookBaseUrl(): string | null {
  const v = process.env.NUXT_RUNNER_WEBHOOK_BASE_URL?.trim()
  if (!v) return null
  return v.replace(/\/+$/, '')
}

/** Provider calls one user may have in flight at once; the rest wait in order. */
export const RUNNER_PER_USER_LIMIT = 4

/** How long a job may wait to start at its first service before it is moved to the backup. */
export const DEFAULT_BACKUP_STALL_MS = 120_000

export interface BackupSettings {
  /** False: a job is never moved to its backup service, for any reason. */
  enabled: boolean
  /** A job still waiting to start this long after it was sent is moved; 0 = never for a slow start. */
  stallMs: number
}

/**
 * The backup-service switch. On unless NUXT_RUNNER_BACKUP is off, so a broken
 * first service can't hide behind its backup during a live check.
 */
export function runnerBackup(): BackupSettings {
  const flag = process.env.NUXT_RUNNER_BACKUP?.trim().toLowerCase()
  const enabled = !(flag === 'off' || flag === '0' || flag === 'false' || flag === 'no')
  const raw = process.env.NUXT_RUNNER_BACKUP_STALL_MS?.trim()
  const n = raw ? Number(raw) : Number.NaN
  const stallMs = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_BACKUP_STALL_MS
  return { enabled, stallMs }
}

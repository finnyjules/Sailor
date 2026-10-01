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
 *   NUXT_RUNNER_BACKUP=on                    let a stalled or refused job move to its backup service (off by default)
 *   NUXT_RUNNER_BACKUP_STALL_MS=120000       how long a job may wait to start before it is switched; 0 = never for a slow start
 */
import { LOCAL_MODEL_TOOL_FAMILIES, MEDIA_EFFECT_TOOL_FAMILIES, MEDIA_TOOL_FAMILIES, NO_FAMILIES, parseFamilies, type RunnerFamily } from '#shared/runner/families'
import { mediaToolsReady } from '../media/tools'

function truthy(v: string | undefined): boolean {
  if (typeof v !== 'string') return false
  const s = v.trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

export function runnerEnabled(): boolean {
  return truthy(process.env.NUXT_RUNNER_ENABLED)
}

/** Every family that needs the video tools: R5's (MEDIA_TOOL_FAMILIES), R6's (MEDIA_EFFECT_TOOL_FAMILIES) and R7's (LOCAL_MODEL_TOOL_FAMILIES). */
const TOOL_FAMILIES: readonly RunnerFamily[] = [...MEDIA_TOOL_FAMILIES, ...MEDIA_EFFECT_TOOL_FAMILIES, ...LOCAL_MODEL_TOOL_FAMILIES]

/**
 * The families switched on, server side. None while the runner itself is off.
 * The media families (MEDIA_TOOL_FAMILIES, R5.3; R6's MEDIA_EFFECT_TOOL_FAMILIES)
 * answer as off while the video tools are missing or refused (R5 rule 1): their
 * classes go to the engine.
 */
export function runnerFamilies(): ReadonlySet<RunnerFamily> {
  if (!runnerEnabled()) return NO_FAMILIES
  const on = parseFamilies(process.env.NUXT_RUNNER_FAMILIES)
  if (mediaToolsReady() || !TOOL_FAMILIES.some(f => on.has(f))) return on
  return new Set([...on].filter(f => !TOOL_FAMILIES.includes(f)))
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
 * The backup-service switch. Off unless NUXT_RUNNER_BACKUP is on (1, true,
 * yes or on): no backup request has had a live check yet, and a backup fal
 * or Replicate only refuses at the result would turn a slow job into an
 * error after the stall (final review finding 11; final fix F11). An
 * explicit value turns it on once a backup's live call has passed.
 */
export function runnerBackup(): BackupSettings {
  const enabled = truthy(process.env.NUXT_RUNNER_BACKUP)
  const raw = process.env.NUXT_RUNNER_BACKUP_STALL_MS?.trim()
  const n = raw ? Number(raw) : Number.NaN
  const stallMs = Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_BACKUP_STALL_MS
  return { enabled, stallMs }
}

/**
 * Releases holds stuck open past a TTL — a crashed process between hold and
 * settle/release would otherwise lock those credits forever, quietly
 * shrinking a user's spendable balance with no charge to show for it.
 *
 * Runs on the ledger's shared session: the SELECT is a plain read, which
 * ledger.ts documents as safe OUTSIDE the transaction mutex (getBalance /
 * getAvailable do the same), and each release() is itself mutex-protected
 * inside the ledger. So this module never opens a transaction of its own.
 *
 * All I/O is injected through HoldSweepDeps (the settleWatcher.ts style) so
 * the policy — cutoff arithmetic, per-hold error isolation, the count — is
 * unit-testable without a database.
 */
import { getLiveLedger } from './ledgerLive'
import { getSharedLedgerDb } from './ledgerDb'
import type { LedgerDb } from './ledger'
import { isHosted } from './deployMode'

/** Longest legitimate provider job is minutes — 2h is a wide safety margin. */
export const HOLD_TTL_MS = 2 * 60 * 60 * 1000
/**
 * The Sailor runner's holds (idempotency key `runner:…`) can sit queued at
 * fal for a long time before the job even starts, so they get a day.
 */
export const RUNNER_HOLD_TTL_MS = 24 * 60 * 60 * 1000
/** Sweep cadence — well inside the TTL so a stale hold is short-lived. */
export const HOLD_SWEEP_INTERVAL_MS = 15 * 60_000
/** Boot must not pay for a sweep: the first one runs a minute in. */
export const HOLD_SWEEP_FIRST_RUN_MS = 60_000

export interface HoldSweepDeps {
  /** Open holds created before `cutoff`; runner holds only before `runnerCutoff`. */
  listStaleHoldIds(cutoff: Date, runnerCutoff: Date): Promise<number[]>
  release(holdId: number): Promise<void>
}

/**
 * Release every hold still open past the cutoff. One hold's failure never
 * stops the others (a hold row deleted underneath us, a transient session
 * drop) — it is logged and the sweep continues; the return value counts
 * only the holds actually released, so a partly-failed sweep can't report
 * itself as clean. A LISTING failure, by contrast, propagates: silently
 * returning 0 there would look identical to "nothing was stale".
 */
export async function sweepStaleHoldsWith(deps: HoldSweepDeps, now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - HOLD_TTL_MS)
  const runnerCutoff = new Date(now.getTime() - RUNNER_HOLD_TTL_MS)
  const ids = await deps.listStaleHoldIds(cutoff, runnerCutoff)

  let released = 0
  for (const id of ids) {
    try {
      await deps.release(id)
      released++
    } catch (e) {
      console.error('[holdSweep] release failed', { holdId: id, error: e })
    }
  }
  if (released > 0) console.warn(`[holdSweep] released ${released} stale hold(s)`)
  return released
}

/** The open holds past their TTL: `runner:` holds past `runnerCutoff`, all others past `cutoff`. */
export async function listStaleHoldIds(db: LedgerDb, cutoff: Date, runnerCutoff: Date): Promise<number[]> {
  const { rows } = await db.query(
    `SELECT id FROM holds WHERE state = 'open' AND created_at < $1
       AND (left(idempotency_key, 7) <> 'runner:' OR created_at < $2)
     ORDER BY id`, [cutoff, runnerCutoff])
  return rows.map(r => Number(r.id))
}

/** Production wiring: the shared ledger session + the live ledger's release. */
export async function sweepStaleHolds(now = new Date()): Promise<number> {
  const db = getSharedLedgerDb()
  const ledger = getLiveLedger()
  return sweepStaleHoldsWith({
    listStaleHoldIds: (cutoff, runnerCutoff) => listStaleHoldIds(db, cutoff, runnerCutoff),
    release: holdId => ledger.release(holdId),
  }, now)
}

export interface HoldSweeperDeps {
  isHosted(): boolean
  sweep(): Promise<number>
  setTimeout(fn: () => void, ms: number): unknown
  setInterval(fn: () => void, ms: number): unknown
}

/**
 * Schedules the sweep. Returns whether anything was scheduled (false in
 * local mode — no Clerk keys means no wallets, no holds, and no
 * DATABASE_URL to open). Nothing is awaited or swept synchronously: a Nitro
 * plugin must never hold boot hostage on a database round-trip, so the
 * first sweep is a delayed callback and every tick swallows its own errors
 * (an unhandled rejection from a timer takes the process down).
 */
export function startHoldSweeperWith(deps: HoldSweeperDeps): boolean {
  if (!deps.isHosted()) return false

  const tick = async (): Promise<void> => {
    try {
      await deps.sweep()
    } catch (e) {
      console.error('[holdSweep] sweep failed', { error: e })
    }
  }

  deps.setTimeout(tick, HOLD_SWEEP_FIRST_RUN_MS)
  deps.setInterval(tick, HOLD_SWEEP_INTERVAL_MS)
  return true
}

/** Production wiring for the Nitro plugin. */
export function startHoldSweeper(): boolean {
  return startHoldSweeperWith({
    isHosted,
    sweep: () => sweepStaleHolds(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    setInterval: (fn, ms) => setInterval(fn, ms),
  })
}

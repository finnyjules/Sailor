/**
 * Frame Animate's Stop while the model runs (LC10 fix round 1, Important 2).
 *
 * The user's policy (2026-09-25, the runner's own): on Stop the hold is
 * released even before the provider confirms the cancel, and Sailor absorbs
 * a job that runs anyway. A cancel is believed only once the provider
 * confirms it (server/runner/cancelCheck.ts `cancelAndConfirm`). Until then
 * it is watched with the runner's waits (CANCEL_WATCH_WAITS_MS, given up after
 * CANCEL_WATCH_GIVE_UP_MS); a job that finished anyway is reported under the
 * runner's own site, `runner.cancel.ran-anyway`.
 *
 * Abuse bound: a Stop whose cancel isn't confirmed at once counts against the
 * person (and stays counted if the job ran anyway); past ANIMATE_STOP_LIMIT
 * in ANIMATE_STOP_WINDOW_MS, Animate is refused for a while (hosted only:
 * locally the fal key is the person's own). A cancel confirmed later as ended
 * stops counting. The counts live in memory: a restart forgets them.
 */
import { cancelAndConfirm, type CancelCheck } from '../runner/cancelCheck'
import { realFalClient, type ProviderClient } from '../runner/falQueue'
import { captureError } from '../utils/observe'

/** The runner's own watch waits and give-up (server/runner/engine.ts; equal by test, not imported to keep the engine out of this route). */
export const CANCEL_WATCH_WAITS_MS = [30_000, 60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000]
export const CANCEL_WATCH_GIVE_UP_MS = 48 * 60 * 60_000

export const ANIMATE_STOP_LIMIT = 3
export const ANIMATE_STOP_WINDOW_MS = 10 * 60_000
export const ANIMATE_STOPS_REFUSED = 'You stopped several clips while the model was already making them. Wait a few minutes before animating again. Nothing was charged.'

export interface StoppedJob { userId: string | null; endpoint: string; requestId: string; cancelUrl: string; statusUrl: string }

export interface CancelDeps {
  client: ProviderClient
  sleep(ms: number): Promise<void>
  now(): number
  report(e: Error, ctx: Record<string, unknown>): void
}

const realDeps: CancelDeps = {
  client: realFalClient,
  sleep: ms => new Promise<void>((r) => { const t = setTimeout(r, ms); t.unref?.() }),
  now: () => Date.now(),
  report: (e, ctx) => { console.error('[frame-animate]', ctx, e); captureError(e, ctx) },
}
let deps: CancelDeps = realDeps
export function __setAnimateCancelDepsForTests(d: Partial<CancelDeps> | null): void {
  deps = d ? { ...realDeps, ...d } : realDeps
  counted.clear()
  watches.clear()
}

/** Per person: requestId → when its Stop was counted. */
const counted = new Map<string, Map<string, number>>()
const watches = new Map<string, Promise<void>>()

const key = (userId: string | null) => userId ?? 'local'

function count(job: StoppedJob): void {
  const m = counted.get(key(job.userId)) ?? new Map<string, number>()
  m.set(job.requestId, deps.now())
  counted.set(key(job.userId), m)
}
function uncount(job: StoppedJob): void {
  counted.get(key(job.userId))?.delete(job.requestId)
}

/** The refusal for a person past the limit, else null. */
export function animateStopsRefusal(userId: string | null): string | null {
  const m = counted.get(key(userId))
  if (!m) return null
  const since = deps.now() - ANIMATE_STOP_WINDOW_MS
  let n = 0
  for (const [id, at] of m) { if (at >= since) n++; else m.delete(id) }
  return n >= ANIMATE_STOP_LIMIT ? ANIMATE_STOPS_REFUSED : null
}

const meta = (job: StoppedJob) => ({ provider: 'fal', requestId: job.requestId, endpoint: job.endpoint, userId: job.userId, source: 'frame-animate' })

function ranAnyway(job: StoppedJob): void {
  deps.report(new Error(`fal job ${job.requestId} finished after Sailor cancelled it; the provider billed it`), { site: 'runner.cancel.ran-anyway', ...meta(job) })
}

async function check(job: StoppedJob): Promise<CancelCheck> {
  try { return await cancelAndConfirm(deps.client, job, { tries: 1, waitMs: () => 0, sleep: deps.sleep }) }
  catch (e) { return { confirmed: false, lastStatus: null, lastError: e instanceof Error ? e.message : String(e) } }
}

/**
 * Cancel a stopped Animate job and watch until fal confirms it is over. The
 * returned promise ends when the watch does (tests await it; the route does not).
 */
export function watchAnimateCancel(job: StoppedJob): Promise<void> {
  const existing = watches.get(job.requestId)
  if (existing) return existing
  const since = deps.now()
  const p = (async () => {
    let c = await check(job)
    if (c.confirmed) {
      if (c.ended === 'finished') { count(job); ranAnyway(job) }
      return
    }
    count(job)
    for (let round = 0; ; round++) {
      await deps.sleep(CANCEL_WATCH_WAITS_MS[Math.min(round, CANCEL_WATCH_WAITS_MS.length - 1)]!)
      c = await check(job)
      if (c.confirmed) {
        if (c.ended === 'finished') ranAnyway(job)
        else uncount(job)
        return
      }
      if (deps.now() - since >= CANCEL_WATCH_GIVE_UP_MS) {
        deps.report(new Error(`Gave up checking the cancel of fal job ${job.requestId}: it may still run and bill Sailor`), {
          site: 'runner.cancel.gave-up', ...meta(job), lastStatus: c.lastStatus, lastError: c.lastError,
        })
        return
      }
    }
  })()
    .catch(e => deps.report(e instanceof Error ? e : new Error(String(e)), { site: 'runner.cancel.watch', ...meta(job) }))
    .finally(() => watches.delete(job.requestId))
  watches.set(job.requestId, p)
  return p
}

/**
 * Cancel a provider job and make sure it really stopped.
 *
 * A cancel request is not a cancel. On 24 Sep 2026 (Replicate "Degraded")
 * the runner asked Replicate to cancel a Nano Banana 2 prediction that was
 * still "starting", told the user it was cancelled and released the hold —
 * and the prediction was still "starting" 20 hours later. The old code
 * swallowed any cancel failure, and counted any 2xx answer whose body was not
 * succeeded/failed (so "starting" too) as cancelled.
 *
 * Here a job only counts as stopped when the provider itself says so: its
 * status reads finished (Replicate canceled / succeeded / failed, fal
 * COMPLETED), the cancel's own answer says canceled, or the provider no
 * longer knows the job (404). Anything else is tried again.
 */
import { FalError, type CancelOutcome, type FalStatus, type ProviderClient } from './falQueue'
import { ReplicateError } from './replicateQueue'

export type CancelCheck =
  /**
   * The provider confirmed the job is over.
   *   'ended'    — cancelled (or failed): nothing was made.
   *   'finished' — it finished with a result before the cancel landed (it is billed).
   *   'gone'     — the provider no longer knows the job.
   */
  | { confirmed: true; ended: 'ended' | 'finished' | 'gone'; status: FalStatus | null }
  | { confirmed: false; lastStatus: string | null; lastError: string | null }

export interface CancelCheckOptions {
  /** Cancel-and-look rounds before giving up (at least 1). */
  tries: number
  /** Wait before round `i + 1` (i from 0). */
  waitMs(i: number): number
  sleep(ms: number): Promise<void>
}

const notFound = (e: unknown) => (e instanceof FalError || e instanceof ReplicateError) && e.status === 404
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

export async function cancelAndConfirm(
  client: ProviderClient,
  req: { cancelUrl: string; statusUrl: string },
  o: CancelCheckOptions,
): Promise<CancelCheck> {
  let lastStatus: string | null = null
  let lastError: string | null = null
  const tries = Math.max(1, o.tries)
  for (let i = 0; i < tries; i++) {
    if (i > 0) await o.sleep(o.waitMs(i - 1))
    let outcome: CancelOutcome | null = null
    try { outcome = await client.cancel(req.cancelUrl) }
    catch (e) { lastError = `cancel: ${message(e)}` }
    if (outcome === 'not-found') return { confirmed: true, ended: 'gone', status: null }
    // Always look again: an accepted cancel is only a request.
    let s: FalStatus | null = null
    try { s = await client.status(req.statusUrl, { logs: false }) }
    catch (e) {
      if (notFound(e)) return { confirmed: true, ended: 'gone', status: null }
      lastError = `status: ${message(e)}`
    }
    if (s && !s.transient) {
      lastStatus = s.status
      if (s.status === 'COMPLETED') return { confirmed: true, ended: s.error ? 'ended' : 'finished', status: s }
    }
    // No real answer to the look, but the cancel's own answer was the
    // provider saying the job is canceled (Replicate returns the prediction).
    else if (outcome === 'cancelled') return { confirmed: true, ended: 'ended', status: null }
  }
  return { confirmed: false, lastStatus, lastError }
}

/**
 * The price of a node that makes several provider calls (a runner `pipeline`,
 * step 3 R3.1 fix round 1), from ONE per-call calculation: each call's
 * dollars are marked up on their own (`callCredits`), and a node's figure is
 * the sum of its calls' credits — never the markup of a summed dollar figure
 * (creditsForUsd marks up 2× below $0.10 and 1.5× above, so the two differ).
 *   - the hold: `callsCredits` of every call the node's settings can make
 *     (`pipelineCallsOf`, read by priceNode, so the badge, the ComfyUI path
 *     and the runner's hold agree);
 *   - the charge: `callsCredits` of the calls that finished and whose results
 *     were delivered (server/runner/engine.ts chargeableCredits), never above
 *     the hold.
 * The table is filled by the tasks that port a pipeline class (R3.2 onwards);
 * it is empty until then.
 */
import { creditsForUsd } from './markup'
import type { NodeInputs } from './nodePrice'

/** One call's price basis: what the service charges for it, in dollars. */
export interface PricedCall { usd: number }

/** One call's credits: its own dollars, marked up. */
export function callCredits(c: PricedCall): number {
  return creditsForUsd(c.usd)
}

/** A set of calls' credits: each call's, summed. */
export function callsCredits(calls: readonly PricedCall[]): number {
  return calls.reduce((sum, c) => sum + callCredits(c), 0)
}

/** Pipeline classes: the calls a node's settings can make, at their dearest (its hold). Filled by each task. */
export const PIPELINE_CALLS: Readonly<Record<string, (inputs: NodeInputs) => PricedCall[] | null>> = {}

/** The calls a pipeline node's settings can make, or null for a class (or settings) that isn't priced this way. */
export function pipelineCallsOf(classType: string, inputs: NodeInputs): PricedCall[] | null {
  const planned = Object.prototype.hasOwnProperty.call(PIPELINE_CALLS, classType) ? PIPELINE_CALLS[classType]!(inputs) : null
  return planned ?? null
}

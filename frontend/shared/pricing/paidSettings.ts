/**
 * The calls a paid node's settings can make (step 3, R3), for its price: the
 * hold, the badge and the charge all read `paidCalls` through priceNode
 * (nodePrice.ts), on both paths. Each R3 task adds its classes' planners
 * here; the tables are empty until then, so every class keeps its flat row
 * in GRAPH_NODE_CREDITS (server/utils/priceBook.ts) until its own task
 * removes that row.
 *
 * A planner gives the calls at their most expensive where an input is linked
 * (known only at run time), the most a text model can be sent and can answer
 * (ruling (c): one token per byte of text sent, at most the moderation limit,
 * plus the node's longest answer), and every call a pipeline may make. Given
 * `opts.answerUsage` (what the answer reported) it gives the calls as used,
 * for the charge; priceNode never lets that exceed the hold.
 *
 * `paidNoCall` says, from the inputs as sent, when Python returns before
 * calling anyone (rule 8): the stage hold skips such a node
 * (server/runner/metering.ts stageEstimate), as it skips a nano action that
 * hands its picture on.
 *
 * Pure; relative imports only (Nitro, the app and vitest all load it).
 */
import type { NodeInputs, PriceOptions } from './nodePrice'
import type { PaidCall } from './paidRates'

/** The calls a node makes: each call `times` times in one run, or the reason it can't be priced. */
export type PaidCalls = { steps: { call: PaidCall, times: number }[] } | { refused: string }

type PaidPlanner = (inputs: NodeInputs, opts: PriceOptions) => PaidCalls

/** Each paid class's planner. Filled by each R3 task. */
const PAID_PLANNERS: Readonly<Record<string, PaidPlanner>> = {}

/** Each paid class's no-call rule (rule 8), where Python has one. Filled by each R3 task. */
const PAID_NO_CALL: Readonly<Record<string, (inputs: NodeInputs) => boolean>> = {}

/** The classes priced by their calls (paidCalls). */
export const PAID_NODE_CLASSES: readonly string[] = Object.keys(PAID_PLANNERS)

const own = <T>(o: Readonly<Record<string, T>>, k: string): T | undefined =>
  (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined)

/**
 * The calls the node's settings can make, at their most expensive where an
 * input is linked. `opts.answerUsage`: what the answer reported (token
 * nodes), for the charge.
 */
export function paidCalls(classType: string, inputs: NodeInputs, opts: PriceOptions): PaidCalls {
  const plan = own(PAID_PLANNERS, classType)
  return plan ? plan(inputs, opts) : { refused: `${classType} is not priced by its calls` }
}

/** True when Python returns before calling anyone, decided from the inputs as sent (rule 8). */
export function paidNoCall(classType: string, inputs: NodeInputs): boolean {
  const rule = own(PAID_NO_CALL, classType)
  return !!rule && rule(inputs)
}

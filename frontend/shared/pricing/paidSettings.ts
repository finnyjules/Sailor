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
 * (ruling (c), `tokenCeiling`: one token per UTF-8 byte of text sent, each
 * moderated text at most the moderation limit in hosted, plus Sailor's own
 * fixed prompt text, plus the node's longest answer), and every call a pipeline may make. Given
 * `opts.answerUsage` (what the answer reported) it gives the calls as used,
 * for the charge; priceNode never lets that exceed the hold.
 *
 * Rule (c) is implemented once, in `tokenCeiling`: every text model's
 * planner builds its ceiling from it.
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

/**
 * The most bytes of one moderated text in hosted (server/utils/moderation.ts
 * MODERATION_MAX_INPUT_BYTES: a longer text is refused before the hold). A
 * test keeps the two equal; shared code can't import the server's.
 */
export const TOKEN_TEXT_CAP_BYTES = 32_768

const UTF8 = new TextEncoder()

/** A text's size in UTF-8 bytes (what the moderation limit and a token ceiling count). */
export function utf8Bytes(text: string): number {
  return UTF8.encode(text).length
}

/** What a text node sends, for its token ceiling. */
export interface TokenTexts {
  /** The user's texts as typed, each moderated on its own. */
  texts: readonly string[]
  /** How many of the user's texts are linked (known only at run time): each counted at the cap. */
  linkedTexts?: number
  /** Sailor's own fixed text sent with them (system prompts, templates): counted whole, never capped. */
  fixed?: readonly string[]
  /** The node's longest answer, in tokens (its max-tokens setting). */
  maxAnswerTokens: number
}

/**
 * Ruling (c)'s ceiling for a text model's call, in tokens, counted
 * generously as one token per UTF-8 byte:
 *  - input: the user's texts (hosted: each at most TOKEN_TEXT_CAP_BYTES, as
 *    moderation refuses a longer one; local: whole), a linked text at the cap
 *    (local runs are free, so this bound only shows on the badge), or the
 *    caller's measured `opts.inputBytes` in their place (hosted: at most the
 *    cap per text); plus Sailor's fixed text, never capped;
 *  - output: the node's longest answer.
 */
export function tokenCeiling(t: TokenTexts, opts: Pick<PriceOptions, 'inputBytes' | 'hosted'> = {}): { inputTokens: number, outputTokens: number } {
  const linked = Math.max(0, t.linkedTexts ?? 0)
  const cap = (bytes: number) => (opts.hosted ? Math.min(bytes, TOKEN_TEXT_CAP_BYTES) : bytes)
  const measured = opts.inputBytes
  const user = typeof measured === 'number' && Number.isFinite(measured) && measured >= 0
    ? (opts.hosted ? Math.min(measured, TOKEN_TEXT_CAP_BYTES * Math.max(1, t.texts.length + linked)) : measured)
    : t.texts.reduce((sum, text) => sum + cap(utf8Bytes(text)), 0) + linked * TOKEN_TEXT_CAP_BYTES
  const fixed = (t.fixed ?? []).reduce((sum, text) => sum + utf8Bytes(text), 0)
  return { inputTokens: user + fixed, outputTokens: t.maxAnswerTokens }
}

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

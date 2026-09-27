/**
 * The calls a paid node's settings can make (step 3, R3), for its price: the
 * hold, the badge and the charge all read `paidCalls` through priceNode
 * (nodePrice.ts), on both paths. Each R3 task adds its classes' planners
 * here (R3.3: the seven LLM text nodes); every other class keeps its flat
 * row in GRAPH_NODE_CREDITS (server/utils/priceBook.ts) until its own task
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
import { isLink } from '../runner/graph'
import {
  BRAINSTORM_MAX_TOKENS, LLM_MODEL_SLUGS, LLM_NO_CALL_INPUT, LLM_TEXT_INPUTS, REASON_MAX_TOKENS, REWRITE_MAX_TOKENS,
  SUMMARIZE_LENGTHS, SUMMARIZE_MAX_TOKENS, TRANSLATE_MAX_TOKENS, brainstormCount, brainstormSystem, improvePromptSystem, isBlank,
  reasonSystem, rewriteSystem, summarizeSystem, translateSystem, type LlmTextClass,
} from '../runner/llm'
import { pyStrip, pyTruthy } from '../runner/pyText'

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

// ── R3.3: the LLM text nodes (#shared/runner/llm) ──

/** What one LLM text node's call is priced from: its endpoint, Sailor's own text, its longest answer. */
interface LlmCallShape { endpoint: string; fixed: string[]; maxAnswerTokens: number }

const text = (v: unknown): string => (typeof v === 'string' ? v : '')
const intIn = (v: unknown, def: number, lo: number, hi: number): number => {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v) ? Number.parseInt(v, 10) : def
  return Math.min(hi, Math.max(lo, n))
}
const slugOf = (model: unknown): string | null => {
  const row = typeof model === 'string' && Object.prototype.hasOwnProperty.call(LLM_MODEL_SLUGS, model) ? LLM_MODEL_SLUGS[model] : undefined
  return row ? row[0] : null
}
/** A combo value the node knows, else the dearest of its options (a price never guesses low). */
const optionOr = (v: unknown, options: Readonly<Record<string, string>>, dearest: string): string =>
  (typeof v === 'string' && Object.prototype.hasOwnProperty.call(options, v) ? v : dearest)

/**
 * Each class's call as its settings make it (the same request the runner
 * builds, #shared/runner/llm): the endpoint by `model`, Sailor's system text
 * (counted whole), the answer limit sent. An unknown model can't be priced.
 */
const LLM_CALL_SHAPES: Readonly<Record<LlmTextClass, (i: NodeInputs) => LlmCallShape | null>> = {
  ChatLLMNode: (i) => {
    const endpoint = slugOf(i.model)
    // Chat's system prompt is the user's text (LLM_TEXT_INPUTS), not Sailor's.
    return endpoint ? { endpoint, fixed: [], maxAnswerTokens: intIn(i.max_tokens, 8192, 1, 8192) } : null
  },
  ImprovePromptNode: (i) => ({ endpoint: 'openai/gpt-5-nano', fixed: [improvePromptSystem(text(i.target) === 'video' ? 'video' : 'image')], maxAnswerTokens: 200 }),
  SummarizeTextNode: (i) => {
    const endpoint = slugOf(i.model)
    const length = optionOr(i.length, SUMMARIZE_LENGTHS, 'Bullets')
    return endpoint ? { endpoint, fixed: [summarizeSystem(length)], maxAnswerTokens: SUMMARIZE_MAX_TOKENS } : null
  },
  // The target language: a typed custom one is the user's text (counted there); else the picked one.
  TranslateTextNode: (i) => {
    const custom = isLink(i.custom_language) ? '' : pyStrip(text(i.custom_language))
    return { endpoint: 'google/gemini-3-flash', fixed: [translateSystem(custom ? '' : text(i.target_language) || 'Chinese (Traditional)')], maxAnswerTokens: TRANSLATE_MAX_TOKENS }
  },
  RewriteToneNode: (i) => {
    const endpoint = slugOf(i.model)
    return endpoint ? { endpoint, fixed: [rewriteSystem(text(i.tone) || 'Professional')], maxAnswerTokens: REWRITE_MAX_TOKENS } : null
  },
  BrainstormIdeasNode: (i) => ({
    endpoint: 'openai/gpt-5-mini',
    fixed: [brainstormSystem(intIn(brainstormCount(i), 12, 2, 12), text(i.angle) || 'Styles')],
    maxAnswerTokens: BRAINSTORM_MAX_TOKENS,
  }),
  ReasonStepByStepNode: (i) => {
    const endpoint = slugOf(i.model)
    // A wired switch (the ComfyUI path only): the longer of the two system texts.
    const fixed = isLink(i.include_reasoning)
      ? [reasonSystem(true), reasonSystem(false)].sort((a, b) => b.length - a.length)[0]!
      : reasonSystem(pyTruthy(i.include_reasoning))
    return endpoint ? { endpoint, fixed: [fixed], maxAnswerTokens: REASON_MAX_TOKENS } : null
  },
}

/**
 * An LLM text node's one call: its ceiling (ruling (c), tokenCeiling: the
 * user's texts as typed, a wired one at the cap, Sailor's system text whole,
 * the answer limit sent), or, with `answerUsage`, the tokens the answer
 * reported, on the same endpoint's card.
 */
function llmPlanner(classType: LlmTextClass): PaidPlanner {
  return (inputs, opts) => {
    const shape = LLM_CALL_SHAPES[classType](inputs)
    if (!shape) return { refused: `${classType} has no known model` }
    if (opts.answerUsage) {
      const { inputTokens, outputTokens } = opts.answerUsage
      return { steps: [{ call: { endpoint: shape.endpoint, inputTokens, outputTokens }, times: 1 }] }
    }
    const names = LLM_TEXT_INPUTS[classType]
    const linkedTexts = names.filter(n => isLink(inputs[n])).length
    const texts = names.filter(n => !isLink(inputs[n])).map(n => text(inputs[n]))
    const t = tokenCeiling({ texts, linkedTexts, fixed: shape.fixed, maxAnswerTokens: shape.maxAnswerTokens }, opts)
    return { steps: [{ call: { endpoint: shape.endpoint, ...t }, times: 1 }] }
  }
}

/** Python returns "" before calling anyone when the text is blank (typed; a wired one is priced as a call). */
function llmNoCall(classType: LlmTextClass): ((inputs: NodeInputs) => boolean) | null {
  const name = LLM_NO_CALL_INPUT[classType]
  return name ? (inputs: NodeInputs) => !isLink(inputs[name]) && isBlank(inputs[name]) : null
}

const LLM_CLASSES = Object.keys(LLM_CALL_SHAPES) as LlmTextClass[]

/** Each paid class's planner. Filled by each R3 task. */
const PAID_PLANNERS: Readonly<Record<string, PaidPlanner>> = {
  ...Object.fromEntries(LLM_CLASSES.map(c => [c, llmPlanner(c)])),
}

/** Each paid class's no-call rule (rule 8), where Python has one. Filled by each R3 task. */
const PAID_NO_CALL: Readonly<Record<string, (inputs: NodeInputs) => boolean>> = {
  ...Object.fromEntries(LLM_CLASSES.flatMap(c => { const r = llmNoCall(c); return r ? [[c, r]] : [] })),
}

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

/**
 * The seven LLM text nodes as runner plans (step 3, R3.3, family
 * `llm-text`): Chat with an LLM, Improve a prompt, Summarize text, Translate
 * text, Rewrite in a tone, Brainstorm ideas, Think step by step. Each makes
 * one Replicate call (`_run_prediction` on the model's slug) and hands on the
 * answer's text, byte-identical to Python's STRING. The requests and the
 * text rules are ported once, in #shared/runner/llm (the price module reads
 * the same requests); this file turns them into plans.
 *
 *  - A blank text Python never sends (Summarize, Translate, Rewrite,
 *    Brainstorm, Think step by step) makes no call: the node hands on "" and
 *    shows it, free (rule 8).
 *  - A blank question (Chat) or idea (Improve a prompt) is refused in plain
 *    words: before the hold when typed (requestRules.ts), here when a wire
 *    brought it. A Claude answer limit under Replicate's published 1024 is
 *    sent as Python sends it (ruling 3: the live check decides).
 *  - The charge is the token counts the prediction reports
 *    (`metrics.input_token_count` / `output_token_count`, as Replicate bills
 *    them) through the endpoint's card, capped by the ceiling of the inputs
 *    the hold was priced from (`ctx.priceInputs`: wires left as wires, never
 *    the value a wire brought) and never above the hold; no counts, the hold
 *    (ruling (c)).
 *  - A request byte-identical to one this user already made gives back that
 *    answer, free (ruling (d)): the plan is reusable by its request alone.
 */
import { parsePyJson, type PyJson } from '#shared/runner/pyJson'
import {
  LLM_BUILDERS, LLM_TEXT_CLASSES, brainstormCount, brainstormLines, llmRequestProblem, llmText,
  type LlmTextClass,
} from '#shared/runner/llm'
import { priceNode } from '#shared/pricing/nodePrice'
import type { NodePlan, PlanContext } from '../executors'
import type { RunnerValue } from '../types'

export {
  LLM_MODEL_SLUGS, llmInput, llmText, brainstormLines,
  chatLlmInput, improvePromptInput, summarizeInput, translateInput, rewriteInput, brainstormInput, reasonInput,
} from '#shared/runner/llm'

const LLM_CLASS_SET: ReadonlySet<string> = new Set(LLM_TEXT_CLASSES)

export function isLlmTextClass(classType: string): classType is LlmTextClass {
  return LLM_CLASS_SET.has(classType)
}

/** Chat and Improve a prompt return no ui (Python's NodeOutput without one); the other five show their text. */
const SHOWS_TEXT: ReadonlySet<string> = new Set([
  'SummarizeTextNode', 'TranslateTextNode', 'RewriteToneNode', 'BrainstormIdeasNode', 'ReasonStepByStepNode',
])

/** A JSON value as Python's json.loads would have it, for an answer whose body text isn't kept. */
function toPyJson(v: unknown): PyJson {
  if (v === null || v === undefined) return null
  if (typeof v === 'boolean' || typeof v === 'string') return v
  if (typeof v === 'number') return Number.isInteger(v) ? { int: String(v) } : { float: v }
  if (Array.isArray(v)) return v.map(toPyJson)
  return { obj: Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toPyJson(x)] as [string, PyJson]) }
}

/** `pred.get("output")`: read from the body text where it is kept (numbers keep their written form). */
export function answerOutput(result: unknown, raw: string | null): PyJson {
  if (raw !== null) {
    const body = parsePyJson(raw)
    if (body && typeof body === 'object' && !Array.isArray(body) && 'obj' in body) {
      const hit = body.obj.find(([k]) => k === 'output')
      return hit ? hit[1] : null
    }
    return null
  }
  const out = result && typeof result === 'object' ? (result as Record<string, unknown>).output : undefined
  return toPyJson(out)
}

/** The token counts a prediction reports (Replicate's billing metrics), or null. */
export function answerUsage(result: unknown): { inputTokens: number; outputTokens: number } | null {
  const metrics = result && typeof result === 'object' ? (result as Record<string, unknown>).metrics : undefined
  if (!metrics || typeof metrics !== 'object') return null
  const m = metrics as Record<string, unknown>
  const i = m.input_token_count
  const o = m.output_token_count
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
  return ok(i) && ok(o) ? { inputTokens: i, outputTokens: o } : null
}

/** The node's plan: one Replicate call whose answer is the node's text, or "" with no call. */
export function planLlm(ctx: PlanContext): NodePlan {
  const node = ctx.prompt[ctx.nodeId]!
  const classType = node.class_type as LlmTextClass
  const inputs = node.inputs ?? {}
  const built = LLM_BUILDERS[classType](inputs)
  const shows = SHOWS_TEXT.has(classType)
  if ('noCall' in built) {
    const values: Record<number, RunnerValue> = { 0: { kind: 'text', text: '' } }
    return { kind: 'derive', derive: async () => ({ values, ui: shows ? { text: [''] } : null }) }
  }
  // A wired blank question or idea arrives here (typed ones were refused before the hold).
  const problem = llmRequestProblem(classType, inputs)
  if (problem) throw new Error(problem.message)
  const finish = classType === 'BrainstormIdeasNode'
    ? (text: string) => brainstormLines(text, brainstormCount(inputs))
    : (text: string) => text
  return {
    kind: 'provider', provider: 'replicate', endpoint: built.slug, payload: built.input,
    media: 'value', prefix: 'llm',
    reuse: 'same-request',
    valuesOf: (result, raw) => ({ 0: { kind: 'text', text: finish(llmText(answerOutput(result, raw))) } }),
    uiFor: (_files, values) => {
      if (!shows) return null
      const v = values?.[0]
      return { text: [v && v.kind === 'text' ? v.text : ''] }
    },
    chargeOf: (result) => {
      const used = answerUsage(result)
      if (!used) return null
      // Priced as the hold was (metering.ts nodeCredits: the node as sent, no host cap).
      const p = priceNode(classType, ctx.priceInputs ?? inputs, { answerUsage: used })
      return 'refused' in p ? null : p.credits
    },
  }
}

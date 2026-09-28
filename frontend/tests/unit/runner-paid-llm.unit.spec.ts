/**
 * R3.3: the seven LLM text nodes (family `llm-text`) — Chat with an LLM,
 * Improve a prompt, Summarize, Translate, Rewrite in a tone, Brainstorm
 * ideas, Think step by step — against what their real Python sends and
 * returns (fixtures/runner-paid-llm.json, scripts/runner_paid_fixtures.py
 * --group llm), priced by Replicate's per-token cards.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createFakeReplicate, makeKit } from './__runner__/kit'
import { normalizeSent, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed } from '#shared/runner/eligibility'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { OUTPUT_KINDS } from '#shared/runner/values'
import { RUNNER_OUTPUT_CLASSES } from '#shared/runner/validate'
import { pyIsDigit, pySplitlines } from '#shared/runner/pyText'
import { parsePyJson } from '#shared/runner/pyJson'
import {
  CHAT_LLM_MODELS, REASON_MODELS, REWRITE_MODELS, SUMMARIZE_MODELS, rewriteSystem,
  CHAT_NEEDS_QUESTION, IMPROVE_NEEDS_IDEA, LLM_BUILDERS, LLM_ENDPOINTS, LLM_TEXT_CLASSES,
  REWRITE_TONES, TONE_GUIDANCE, brainstormCount, brainstormLines, llmRequestProblem, llmText, type LlmTextClass,
} from '#shared/runner/llm'
import { PAID_RATES, otherCardFor, paidCallUsd } from '#shared/pricing/paidRates'
import { LLM_MODEL_UNPRICED, PAID_NODE_CLASSES, TOKEN_TEXT_CAP_BYTES, paidCalls, paidNoCall, utf8Bytes } from '#shared/pricing/paidSettings'
import { priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd } from '#shared/pricing/markup'
import { GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, extraPromptTexts, stageEstimate } from '~~/server/runner/metering'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import { answerOutput, answerUsage } from '~~/server/runner/generators/llm'
import { requestProblems } from '~~/server/runner/requestRules'

const FIXTURE = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'runner-paid-llm.json'), 'utf8')) as {
  cases: PaidCase[]
  isdigit_ranges: [number, number][]
}
const CASES = FIXTURE.cases
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const ON: ReadonlySet<RunnerFamily> = new Set<RunnerFamily>(['cards', 'llm-text'])
const cls = (c: PaidCase) => c.class_type as LlmTextClass

/** The answer a case gives, as the engine reads it: its body text and the object parsed from it. */
function answerOf(c: PaidCase): { result: unknown; raw: string } {
  const a = c.answers[0] as { __body__: string }
  return { result: JSON.parse(a.__body__.replace(/\bNaN\b/g, 'null')), raw: a.__body__ }
}

/**
 * Python's wire text, with its one known difference from the runner's:
 * Python sends `temperature` as a float, so a whole one is written `1.0`
 * where the runner's JSON writes `1` (Chat's widget; reported, R3.3 — both
 * are the JSON number 1 to Replicate's schema, type number).
 */
function pythonWire(payloadJson: string, sent: Record<string, unknown>): string {
  if (typeof sent.temperature === 'number' && Number.isInteger(sent.temperature)) {
    return payloadJson.replace(/"temperature": (-?\d+)\.0([,}])/, '"temperature": $1$2')
  }
  return payloadJson
}

/**
 * The refusals the runner makes where Python sends and pays (the brief's
 * deviations: a blank question or idea). A Claude answer limit under
 * Replicate's published 1024 is sent as Python sends it (ruling 3).
 */
function expectedRefusal(c: PaidCase): string | null {
  const w = c.widgets
  const blank = (v: unknown) => typeof v === 'string' && !v.replace(/[\s　]/g, '')
  if (c.class_type === 'ChatLLMNode' && blank(w.prompt)) return CHAT_NEEDS_QUESTION
  if (c.class_type === 'ImprovePromptNode' && blank(w.idea)) return IMPROVE_NEEDS_IDEA
  return null
}

async function planOf(classType: string, inputs: Record<string, unknown>, hosted = false): Promise<NodePlan> {
  return planNode({
    prompt: { n: { class_type: classType, inputs } }, nodeId: 'n', filesFrom: () => [], gateOpen: false, hosted,
    toUrl: async () => { throw new Error('no files here') },
  })
}

describe('the fixture', () => {
  it('covers every class × model × text kind and every setting the brief names', () => {
    const names = new Set(CASES.map(c => c.name))
    expect(CASES.length).toBeGreaterThanOrEqual(220)
    expect(new Set(CASES.map(c => c.class_type))).toEqual(new Set(LLM_TEXT_CLASSES))
    for (const kind of ['blank', 'spaces', 'one line', '2000 chars', 'non-ASCII', 'emoji']) {
      for (const m of ['GPT-5', 'Claude 4.5 Sonnet', 'Gemini 3 Flash']) expect(names.has(`chat · ${m} · ${kind}`), `chat ${m} ${kind}`).toBe(true)
      for (const m of ['Gemini 3 Flash', 'GPT-5 nano', 'Claude 4.5 Haiku']) expect(names.has(`summarize · ${m} · ${kind}`)).toBe(true)
      for (const m of ['DeepSeek R1', 'GPT-5', 'Claude 4.5 Sonnet']) expect(names.has(`reason · ${m} · ${kind}`)).toBe(true)
    }
    expect(CASES.filter(c => c.name.startsWith('translate · ') && !c.name.includes('fixed model')).length).toBe(19 + 2)
    expect(CASES.filter(c => c.name.startsWith('rewrite · ') && c.name.split(' · ').length === 2).length).toBe(11)
    expect(names.has('brainstorm · count 2') && names.has('brainstorm · count 12')).toBe(true)
    // Every endpoint is reached by some case that calls it.
    expect(new Set(CASES.flatMap(c => c.calls.map(x => x.endpoint)))).toEqual(new Set(LLM_ENDPOINTS))
  })
})

describe('Python helpers', () => {
  it('pyIsDigit is str.isdigit() on every code point (Python 3.12, Unicode 15.0)', () => {
    const ranges = FIXTURE.isdigit_ranges
    let r = 0
    let checked = 0
    for (let c = 0; c < 0x110000; c++) {
      if (c >= 0xD800 && c <= 0xDFFF) continue
      while (r < ranges.length && ranges[r]![1] < c) r++
      const want = r < ranges.length && ranges[r]![0] <= c
      if (pyIsDigit(String.fromCodePoint(c)) !== want) throw new Error(`U+${c.toString(16)}: ${!want}`)
      checked++
    }
    expect(checked).toBe(0x110000 - 0x800)
    expect(pyIsDigit('12')).toBe(false)
    expect(pyIsDigit('')).toBe(false)
  })

  it('pySplitlines is str.splitlines()', () => {
    expect(pySplitlines('')).toEqual([])
    expect(pySplitlines('\n')).toEqual([''])
    expect(pySplitlines('a\r\nb\rc\n')).toEqual(['a', 'b', 'c'])
    expect(pySplitlines('a\n\nb')).toEqual(['a', '', 'b'])
    expect(pySplitlines('a b\x85c\x0bd\x0ce\x1cf\x1dg\x1eh i')).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'])
    expect(pySplitlines('a\x1fb')).toEqual(['a\x1fb'])
  })
})

describe('every fixture case: what Python sends and returns', () => {
  const refused: string[] = []
  const wholeTemperature: string[] = []

  it.each(CASES.map(c => [c.name, c] as const))('%s — the request and the text', async (_n, c) => {
    const want = expectedRefusal(c)
    expect(llmRequestProblem(c.class_type, c.widgets)?.message ?? null).toBe(want)
    const built = LLM_BUILDERS[cls(c)](c.widgets)
    if (want) {
      // Python sends it (and pays for an empty or refused answer): the runner refuses first.
      expect(c.calls.length).toBe(1)
      refused.push(c.name)
      await expect(planOf(c.class_type, c.widgets)).rejects.toThrow(want)
      return
    }
    if (!c.calls.length) {
      expect('noCall' in built).toBe(true)
      expect(paidNoCall(c.class_type, c.widgets)).toBe(true)
      const plan = await planOf(c.class_type, c.widgets)
      expect(plan.kind).toBe('derive')
      const made = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive({} as never)
      expect(made.values).toEqual({ 0: { kind: 'text', text: c.output![0 as never] } })
      expect(made.ui).toEqual(c.ui)
      return
    }
    expect(paidNoCall(c.class_type, c.widgets)).toBe(false)
    expect('noCall' in built).toBe(false)
    const b = built as Exclude<typeof built, { noCall: true }>
    expect(c.calls.length).toBe(1)
    const py = c.calls[0]!
    expect({ provider: 'replicate', endpoint: b.slug, payload: b.input }).toEqual({ provider: py.provider, endpoint: py.endpoint, payload: py.payload })
    const pw = pythonWire(py.payload_json!, b.input)
    if (pw !== py.payload_json) wholeTemperature.push(c.name)
    expect(wireText(b.input)).toBe(pw)
    // The answer: the text Python returns, byte for byte, and its ui.
    const plan = await planOf(c.class_type, c.widgets) as Extract<NodePlan, { kind: 'provider' }>
    expect(plan.kind).toBe('provider')
    expect(plan.reuse).toBe('same-request')
    const { result, raw } = answerOf(c)
    const values = plan.valuesOf!(result, raw)
    expect(values).toEqual({ 0: { kind: 'text', text: (c.output as string[])[0] } })
    expect(plan.uiFor([], values)).toEqual(c.ui)
  })

  it('the deviations are exactly the brief\'s (blank Chat and Improve)', () => {
    // Chat blank and spaces on 3 models (6), Improve blank and spaces (2).
    expect(refused.length).toBe(8)
  })

  it('whole temperatures are the only wire difference, and only Chat sends one', () => {
    expect(wholeTemperature.length).toBeGreaterThan(0)
    expect(wholeTemperature.every(n => n.startsWith('chat · '))).toBe(true)
  })
})

describe('every fixture case through the engine (cards and llm-text on)', () => {
  const calling = CASES.filter(c => c.calls.length && !expectedRefusal(c))
  const silent = CASES.filter(c => !c.calls.length)

  it.each(calling.map(c => [c.name, c] as const))('%s — sent, handed on and charged', async (_n, c) => {
    const run = await runPaidCase(c, { families: ON })
    expect(run.status, run.error ?? '').toBe('done')
    const sent = normalizeSent(run.sent)
    expect(sent).toEqual([{ provider: 'replicate', endpoint: c.calls[0]!.endpoint, payload: c.calls[0]!.payload }])
    expect(wireText(sent[0]!.payload)).toBe(pythonWire(c.calls[0]!.payload_json!, sent[0]!.payload))
    expect(run.values).toEqual({ 0: { kind: 'text', text: (c.output as string[])[0] } })
    // Charged the tokens the prediction reports, through the card; the hold without them.
    const hold = priceNode(c.class_type, c.widgets)
    if ('refused' in hold) throw new Error(hold.refused)
    const used = answerUsage(answerOf(c).result)
    const charge = used ? priceNode(c.class_type, c.widgets, { answerUsage: used }) : hold
    if ('refused' in charge) throw new Error(charge.refused)
    expect(run.credits).toBe(Math.min(hold.credits, charge.credits))
    expect(run.credits).toBeLessThanOrEqual(hold.credits)
  })

  it.each(silent.slice(0, 10).map(c => [c.name, c] as const))('%s — blank: no call, "" handed on, nothing charged', async (_n, c) => {
    const run = await runPaidCase({ ...c, answers: [] }, { families: ON })
    expect(run.status).toBe('done')
    expect(run.sent).toEqual([])
    expect(run.values).toEqual({ 0: { kind: 'text', text: '' } })
    expect(run.credits).toBe(0)
  })

  it('the refused cases are refused before anything is held or sent (hosted)', async () => {
    const refusedCases = CASES.filter(expectedRefusal)
    expect(refusedCases.length).toBe(8)
    for (const c of refusedCases) {
      const k = makeKit({ hosted: true, deps: { families: () => ON } })
      const p: ApiPrompt = { n: { class_type: c.class_type, inputs: { ...c.widgets } } }
      await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START }), c.name).rejects.toThrow(expectedRefusal(c)!)
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
    }
  })
})

describe('the answer\'s text', () => {
  it('reads `output` from the body text (numbers keep their form), else from the object', () => {
    expect(llmText(answerOutput(null, '{"output": [1, 2.0, true, null]}'))).toBe('12.0TrueNone')
    expect(llmText(answerOutput({ output: [1, 2.5, true, null] }, null))).toBe('12.5TrueNone')
    expect(llmText(answerOutput({}, '{"status": "succeeded"}'))).toBe('')
    expect(llmText(parsePyJson('0'))).toBe('')
    expect(llmText(parsePyJson('0.0'))).toBe('')
    expect(llmText(parsePyJson('1e5'))).toBe('100000.0')
    expect(() => llmText(parsePyJson('[[1]]'))).toThrow()
  })

  it('Brainstorm\'s clean-up by code point (an astral digit counts)', () => {
    expect(brainstormLines('\u{1D7CE}. zero\n- a\n\n* b', 12)).toBe('zero\na\nb')
    expect(brainstormLines('a\nb\nc', 2)).toBe('a\nb')
    expect(brainstormLines('', 3)).toBe('')
    expect(brainstormCount({ count: '7' })).toBe(7)
  })

  it('token counts come from the prediction\'s metrics, or none', () => {
    expect(answerUsage({ metrics: { input_token_count: 11, output_token_count: 68 } })).toEqual({ inputTokens: 11, outputTokens: 68 })
    expect(answerUsage({ metrics: { predict_time: 3 } })).toBeNull()
    expect(answerUsage({ metrics: { input_token_count: -1, output_token_count: 3 } })).toBeNull()
    expect(answerUsage({ output: 'x' })).toBeNull()
  })
})

// Replicate's published inputs (each model page's schema, read 2026-09-27), until the saved
// schemas (fixtures/provider-schemas/replicate/) are snapshotted by the controller.
const PUBLISHED: Record<string, { keys: string[]; min?: Record<string, number>; max?: Record<string, number> }> = {
  'openai/gpt-5': { keys: ['prompt', 'messages', 'verbosity', 'image_input', 'system_prompt', 'reasoning_effort', 'max_completion_tokens'] },
  'openai/gpt-5-mini': { keys: ['prompt', 'messages', 'verbosity', 'image_input', 'system_prompt', 'reasoning_effort', 'max_completion_tokens'] },
  'openai/gpt-5-nano': { keys: ['prompt', 'messages', 'verbosity', 'image_input', 'system_prompt', 'reasoning_effort', 'max_completion_tokens'] },
  'anthropic/claude-4.5-sonnet': { keys: ['image', 'prompt', 'max_tokens', 'system_prompt', 'max_image_resolution'], min: { max_tokens: 1024 }, max: { max_tokens: 64000 } },
  'anthropic/claude-4.5-haiku': { keys: ['image', 'prompt', 'max_tokens', 'system_prompt', 'max_image_resolution'], min: { max_tokens: 1024 }, max: { max_tokens: 64000 } },
  'google/gemini-3-flash': {
    keys: ['audio', 'top_p', 'images', 'prompt', 'videos', 'video_fps', 'temperature', 'thinking_level', 'max_output_tokens', 'system_instruction'],
    min: { temperature: 0, max_output_tokens: 1 }, max: { temperature: 2, max_output_tokens: 65535 },
  },
  'deepseek-ai/deepseek-r1': { keys: ['top_p', 'prompt', 'max_tokens', 'temperature', 'presence_penalty', 'frequency_penalty'] },
}
/** What Python sends that the schema doesn't declare (reported for a ruling; Replicate drops unknown keys). */
const UNDECLARED: Record<string, string[]> = {
  'openai/gpt-5': ['temperature'], 'openai/gpt-5-mini': ['temperature'], 'openai/gpt-5-nano': ['temperature'],
  'anthropic/claude-4.5-sonnet': ['temperature'], 'anthropic/claude-4.5-haiku': ['temperature'],
  'google/gemini-3-flash': [],
  'deepseek-ai/deepseek-r1': ['max_completion_tokens', 'system_prompt'],
}

describe('the requests against Replicate\'s published inputs', () => {
  it('every sent payload keeps within them, but for the undeclared keys and the Claude limits pinned here', () => {
    const seen: Record<string, Set<string>> = {}
    const underMin: string[] = []
    for (const c of CASES) {
      if (expectedRefusal(c) || !c.calls.length) continue
      const b = LLM_BUILDERS[cls(c)](c.widgets) as { slug: string; input: Record<string, unknown> }
      const pub = PUBLISHED[b.slug]!
      for (const [k, v] of Object.entries(b.input)) {
        if (!pub.keys.includes(k)) (seen[b.slug] ??= new Set()).add(k)
        // Ruling 3: a Claude limit under the published 1024 is sent as Python sends it; the live check decides.
        if (pub.min?.[k] !== undefined && (v as number) < pub.min[k]!) underMin.push(`${b.slug} ${k}=${v as number}`)
        if (pub.max?.[k] !== undefined) expect(v as number, `${c.name} ${k}`).toBeLessThanOrEqual(pub.max[k]!)
      }
    }
    for (const slug of LLM_ENDPOINTS) expect([...(seen[slug] ?? [])].sort(), slug).toEqual([...UNDECLARED[slug]!].sort())
    // Only Claude's max_tokens: Summarize's 400 on Haiku, and Chat's small limits on Sonnet.
    expect([...new Set(underMin)].sort()).toEqual(['anthropic/claude-4.5-haiku max_tokens=400', 'anthropic/claude-4.5-sonnet max_tokens=1'])
  })

  it('Summarize on Claude 4.5 Haiku and Chat on Claude under 1024 are sent as Python sends them (ruling 3)', async () => {
    const haiku = CASES.find(c => c.name === 'summarize · Claude 4.5 Haiku · one line')!
    expect(llmRequestProblem(haiku.class_type, haiku.widgets)).toBeNull()
    const plan = await planOf(haiku.class_type, haiku.widgets) as Extract<NodePlan, { kind: 'provider' }>
    expect(plan.payload.max_tokens).toBe(400)
    expect(plan.payload).toEqual(haiku.calls[0]!.payload)
    const sonnet = CASES.find(c => c.name.startsWith('chat · Claude 4.5 Sonnet · system off · t1.0 · max 1'))!
    expect(requestProblems({ n: { class_type: sonnet.class_type, inputs: sonnet.widgets } }, { runner: true })).toEqual([])
  })

  it('the saved schemas, where snapshotted, agree with the published inputs above', () => {
    for (const slug of LLM_ENDPOINTS) {
      const file = join(__dirname, 'fixtures', 'provider-schemas', 'replicate', `${slug.replace('/', '__')}.json`)
      if (!existsSync(file)) continue
      const f = JSON.parse(readFileSync(file, 'utf8'))
      const props = Object.keys(f.components.schemas.Input.properties).sort()
      expect(props, slug).toEqual([...PUBLISHED[slug]!.keys].sort())
    }
  })
})

describe('prices: Replicate\'s per-token cards, the hold and the charge (rulings (a), (c))', () => {
  it('one verified per-token card per endpoint, read from its page, no other card for it', () => {
    for (const slug of LLM_ENDPOINTS) {
      const card = PAID_RATES[slug]!
      expect(card.unit, slug).toBe('per_token')
      expect(card.service).toBe('replicate')
      expect(card.source).toBe(`https://replicate.com/${slug}`)
      expect(card.read).toBe('2026-09-27')
      expect(card.confidence).toBe('verified')
      expect(otherCardFor(slug)).toBeNull()
    }
    const perMillion = Object.fromEntries(LLM_ENDPOINTS.map(s => [s, PAID_RATES[s]]).map(([s, c]) => [s, [(c as any).inputPerMillion, (c as any).outputPerMillion]]))
    expect(perMillion).toEqual({
      'openai/gpt-5': [1.25, 10], 'openai/gpt-5-mini': [0.25, 2], 'openai/gpt-5-nano': [0.05, 0.4],
      'anthropic/claude-4.5-sonnet': [3, 15], 'anthropic/claude-4.5-haiku': [1, 5],
      'google/gemini-3-flash': [0.5, 3], 'deepseek-ai/deepseek-r1': [3.75, 10],
    })
  })

  it('the classes are priced by their calls and have no flat row', () => {
    for (const c of LLM_TEXT_CLASSES) {
      expect(PAID_NODE_CLASSES).toContain(c)
      expect(Object.prototype.hasOwnProperty.call(GRAPH_NODE_CREDITS, c), c).toBe(false)
    }
    expect(PRICE_BOOK_VERSION).toBe('r3-lora')
  })

  it('the hold for Chat on GPT-5 at 8192 max tokens is the card\'s ceiling', () => {
    const prompt = 'Name a colour 🎨'
    const inputs = { model: 'GPT-5', prompt, system_prompt: 'Be brief.', temperature: 1, max_tokens: 8192 }
    const bytes = utf8Bytes(prompt) + utf8Bytes('Be brief.')
    const usd = bytes * 1.25 / 1e6 + 8192 * 10 / 1e6
    expect(priceNode('ChatLLMNode', inputs)).toEqual({ usd: Math.round(usd * 1e8) / 1e8, credits: creditsForUsd(usd) })
    expect(creditsForUsd(usd)).toBe(17)
    // A wired prompt counts at the moderation cap.
    const wired = priceNode('ChatLLMNode', { ...inputs, prompt: ['t', 0] })
    const wiredUsd = (TOKEN_TEXT_CAP_BYTES + utf8Bytes('Be brief.')) * 1.25 / 1e6 + 8192 * 10 / 1e6
    expect(wired).toEqual({ usd: Math.round(wiredUsd * 1e8) / 1e8, credits: creditsForUsd(wiredUsd) })
  })

  it('Sailor\'s own system text counts in the ceiling, whole', () => {
    const p = paidCalls('SummarizeTextNode', { text: 'abc', length: 'Short', model: 'Gemini 3 Flash' }, {})
    if ('refused' in p) throw new Error(p.refused)
    const call = p.steps[0]!.call
    expect(call.endpoint).toBe('google/gemini-3-flash')
    expect(call.outputTokens).toBe(400)
    expect(call.inputTokens).toBeGreaterThan(200)
    expect(paidCallUsd(call)).toBeCloseTo(call.inputTokens! * 0.5e-6 + 400 * 3e-6, 10)
  })

  it('the charge is the reported tokens through the card, never above the hold; none reported, the hold', () => {
    const inputs = { model: 'GPT-5', prompt: 'Hi', system_prompt: '', temperature: 1, max_tokens: 8192 }
    const hold = priceNode('ChatLLMNode', inputs) as { credits: number }
    const small = priceNode('ChatLLMNode', inputs, { answerUsage: { inputTokens: 10, outputTokens: 100 } }) as { credits: number }
    expect(small.credits).toBe(creditsForUsd(10 * 1.25e-6 + 100 * 1e-5))
    expect(small.credits).toBeLessThan(hold.credits)
    const huge = priceNode('ChatLLMNode', inputs, { answerUsage: { inputTokens: 1e6, outputTokens: 1e6 } }) as { credits: number }
    expect(huge.credits).toBe(hold.credits)
  })

  it('the ComfyUI path charges the same calculation: the ceiling (per class, default settings)', () => {
    const DEFAULTS: Record<LlmTextClass, Record<string, unknown>> = {
      ChatLLMNode: { model: 'Gemini 3 Flash', prompt: 'Hello', system_prompt: '', temperature: 1, max_tokens: 1024 },
      ImprovePromptNode: { model: 'GPT-5 nano', idea: 'a cat', target: 'image' },
      SummarizeTextNode: { text: 'Some text', length: 'Short', model: 'Gemini 3 Flash' },
      TranslateTextNode: { text: 'Hello', target_language: 'English', custom_language: '' },
      RewriteToneNode: { text: 'We sell shoes', tone: 'Punchy', model: 'Claude 4.5 Haiku' },
      BrainstormIdeasNode: { topic: 'Coffee', count: 3, angle: 'Variations' },
      ReasonStepByStepNode: { question: '17 * 23?', include_reasoning: false, model: 'DeepSeek R1' },
    }
    const got = Object.fromEntries(LLM_TEXT_CLASSES.map(c => [c, priceGraph({ 1: { class_type: c, inputs: DEFAULTS[c] } }).nodes!['1']]))
    for (const c of LLM_TEXT_CLASSES) {
      const p = priceNode(c, DEFAULTS[c])
      if ('refused' in p) throw new Error(p.refused)
      expect(got[c], c).toBe(p.credits)
    }
    expect(got).toEqual({
      ChatLLMNode: 1, ImprovePromptNode: 1, SummarizeTextNode: 1, TranslateTextNode: 2,
      RewriteToneNode: 2, BrainstormIdeasNode: 1, ReasonStepByStepNode: 5,
    })
  })

  it('a typed blank text holds nothing; a wired one is held as a call', () => {
    const typed: ApiPrompt = { n: { class_type: 'SummarizeTextNode', inputs: { text: '  ', length: 'Short', model: 'Gemini 3 Flash' } }, t: { class_type: 'Text', inputs: { text: '' } } }
    expect(stageEstimate(typed, ['n', 't'], false, ON)).toBe(0)
    const wired: ApiPrompt = { ...typed, n: { class_type: 'SummarizeTextNode', inputs: { text: ['t', 0], length: 'Short', model: 'Gemini 3 Flash' } } }
    expect(stageEstimate(wired, ['n', 't'], false, ON)).toBe(priceNode('SummarizeTextNode', wired.n!.inputs).credits)
  })
})

describe('settings known only at run time are priced at their dearest (fix round 1)', () => {
  const LINK = ['w', 0]
  const credits = (ct: string, inputs: Record<string, unknown>) => {
    const p = priceNode(ct, inputs)
    if ('refused' in p) throw new Error(p.refused)
    return p.credits
  }
  const BASE: [LlmTextClass, Record<string, unknown>, readonly string[]][] = [
    ['ChatLLMNode', { prompt: 'Hello there', system_prompt: '', temperature: 1, max_tokens: 1024 }, CHAT_LLM_MODELS],
    ['SummarizeTextNode', { text: 'Some text', length: 'Short' }, SUMMARIZE_MODELS],
    ['RewriteToneNode', { text: 'We sell shoes', tone: 'Punchy' }, REWRITE_MODELS],
    ['ReasonStepByStepNode', { question: '17 * 23?', include_reasoning: false }, REASON_MODELS],
  ]

  it('a wired model: the dearest model the node offers, on both paths, never refused', () => {
    for (const [ct, inputs, models] of BASE) {
      const each = models.map(model => priceNode(ct, { ...inputs, model }) as { usd: number; credits: number })
      const dearest = each.reduce((a, b) => (b.usd > a.usd ? b : a))
      expect(priceNode(ct, { ...inputs, model: LINK }), ct).toEqual(dearest)
      expect(priceGraph({ 1: { class_type: ct, inputs: { ...inputs, model: LINK } } }).nodes!['1'], ct).toBe(dearest.credits)
    }
    // Chat at 1024 max tokens: Claude 4.5 Sonnet ($15/M out) is the dearest.
    expect(priceNode('ChatLLMNode', { ...BASE[0]![1], model: LINK })).toEqual(priceNode('ChatLLMNode', { ...BASE[0]![1], model: 'Claude 4.5 Sonnet' }))
  })

  it('a model Sailor doesn\'t know is refused in plain words, with no class name', () => {
    const p = priceNode('ChatLLMNode', { ...BASE[0]![1], model: 'GPT-9' })
    expect(p).toEqual({ refused: LLM_MODEL_UNPRICED })
    expect(LLM_MODEL_UNPRICED).not.toMatch(/Node|[A-Z][a-z]+[A-Z]/)
  })

  it('a wired tone: the longest guidance, in bytes', () => {
    const longest = REWRITE_TONES.map(t => rewriteSystem(t)).reduce((a, b) => (utf8Bytes(b) > utf8Bytes(a) ? b : a))
    expect(longest).toContain(TONE_GUIDANCE.Casual)
    const wired = paidCalls('RewriteToneNode', { text: 'abc', tone: LINK, model: 'Claude 4.5 Haiku' }, {})
    if ('refused' in wired) throw new Error(wired.refused)
    expect(wired.steps[0]!.call.inputTokens).toBe(3 + utf8Bytes(longest))
    for (const tone of REWRITE_TONES) {
      expect(credits('RewriteToneNode', { text: 'abc', tone: LINK, model: 'Claude 4.5 Haiku' })).toBeGreaterThanOrEqual(credits('RewriteToneNode', { text: 'abc', tone, model: 'Claude 4.5 Haiku' }))
    }
  })

  it('a wired count and angle on Brainstorm: 12 ideas and the longest angle', () => {
    const wired = paidCalls('BrainstormIdeasNode', { topic: 'x', count: LINK, angle: LINK }, {}) as { steps: { call: { inputTokens: number } }[] }
    const typed = paidCalls('BrainstormIdeasNode', { topic: 'x', count: 12, angle: 'Styles' }, {}) as { steps: { call: { inputTokens: number } }[] }
    expect(wired.steps[0]!.call.inputTokens).toBe(typed.steps[0]!.call.inputTokens)
  })

  it('the charge\'s cap comes from the inputs the hold was priced from, never from a wire\'s value', async () => {
    const sent = { text: LINK, length: 'Short', model: 'Gemini 3 Flash' }
    const planned = { ...sent, text: 'short' }
    const plan = await planNode({
      prompt: { n: { class_type: 'SummarizeTextNode', inputs: planned } }, nodeId: 'n', filesFrom: () => [], gateOpen: false,
      toUrl: async () => { throw new Error('no files') }, priceInputs: sent,
    }) as Extract<NodePlan, { kind: 'provider' }>
    const usage = { inputTokens: 30_000, outputTokens: 400 }
    const result = { metrics: { input_token_count: usage.inputTokens, output_token_count: usage.outputTokens } }
    const fromSent = (priceNode('SummarizeTextNode', sent, { answerUsage: usage }) as { credits: number }).credits
    const fromWireValue = (priceNode('SummarizeTextNode', planned, { answerUsage: usage }) as { credits: number }).credits
    expect(fromSent).toBeGreaterThan(fromWireValue)
    expect(plan.chargeOf!(result)).toBe(fromSent)
    expect(fromSent).toBeLessThanOrEqual(credits('SummarizeTextNode', sent))
  })
})

describe('moderation and hosted start checks', () => {
  it('lists the user\'s texts for moderation, not Sailor\'s system prompts', () => {
    expect(Object.fromEntries(LLM_TEXT_CLASSES.map(c => [c, PAID_TEXT_INPUTS[c]]))).toEqual({
      ChatLLMNode: ['prompt', 'system_prompt'], ImprovePromptNode: ['idea'], SummarizeTextNode: ['text'],
      TranslateTextNode: ['text', 'custom_language'], RewriteToneNode: ['text'], BrainstormIdeasNode: ['topic'], ReasonStepByStepNode: ['question'],
    })
    expect(extraPromptTexts({ n: { class_type: 'TranslateTextNode', inputs: { text: 'Bonjour', target_language: 'English', custom_language: 'Welsh' } } }))
      .toEqual(expect.arrayContaining(['Bonjour', 'Welsh']))
  })

  it('a hosted Chat moderates its question and its system prompt at the start', async () => {
    const moderate = vi.fn(async (_t: string) => ({ ok: true as const }))
    const replicate = createFakeReplicate({ bodyText: () => '{"id": "p", "status": "succeeded", "output": ["Blue"], "metrics": {"input_token_count": 5, "output_token_count": 1}}' })
    const k = makeKit({ hosted: true, moderate, replicate, deps: { families: () => ON } })
    const p: ApiPrompt = { n: { class_type: 'ChatLLMNode', inputs: { model: 'GPT-5', prompt: 'Pick a colour', system_prompt: 'Answer in one word', temperature: 0.5, max_tokens: 64 } } }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const texts = moderate.mock.calls.map(x => x[0])
    expect(texts).toEqual(expect.arrayContaining(['Pick a colour', 'Answer in one word']))
    const rec = (await k.store.get(runId))!.takes[0]!.nodes.n!
    expect(rec.values).toEqual({ 0: { kind: 'text', text: 'Blue' } })
  })

  it('a flagged question is refused before anything is held', async () => {
    const moderate = vi.fn(async (t: string) => (t.includes('forbidden') ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    const k = makeKit({ hosted: true, moderate, deps: { families: () => ON } })
    const p: ApiPrompt = { n: { class_type: 'ReasonStepByStepNode', inputs: { question: 'a forbidden thing', include_reasoning: false, model: 'GPT-5' } } }
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow()
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
  })

  it('requestProblems judges typed text only on a runner run', () => {
    const p: ApiPrompt = { n: { class_type: 'ChatLLMNode', inputs: { model: 'GPT-5', prompt: ' ', system_prompt: '', temperature: 1, max_tokens: 64 } } }
    expect(requestProblems(p, { runner: true }).map(x => x.message)).toEqual([CHAT_NEEDS_QUESTION])
    expect(requestProblems(p)).toEqual([])
    const wired: ApiPrompt = { ...p, n: { ...p.n!, inputs: { ...p.n!.inputs, prompt: ['s', 0] } }, s: { class_type: 'SummarizeTextNode', inputs: { text: 'x', length: 'Short', model: 'Gemini 3 Flash' } } }
    expect(requestProblems(wired, { runner: true })).toEqual([])
  })
})

describe('chains through the cards', () => {
  const summaryBody = '{"id": "p", "status": "succeeded", "output": ["  A short ", "summary.  "], "metrics": {"input_token_count": 40, "output_token_count": 4}}'

  it('a Text card fed by Summarize shows Python\'s text', async () => {
    const replicate = createFakeReplicate({ bodyText: () => summaryBody })
    const k = makeKit({ replicate, deps: { families: () => ON } })
    const p: ApiPrompt = {
      s: { class_type: 'SummarizeTextNode', inputs: { text: 'A long article.', length: 'Short', model: 'Gemini 3 Flash' } },
      t: { class_type: 'Text', inputs: { text: '', source: ['s', 0] } },
    }
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.s!.values).toEqual({ 0: { kind: 'text', text: 'A short summary.' } })
    expect(nodes.t!.values).toEqual({ 0: { kind: 'text', text: 'A short summary.' } })
    const executed = k.seen.filter(m => m.type === 'executed').map(m => (m as any).data)
    expect(executed.find((d: any) => d.node === 's')?.output).toEqual({ text: ['A short summary.'] })
  })

  it('Summarize → Generate an image\'s prompt_in is moderated at the node\'s turn and refused when blocked', async () => {
    const replicate = createFakeReplicate({ bodyText: () => summaryBody })
    const moderate = vi.fn(async (t: string) => (t === 'A short summary.' ? { ok: false as const, categories: ['violence'] } : { ok: true as const }))
    const k = makeKit({ hosted: true, moderate, replicate, deps: { families: () => ON } })
    const p: ApiPrompt = {
      s: { class_type: 'SummarizeTextNode', inputs: { text: 'A long article.', length: 'Short', model: 'Gemini 3 Flash' } },
      1: { class_type: 'GenerateImageNode', inputs: { model: 'nano-banana-2', prompt: '', prompt_in: ['s', 0], aspect_ratio: '1:1', seed: 7, model_options: '{}' } },
      2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
    }
    expect(isRunnerEligible(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(nodes.s!.status).toBe('done')
    expect(moderate.mock.calls.map(x => x[0])).toContain('A short summary.')
    expect(nodes['1']!.status).toBe('error')
    expect(k.fal.client.submit).not.toHaveBeenCalled()
  })

  it('a blank wired text makes no call and lets its hold go', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    // Through a Gate, so the start can't work the value out: held as a call.
    const p: ApiPrompt = {
      v: { class_type: 'PrimitiveString', inputs: { value: '   ' } },
      g: { class_type: 'ComfyGateNode', inputs: { data_in: ['v', 0], bypass: true } },
      s: { class_type: 'SummarizeTextNode', inputs: { text: ['g', 0], length: 'Short', model: 'Gemini 3 Flash' } },
      t: { class_type: 'Text', inputs: { text: '', source: ['s', 0] } },
    }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    await k.engine.settled(runId)
    const nodes = (await k.store.get(runId))!.takes[0]!.nodes
    expect(k.ledger.hold).toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(nodes.s!.values).toEqual({ 0: { kind: 'text', text: '' } })
    expect(nodes.s!.credits).toBe(0)
    const h = [...k.ledger.holds.values()]
    expect(h.every(x => x.state === 'released' || (x.state === 'settled' && x.actual === 0))).toBe(true)
  })

  it('a byte-identical request gives back the last answer, free (ruling (d)); a changed one calls again', async () => {
    const replicate = createFakeReplicate({ bodyText: () => summaryBody })
    const k = makeKit({ hosted: true, replicate, deps: { families: () => ON } })
    const p = (text: string): ApiPrompt => ({ s: { class_type: 'SummarizeTextNode', inputs: { text, length: 'Short', model: 'Gemini 3 Flash' } } })
    const runOnce = async (q: ApiPrompt) => {
      const { runId } = await k.engine.startRun({ userId: k.userId, takes: [q], ...START })
      await k.engine.settled(runId)
      return (await k.store.get(runId))!.takes[0]!.nodes.s!
    }
    const first = await runOnce(p('A long article.'))
    expect(first.reused).toBe(false)
    expect(first.credits).toBeGreaterThan(0)
    const again = await runOnce(p('A long article.'))
    expect(again.reused).toBe(true)
    expect(again.values).toEqual(first.values)
    expect(replicate.client.submit).toHaveBeenCalledTimes(1)
    const executed = k.seen.filter(m => m.type === 'executed').map(m => (m as any).data).filter((d: any) => d.node === 's')
    expect(executed.at(-1)?.output).toEqual({ text: ['A short summary.'] })
    // The first run is charged its node; the reused one nothing: its hold is let go.
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', first.credits], ['released', null]])
    const changed = await runOnce(p('A longer article.'))
    expect(changed.status, changed.error ?? '').toBe('done')
    expect(changed.reused).toBe(false)
    expect(replicate.client.submit).toHaveBeenCalledTimes(2)
  })
})

describe('with llm-text off (rule 15)', () => {
  const OFF_SETS: [string, RunnerFamily[]][] = [
    ['none', []],
    ['cards only', ['cards']],
    ['every family but llm-text', RUNNER_FAMILIES.filter(f => f !== 'llm-text')],
  ]
  /** The same prompt as before R3.3: the classes had no rule row and no output kind (renamed to one that has none). */
  const before = (p: ApiPrompt): ApiPrompt => Object.fromEntries(Object.entries(p).map(([id, n]) => [id, LLM_TEXT_CLASSES.includes(n.class_type as LlmTextClass) ? { ...n, class_type: `${n.class_type}Before` } : n]))
  function sameAsBefore(p: ApiPrompt, label: string) {
    const old = before(p)
    for (const [name, fam] of OFF_SETS) {
      const families = new Set(fam)
      const titleOf = (id: string) => id
      expect(nodesNeedingEngine(p, { runnerOn: true, families, titleOf }), `${label}, ${name}`).toEqual(nodesNeedingEngine(old, { runnerOn: true, families, titleOf }))
      expect(isRunnerEligible(p, families), `${label}, ${name}`).toBe(isRunnerEligible(old, families))
      for (const id of Object.keys(p)) {
        expect(runnerTakesNode(p, id, families), `${label} ${id}, ${name}`).toBe(runnerTakesNode(old, id, families))
        // A reader of an LLM node (its own inputs' rule is read only with its family on).
        if (!LLM_TEXT_CLASSES.includes(p[id]!.class_type as LlmTextClass)) {
          expect(valueWiresAllowed(p, id, outputKindsFor(families)), `${label} ${id}, ${name}`).toBe(valueWiresAllowed(old, id, outputKindsFor(families)))
        }
      }
    }
  }

  it('each class is left to the engine, and named by the needs-the-engine list', () => {
    for (const c of LLM_TEXT_CLASSES) {
      const p: ApiPrompt = { n: { class_type: c, inputs: CASES.find(x => x.class_type === c && x.calls.length)!.widgets } }
      expect(runnerTakesNode(p, 'n', new Set(['cards'])), c).toBe(false)
      expect(runnerTakesNode(p, 'n', ON), c).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: new Set(['cards']), titleOf: id => id })).toEqual(['n'])
      expect(RUNNER_OUTPUT_CLASSES.has(c)).toBe(true)
      expect(OUTPUT_KINDS[c]).toEqual({ 0: 'text' })
      expect(outputKindsFor(new Set(['cards']))[c]).toBeUndefined()
      expect(outputKindsFor(ON)[c]).toEqual({ 0: 'text' })
      expect(RUNNER_NODE_RULES[c]!.family).toBe('llm-text')
    }
  })

  it('over synthetic chains: a Text card into an LLM node, an LLM node into a Text card and a generator', () => {
    for (const c of LLM_TEXT_CLASSES) {
      const widgets = CASES.find(x => x.class_type === c && x.calls.length)!.widgets
      const input = Object.keys(PAID_TEXT_INPUTS[c] ? { [PAID_TEXT_INPUTS[c]![0]!]: 1 } : {})[0]!
      sameAsBefore({ n: { class_type: c, inputs: widgets } }, `${c} alone`)
      sameAsBefore({ t: { class_type: 'Text', inputs: { text: 'hi' } }, n: { class_type: c, inputs: { ...widgets, [input]: ['t', 0] } } }, `Text → ${c}`)
      sameAsBefore({ n: { class_type: c, inputs: widgets }, t: { class_type: 'Text', inputs: { text: '', source: ['n', 0] } } }, `${c} → Text`)
      sameAsBefore({
        n: { class_type: c, inputs: widgets },
        g: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: '', prompt_in: ['n', 0], aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      }, `${c} → generate`)
    }
  })

  const PROJECTS = resolve(__dirname, '../../../user/sailor/projects')
  const projectsIt = existsSync(PROJECTS) ? it : it.skip

  projectsIt('over every saved project graph (with Summarize spliced in beside each)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(resolve(__dirname, '../../server/native/objectInfo.baseline.json.gz'))).toString('utf8'))
    let graphs = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        graphs++
        sameAsBefore(p, uuid)
        sameAsBefore({ ...p, llm_s: { class_type: 'SummarizeTextNode', inputs: { text: 'x', length: 'Short', model: 'Gemini 3 Flash' } } }, `${uuid} + Summarize`)
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`llm-text families-off invariant: ${graphs} saved graphs`)
  }, 600_000)
})

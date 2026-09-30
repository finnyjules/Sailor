/**
 * R3.2: the shared pieces every paid-node task fills in — the rate cards
 * (paidRates.ts), the calls a node's settings can make (paidSettings.ts),
 * priceNode over them (one per-call price, summed: the R3.1 fix-round
 * ruling), the no-call branches the hold skips, the paid text inputs
 * moderation reads, and the parity harness (__runner__/paidParity.ts).
 * No R3 class is priced yet, so stand-in classes are planned here (the
 * vi.mock pattern of runner-paid-machinery.unit.spec.ts).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import type { NodeInputs, PriceOptions } from '#shared/pricing/nodePrice'
import type { PaidCall, PaidRate } from '#shared/pricing/paidRates'
import type { PaidCalls } from '#shared/pricing/paidSettings'
import { SHARED_PRICED_CLASS_SET, priceNode } from '#shared/pricing/nodePrice'
import { creditsForUsd, usdChargedAtCost } from '#shared/pricing/markup'
import { callCredits, callsCredits } from '#shared/pricing/pipelinePrice'
import { PAID_RATES, otherCardFor, paidCallUsd } from '#shared/pricing/paidRates'
import { LLM_ENDPOINTS, LLM_TEXT_CLASSES } from '#shared/runner/llm'
import { DESCRIBE_CLASSES } from '#shared/runner/describe'
import { REPAIR_PER_CALL_CLASSES } from '#shared/runner/repair'
import { LAYERS_CLASSES, SPLIT_CLASS } from '#shared/runner/layers'
import { SOUND_IN_CLASSES } from '#shared/runner/soundIn'
import { AUDIO_GEN_CLASSES } from '#shared/runner/audioGen'
import { GEN_3D_CLASSES } from '#shared/runner/gen3d'
import { IMAGE_EXTRAS_CLASSES } from '#shared/runner/imageExtras'
import { LORA_CLASSES, RESTYLE_LORA_CLASS } from '#shared/runner/lora'
import { TURNTABLE_CLASS } from '#shared/runner/turntable'
import { PAID_NODE_CLASSES, TOKEN_TEXT_CAP_BYTES, paidCalls, paidNoCall, tokenCeiling, utf8Bytes } from '#shared/pricing/paidSettings'
import { MODERATION_MAX_INPUT_BYTES } from '~~/server/utils/moderation'
import { editUsd } from '#shared/pricing/editRates'
import { clipUsd } from '#shared/pricing/clipRates'
import { videoPriceUsd } from '#shared/pricing/videoRates'
import { GRAPH_NODE_CREDITS, priceGraph } from '~~/server/utils/priceBook'
import { PAID_TEXT_INPUTS, createMetering, extraPromptTexts, nodeCredits, stageEstimate } from '~~/server/runner/metering'
import { makeKit } from './__runner__/kit'
import { expectCalls, normalizeSent, runPaidCase, wireText, type PaidCase } from './__runner__/paidParity'

// ── Stand-ins ────────────────────────────────────────────────────────────────

/** Stand-in rate cards (the real table is empty until a task fills it). */
const RATES = vi.hoisted((): Record<string, unknown> => ({
  'test/llm': { unit: 'per_token', inputPerMillion: 1.25, outputPerMillion: 10, service: 'replicate', source: 'test', read: '2026-09-27', confidence: 'verified' },
  'test/a': { unit: 'per_call', usd: 0.05, service: 'replicate', source: 'test', read: '2026-09-27', confidence: 'verified' },
  'test/b': { unit: 'per_call', usd: 0.03, service: 'replicate', source: 'test', read: '2026-09-27', confidence: 'verified' },
  'test/c': { unit: 'per_call', usd: 0.2, service: 'fal', source: 'test', read: '2026-09-27', confidence: 'verified' },
}))

/** The token stand-in's ceiling: one token per byte of text sent (at most 32,768), plus its longest answer. */
const MAX_ANSWER_TOKENS = 8192
/** The token stand-in's own fixed prompt, in bytes. */
const SYSTEM = 'You are a summarizer.'.length
const STAND_IN = vi.hoisted(() => ({
  TestTokenNode: null as unknown as (inputs: Record<string, unknown>, opts: Record<string, unknown>) => unknown,
  TestPipelineNode: () => ({
    steps: [
      { call: { endpoint: 'test/a' }, times: 2 },
      { call: { endpoint: 'test/b', fallbacks: [{ endpoint: 'test/c' }] }, times: 1 },
    ],
  }),
  TestUnpricedNode: () => ({ steps: [{ call: { endpoint: 'test/no-card' }, times: 1 }] }),
  TestRefusedNode: () => ({ refused: 'Pick a model first.' }),
  TestBadTimesNode: (inputs: Record<string, unknown>) => ({ steps: [{ call: { endpoint: 'test/a' }, times: inputs.times as number }] }),
}))

vi.mock('#shared/pricing/paidRates', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/pricing/paidRates')>()
  const table = { ...real.PAID_RATES, ...RATES } as Record<string, PaidRate>
  return { ...real, paidCallUsd: (c: PaidCall, rates?: Record<string, PaidRate>) => real.paidCallUsd(c, rates ?? table) }
})

vi.mock('#shared/pricing/paidSettings', async (importOriginal) => {
  const real = await importOriginal<typeof import('#shared/pricing/paidSettings')>()
  // The token stand-in builds its ceiling from the one shared rule (c).
  STAND_IN.TestTokenNode = (inputs: NodeInputs, opts: PriceOptions) => ({
    steps: [{
      call: opts.answerUsage
        ? { endpoint: 'test/llm', inputTokens: opts.answerUsage.inputTokens, outputTokens: opts.answerUsage.outputTokens }
        : { endpoint: 'test/llm', ...real.tokenCeiling({ texts: typeof inputs.text === 'string' ? [inputs.text] : [], linkedTexts: Array.isArray(inputs.text) ? 1 : 0, fixed: ['You are a summarizer.'], maxAnswerTokens: 8192 }, opts) },
      times: 1,
    }],
  }) as never
  const planned = STAND_IN as unknown as Record<string, (i: NodeInputs, o: PriceOptions) => PaidCalls>
  return {
    ...real,
    PAID_NODE_CLASSES: [...real.PAID_NODE_CLASSES, ...Object.keys(STAND_IN)],
    paidCalls: (ct: string, inputs: NodeInputs, opts: PriceOptions) =>
      Object.prototype.hasOwnProperty.call(planned, ct) ? planned[ct]!(inputs, opts) : real.paidCalls(ct, inputs, opts),
    // A picture model whose `test_no_call` input stands for Python returning before any call.
    paidNoCall: (ct: string, inputs: NodeInputs) => (ct === 'GenerateImageNode' && inputs.test_no_call === true) || real.paidNoCall(ct, inputs),
  }
})

const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }
const tokenUsd = (inTok: number, outTok: number) => Math.round((inTok * 1.25 / 1e6 + outTok * 10 / 1e6) * 1e8) / 1e8

// ── The rate cards ───────────────────────────────────────────────────────────

describe('paidCallUsd', () => {
  const meta = { service: 'replicate', source: 'test', read: '2026-09-27', confidence: 'verified' } as const
  const T: Record<string, PaidRate> = {
    call: { ...meta, unit: 'per_call', usd: 0.012 },
    tok: { ...meta, unit: 'per_token', inputPerMillion: 0.3, outputPerMillion: 2.5 },
    inSec: { ...meta, unit: 'per_input_second', perSecond: 0.0005, minSeconds: 10 },
    outSec: { ...meta, unit: 'per_output_second', perSecond: 0.18 },
    chars: { ...meta, unit: 'per_thousand_chars', perThousand: 0.1 },
    gpu: { ...meta, unit: 'gpu_ceiling', usd: 0.35, note: 'A100 × 120 s' },
  }
  it('prices each unit from what the call carries', () => {
    expect(paidCallUsd({ endpoint: 'call' }, T)).toBe(0.012)
    expect(paidCallUsd({ endpoint: 'tok', inputTokens: 1000, outputTokens: 400 }, T)).toBe(0.0013)
    expect(paidCallUsd({ endpoint: 'inSec', inputSeconds: 4 }, T)).toBe(0.005)
    expect(paidCallUsd({ endpoint: 'inSec', inputSeconds: 30 }, T)).toBe(0.015)
    expect(paidCallUsd({ endpoint: 'outSec', outputSeconds: 5 }, T)).toBe(0.9)
    expect(paidCallUsd({ endpoint: 'chars', chars: 2500 }, T)).toBe(0.25)
    expect(paidCallUsd({ endpoint: 'gpu' }, T)).toBe(0.35)
  })
  it('refuses (null) a call its card can’t price: no card, or a count the unit needs is missing', () => {
    expect(paidCallUsd({ endpoint: 'nobody/knows' }, T)).toBeNull()
    expect(paidCallUsd({ endpoint: 'constructor' }, T)).toBeNull()
    expect(paidCallUsd({ endpoint: 'tok', inputTokens: 5 }, T)).toBeNull()
    expect(paidCallUsd({ endpoint: 'inSec' }, T)).toBeNull()
    expect(paidCallUsd({ endpoint: 'outSec', outputSeconds: -1 }, T)).toBeNull()
    expect(paidCallUsd({ endpoint: 'chars' }, T)).toBeNull()
  })
  it('an endpoint carded already is priced by its own card (edits, clips, video models)', () => {
    const edit = { endpoint: 'fal-ai/nano-banana-2/edit', tier: '2K', inputPixels: null, outputPixels: null }
    expect(paidCallUsd(edit, {})).toBe(editUsd(edit))
    expect(paidCallUsd(edit, {})).toBe(0.12)
    const clip = 'minimax/h3/image-to-video'
    expect(paidCallUsd({ endpoint: clip, outputSeconds: 6, tier: '768p', audio: false }, {}))
      .toBe(clipUsd(clip, { seconds: 6, resolution: '768p', audio: false }))
    // Sound not said: the dearer of with and without.
    expect(paidCallUsd({ endpoint: clip, outputSeconds: 6, tier: '768p' }, {}))
      .toBe(Math.max(clipUsd(clip, { seconds: 6, resolution: '768p', audio: false })!, clipUsd(clip, { seconds: 6, resolution: '768p', audio: true })!))
    const video = paidCallUsd({ endpoint: 'hailuo-h3', outputSeconds: 5, tier: '768p', audio: false }, {})
    expect(video).toBe(videoPriceUsd('hailuo-h3', { seconds: 5, resolution: '768p', audio: false, inputVideoSeconds: 0 }))
    expect(video).toBeGreaterThan(0)
    expect(paidCallUsd({ endpoint: clip }, {})).toBeNull()
  })
  it('fallbacks are covered at cost, the first call marked up (one call’s price basis)', () => {
    expect(paidCallUsd({ endpoint: 'call', fallbacks: [{ endpoint: 'gpu' }] }, T)).toBe(usdChargedAtCost(0.35))
    expect(paidCallUsd({ endpoint: 'gpu', fallbacks: [{ endpoint: 'call' }] }, T)).toBe(0.35)
    expect(paidCallUsd({ endpoint: 'call', fallbacks: [{ endpoint: 'nobody/knows' }] }, T)).toBeNull()
  })
  it('the real table holds only the cards the tasks added (R3.3: the LLM text nodes; R3.4: describe; R3.5: image-repair; R3.6 and R3.7: layers; R3.8: audio-gen; R3.9: gen-3d; R3.10: sound-in; R3.12: image-extras; R3.13 and R3.14: lora)', () => {
    // (R3.4: Gemini 2.5 Flash, Dolphin, YOLO-World; moondream2 keeps its edit card.
    // R3.5: Restore and Remove background; the upscalers keep their edit cards.
    // R3.6: Ideogram Layerize, Seedream Layerize, Flux Fill Pro and Bria Expand.
    // R3.7: the two fill engines, LaMa and Bria Eraser; the cut-out is Remove background's card.
    // R3.8: MusicGen and MiniMax Speech-02 HD.
    // R3.9: Hunyuan3D 2, Hunyuan3D-2mv, Rodin and TRELLIS.
    // R3.12: Ideogram V3 Turbo, Flux Kontext Pro and Ideogram Character; Nano Banana keeps its edit card.
    // R3.13: flux-dev-multi-lora; flux-dev-lora keeps its edit card.)
    expect(Object.keys(PAID_RATES).sort()).toEqual([
      ...LLM_ENDPOINTS, 'google/gemini-2.5-flash', 'bytedance/dolphin', 'zsxkib/yolo-world',
      'flux-kontext-apps/restore-image', '851-labs/background-remover',
      'ideogram-ai/layerize', 'bytedance/seedream/v5/pro/layerize', 'black-forest-labs/flux-fill-pro', 'bria/expand-image',
      'zylim0702/remove-object', 'bria/eraser',
      'meta/musicgen', 'minimax/speech-02-hd',
      'tencent/hunyuan3d-2', 'tencent/hunyuan3d-2mv', 'hyper3d/rodin', 'firtoz/trellis',
      'ideogram-ai/ideogram-v3-turbo', 'black-forest-labs/flux-kontext-pro', 'ideogram-ai/ideogram-character',
      'lucataco/flux-dev-multi-lora',
      // R3.10: Wizper, whisper-diarization and realistic-voice-cloning; lipsync-2-pro keeps its clip card.
      'fal-ai/wizper', 'thomasmol/whisper-diarization', 'zsxkib/realistic-voice-cloning',
    ].sort())
  })
  it('no paid card duplicates an edit, clip or video card (each rate lives in one place)', () => {
    for (const endpoint of Object.keys(PAID_RATES)) expect(otherCardFor(endpoint), endpoint).toBeNull()
    // The guard sees each kind of existing card.
    expect(otherCardFor('fal-ai/nano-banana-2/edit')).toBe('edit')
    expect(otherCardFor('minimax/h3/image-to-video')).toBe('clip')
    expect(otherCardFor('hailuo-h3')).toBe('video')
    expect(otherCardFor('test/llm')).toBeNull()
    expect(otherCardFor('constructor')).toBeNull()
  })
})

// ── Rule (c): the token ceiling ──────────────────────────────────────────────

describe('tokenCeiling', () => {
  const CJK = '日本語のテキスト' // 8 characters, 24 bytes
  const EMOJI = '😀🎉' // 4 UTF-16 units, 8 bytes
  it('counts UTF-8 bytes, not characters or UTF-16 units', () => {
    expect([CJK.length, utf8Bytes(CJK)]).toEqual([8, 24])
    expect([EMOJI.length, utf8Bytes(EMOJI)]).toEqual([4, 8])
    expect(tokenCeiling({ texts: [CJK, EMOJI, 'ab'], maxAnswerTokens: 400 })).toEqual({ inputTokens: 24 + 8 + 2, outputTokens: 400 })
  })
  it('hosted: each text at most the moderation limit; local: whole', () => {
    expect(TOKEN_TEXT_CAP_BYTES).toBe(MODERATION_MAX_INPUT_BYTES)
    const long = '語'.repeat(20_000) // 60,000 bytes
    const short = '😀'.repeat(10) // 40 bytes
    expect(tokenCeiling({ texts: [long, short], maxAnswerTokens: 1 }, { hosted: true }).inputTokens).toBe(32_768 + 40)
    expect(tokenCeiling({ texts: [long, short], maxAnswerTokens: 1 }, { hosted: false }).inputTokens).toBe(60_000 + 40)
    expect(tokenCeiling({ texts: [long, short], maxAnswerTokens: 1 }).inputTokens).toBe(60_000 + 40)
  })
  it('Sailor’s own fixed prompt is added whole, never capped', () => {
    const system = '指示'.repeat(20_000) // 120,000 bytes
    expect(tokenCeiling({ texts: ['hi'], fixed: [system, 'Output only the text.'], maxAnswerTokens: 8 }, { hosted: true }))
      .toEqual({ inputTokens: 2 + 120_000 + 21, outputTokens: 8 })
  })
  it('a linked text counts at the cap; a measured size replaces the texts (hosted: capped per text)', () => {
    expect(tokenCeiling({ texts: [CJK], linkedTexts: 2, maxAnswerTokens: 0 }).inputTokens).toBe(24 + 2 * 32_768)
    expect(tokenCeiling({ texts: [CJK], linkedTexts: 1, fixed: ['sys'], maxAnswerTokens: 0 }, { inputBytes: 90_000 }).inputTokens).toBe(90_000 + 3)
    expect(tokenCeiling({ texts: [CJK], linkedTexts: 1, fixed: ['sys'], maxAnswerTokens: 0 }, { inputBytes: 90_000, hosted: true }).inputTokens).toBe(2 * 32_768 + 3)
    expect(tokenCeiling({ texts: [CJK], maxAnswerTokens: 0 }, { inputBytes: Number.NaN }).inputTokens).toBe(24)
  })
  it('a stand-in text node with CJK and emoji text is priced on its bytes', () => {
    const text = CJK + EMOJI
    expect(priceNode('TestTokenNode', { text })).toEqual({ usd: tokenUsd(32 + SYSTEM, 8192), credits: creditsForUsd(tokenUsd(32 + SYSTEM, 8192)) })
  })
})

// ── priceNode ────────────────────────────────────────────────────────────────

describe('priceNode for a paid class', () => {
  it('stand-ins are shared-priced classes; the real list is the tasks\' classes (R3.3: the LLM text nodes; R3.4: describe; R3.5: image-repair; R3.6 and R3.7: layers; R3.8: audio-gen; R3.10: sound-in; R3.9: gen-3d; R3.12: image-extras; R3.13: lora; R3.16: turntable)', () => {
    for (const ct of Object.keys(STAND_IN)) expect(SHARED_PRICED_CLASS_SET.has(ct)).toBe(true)
    expect(PAID_NODE_CLASSES).toEqual([...LLM_TEXT_CLASSES, ...DESCRIBE_CLASSES, ...REPAIR_PER_CALL_CLASSES, ...LAYERS_CLASSES, SPLIT_CLASS, ...AUDIO_GEN_CLASSES, ...SOUND_IN_CLASSES.filter(c => !c.startsWith('Lipsync')), ...GEN_3D_CLASSES, ...IMAGE_EXTRAS_CLASSES, ...LORA_CLASSES, RESTYLE_LORA_CLASS, TURNTABLE_CLASS, ...Object.keys(STAND_IN)])
  })

  it('a token node: the hold is creditsForUsd of the ceiling (rule (c), tokenCeiling)', () => {
    const inputs = { text: 'x'.repeat(1000) }
    const hold = priceNode('TestTokenNode', inputs)
    expect(hold).toEqual({ usd: tokenUsd(1000 + SYSTEM, MAX_ANSWER_TOKENS), credits: creditsForUsd(tokenUsd(1000 + SYSTEM, MAX_ANSWER_TOKENS)) })
    // The caller's measured bytes, when given; capped per text in hosted only.
    expect(priceNode('TestTokenNode', inputs, { inputBytes: 50_000 })).toEqual({ usd: tokenUsd(50_000 + SYSTEM, 8192), credits: creditsForUsd(tokenUsd(50_000 + SYSTEM, 8192)) })
    expect(priceNode('TestTokenNode', inputs, { inputBytes: 50_000, hosted: true })).toEqual({ usd: tokenUsd(32_768 + SYSTEM, 8192), credits: creditsForUsd(tokenUsd(32_768 + SYSTEM, 8192)) })
    // Through the graph pricer (the ComfyUI path and the runner's charge) too.
    expect(priceGraph({ n: { class_type: 'TestTokenNode', inputs } }).nodes!.n).toBe((hold as { credits: number }).credits)
  })

  it('what the answer reports prices below the ceiling; above it, the hold', () => {
    const inputs = { text: 'x'.repeat(1000) }
    const hold = (priceNode('TestTokenNode', inputs) as { credits: number }).credits
    const small = priceNode('TestTokenNode', inputs, { answerUsage: { inputTokens: 300, outputTokens: 50 } })
    expect(small).toEqual({ usd: tokenUsd(300, 50), credits: creditsForUsd(tokenUsd(300, 50)) })
    expect((small as { credits: number }).credits).toBeLessThan(hold)
    const big = priceNode('TestTokenNode', inputs, { answerUsage: { inputTokens: 200_000, outputTokens: 60_000 } })
    expect(creditsForUsd(tokenUsd(200_000, 60_000))).toBeGreaterThan(hold)
    expect((big as { credits: number }).credits).toBe(hold)
  })

  it('a pipeline: Σ times × each call’s own credits (R3.1 ruling), not a markup of the summed dollars', () => {
    const a = callCredits({ usd: 0.05 })
    const b = callCredits({ usd: usdChargedAtCost(0.2) })
    const p = priceNode('TestPipelineNode', {}) as { usd: number; credits: number }
    expect(p.credits).toBe(2 * a + b)
    expect(p.credits).toBe(40)
    // The credits are not the markup of the summed dollars (0.1 + usdChargedAtCost(0.2) would mark up to 27)…
    expect(creditsForUsd(0.1 + usdChargedAtCost(0.2))).not.toBe(p.credits)
    // …and the dollars shown are the basis those credits came from (R3.14 fix round 1: credits = creditsForUsd(usd)).
    expect(p.usd).toBe(usdChargedAtCost(0.40))
    expect(creditsForUsd(p.usd)).toBe(p.credits)
    // A partial charge (the first step's calls only) is never above the whole.
    const first = callsCredits([{ usd: paidCallUsd({ endpoint: 'test/a' })! }, { usd: paidCallUsd({ endpoint: 'test/a' })! }])
    expect(first).toBe(20)
    expect(first).toBeLessThanOrEqual(p.credits)
  })

  it('refuses a class whose call has no card, or whose settings refuse', () => {
    expect(priceNode('TestUnpricedNode', {})).toEqual({ refused: 'test/no-card has no listed price' })
    expect(priceNode('TestRefusedNode', {})).toEqual({ refused: 'Pick a model first.' })
    expect(() => priceGraph({ n: { class_type: 'TestUnpricedNode', inputs: {} } })).toThrow(/no listed price/)
  })

  it('refuses a step planned to run other than a whole number of times, at least once', () => {
    for (const times of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = priceNode('TestBadTimesNode', { times })
      expect(p, String(times)).toEqual({ refused: `test/a is planned to run ${times} times; a call runs a whole number of times, at least once` })
    }
    // 3 × 10 credits; the dollars shown mark up to them (R3.14 fix round 1), not the summed $0.15 (23).
    expect(priceNode('TestBadTimesNode', { times: 3 })).toEqual({ usd: 0.2, credits: 30 })
  })

  it('the real paidCalls refuses a class no task has planned, and paidNoCall is false for it', () => {
    expect(paidCalls('FluxProRemoteNode', { image: ['1', 0] }, {})).toEqual({ refused: 'FluxProRemoteNode is not priced by its calls' })
    expect(paidNoCall('FluxProRemoteNode', { image: ['1', 0] })).toBe(false)
  })
})

describe('GRAPH_NODE_CREDITS', () => {
  it('still prices every class no task has moved, at its flat figure', () => {
    const rows = Object.entries(GRAPH_NODE_CREDITS)
    // (R3.3 moved the seven LLM text nodes out, R3.4 five describe nodes, R3.5 Restore and Remove background with their twins,
    // R3.6 Layerize, Seedream Layerize and Outpaint, R3.7 Separate background and foreground, R3.8 music and speech with their twins,
    // R3.9 the three 3D nodes, R3.12 Text effect, Sketch to image and Generate face references,
    // R3.13 Flux Dev + LoRA and Flux Dev + LoRAs, R3.16 Turntable, R3.10 Transcribe, Whisper, Identify speakers and Clone a singing voice.)
    expect(rows.length).toBeGreaterThanOrEqual(6)
    for (const [ct, flat] of rows) {
      expect(PAID_NODE_CLASSES.includes(ct), ct).toBe(false)
      expect(priceGraph({ n: { class_type: ct, inputs: {} } }).nodes!.n, ct).toBe(flat)
    }
  })
})

// ── The hold skips a no-call branch ──────────────────────────────────────────

describe('paidNoCall', () => {
  const node = (noCall: boolean) => ({ class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'p', aspect_ratio: '1:1', seed: 0, model_options: '{}', test_no_call: noCall } })
  it('stageEstimate holds nothing for a node Python would answer without a call', () => {
    const called: ApiPrompt = { 1: node(false) }
    expect(stageEstimate(called, ['1'], false)).toBe(nodeCredits(called['1']!))
    expect(stageEstimate(called, ['1'], false)).toBeGreaterThan(0)
    expect(stageEstimate({ 1: node(true) }, ['1'], false)).toBe(0)
    expect(stageEstimate({ 1: node(true) }, ['1'], true)).toBe(0)
    // Beside a node that does call, only that one is held (plus the render credit).
    const both: ApiPrompt = { 1: node(true), 2: node(false) }
    expect(stageEstimate(both, ['1', '2'], true)).toBe(nodeCredits(both['2']!) + 1)
  })
})

// ── Moderation of the paid text inputs ───────────────────────────────────────

describe('PAID_TEXT_INPUTS', () => {
  const table = PAID_TEXT_INPUTS as Record<string, readonly string[]>
  afterEach(() => { delete table.GenerateImageNode; delete table.TestTokenNode })

  it('lists only the tasks\' classes (R3.3: the LLM text nodes; R3.4: describe; R3.5: Upscale and Enhance detail; R3.6: layers; R3.8: audio-gen; R3.9: Multi-View; R3.12: image-extras; R3.13 and R3.14: lora; R3.15: Pose Mannequin; R3.16: Turntable)', () => {
    // (R3.4: every describe class but Extract text, which sends no text. R3.5: the two with prompts. R3.6: all three. R3.8: all four.
    // R3.9: Multi-View's prompt; Generate a 3D model and its twin send no text. R3.12: all three. R3.13: both. R3.14: Restyle.
    // R3.15: Pose Mannequin; Lens · 3D Reframe sends only Sailor's own text. R3.16: Turntable's extra direction.)
    expect(Object.keys(PAID_TEXT_INPUTS)).toEqual([...LLM_TEXT_CLASSES, ...DESCRIBE_CLASSES.filter(c => c !== 'ExtractTextNode'), 'UpscaleImageNode', 'EnhanceDetailNode', ...LAYERS_CLASSES, ...AUDIO_GEN_CLASSES, 'Hunyuan3DMultiViewNode', ...IMAGE_EXTRAS_CLASSES, ...LORA_CLASSES, RESTYLE_LORA_CLASS, 'PoseMannequin', 'TurntableNode'])
  })

  it('extraPromptTexts reads a paid class’s listed inputs (typed text only)', () => {
    table.TestTokenNode = ['text', 'context', 'tone']
    const p: ApiPrompt = {
      1: { class_type: 'TestTokenNode', inputs: { text: 'summarise this', context: '  ', tone: ['9', 0], other: 'not listed' } },
      2: { class_type: 'OtherNode', inputs: { context: 'another class' } },
    }
    expect(extraPromptTexts(p)).toEqual(['summarise this'])
  })

  it('the listed texts reach moderate at the start of a take (typed), each once', async () => {
    table.GenerateImageNode = ['prompt', 'test_text']
    const moderate = vi.fn(async (_t: string) => ({ ok: true as const }))
    const k = makeKit({ hosted: true, moderate })
    const p: ApiPrompt = { 1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', test_text: 'the paid text' } }, 2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } } }
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [p], ...START })
    // Checked before anything was held.
    expect(moderate.mock.calls.map(c => c[0]).sort()).toEqual(['a red fox', 'the paid text'])
    await k.engine.settled(runId)
    expect(moderate.mock.calls.map(c => c[0]).sort()).toEqual(['a red fox', 'the paid text'])
  })

  it('a flagged listed text refuses the take before any hold', async () => {
    table.GenerateImageNode = ['test_text']
    const moderate = vi.fn(async (t: string) => (t === 'bad words' ? { ok: false as const, categories: ['harassment'] } : { ok: true as const }))
    const k = makeKit({ hosted: true, moderate })
    const p: ApiPrompt = { 1: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}', test_text: 'bad words' } }, 2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } } }
    await expect(k.engine.startRun({ userId: k.userId, takes: [p], ...START })).rejects.toThrow()
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('metering.moderate checks each listed text once, beside the prompts', async () => {
    table.TestTokenNode = ['text', 'context', 'notes']
    const check = vi.fn(async (_t: string) => ({ ok: true as const }))
    const m = createMetering({ hosted: () => true, ledger: () => { throw new Error('unused') }, graphRuns: { create: async () => {}, appendOutput: async () => {}, resolve: async () => {} }, spendGuard: async () => {}, moderate: check })
    await m.moderate([{ 1: { class_type: 'TestTokenNode', inputs: { text: 'same', context: 'same', notes: 'a note' } }, 2: { class_type: 'TestTokenNode', inputs: { text: 'other', context: 'a context', notes: ' ' } } }])
    expect(check.mock.calls.map(c => c[0]).sort()).toEqual(['a context', 'a note', 'other', 'same'])
  })
})

// ── The parity harness ───────────────────────────────────────────────────────

describe('paidParity', () => {
  it('normalizes a handed-off picture to IMG:<input name> and a sound to WAV:<input name>', () => {
    const sent = [{ provider: 'fal' as const, endpoint: 'e', payload: { image_urls: ['https://fal.storage/input_image.png'], audio: 'https://fal.storage/voice.wav', n: 1 } }]
    expect(normalizeSent(sent, ['input_image'], ['voice'])).toEqual([{ provider: 'fal', endpoint: 'e', payload: { image_urls: ['IMG:input_image'], audio: 'WAV:voice', n: 1 } }])
  })

  it('compares payloads on the wire too: Python’s 1.0 is not a sent 1', () => {
    const sent = [{ provider: 'fal' as const, endpoint: 'e', payload: { b: 1, a: 'é', c: [0.5, 2] } }]
    expect(wireText(sent[0]!.payload)).toBe('{"a": "\\u00e9", "b": 1, "c": [0.5, 2]}')
    expectCalls(sent, [{ ...sent[0]!, payload_json: '{"a": "\\u00e9", "b": 1, "c": [0.5, 2]}' }])
    expect(() => expectCalls(sent, [{ ...sent[0]!, payload_json: '{"a": "\\u00e9", "b": 1.0, "c": [0.5, 2]}' }])).toThrow()
    expect(() => expectCalls(sent, [{ ...sent[0]!, payload_json: '{"a": "\\u00e9", "b": 1, "c": [0.5, 2.0]}' }])).toThrow()
  })

  it('a GET the case doesn’t serve fails the node, not a quiet default', async () => {
    const fam = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-families.json'), 'utf8')) as { falEdit: { class_type: string; widgets: Record<string, unknown>; links: string[]; call: PaidCase['calls'][number] }[] }
    const one = fam.falEdit[0]!
    const r = await runPaidCase({ name: 'unserved', class_type: one.class_type, widgets: one.widgets, pictures: one.links, answers: [{ images: [{ url: 'https://fal.media/missing.png' }] }], calls: [one.call], output: null, ui: null, files: {} }, { families: new Set(['fal-edit', 'cards']) })
    expect(r.status).toBe('error')
  })

  it('runs a Python-captured case through planNode and the kit: the calls match Python’s, call by call', async () => {
    // The first fal-edit case Python captured (runner-families.json), as a paid case.
    const fam = JSON.parse(readFileSync(resolve(__dirname, 'fixtures/runner-families.json'), 'utf8')) as { falEdit: { class_type: string; widgets: Record<string, unknown>; links: string[]; call: { provider: 'fal' | 'replicate'; endpoint: string; payload: Record<string, unknown> } }[] }
    const one = fam.falEdit[0]!
    const c: PaidCase = {
      name: 'fal edit, first case', class_type: one.class_type, widgets: one.widgets, pictures: one.links,
      answers: [{ images: [{ url: 'https://fal.media/out.png' }] }], calls: [one.call], output: null, ui: null,
      files: { 'https://fal.media/out.png': (await sharp(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), { raw: { width: 2, height: 2, channels: 3 } }).png().toBuffer()).toString('base64') },
    }
    const families: ReadonlySet<RunnerFamily> = new Set(['fal-edit', 'cards'])
    const r = await runPaidCase(c, { families, hosted: true })
    expectCalls(r.sent, c.calls, c.pictures)
    expect(r.files).toHaveLength(1)
    expect(r.credits).toBe((priceNode(one.class_type, one.widgets, { families }) as { credits: number }).credits)
    // A call Python didn't make is caught.
    expect(() => expectCalls(r.sent, [{ ...one.call, payload: { ...one.call.payload, seed: 9 } }], c.pictures)).toThrow()
  })
})

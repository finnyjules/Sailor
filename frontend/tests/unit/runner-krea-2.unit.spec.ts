/**
 * Task F17 (model line-up): Krea 2 Large and Krea 2 Medium in the runner,
 * family `krea-2` (server/runner/generators/krea2.ts): "Generate an image"
 * on fal's krea/v2/{large,medium}/text-to-image, Replicate's
 * krea/krea-2-{large,medium} the backup.
 *
 * Unlike the runner-only F-tasks, both models already run on the ComfyUI
 * path (Python `_fal_krea2`, fal first, `_b_krea2` on Replicate behind it),
 * so this family moves them the way replicate-image moved the Replicate
 * models (Phase B): the catalogue entry is unchanged (no `runnerOnly`, no
 * `family`), the model is never refused, and it shows in the gallery whether
 * the switch is on or off. With the family off, the price, badge, estimate
 * and the ComfyUI path's checks are what they were.
 *
 * The family contract:
 *  - every payload over the settings grid fits the saved schema, and so does
 *    its backup; the price reads what is sent (one flat price per picture,
 *    the same on both services);
 *  - hand-written expected payloads: plain (fal's own "Full Example"),
 *    every setting there is, and a moodboard picture linked (not sent);
 *  - the runner sends what Python sends (recorded from .venv/bin/python);
 *  - eligibility with the family on and off;
 *  - blockedModelUses never refuses it (it has an engine builder);
 *  - the gallery shows it with the family on or off;
 *  - the price is verified and non-zero, badge = charge, and unchanged;
 *  - an empty prompt (the schema's minLength 1) and one over the schema's
 *    5,000 characters are refused up front on a runner run, and only there;
 *  - the engine, end to end: the family's own endpoint, and the hold.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_IMAGE_MODEL_IDS, RUNNER_NODE_RULES, RUNNER_REPLICATE_IMAGE_MODEL_IDS, isRunnerEligible } from '#shared/runner/eligibility'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { __resetModelMenusForTests, galleryEntries } from '#shared/runner/modelMenus'
import { creditsForUsd, usdChargedAtCost } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { IMAGE_BACKUP_RATES, IMAGE_RATES, imagePriceMaxUsd, imagePriceUsd } from '#shared/pricing/imageRates'
import { effectiveImageSettings } from '#shared/pricing/imageSettings'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID } from '~~/app/data/image-models'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import {
  KREA_2_CREATIVITY, KREA_2_FAL_APPS, KREA_2_IDS, KREA_2_LONG_PROMPT, KREA_2_NEEDS_PROMPT, KREA_2_PROMPT_MAX, KREA_2_RATIOS,
  KREA_2_REPLICATE_SLUGS, krea2Generate, krea2OnReplicate, type Krea2Id,
} from '~~/server/runner/generators/krea2'
import {
  PROMPT_MAX_LENGTH, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, requestProblem, requestProblems,
} from '~~/server/runner/requestRules'
import { requestRefusal } from '~~/server/utils/blockedModels'
import { IMAGE_BACKUPS, RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const FAMILY: RunnerFamily = 'krea-2'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
/** Text-to-image, per picture, the same on both services (fal llms.txt; Replicate billing). */
const PRICE: Record<Krea2Id, number> = { 'krea-2-large': 0.06, 'krea-2-medium': 0.03 }

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

const falSchema = (id: Krea2Id) => {
  const f = loadProviderSchema('fal', KREA_2_FAL_APPS[id])
  expect(f.endpoint).toBe(KREA_2_FAL_APPS[id])
  return f
}
const repSchema = (id: Krea2Id) => {
  const f = loadProviderSchema('replicate', KREA_2_REPLICATE_SLUGS[id])
  expect(f.endpoint).toBe(KREA_2_REPLICATE_SLUGS[id])
  return f
}
/** A saved schema's input object (its $ref followed). */
function inputOf(f: ReturnType<typeof loadProviderSchema>): Record<string, any> {
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}
const schemaRef = (f: ReturnType<typeof loadProviderSchema>, name: string) => f.components.schemas[name] as Record<string, any>

/** A "Generate an image" node on Krea 2. */
function gen(id: Krea2Id, o: { prompt?: string, ar?: unknown, seed?: unknown, opts?: Record<string, unknown> } = {}) {
  const inputs: Record<string, unknown> = {
    model: id, prompt: o.prompt ?? 'a red fox in the snow', seed: o.seed ?? 0, model_options: JSON.stringify(o.opts ?? {}),
  }
  if (o.ar !== undefined) inputs.aspect_ratio = o.ar
  return { class_type: 'GenerateImageNode', inputs }
}

function plan(node: { class_type: string, inputs: Record<string, unknown> }) {
  return planNode({
    prompt: { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, n: node },
    nodeId: 'n',
    filesFrom: () => [{ filename: 'first.png', subfolder: '', type: 'input' }],
    toUrl: async (f: OutputFile) => `IMG:${f.filename}`,
    gateOpen: false,
  })
}
async function providerPlan(node: { class_type: string, inputs: Record<string, unknown> }): Promise<ProviderPlan> {
  const p = await plan(node)
  if (p.kind !== 'provider') throw new Error('no provider call')
  return p
}

// ── The saved schemas ──────────────────────────────────────────────────────

describe('the saved schemas', () => {
  it.each(KREA_2_IDS)('%s on fal: prompt, ratio, creativity, seed and the priced style extras; the same lists on Replicate', (id) => {
    const fal = inputOf(falSchema(id))
    expect(fal.required).toEqual(['prompt'])
    expect(Object.keys(fal.properties).sort()).toEqual(['aspect_ratio', 'creativity', 'image_style_references', 'moodboards', 'prompt', 'seed', 'styles'])
    expect(fal.properties.aspect_ratio.enum).toEqual([...KREA_2_RATIOS])
    expect(fal.properties.creativity.enum).toEqual([...KREA_2_CREATIVITY])
    expect(fal.properties.creativity.default).toBe('medium')
    const rep = repSchema(id)
    expect(inputOf(rep).required).toEqual(['prompt'])
    expect(Object.keys(inputOf(rep).properties).sort()).toEqual([
      'aspect_ratio', 'creativity', 'moodboard_id', 'moodboard_strength', 'prompt', 'seed', 'style_reference_images', 'style_reference_strength',
    ])
    expect(schemaRef(rep, 'aspect_ratio').enum).toEqual([...KREA_2_RATIOS])
    expect(schemaRef(rep, 'creativity').enum).toEqual([...KREA_2_CREATIVITY])
    // The catalogue offers exactly these ratios, and a creativity select with these values.
    const m = IMAGE_MODELS_BY_ID[id]!
    expect(m.aspectRatios).toEqual([...KREA_2_RATIOS])
    expect(m.advanced.find(a => a.name === 'creativity')).toMatchObject({ default: 'medium', options: [...KREA_2_CREATIVITY] })
  })

  it('the price text: text-to-image per picture; style pictures cost more (never sent)', () => {
    expect(falSchema('krea-2-large').pricingText).toContain('**$0.060** (text-to-image)')
    expect(falSchema('krea-2-medium').pricingText).toContain('**$0.030** (text-to-image)')
  })

  it('the prompt rules are fal\'s schema\'s own: minLength 1 (not a ruling) and maxLength 5,000', () => {
    for (const id of KREA_2_IDS) {
      const prompt = inputOf(falSchema(id)).properties.prompt
      expect(prompt.minLength).toBe(1)
      expect(prompt.maxLength).toBe(KREA_2_PROMPT_MAX)
      const key = `fal ${KREA_2_FAL_APPS[id]}`
      expect(PROMPT_MIN_LENGTH[key]).toEqual({ min: 1, message: KREA_2_NEEDS_PROMPT })
      expect(PROMPT_MIN_LENGTH_RULINGS).not.toContain(key)
      expect(PROMPT_MAX_LENGTH[key]).toEqual({ max: 5000, message: KREA_2_LONG_PROMPT })
      // Replicate sets no limit; its backup is built from a request that passed fal's.
      expect(inputOf(repSchema(id)).properties.prompt.maxLength).toBeUndefined()
    }
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

describe('settings grid: every request and its backup fit their schemas, the price reads what is sent', () => {
  const RATIOS: unknown[] = [...KREA_2_RATIOS, '3:4', '21:9', 'auto', '', 7, null, undefined]
  const SEEDS: unknown[] = [0, 42, -1, 2 ** 40, '17', 'x', undefined]
  const CREATIVITY: unknown[] = [...KREA_2_CREATIVITY, 'bogus', null, true, 3, undefined]

  it.each(KREA_2_IDS)('%s: ratio × seed × creativity', async (id) => {
    let n = 0
    for (const ar of RATIOS) for (const seed of SEEDS) for (const c of CREATIVITY) {
      const opts: Record<string, unknown> = c === undefined ? { output_format: 'png' } : { creativity: c, num_images: 1 }
      const node = gen(id, { ar, seed, opts })
      const label = JSON.stringify({ ar, seed, c })
      const p = await providerPlan(node)
      expect(p.provider, label).toBe('fal')
      expect(p.endpoint, label).toBe(KREA_2_FAL_APPS[id])
      expect(checkPayload(falSchema(id), p.payload), label).toEqual([])
      const ratio = typeof ar === 'string' && (KREA_2_RATIOS as readonly string[]).includes(ar) ? ar : '1:1'
      const creativity = typeof c === 'string' && (KREA_2_CREATIVITY as readonly string[]).includes(c) ? c : 'medium'
      const s = typeof seed === 'number' ? seed : seed === '17' ? 17 : 0
      expect(p.payload, label).toEqual({ prompt: 'a red fox in the snow', aspect_ratio: ratio, creativity, ...(s > 0 ? { seed: s } : {}) })
      // The backup: Replicate, the same fields.
      expect(p.backup, label).toEqual({ provider: 'replicate', endpoint: KREA_2_REPLICATE_SLUGS[id], payload: p.payload })
      expect(checkPayload(repSchema(id), p.backup!.payload), label).toEqual([])
      // Priced on what is sent: one picture, no style pictures, one price.
      expect(effectiveImageSettings(id, ar, node.inputs.model_options), label).toEqual({ images: 1, tier: null, megapixels: null, webSearch: false })
      expect(providerUsd('GenerateImageNode', node.inputs), label).toBeCloseTo(PRICE[id], 9)
      expect(requestProblems({ 1: node }), label).toEqual([])
      n++
    }
    expect(n).toBe(RATIOS.length * SEEDS.length * CREATIVITY.length)
  })

  it('the backup builder refuses a request it can\'t carry, rather than change it', () => {
    const ok = krea2Generate({ model: 'krea-2-medium', prompt: 'a fox', aspectRatio: '16:9', seed: 5, adv: { creativity: 'low' } })
    expect(krea2OnReplicate(ok)).toEqual({ provider: 'replicate', endpoint: 'krea/krea-2-medium', payload: { prompt: 'a fox', aspect_ratio: '16:9', creativity: 'low', seed: 5 } })
    expect(() => krea2OnReplicate({ ...ok, endpoint: 'fal-ai/recraft/v4/text-to-image' })).toThrow(/endpoint/)
    expect(() => krea2OnReplicate({ ...ok, provider: 'replicate' })).toThrow(/endpoint/)
    expect(() => krea2OnReplicate({ ...ok, payload: { ...ok.payload, aspect_ratio: '3:4' } })).toThrow(/aspect_ratio/)
    expect(() => krea2OnReplicate({ ...ok, payload: { ...ok.payload, creativity: 'wild' } })).toThrow(/creativity/)
    expect(() => krea2OnReplicate({ ...ok, payload: { ...ok.payload, seed: 1.5 } })).toThrow(/seed/)
    expect(() => krea2OnReplicate({ ...ok, payload: { ...ok.payload, image_style_references: [] } })).toThrow(/image_style_references/)
    expect(() => krea2OnReplicate({ ...ok, payload: { ...ok.payload, prompt: 7 } })).toThrow(/prompt/)
  })
})

// ── Hand-written expected payloads ─────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: fal\'s own "Full Example" (its empty style lists, the schema defaults, left out)', async () => {
    // https://fal.ai/models/krea/v2/medium/text-to-image/llms.txt (read 2026-09-25), "Full Example":
    // { prompt: "A Van Gogh-tinged Provençal farmhouse under starry nights.", aspect_ratio: "1:1",
    //   creativity: "medium", image_style_references: [], styles: [], moodboards: [] }
    const prompt = 'A Van Gogh-tinged Provençal farmhouse under starry nights.'
    for (const id of KREA_2_IDS) {
      const p = await providerPlan(gen(id, { prompt, ar: '1:1', opts: { creativity: 'medium' } }))
      expect(p.payload).toEqual({ prompt, aspect_ratio: '1:1', creativity: 'medium' })
      const props = inputOf(falSchema(id)).properties
      expect(props.prompt.examples).toEqual([prompt])
      expect(props.aspect_ratio.examples).toEqual(['1:1'])
      for (const k of ['image_style_references', 'styles', 'moodboards']) expect(props[k].default, k).toEqual([])
      expect(p.backup!.payload).toEqual({ prompt, aspect_ratio: '1:1', creativity: 'medium' })
    }
  })

  it('every setting there is: a wide ratio, raw creativity and a seed', async () => {
    const p = await providerPlan(gen('krea-2-large', { prompt: 'a chrome teapot', ar: '2.35:1', seed: 1234, opts: { creativity: 'raw' } }))
    expect(p.endpoint).toBe('krea/v2/large/text-to-image')
    expect(p.payload).toEqual({ prompt: 'a chrome teapot', aspect_ratio: '2.35:1', creativity: 'raw', seed: 1234 })
    expect(p.backup).toEqual({ provider: 'replicate', endpoint: 'krea/krea-2-large', payload: { prompt: 'a chrome teapot', aspect_ratio: '2.35:1', creativity: 'raw', seed: 1234 } })
  })

  it('a linked picture\'s place (a moodboard): style text joins the prompt, the pictures are not sent (as Python)', async () => {
    const node = gen('krea-2-medium', { prompt: 'a label', ar: '4:5' })
    node.inputs.style_block = 'ink wash'
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png', 'b.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'ink wash a label', aspect_ratio: '4:5', creativity: 'medium' })
    expect(p.backup!.payload).toEqual(p.payload)
  })

  it('the same request as the ComfyUI path (Python _fal_krea2 and _b_krea2, recorded from .venv/bin/python)', async () => {
    // _fal_krea2(prompt, ar, seed, adv) and _b_krea2(...) returned the same dict for each case, 2026-09-25.
    const recorded: { args: [string, string, number, Record<string, unknown>], out: Record<string, unknown> }[] = [
      { args: ['a fox', '1:1', 0, {}], out: { prompt: 'a fox', aspect_ratio: '1:1', creativity: 'medium' } },
      { args: ['a fox', '21:9', 42, { creativity: 'raw' }], out: { prompt: 'a fox', aspect_ratio: '1:1', creativity: 'raw', seed: 42 } },
      { args: ['a fox', '2.35:1', -1, { creativity: 'bogus' }], out: { prompt: 'a fox', aspect_ratio: '2.35:1', creativity: 'medium' } },
      { args: ['a fox', '9:16', 7, { creativity: null }], out: { prompt: 'a fox', aspect_ratio: '9:16', creativity: 'medium', seed: 7 } },
      { args: ['x', '4:5', 3, { creativity: 'high', output_format: 'png' }], out: { prompt: 'x', aspect_ratio: '4:5', creativity: 'high', seed: 3 } },
    ]
    for (const { args: [prompt, ar, seed, opts], out } of recorded) {
      for (const id of KREA_2_IDS) {
        const p = await providerPlan(gen(id, { prompt, ar, seed, opts }))
        expect(p.payload, JSON.stringify(args(prompt, ar, seed, opts))).toEqual(out)
        expect(p.backup!.payload).toEqual(out)
      }
    }
    function args(...a: unknown[]) { return a }
  })

  it('the routes table: fal first, Replicate the backup', () => {
    for (const id of KREA_2_IDS) {
      expect(RUNNER_ROUTES[`image:${id}`], id).toEqual({ first: 'fal', backup: 'replicate' })
      // The generic backups table is for Replicate-first models; this one builds its own.
      expect(IMAGE_BACKUPS[id], id).toBeUndefined()
    }
  })
})

// ── The prompt: not empty (the schema's minLength), at most 5,000 characters ──

describe('the prompt is refused up front on a runner run, in plain words', () => {
  const refusal = (message: string) => [{ nodeId: '1', classType: 'GenerateImageNode', input: 'prompt', message }]

  it('the words name the model, say what to do, and carry no ids', () => {
    expect(KREA_2_NEEDS_PROMPT).toBe('Krea 2 needs a prompt. Describe the picture you want.')
    expect(KREA_2_LONG_PROMPT).toBe('Krea 2 takes a prompt of at most 5,000 characters. Shorten it.')
    for (const s of [KREA_2_NEEDS_PROMPT, KREA_2_LONG_PROMPT]) expect(s).not.toMatch(/_|krea-|krea\//)
  })

  it('on a runner run, before the hold: empty, missing, or over 5,000 characters as sent (code points)', () => {
    const runner = { runner: true } as const
    for (const id of KREA_2_IDS) {
      expect(requestProblems({ 1: gen(id, { prompt: '' }) }, runner), id).toEqual(refusal(KREA_2_NEEDS_PROMPT))
      const missing = gen(id)
      delete missing.inputs.prompt
      expect(requestProblems({ 1: missing }, runner), id).toEqual(refusal(KREA_2_NEEDS_PROMPT))
      expect(requestProblems({ 1: gen(id, { prompt: 'a'.repeat(5000) }) }, runner), id).toEqual([])
      expect(requestProblems({ 1: gen(id, { prompt: '🦊'.repeat(5000) }) }, runner), id).toEqual([])
      expect(requestProblems({ 1: gen(id, { prompt: 'a'.repeat(5001) }) }, runner), id).toEqual(refusal(KREA_2_LONG_PROMPT))
      const styled = gen(id, { prompt: 'a'.repeat(4995) })
      styled.inputs.style_block = 'ink wash'
      expect(requestProblems({ 1: styled }, runner), id).toEqual(refusal(KREA_2_LONG_PROMPT))
      for (const wired of ['prompt', 'prompt_in', 'style_block', 'style_in']) {
        const node = gen(id, { prompt: '' })
        node.inputs[wired] = LINK
        expect(requestProblems({ 1: node }, runner), wired).toEqual([])
      }
    }
  })

  it('the ComfyUI path is not judged: it sends what it sent before (Python falls over to Replicate, which sets no limit)', () => {
    for (const id of KREA_2_IDS) {
      for (const prompt of ['', 'a'.repeat(5001)]) {
        expect(requestProblems({ 1: gen(id, { prompt }) }), id).toEqual([])
        expect(requestRefusal({ 1: gen(id, { prompt }) }), id).toBeNull()
      }
    }
  })

  it('at planning: the runner refuses both', async () => {
    for (const id of KREA_2_IDS) {
      await expect(plan(gen(id, { prompt: '' }))).rejects.toThrow(KREA_2_NEEDS_PROMPT)
      await expect(plan(gen(id, { prompt: 'a'.repeat(5001) }))).rejects.toThrow(KREA_2_LONG_PROMPT)
      expect(requestProblem('fal', KREA_2_FAL_APPS[id], { prompt: 'a'.repeat(5000) })).toBeNull()
      expect(requestProblem('fal', KREA_2_FAL_APPS[id], { prompt: 'a'.repeat(5001) })).toBe(KREA_2_LONG_PROMPT)
    }
  })
})

// ── Eligibility ────────────────────────────────────────────────────────────

describe('eligibility follows the family switch', () => {
  it('the row names the family; neither id is on the fal or Replicate lists the runner takes without one', () => {
    for (const id of KREA_2_IDS) {
      expect(RUNNER_NODE_RULES.GenerateImageNode!.models![id], id).toBe(FAMILY)
      expect((RUNNER_IMAGE_MODEL_IDS as readonly string[]).includes(id), id).toBe(false)
      expect((RUNNER_REPLICATE_IMAGE_MODEL_IDS as readonly string[]).includes(id), id).toBe(false)
    }
  })

  it.each(KREA_2_IDS)('%s off (no families, or every other family): not taken, so it goes to ComfyUI as before', (id) => {
    const p: ApiPrompt = { 1: gen(id) }
    expect(isRunnerEligible(p)).toBe(false)
    expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(p, ALL_BUT)).toBe(false)
  })

  it.each(KREA_2_IDS)('%s on: taken; never with the prompt, options, style or Idea wired, nor asking for several pictures', (id) => {
    const p: ApiPrompt = { 1: gen(id) }
    expect(isRunnerEligible(p, ON)).toBe(true)
    expect(isRunnerEligible(p, ALL)).toBe(true)
    for (const wired of ['prompt', 'model_options', 'style_in', 'prompt_in', 'style_block']) {
      const n = gen(id)
      n.inputs[wired] = LINK
      expect(isRunnerEligible({ 9: { class_type: 'Image', inputs: { image: 'a.png' } }, 1: n }, ON), wired).toBe(false)
    }
    expect(isRunnerEligible({ 1: gen(id, { opts: { num_outputs: 2 } }) }, ON)).toBe(false)
  })
})

describe('blockedModelUses: never refused (it has an engine builder)', () => {
  it.each(KREA_2_IDS)('%s: on either path, with the family on or off', (id) => {
    for (const families of [NO_FAMILIES, ON, ALL, ALL_BUT]) {
      expect(blockedModelUses({ 1: gen(id) }, { families })).toEqual([])
      expect(blockedModelUses({ 1: gen(id) }, { families, runnerTakes: true })).toEqual([])
    }
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery', () => {
  afterEach(() => __resetModelMenusForTests())

  it('the catalogue entries are as before: not runner-only, no family, brand Krea', () => {
    for (const id of KREA_2_IDS) {
      const m = IMAGE_MODELS_BY_ID[id]!
      expect(m.runnerOnly, id).toBeUndefined()
      expect(m.family, id).toBeUndefined()
      expect(m.hidden, id).toBeUndefined()
      expect(m).toMatchObject({ brand: 'Krea', replicateSlug: KREA_2_REPLICATE_SLUGS[id], pricePerImage: PRICE[id], defaultAspectRatio: '1:1' })
    }
  })

  it('shown in "Generate an image" with the family on or off', () => {
    const shown = (f: ReadonlySet<RunnerFamily>) => galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: f, current: null }).map(e => e.model.id)
    for (const f of [NO_FAMILIES, ON, ALL_BUT, ALL]) {
      for (const id of KREA_2_IDS) expect(shown(f), id).toContain(id)
    }
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  const charge = (inputs: Record<string, unknown>, families?: ReadonlySet<RunnerFamily>) =>
    priceGraph({ 1: { class_type: 'GenerateImageNode', inputs }, 2: SINK }, families ? { families } : undefined).credits

  it('the cards: fal first (P3\'s, unchanged), Replicate the backup at the same price, all verified; no price moved', () => {
    expect(IMAGE_RATES['krea-2-large']).toEqual({
      unit: 'per_image', usd: 0.06, service: 'fal', source: 'https://fal.ai/models/krea/v2/large/text-to-image/llms.txt', read: '2026-09-24', confidence: 'verified',
    })
    expect(IMAGE_RATES['krea-2-medium']).toEqual({
      unit: 'per_image', usd: 0.03, service: 'fal', source: 'https://fal.ai/models/krea/v2/medium/text-to-image/llms.txt', read: '2026-09-24', confidence: 'verified',
    })
    for (const id of KREA_2_IDS) {
      expect(IMAGE_BACKUP_RATES[id], id).toEqual({
        unit: 'per_image', usd: PRICE[id], service: 'replicate', source: `https://replicate.com/${KREA_2_REPLICATE_SLUGS[id]}`, read: '2026-09-25', confidence: 'verified',
      })
    }
    // Adding the backup cards moves no price, so the book's version stays F16's.
    expect(PRICE_BOOK_VERSION).toBe('lineup-f21')
  })

  it('the basis: fal\'s price, since the backup covered at cost is less; one price covers either service and either path', () => {
    for (const id of KREA_2_IDS) {
      expect(usdChargedAtCost(PRICE[id])).toBeLessThan(PRICE[id])
      expect(imagePriceUsd(id, effectiveImageSettings(id, '1:1', '{}'))).toBe(PRICE[id])
      expect(imagePriceMaxUsd(id)).toBeCloseTo(PRICE[id], 9)
    }
    expect(creditsForUsd(0.06)).toBe(12)
    expect(creditsForUsd(0.03)).toBe(6)
  })

  const examples: { name: string, id: Krea2Id, inputs: Record<string, unknown> }[] = [
    { name: 'medium at its defaults, 1:1 (the live check)', id: 'krea-2-medium', inputs: gen('krea-2-medium', { ar: '1:1' }).inputs },
    { name: 'large, every setting', id: 'krea-2-large', inputs: gen('krea-2-large', { ar: '2.35:1', seed: 9, opts: { creativity: 'high' } }).inputs },
    { name: 'linked options', id: 'krea-2-large', inputs: { ...gen('krea-2-large').inputs, model_options: ['7', 0] } },
    { name: 'a linked ratio', id: 'krea-2-medium', inputs: { ...gen('krea-2-medium').inputs, aspect_ratio: ['7', 0] } },
  ]
  for (const ex of examples) {
    it(`${ex.name}: badge = charge = run estimate, the same with the family on or off`, () => {
      expect(providerUsd('GenerateImageNode', ex.inputs)).toBeCloseTo(PRICE[ex.id], 9)
      const credits = creditsForUsd(PRICE[ex.id])
      expect(credits).toBeGreaterThan(0)
      expect(nodeCredits('GenerateImageNode', ex.inputs)).toBe(credits)
      for (const families of [undefined, NO_FAMILIES, ON, ALL]) {
        expect(nodeCredits('GenerateImageNode', ex.inputs, families ? { families } : {})).toBe(credits)
        expect(charge(ex.inputs, families)).toBe(credits + 1) // + base render
      }
      expect(nodeCreditEstimate('GenerateImageNode', ex.inputs)).toBe(credits + 1)
      const names = Object.keys(ex.inputs)
      const est = estimateUsdForNodes([{ id: '1', type: 'GenerateImageNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]) }], { hosted: true })!
      expect(est.hostedCredits).toBe(credits + 1)
    })
  }
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take = (prompt = 'a red fox in the snow'): ApiPrompt => ({
    1: gen('krea-2-medium', { prompt, ar: '1:1' }), 2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  })
  const start = (k: ReturnType<typeof makeKit>, prompt?: string) =>
    k.engine.startRun({ userId: k.userId, takes: [take(prompt)], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: fal\'s krea/v2/medium/text-to-image, held at the node\'s price, a real output; Replicate untouched', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual(['krea/v2/medium/text-to-image'])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a red fox in the snow', aspect_ratio: '1:1', creativity: 'medium' })
    expect(k.replicate.reqs.size).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([creditsForUsd(0.03) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: the runner does not take it (the browser sends it to ComfyUI), nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT } })
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })

  it('an empty prompt, or one too long, with the family on: refused, nothing held or sent', async () => {
    for (const prompt of ['', 'a'.repeat(5001)]) {
      const k = makeKit({ hosted: true, deps: { families: () => ON } })
      await expect(start(k, prompt), JSON.stringify(prompt.length)).rejects.toThrow()
      expect(k.fal.reqs.size).toBe(0)
      expect(k.ledger.holds.size).toBe(0)
    }
  })
})

/**
 * Task F16 (model line-up): Recraft V4.1, runner-only, family `recraft-v4.1`
 * (server/runner/generators/recraftV41.ts): "Generate an image" on fal's
 * fal-ai/recraft/v4.1/text-to-image, Replicate's recraft-ai/recraft-v4.1 the
 * backup.
 *
 * The family contract:
 *  - every payload over the settings grid fits the saved schema, and so does
 *    its backup; the price reads what is sent (one flat price per picture on
 *    both services);
 *  - fal is sent only the named sizes its schema lists;
 *  - hand-written expected payloads: plain (fal's own "Full Example"),
 *    every setting there is, and a moodboard picture linked (not sent: this
 *    endpoint takes no picture);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off;
 *  - the price is verified and non-zero, and badge = charge;
 *  - an empty prompt (the schema's minLength 1) and one over the schema's
 *    10,000 characters are refused up front;
 *  - the engine, end to end: the family's own endpoint, and the hold;
 *  - the older Recraft models are untouched, and no SVG model is added (D4).
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, RUNNER_REPLICATE_IMAGE_MODEL_IDS, isRunnerEligible } from '#shared/runner/eligibility'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { __resetModelMenusForTests, galleryEntries, menuDefault, modelMenu } from '#shared/runner/modelMenus'
import { creditsForUsd, usdChargedAtCost } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { IMAGE_BACKUP_RATES, IMAGE_RATES, imagePriceMaxUsd, imagePriceUsd, imageRateLabel } from '#shared/pricing/imageRates'
import { effectiveImageSettings } from '#shared/pricing/imageSettings'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID, IMAGE_MODEL_PREFERENCE } from '~~/app/data/image-models'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import {
  RECRAFT_V41_FAL_APP, RECRAFT_V41_LONG_PROMPT, RECRAFT_V41_NEEDS_PROMPT, RECRAFT_V41_PROMPT_MAX, RECRAFT_V41_RATIOS,
  RECRAFT_V41_REPLICATE_SLUG, RECRAFT_V41_SIZES, recraftV41Generate, recraftV41OnReplicate,
} from '~~/server/runner/generators/recraftV41'
import {
  PROMPT_MAX_LENGTH, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, requestProblem, requestProblems,
} from '~~/server/runner/requestRules'
import { IMAGE_BACKUPS, RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'recraft-v4.1'
const FAMILY: RunnerFamily = 'recraft-v4.1'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
const PRICE = 0.035
const BACKUP_PRICE = 0.04

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

const falSchema = () => {
  const f = loadProviderSchema('fal', RECRAFT_V41_FAL_APP)
  expect(f.endpoint).toBe(RECRAFT_V41_FAL_APP)
  return f
}
const repSchema = () => {
  const f = loadProviderSchema('replicate', RECRAFT_V41_REPLICATE_SLUG)
  expect(f.endpoint).toBe(RECRAFT_V41_REPLICATE_SLUG)
  return f
}
/** A saved schema's input object (its $ref followed). */
function inputOf(f: ReturnType<typeof loadProviderSchema>): Record<string, any> {
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}
const schemaRef = (f: ReturnType<typeof loadProviderSchema>, name: string) => f.components.schemas[name] as Record<string, any>
/** fal's named sizes: the string branch of `image_size`. */
function falSizeNames(): string[] {
  const branches = inputOf(falSchema()).properties.image_size.anyOf as Record<string, any>[]
  return branches.find(b => b.type === 'string')!.enum
}

/** A "Generate an image" node on Recraft V4.1. */
function gen(o: { prompt?: string, ar?: unknown, seed?: unknown, opts?: Record<string, unknown> } = {}) {
  const inputs: Record<string, unknown> = {
    model: ID, prompt: o.prompt ?? 'a poster that says HELLO', seed: o.seed ?? 0, model_options: JSON.stringify(o.opts ?? {}),
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
  it('fal\'s fal-ai/recraft/v4.1/text-to-image: prompt, size, colours, background, safety; no seed, no format, no picture', () => {
    const props = inputOf(falSchema()).properties
    expect(inputOf(falSchema()).required).toEqual(['prompt'])
    expect(Object.keys(props).sort()).toEqual(['background_color', 'colors', 'enable_safety_checker', 'image_size', 'prompt'])
    // The named sizes fal lists; the catalogue's ratios map onto them, and nothing else is sent.
    expect(falSizeNames()).toEqual(['square_hd', 'square', 'portrait_4_3', 'portrait_16_9', 'landscape_4_3', 'landscape_16_9'])
    for (const r of RECRAFT_V41_RATIOS) expect(falSizeNames(), r).toContain(RECRAFT_V41_SIZES[r])
    expect(IMAGE_MODELS_BY_ID[ID]!.aspectRatios).toEqual([...RECRAFT_V41_RATIOS])
    // The price text: one flat price a picture.
    expect(falSchema().pricingText).toContain('$0.035 per images')
  })

  it('Replicate\'s recraft-ai/recraft-v4.1: prompt, ratio, size; every catalogue ratio is in its enum', () => {
    const f = repSchema()
    const props = inputOf(f).properties
    expect(inputOf(f).required).toEqual(['prompt'])
    expect(Object.keys(props).sort()).toEqual(['aspect_ratio', 'prompt', 'size'])
    const ratios = schemaRef(f, 'aspect_ratio').enum as string[]
    for (const r of RECRAFT_V41_RATIOS) expect(ratios, r).toContain(r)
    // "Size is ignored if an aspect ratio is set": the backup sends the ratio only.
    expect(props.size.description).toContain('ignored if an aspect ratio is set')
  })

  it('the prompt rules are fal\'s schema\'s own: minLength 1 (not a ruling) and maxLength 10,000', () => {
    const prompt = inputOf(falSchema()).properties.prompt
    expect(prompt.minLength).toBe(1)
    expect(prompt.maxLength).toBe(RECRAFT_V41_PROMPT_MAX)
    expect(RECRAFT_V41_PROMPT_MAX).toBe(10000)
    expect(PROMPT_MIN_LENGTH[`fal ${RECRAFT_V41_FAL_APP}`]).toEqual({ min: 1, message: RECRAFT_V41_NEEDS_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).not.toContain(`fal ${RECRAFT_V41_FAL_APP}`)
    expect(PROMPT_MAX_LENGTH[`fal ${RECRAFT_V41_FAL_APP}`]).toEqual({ max: 10000, message: RECRAFT_V41_LONG_PROMPT })
    // Replicate says the same limit in words only ("up to 10,000 characters").
    expect(inputOf(repSchema()).properties.prompt.description).toContain('10,000')
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

describe('settings grid: every request and its backup fit their schemas, the price reads what is sent', () => {
  const RATIOS: unknown[] = [...RECRAFT_V41_RATIOS, '3:2', '2:1', '21:9', 'auto', '', 7, null, undefined]
  const SEEDS: unknown[] = [0, 42, -1, 'x', undefined]
  const OPTS: Record<string, unknown>[] = [{}, { output_format: 'png' }, { colors: ['#ff0000'] }, { style: 'any' }]

  it('ratio × seed × stray options', async () => {
    let n = 0
    const want = providerUsd('GenerateImageNode', gen().inputs)
    for (const ar of RATIOS) for (const seed of SEEDS) for (const opts of OPTS) {
      const node = gen({ ar, seed, opts })
      const label = JSON.stringify({ ar, seed, opts })
      const p = await providerPlan(node)
      expect(p.provider, label).toBe('fal')
      expect(p.endpoint, label).toBe(RECRAFT_V41_FAL_APP)
      expect(checkPayload(falSchema(), p.payload), label).toEqual([])
      // Exactly these fields, and a size fal lists by name.
      expect(Object.keys(p.payload).sort(), label).toEqual(['image_size', 'prompt'])
      const ratio = typeof ar === 'string' && (RECRAFT_V41_RATIOS as string[]).includes(ar) ? ar as keyof typeof RECRAFT_V41_SIZES : '1:1'
      expect(p.payload.image_size, label).toBe(RECRAFT_V41_SIZES[ratio])
      expect(falSizeNames(), label).toContain(p.payload.image_size)
      // The backup: Replicate, the same prompt and ratio.
      expect(p.backup, label).toEqual({ provider: 'replicate', endpoint: RECRAFT_V41_REPLICATE_SLUG, payload: { prompt: p.payload.prompt, aspect_ratio: ratio } })
      expect(checkPayload(repSchema(), p.backup!.payload), label).toEqual([])
      // Priced on what is sent: one picture, the same price whatever the settings.
      expect(effectiveImageSettings(ID, ar, node.inputs.model_options), label).toMatchObject({ images: 1, tier: null, megapixels: null, webSearch: false })
      expect(providerUsd('GenerateImageNode', node.inputs), label).toBe(want)
      expect(requestProblems({ 1: node }), label).toEqual([])
      n++
    }
    expect(n).toBe(RATIOS.length * SEEDS.length * OPTS.length)
  })

  it('moodboard pictures and style text: the text joins the prompt, the pictures are not sent', async () => {
    const node = gen({ prompt: 'a fox' })
    node.inputs.style_block = 'ink wash'
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'ink wash a fox', image_size: 'square_hd' })
    expect(p.backup!.payload).toEqual({ prompt: 'ink wash a fox', aspect_ratio: '1:1' })
  })

  it('the backup builder refuses a request it can\'t carry, rather than change it', () => {
    const ok = recraftV41Generate({ prompt: 'a fox', aspectRatio: '16:9' })
    expect(recraftV41OnReplicate(ok).payload).toEqual({ prompt: 'a fox', aspect_ratio: '16:9' })
    expect(() => recraftV41OnReplicate({ ...ok, endpoint: 'fal-ai/recraft/v4/text-to-image' })).toThrow(/endpoint/)
    expect(() => recraftV41OnReplicate({ ...ok, payload: { ...ok.payload, image_size: 'square' } })).toThrow(/image_size/)
    expect(() => recraftV41OnReplicate({ ...ok, payload: { ...ok.payload, image_size: { width: 1024, height: 1024 } } })).toThrow(/image_size/)
    expect(() => recraftV41OnReplicate({ ...ok, payload: { ...ok.payload, colors: [] } })).toThrow(/colors/)
    expect(() => recraftV41OnReplicate({ ...ok, payload: { ...ok.payload, prompt: 7 } })).toThrow(/prompt/)
  })
})

// ── Hand-written expected payloads ─────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: fal\'s own "Full Example" (its schema defaults left out)', async () => {
    // https://fal.ai/models/fal-ai/recraft/v4.1/text-to-image/llms.txt (read 2026-09-24), "Full Example":
    // { prompt: "Tilt-shift miniature effect …", image_size: "landscape_16_9", colors: [], enable_safety_checker: true }
    // colors [] and enable_safety_checker true are the schema's defaults, so not sent.
    const prompt = 'Tilt-shift miniature effect on a real Portuguese fishing village at golden hour, colorful boats in the harbor appearing toy-like, selective focus band across the middle, saturated primary colors of blue red and yellow boats against white buildings, 90mm tilt-shift lens, the familiar made fantastical, Wes Anderson color sensibility'
    const p = await providerPlan(gen({ prompt, ar: '16:9' }))
    expect(p.endpoint).toBe('fal-ai/recraft/v4.1/text-to-image')
    expect(p.payload).toEqual({ prompt, image_size: 'landscape_16_9' })
    const props = inputOf(falSchema()).properties
    expect(props.prompt.examples).toEqual([prompt])
    expect(props.image_size.examples).toEqual(['landscape_16_9'])
    expect(props.colors.default).toEqual([])
    expect(props.enable_safety_checker.default).toBe(true)
    expect(p.backup!.payload).toEqual({ prompt, aspect_ratio: '16:9' })
  })

  it('every setting there is: a tall ratio and a seed (not sent: neither service takes one)', async () => {
    const p = await providerPlan(gen({ prompt: 'a festival poster', ar: '9:16', seed: 1234 }))
    expect(p.payload).toEqual({ prompt: 'a festival poster', image_size: 'portrait_16_9' })
    expect(p.backup).toEqual({ provider: 'replicate', endpoint: 'recraft-ai/recraft-v4.1', payload: { prompt: 'a festival poster', aspect_ratio: '9:16' } })
    expect(checkPayload(falSchema(), p.payload)).toEqual([])
    expect(checkPayload(repSchema(), p.backup!.payload)).toEqual([])
  })

  it('a linked picture\'s place (a moodboard): this endpoint takes no picture, so none is sent', async () => {
    const node = gen({ prompt: 'a label', ar: '3:4' })
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png', 'b.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'a label', image_size: 'portrait_4_3' })
    expect(p.backup!.payload).toEqual({ prompt: 'a label', aspect_ratio: '3:4' })
  })

  it('the routes table: fal first, Replicate the backup', () => {
    expect(RUNNER_ROUTES[`image:${ID}`]).toEqual({ first: 'fal', backup: 'replicate' })
    // The generic backups table is for Replicate-first models; this one builds its own.
    expect(IMAGE_BACKUPS[ID]).toBeUndefined()
  })
})

// ── The prompt: not empty (the schema's minLength), at most 10,000 characters ──

describe('the prompt is refused up front, in plain words', () => {
  const refusal = (message: string) => [{ nodeId: '1', classType: 'GenerateImageNode', input: 'prompt', message }]

  it('the words name the model, say what to do, and carry no ids', () => {
    expect(RECRAFT_V41_NEEDS_PROMPT).toBe('Recraft V4.1 needs a prompt. Describe the picture you want.')
    expect(RECRAFT_V41_LONG_PROMPT).toBe('Recraft V4.1 takes a prompt of at most 10,000 characters. Shorten it.')
    for (const s of [RECRAFT_V41_NEEDS_PROMPT, RECRAFT_V41_LONG_PROMPT]) expect(s).not.toMatch(/_|recraft-|recraft\//)
  })

  it('before the hold: an empty prompt, or one that is missing', () => {
    expect(requestProblems({ 1: gen({ prompt: '' }) })).toEqual(refusal(RECRAFT_V41_NEEDS_PROMPT))
    const missing = gen()
    delete missing.inputs.prompt
    expect(requestProblems({ 1: missing })).toEqual(refusal(RECRAFT_V41_NEEDS_PROMPT))
  })

  it('before the hold: over 10,000 characters as sent (style text included), counted as code points', () => {
    expect(requestProblems({ 1: gen({ prompt: 'a'.repeat(10000) }) })).toEqual([])
    expect(requestProblems({ 1: gen({ prompt: 'a'.repeat(10001) }) })).toEqual(refusal(RECRAFT_V41_LONG_PROMPT))
    expect(requestProblems({ 1: gen({ prompt: '🦊'.repeat(10000) }) })).toEqual([])
    const styled = gen({ prompt: 'a'.repeat(9995) })
    styled.inputs.style_block = 'ink wash'
    expect(requestProblems({ 1: styled })).toEqual(refusal(RECRAFT_V41_LONG_PROMPT))
  })

  it('at planning: the runner refuses both', async () => {
    await expect(plan(gen({ prompt: '' }))).rejects.toThrow(RECRAFT_V41_NEEDS_PROMPT)
    await expect(plan(gen({ prompt: 'a'.repeat(10001) }))).rejects.toThrow(RECRAFT_V41_LONG_PROMPT)
    expect(requestProblem('fal', RECRAFT_V41_FAL_APP, { prompt: 'a'.repeat(10000) })).toBeNull()
    expect(requestProblem('fal', RECRAFT_V41_FAL_APP, { prompt: 'a'.repeat(10001) })).toBe(RECRAFT_V41_LONG_PROMPT)
  })

  it('style text alone is a prompt; a wired prompt part isn\'t judged before the run', () => {
    const styled = gen({ prompt: '' })
    styled.inputs.style_block = 'ink wash'
    expect(requestProblems({ 1: styled })).toEqual([])
    for (const wired of ['prompt', 'prompt_in', 'style_block', 'style_in']) {
      for (const prompt of ['', 'a'.repeat(10001)]) {
        const node = gen({ prompt })
        node.inputs[wired] = LINK
        expect(requestProblems({ 1: node }), wired).toEqual([])
      }
    }
  })
})

// ── Eligibility ────────────────────────────────────────────────────────────

describe('eligibility follows the family switch', () => {
  const p: ApiPrompt = { 1: gen() }

  it('the row names the family', () => {
    expect(RUNNER_NODE_RULES.GenerateImageNode!.models![ID]).toBe(FAMILY)
  })

  it('off (no families, or every other family): not taken', () => {
    expect(isRunnerEligible(p)).toBe(false)
    expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(p, ALL_BUT)).toBe(false)
  })

  it('on: taken; never with the prompt, options, style or Idea wired', () => {
    expect(isRunnerEligible(p, ON)).toBe(true)
    expect(isRunnerEligible(p, ALL)).toBe(true)
    for (const wired of ['prompt', 'model_options', 'style_in', 'prompt_in', 'style_block']) {
      const n = gen()
      n.inputs[wired] = LINK
      expect(isRunnerEligible({ 9: { class_type: 'Image', inputs: { image: 'a.png' } }, 1: n }, ON), wired).toBe(false)
    }
  })
})

describe('blockedModelUses', () => {
  const use = { nodeId: '1', classType: 'GenerateImageNode', value: ID, reason: 'runner-only' }

  it('refuses the model while the family is off, on either path', () => {
    expect(blockedModelUses({ 1: gen() })).toEqual([use])
    expect(blockedModelUses({ 1: gen() }, { families: ALL_BUT, runnerTakes: true })).toEqual([use])
  })

  it('lets it through only on a runner run with the family on; the ComfyUI path refuses it', () => {
    expect(blockedModelUses({ 1: gen() }, { families: ON, runnerTakes: true })).toEqual([])
    expect(blockedModelUses({ 1: gen() }, { families: ON })).toEqual([use])
  })

  it('a workflow that needs the engine is refused before it goes there, naming the model', () => {
    const p: ApiPrompt = { 1: gen(), 2: { class_type: 'KSampler', inputs: {} } }
    const titles: Record<string, string> = { 1: 'Poster', 2: 'Old sampler' }
    const r = blockedRunRefusal([{ prompt: p, titleOf: id => titles[id] ?? 'Unnamed node' }], { runnerOn: true, families: ON })
    expect(r).not.toBeNull()
    expect(`${r!.title} ${r!.description}`).toContain('Recraft V4.1')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: gen() }, titleOf: () => 'Poster' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family recraft-v4.1, with its brand name and plain words, no settings', () => {
    const m = IMAGE_MODELS_BY_ID[ID]!
    expect(m).toMatchObject({ runnerOnly: true, family: FAMILY, label: 'Recraft V4.1', brand: 'Recraft', replicateSlug: 'recraft-ai/recraft-v4.1', defaultAspectRatio: '1:1', pricePerImage: PRICE })
    expect(m.hidden).toBeUndefined()
    expect(m.advanced).toEqual([])
    expect(m.tags).not.toContain('svg')
    for (const s of [m.label, m.pitch, m.description ?? '']) {
      expect(s).not.toMatch(/_|recraft-|recraft\//)
    }
  })

  it('hidden from "Generate an image" while the family is off, shown while on; a saved node still shows it, tagged', () => {
    const shown = (f: ReadonlySet<RunnerFamily>) => galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: f, current: null }).map(e => e.model.id)
    expect(shown(NO_FAMILIES)).not.toContain(ID)
    expect(shown(ALL_BUT)).not.toContain(ID)
    expect(shown(ON)).toContain(ID)
    const saved = galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: NO_FAMILIES, current: ID })
    expect(saved.find(e => e.model.id === ID)).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
  })

  it('a new node\'s default does not move to it', () => {
    expect(IMAGE_MODEL_PREFERENCE).not.toContain(ID)
    expect(menuDefault(modelMenu('GenerateImageNode')!, ALL)).toBe(IMAGE_MODEL_PREFERENCE[0])
  })
})

// ── The older Recraft models stay as they are; no SVG model (D4) ───────────

describe('the older Recraft models are untouched', () => {
  it('V4 and V4 Pro: Replicate first, fal behind, as before; the SVG ones not in the runner', () => {
    expect(RUNNER_ROUTES['image:recraft-v4']).toEqual({ first: 'replicate', backup: 'fal' })
    expect(RUNNER_ROUTES['image:recraft-v4-pro']).toEqual({ first: 'replicate', backup: 'fal' })
    for (const id of ['recraft-v4', 'recraft-v4-pro', 'recraft-v4-svg', 'recraft-v4-pro-svg', 'recraft-v3', 'recraft-v3-svg']) {
      const m = IMAGE_MODELS_BY_ID[id]!
      expect(m.runnerOnly, id).toBeUndefined()
      expect(m.family, id).toBeUndefined()
    }
    for (const id of ['recraft-v4-svg', 'recraft-v4-pro-svg', 'recraft-v3-svg']) {
      expect(RUNNER_REPLICATE_IMAGE_MODEL_IDS, id).not.toContain(id)
      expect(RUNNER_ROUTES[`image:${id}`], id).toBeUndefined()
    }
  })

  it('no Recraft V4.1 vector model is added: the runner would hand an SVG to nodes that take PNG, JPEG or WebP', () => {
    expect(IMAGE_MODELS.filter(m => m.id.startsWith('recraft-v4.1')).map(m => m.id)).toEqual([ID])
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateImageNode', inputs }, 2: SINK }).credits

  it('the cards: fal\'s flat $0.035 an image first, Replicate\'s $0.04 the backup, both verified; the book carries them (lineup-f16, now lineup-g1)', () => {
    expect(IMAGE_RATES[ID]).toEqual({
      unit: 'per_image', usd: PRICE, service: 'fal', source: 'https://fal.ai/models/fal-ai/recraft/v4.1/text-to-image/llms.txt', read: '2026-09-24', confidence: 'verified',
    })
    expect(IMAGE_BACKUP_RATES[ID]).toEqual({
      unit: 'per_image', usd: BACKUP_PRICE, service: 'replicate', source: 'https://replicate.com/recraft-ai/recraft-v4.1', read: '2026-09-24', confidence: 'verified',
    })
    expect(PRICE_BOOK_VERSION).toBe('r3-turntable')
  })

  it('the basis: fal\'s price, since the backup covered at cost is less ($0.02)', () => {
    expect(usdChargedAtCost(BACKUP_PRICE)).toBeLessThan(PRICE)
    expect(imagePriceUsd(ID, effectiveImageSettings(ID, '1:1', '{}'))).toBe(Math.max(PRICE, usdChargedAtCost(BACKUP_PRICE)))
    // Charged 7 credits ($0.07): a job the backup serves ($0.04) is still covered.
    expect(creditsForUsd(PRICE)).toBe(7)
    expect(creditsForUsd(PRICE) / 100).toBeGreaterThanOrEqual(BACKUP_PRICE)
  })

  const examples: { name: string, inputs: Record<string, unknown> }[] = [
    { name: 'at its defaults, 1:1 (the live check)', inputs: gen({ ar: '1:1' }).inputs },
    { name: 'a wide ratio', inputs: gen({ ar: '16:9' }).inputs },
    { name: 'linked options', inputs: { ...gen().inputs, model_options: ['7', 0] } },
    { name: 'a linked ratio', inputs: { ...gen().inputs, aspect_ratio: ['7', 0] } },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $0.035; badge = charge = run estimate`, () => {
      expect(providerUsd('GenerateImageNode', ex.inputs)).toBeCloseTo(PRICE, 9)
      const credits = creditsForUsd(PRICE)
      expect(credits).toBeGreaterThan(0)
      expect(nodeCredits('GenerateImageNode', ex.inputs)).toBe(credits)
      const c = charge(ex.inputs)
      expect(c).toBe(credits + 1) // + base render
      expect(nodeCreditEstimate('GenerateImageNode', ex.inputs)).toBe(c)
      const names = Object.keys(ex.inputs)
      const est = estimateUsdForNodes([{ id: '1', type: 'GenerateImageNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]) }], { hosted: true })!
      expect(est.hostedCredits).toBe(c)
    })
  }

  it('the dearest it can be is the same flat price; the gallery labels', () => {
    expect(imagePriceMaxUsd(ID)).toBeCloseTo(PRICE, 9)
    expect(imageRateLabel(ID, '1:1', { hosted: true })).toBe(`${creditsForUsd(PRICE)} credits`)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take = (prompt = 'a poster that says HELLO'): ApiPrompt => ({
    1: gen({ prompt, ar: '1:1' }), 2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  })
  const start = (k: ReturnType<typeof makeKit>, prompt?: string) =>
    k.engine.startRun({ userId: k.userId, takes: [take(prompt)], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: fal\'s fal-ai/recraft/v4.1/text-to-image, held at the node\'s price, a real output; Replicate untouched', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual([RECRAFT_V41_FAL_APP])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a poster that says HELLO', image_size: 'square_hd' })
    expect(k.replicate.reqs.size).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([creditsForUsd(PRICE) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT } })
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })

  it('an empty prompt, or one too long, with the family on: refused, nothing held or sent', async () => {
    for (const prompt of ['', 'a'.repeat(10001)]) {
      const k = makeKit({ hosted: true, deps: { families: () => ON } })
      await expect(start(k, prompt), JSON.stringify(prompt.length)).rejects.toThrow()
      expect(k.fal.reqs.size).toBe(0)
      expect(k.ledger.holds.size).toBe(0)
    }
  })
})

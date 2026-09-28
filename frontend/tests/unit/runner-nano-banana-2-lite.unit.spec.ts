/**
 * Task F14 (model line-up): Nano Banana 2 Lite (Google), runner-only, family
 * `nano-banana-2-lite` (server/runner/generators/nanoBanana2Lite.ts):
 * "Generate an image" on Replicate's google/nano-banana-2-lite, no backup
 * (fal's google/nano-banana-2-lite bills by tokens and publishes no price a
 * picture, so its cost can't be covered).
 *
 * The family contract:
 *  - every payload over the settings grid fits the saved schema; the price
 *    reads what is sent (one flat price per picture, always 1K);
 *  - hand-written expected payloads: plain, every setting there is, and a
 *    moodboard picture linked (not sent: text-to-image only). The schema's
 *    one example is an edit (image_input + match_input_image), which this
 *    task doesn't send, so none is compared to it;
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off;
 *  - the price is verified and non-zero, and badge = charge;
 *  - an empty prompt is refused up front (a ruling: Replicate's schema
 *    requires a prompt but sets no minimum; fal's schema for the same model
 *    asks for 3 characters);
 *  - the engine, end to end: the family's own endpoint, and the hold.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, isRunnerEligible } from '#shared/runner/eligibility'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { __resetModelMenusForTests, galleryEntries, menuDefault, modelMenu } from '#shared/runner/modelMenus'
import { creditsForUsd } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { IMAGE_BACKUP_RATES, IMAGE_RATES, imagePriceMaxUsd, imageRateLabel } from '#shared/pricing/imageRates'
import { effectiveImageSettings } from '#shared/pricing/imageSettings'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID, IMAGE_MODEL_PREFERENCE } from '~~/app/data/image-models'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import {
  NANO_BANANA_2_LITE_FORMAT, NANO_BANANA_2_LITE_NEEDS_PROMPT, NANO_BANANA_2_LITE_RATIOS, NANO_BANANA_2_LITE_SLUG,
} from '~~/server/runner/generators/nanoBanana2Lite'
import { PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, requestProblems } from '~~/server/runner/requestRules'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'nano-banana-2-lite'
const FAMILY: RunnerFamily = 'nano-banana-2-lite'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
const PRICE = 0.034

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

const schema = () => {
  const f = loadProviderSchema('replicate', NANO_BANANA_2_LITE_SLUG)
  expect(f.endpoint).toBe(NANO_BANANA_2_LITE_SLUG)
  return f
}
/** The saved schema's input object (its $ref followed). */
function inputSchema(): Record<string, any> {
  const f = schema()
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}
/** A property's enum, through its allOf $ref. */
function enumOf(name: string): string[] {
  const f = schema()
  const p = inputSchema().properties[name] as Record<string, any>
  return (f.components.schemas[String(p.allOf[0].$ref).split('/').pop()!] as Record<string, any>).enum as string[]
}

/** A "Generate an image" node on Nano Banana 2 Lite. */
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

// ── The saved schema ───────────────────────────────────────────────────────

describe('the saved schema', () => {
  it('one endpoint, Replicate\'s google/nano-banana-2-lite: prompt, pictures, ratio, format; no seed, no size, no search', () => {
    const props = inputSchema().properties
    expect(inputSchema().required).toEqual(['prompt'])
    expect(Object.keys(props).sort()).toEqual(['aspect_ratio', 'image_input', 'output_format', 'prompt'])
    // Every schema ratio but `match_input_image` (for editing, which this task doesn't send).
    expect([...enumOf('aspect_ratio')].sort()).toEqual([...NANO_BANANA_2_LITE_RATIOS, 'match_input_image'].sort())
    expect(enumOf('output_format')).toContain(NANO_BANANA_2_LITE_FORMAT)
    // The catalogue offers exactly the ratios sent.
    expect(IMAGE_MODELS_BY_ID[ID]!.aspectRatios).toEqual([...NANO_BANANA_2_LITE_RATIOS])
  })

  it('the prompt rule is a ruling: the schema requires a prompt but sets no minimum or maximum', () => {
    expect(inputSchema().properties.prompt.minLength).toBeUndefined()
    expect(inputSchema().properties.prompt.maxLength).toBeUndefined()
    expect(PROMPT_MIN_LENGTH[`replicate ${NANO_BANANA_2_LITE_SLUG}`]).toEqual({ min: 1, message: NANO_BANANA_2_LITE_NEEDS_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).toContain(`replicate ${NANO_BANANA_2_LITE_SLUG}`)
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

describe('settings grid: every request fits the schema, the price reads what is sent', () => {
  const RATIOS: unknown[] = [...NANO_BANANA_2_LITE_RATIOS, 'match_input_image', 'auto', '9:21', '', 7, null, undefined]
  const FORMATS: unknown[] = ['png', 'jpg', 'webp', '', null, undefined]
  const RESOLUTIONS: unknown[] = ['1K', '2K', '4K', undefined]
  const SEEDS: unknown[] = [0, 42, -1, 'x', undefined]

  it('ratio × a saved format and size option × seed', async () => {
    let n = 0
    const want = providerUsd('GenerateImageNode', gen().inputs)
    for (const ar of RATIOS) for (const format of FORMATS) for (const resolution of RESOLUTIONS) for (const seed of SEEDS) {
      const opts: Record<string, unknown> = {}
      if (format !== undefined) opts.output_format = format
      if (resolution !== undefined) opts.resolution = resolution
      const node = gen({ ar, seed, opts })
      const label = JSON.stringify({ ar, seed, opts })
      const p = await providerPlan(node)
      expect(p.provider, label).toBe('replicate')
      expect(p.endpoint, label).toBe(NANO_BANANA_2_LITE_SLUG)
      expect(p.backup, label).toBeUndefined()
      expect(checkPayload(schema(), p.payload), label).toEqual([])
      // Exactly these fields: never a picture, a seed, or a size.
      expect(Object.keys(p.payload).sort(), label).toEqual(['aspect_ratio', 'output_format', 'prompt'])
      expect(p.payload.aspect_ratio, label).toBe(typeof ar === 'string' && (NANO_BANANA_2_LITE_RATIOS as readonly string[]).includes(ar) ? ar : '1:1')
      expect(p.payload.output_format, label).toBe('png')
      // Priced on what is sent: one 1K picture, the same price whatever the settings.
      expect(effectiveImageSettings(ID, ar, node.inputs.model_options), label).toMatchObject({ images: 1, tier: null, megapixels: null, webSearch: false })
      expect(providerUsd('GenerateImageNode', node.inputs), label).toBe(want)
      expect(requestProblems({ 1: node }), label).toEqual([])
      n++
    }
    expect(n).toBe(RATIOS.length * FORMATS.length * RESOLUTIONS.length * SEEDS.length)
  })

  it('moodboard pictures and style text: the text joins the prompt, the pictures are not sent', async () => {
    const node = gen({ prompt: 'a fox' })
    node.inputs.style_block = 'ink wash'
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'ink wash a fox', aspect_ratio: '1:1', output_format: 'png' })
  })
})

// ── Hand-written expected payloads ─────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: the prompt, a square, a png', async () => {
    const p = await providerPlan(gen({ prompt: 'a bowl of lemons on a blue table' }))
    expect(p.endpoint).toBe('google/nano-banana-2-lite')
    expect(p.payload).toEqual({ prompt: 'a bowl of lemons on a blue table', aspect_ratio: '1:1', output_format: 'png' })
  })

  it('every setting there is: the tallest ratio, a seed (not sent: the schema takes none)', async () => {
    const p = await providerPlan(gen({ prompt: 'a banner of paper lanterns', ar: '1:8', seed: 1234 }))
    expect(p.payload).toEqual({ prompt: 'a banner of paper lanterns', aspect_ratio: '1:8', output_format: 'png' })
    expect(checkPayload(schema(), p.payload)).toEqual([])
  })

  it('a linked picture\'s place (a moodboard): no picture is sent, and the ratio is never match_input_image', async () => {
    const node = gen({ prompt: 'a wide street at dusk', ar: '21:9' })
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png', 'b.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'a wide street at dusk', aspect_ratio: '21:9', output_format: 'png' })
  })

  it('the routes table: Replicate, no backup, and why', () => {
    expect(RUNNER_ROUTES[`image:${ID}`]).toMatchObject({ first: 'replicate', backup: null })
    expect(RUNNER_ROUTES[`image:${ID}`]!.why).toMatch(/fal/)
    expect(IMAGE_BACKUP_RATES[ID]).toBeUndefined()
  })

  it('the older Nano Banana 2 is untouched: still its own model, on fal', () => {
    expect(RUNNER_ROUTES['image:nano-banana-2']).toMatchObject({ first: 'fal', backup: null })
    expect(IMAGE_RATES['nano-banana-2']).toMatchObject({ unit: 'by_resolution', service: 'fal' })
    expect(RUNNER_NODE_RULES.GenerateImageNode!.models!['nano-banana-2']).toBeUndefined()
  })
})

// ── An empty prompt (a ruling) ─────────────────────────────────────────────

describe('an empty prompt is refused up front, in plain words', () => {
  const refusal = [{ nodeId: '1', classType: 'GenerateImageNode', input: 'prompt', message: NANO_BANANA_2_LITE_NEEDS_PROMPT }]

  it('the words name the model, ask for a prompt, and carry no ids', () => {
    expect(NANO_BANANA_2_LITE_NEEDS_PROMPT).toBe('Nano Banana 2 Lite needs a prompt. Describe the picture you want.')
    expect(NANO_BANANA_2_LITE_NEEDS_PROMPT).not.toMatch(/_|nano-banana|google\//)
  })

  it('before the hold: an empty prompt, one of only spaces, or one that is missing', () => {
    expect(requestProblems({ 1: gen({ prompt: '' }) })).toEqual(refusal)
    expect(requestProblems({ 1: gen({ prompt: '   ' }) })).toEqual(refusal)
    const missing = gen()
    delete missing.inputs.prompt
    expect(requestProblems({ 1: missing })).toEqual(refusal)
  })

  it('at planning: the runner refuses it', async () => {
    await expect(plan(gen({ prompt: '' }))).rejects.toThrow(NANO_BANANA_2_LITE_NEEDS_PROMPT)
  })

  it('style text alone is a prompt; a wired prompt part isn\'t judged before the run', () => {
    const styled = gen({ prompt: '' })
    styled.inputs.style_block = 'ink wash'
    expect(requestProblems({ 1: styled })).toEqual([])
    for (const wired of ['prompt', 'prompt_in', 'style_block', 'style_in']) {
      const node = gen({ prompt: '' })
      node.inputs[wired] = LINK
      expect(requestProblems({ 1: node }), wired).toEqual([])
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
    expect(`${r!.title} ${r!.description}`).toContain('Nano Banana 2 Lite')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: gen() }, titleOf: () => 'Poster' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family nano-banana-2-lite, with its brand name and plain words, no settings', () => {
    const m = IMAGE_MODELS_BY_ID[ID]!
    expect(m).toMatchObject({ runnerOnly: true, family: FAMILY, label: 'Nano Banana 2 Lite', brand: 'Google', defaultAspectRatio: '1:1', pricePerImage: PRICE })
    expect(m.hidden).toBeUndefined()
    expect(m.advanced).toEqual([])
    for (const s of [m.label, m.pitch, m.description ?? '']) {
      expect(s).not.toMatch(/_|nano-banana|google\//)
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

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateImageNode', inputs }, 2: SINK }).credits

  it('the card: Replicate\'s flat $0.034 an image, verified, non-zero; no backup card; the book carries it (lineup-f14, now lineup-g1)', () => {
    expect(IMAGE_RATES[ID]).toEqual({
      unit: 'per_image', usd: PRICE, service: 'replicate', source: 'https://replicate.com/google/nano-banana-2-lite', read: '2026-09-24', confidence: 'verified',
    })
    expect(PRICE_BOOK_VERSION).toBe('r3-image-extras')
  })

  const examples: { name: string, inputs: Record<string, unknown> }[] = [
    { name: 'at its defaults, 1:1 (the live check)', inputs: gen({ ar: '1:1' }).inputs },
    { name: 'the widest ratio, a saved size and format', inputs: gen({ ar: '8:1', opts: { resolution: '4K', output_format: 'jpg' } }).inputs },
    { name: 'linked options', inputs: { ...gen().inputs, model_options: ['7', 0] } },
    { name: 'a linked ratio', inputs: { ...gen().inputs, aspect_ratio: ['7', 0] } },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $0.034; badge = charge = run estimate`, () => {
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

  it('with the family on: the family\'s own Replicate endpoint, held at the node\'s price, a real output; fal untouched', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    expect(k.fal.reqs.size).toBe(0)
    const submitted = [...k.replicate.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual([NANO_BANANA_2_LITE_SLUG])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a poster that says HELLO', aspect_ratio: '1:1', output_format: 'png' })
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

  it('an empty prompt with the family on: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    await expect(start(k, '')).rejects.toThrow()
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})

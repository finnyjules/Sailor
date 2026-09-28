/**
 * Task F15 (model line-up): Reve 2.1, runner-only, family `reve-2.1`
 * (server/runner/generators/reve21.ts): "Generate an image" on fal's
 * reve/2.1/text-to-image, no backup (Replicate has no Reve 2.1).
 *
 * The family contract:
 *  - every payload over the settings grid fits the saved schema; the price
 *    reads what is sent (one flat price per picture: fal bills Reve 2.1 by
 *    the image, and its schema has no size to choose);
 *  - hand-written expected payloads: plain (fal's own "Full Example"),
 *    every setting there is, and a moodboard picture linked (not sent: this
 *    endpoint takes no picture);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off;
 *  - the price is verified and non-zero, and badge = charge;
 *  - an empty prompt (the schema's minLength 1) and one over the schema's
 *    4,000 characters are refused up front;
 *  - the engine, end to end: the family's own endpoint, and the hold;
 *  - Reve Create is untouched.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, RUNNER_REPLICATE_IMAGE_MODEL_IDS, isRunnerEligible } from '#shared/runner/eligibility'
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
  REVE_21_FAL_APP, REVE_21_FORMAT, REVE_21_LONG_PROMPT, REVE_21_NEEDS_PROMPT, REVE_21_PROMPT_MAX, REVE_21_RATIOS,
} from '~~/server/runner/generators/reve21'
import {
  PROMPT_MAX_LENGTH, PROMPT_MAX_LENGTH_RULINGS, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, requestProblem, requestProblems,
} from '~~/server/runner/requestRules'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'reve-2.1'
const FAMILY: RunnerFamily = 'reve-2.1'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
const PRICE = 0.25

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

const schema = () => {
  const f = loadProviderSchema('fal', REVE_21_FAL_APP)
  expect(f.endpoint).toBe(REVE_21_FAL_APP)
  return f
}
/** The saved schema's input object (its $ref followed). */
function inputSchema(): Record<string, any> {
  const f = schema()
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}

/** A "Generate an image" node on Reve 2.1. */
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
  it('one endpoint, fal\'s reve/2.1/text-to-image: prompt, ratio, count, format; no size, no seed, no picture', () => {
    const props = inputSchema().properties
    expect(inputSchema().required).toEqual(['prompt'])
    expect(Object.keys(props).sort()).toEqual(['aspect_ratio', 'num_images', 'output_format', 'prompt', 'sync_mode'])
    expect(props.output_format.enum).toContain(REVE_21_FORMAT)
    // The catalogue offers every ratio the schema lists except `auto` (the model would pick the shape).
    expect([...REVE_21_RATIOS].sort()).toEqual(props.aspect_ratio.enum.filter((r: string) => r !== 'auto').sort())
    expect(IMAGE_MODELS_BY_ID[ID]!.aspectRatios).toEqual([...REVE_21_RATIOS])
    // The price text: one flat price a picture, no size tiers.
    expect(schema().pricingText).toContain('$0.25 per images')
  })

  it('the prompt rules are the schema\'s own: minLength 1 (not a ruling) and maxLength 4,000', () => {
    expect(inputSchema().properties.prompt.minLength).toBe(1)
    expect(inputSchema().properties.prompt.maxLength).toBe(REVE_21_PROMPT_MAX)
    expect(REVE_21_PROMPT_MAX).toBe(4000)
    expect(PROMPT_MIN_LENGTH[`fal ${REVE_21_FAL_APP}`]).toEqual({ min: 1, message: REVE_21_NEEDS_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).not.toContain(`fal ${REVE_21_FAL_APP}`)
    expect(PROMPT_MAX_LENGTH[`fal ${REVE_21_FAL_APP}`]).toEqual({ max: 4000, message: REVE_21_LONG_PROMPT })
  })

  it('every prompt maximum is its saved schema\'s own maxLength (the ruled rows aside: runner-happyhorse-1-1.unit.spec.ts ties them to their descriptions)', () => {
    for (const [key, rule] of Object.entries(PROMPT_MAX_LENGTH)) {
      if (PROMPT_MAX_LENGTH_RULINGS.includes(key)) continue
      const [provider, endpoint] = key.split(' ') as ['fal' | 'replicate', string]
      const f = loadProviderSchema(provider, endpoint)
      let input = f.input as Record<string, any>
      while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
      expect(input.properties.prompt.maxLength, key).toBe(rule.max)
    }
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

describe('settings grid: every request fits the schema, the price reads what is sent', () => {
  const RATIOS: unknown[] = [...REVE_21_RATIOS, '9:21', '1:16', 'auto', '', 7, null, undefined]
  const FORMATS: unknown[] = ['png', 'jpeg', 'webp', 'jpg', '', null, undefined]
  const SEEDS: unknown[] = [0, 42, -1, 'x', undefined]

  it('ratio × a saved format option × seed', async () => {
    let n = 0
    const want = providerUsd('GenerateImageNode', gen().inputs)
    for (const ar of RATIOS) for (const format of FORMATS) for (const seed of SEEDS) {
      const opts: Record<string, unknown> = {}
      if (format !== undefined) opts.output_format = format
      const node = gen({ ar, seed, opts })
      const label = JSON.stringify({ ar, seed, opts })
      const p = await providerPlan(node)
      expect(p.provider, label).toBe('fal')
      expect(p.endpoint, label).toBe(REVE_21_FAL_APP)
      expect(p.backup, label).toBeUndefined()
      expect(checkPayload(schema(), p.payload), label).toEqual([])
      // Exactly these fields: never a picture, a seed, or `auto`.
      expect(Object.keys(p.payload).sort(), label).toEqual(['aspect_ratio', 'num_images', 'output_format', 'prompt'])
      expect(p.payload.aspect_ratio, label).toBe(typeof ar === 'string' && (REVE_21_RATIOS as readonly string[]).includes(ar) ? ar : '1:1')
      expect(p.payload.num_images, label).toBe(1)
      expect(p.payload.output_format, label).toBe('png')
      // Priced on what is sent: one picture, the same price whatever the settings.
      expect(effectiveImageSettings(ID, ar, node.inputs.model_options), label).toMatchObject({ images: 1, tier: null, megapixels: null, webSearch: false })
      expect(providerUsd('GenerateImageNode', node.inputs), label).toBe(want)
      expect(requestProblems({ 1: node }), label).toEqual([])
      n++
    }
    expect(n).toBe(RATIOS.length * FORMATS.length * SEEDS.length)
  })

  it('moodboard pictures and style text: the text joins the prompt, the pictures are not sent', async () => {
    const node = gen({ prompt: 'a fox' })
    node.inputs.style_block = 'ink wash'
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'ink wash a fox', aspect_ratio: '1:1', num_images: 1, output_format: 'png' })
  })
})

// ── Hand-written expected payloads ─────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: fal\'s own "Full Example"', async () => {
    // https://fal.ai/models/reve/2.1/text-to-image/llms.txt (read 2026-09-24), "Full Example":
    // { prompt: "A towering stack of golden fluffy pancakes …", aspect_ratio: "16:9", num_images: 1, output_format: "png" }
    const prompt = 'A towering stack of golden fluffy pancakes drizzled with amber honey syrup, topped with fresh blackberries and sliced bananas, served on a white ceramic plate on a rustic wooden table with a soft blue-gray background.'
    const p = await providerPlan(gen({ prompt, ar: '16:9' }))
    expect(p.endpoint).toBe('reve/2.1/text-to-image')
    expect(p.payload).toEqual({ prompt, aspect_ratio: '16:9', num_images: 1, output_format: 'png' })
    expect(inputSchema().properties.prompt.examples).toEqual([prompt])
    expect(inputSchema().properties.aspect_ratio.examples).toEqual(['16:9'])
    expect(inputSchema().properties.num_images.examples).toEqual([1])
    expect(inputSchema().properties.output_format.examples).toEqual(['png'])
  })

  it('every setting there is: the widest ratio, a seed and a format (neither sent: always one png)', async () => {
    const p = await providerPlan(gen({ prompt: 'a festival banner', ar: '4:1', seed: 1234, opts: { output_format: 'webp' } }))
    expect(p.payload).toEqual({ prompt: 'a festival banner', aspect_ratio: '4:1', num_images: 1, output_format: 'png' })
    expect(checkPayload(schema(), p.payload)).toEqual([])
  })

  it('a linked picture\'s place (a moodboard): this endpoint takes no picture, so none is sent', async () => {
    const node = gen({ prompt: 'a tall poster', ar: '1:4' })
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png', 'b.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'a tall poster', aspect_ratio: '1:4', num_images: 1, output_format: 'png' })
  })

  it('the routes table: fal, no backup, and why', () => {
    expect(RUNNER_ROUTES[`image:${ID}`]).toMatchObject({ first: 'fal', backup: null })
    expect(RUNNER_ROUTES[`image:${ID}`]!.why).toMatch(/Replicate/)
    expect(IMAGE_BACKUP_RATES[ID]).toBeUndefined()
  })
})

// ── The prompt: not empty (the schema's minLength), at most 4,000 characters ──

describe('the prompt is refused up front, in plain words', () => {
  const refusal = (message: string) => [{ nodeId: '1', classType: 'GenerateImageNode', input: 'prompt', message }]

  it('the words name the model, say what to do, and carry no ids', () => {
    expect(REVE_21_NEEDS_PROMPT).toBe('Reve 2.1 needs a prompt. Describe the picture you want.')
    expect(REVE_21_LONG_PROMPT).toBe('Reve 2.1 takes a prompt of at most 4,000 characters. Shorten it.')
    for (const s of [REVE_21_NEEDS_PROMPT, REVE_21_LONG_PROMPT]) expect(s).not.toMatch(/_|reve-2|reve\//)
  })

  it('before the hold: an empty prompt, or one that is missing', () => {
    expect(requestProblems({ 1: gen({ prompt: '' }) })).toEqual(refusal(REVE_21_NEEDS_PROMPT))
    const missing = gen()
    delete missing.inputs.prompt
    expect(requestProblems({ 1: missing })).toEqual(refusal(REVE_21_NEEDS_PROMPT))
  })

  it('before the hold: over 4,000 characters as sent (style text included), counted as code points', () => {
    expect(requestProblems({ 1: gen({ prompt: 'a'.repeat(4000) }) })).toEqual([])
    expect(requestProblems({ 1: gen({ prompt: 'a'.repeat(4001) }) })).toEqual(refusal(REVE_21_LONG_PROMPT))
    // 4,000 emoji are 8,000 UTF-16 units but 4,000 characters.
    expect(requestProblems({ 1: gen({ prompt: '🦊'.repeat(4000) }) })).toEqual([])
    const styled = gen({ prompt: 'a'.repeat(3995) })
    styled.inputs.style_block = 'ink wash'
    expect(requestProblems({ 1: styled })).toEqual(refusal(REVE_21_LONG_PROMPT))
  })

  it('at planning: the runner refuses both', async () => {
    await expect(plan(gen({ prompt: '' }))).rejects.toThrow(REVE_21_NEEDS_PROMPT)
    await expect(plan(gen({ prompt: 'a'.repeat(4001) }))).rejects.toThrow(REVE_21_LONG_PROMPT)
    expect(requestProblem('fal', REVE_21_FAL_APP, { prompt: 'a'.repeat(4000) })).toBeNull()
    expect(requestProblem('fal', REVE_21_FAL_APP, { prompt: 'a'.repeat(4001) })).toBe(REVE_21_LONG_PROMPT)
  })

  it('style text alone is a prompt; a wired prompt part isn\'t judged before the run', () => {
    const styled = gen({ prompt: '' })
    styled.inputs.style_block = 'ink wash'
    expect(requestProblems({ 1: styled })).toEqual([])
    for (const wired of ['prompt', 'prompt_in', 'style_block', 'style_in']) {
      for (const prompt of ['', 'a'.repeat(4001)]) {
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
    expect(`${r!.title} ${r!.description}`).toContain('Reve 2.1')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: gen() }, titleOf: () => 'Poster' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family reve-2.1, with its brand name and plain words, no settings', () => {
    const m = IMAGE_MODELS_BY_ID[ID]!
    expect(m).toMatchObject({ runnerOnly: true, family: FAMILY, label: 'Reve 2.1', brand: 'Reve', defaultAspectRatio: '1:1', pricePerImage: PRICE })
    expect(m.hidden).toBeUndefined()
    expect(m.advanced).toEqual([])
    for (const s of [m.label, m.pitch, m.description ?? '']) {
      expect(s).not.toMatch(/_|reve-2|reve\//)
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

// ── Reve Create stays as it is ─────────────────────────────────────────────

describe('Reve Create is untouched', () => {
  it('still in the catalogue as before: not runner-only, unpriced, no card, not in the runner', () => {
    const m = IMAGE_MODELS_BY_ID['reve-create']!
    expect(m).toMatchObject({ label: 'Reve Create', brand: 'Reve', replicateSlug: 'reve/create', pricePerImage: null, defaultAspectRatio: '3:2' })
    expect(m.runnerOnly).toBeUndefined()
    expect(m.family).toBeUndefined()
    expect(IMAGE_RATES['reve-create']).toBeUndefined()
    expect(RUNNER_REPLICATE_IMAGE_MODEL_IDS).not.toContain('reve-create')
    expect(RUNNER_NODE_RULES.GenerateImageNode!.models!['reve-create']).toBeUndefined()
    expect(RUNNER_ROUTES['image:reve-create']).toBeUndefined()
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateImageNode', inputs }, 2: SINK }).credits

  it('the card: fal\'s flat $0.25 an image, verified, non-zero; no backup card; the book carries it (lineup-f15, now lineup-g1)', () => {
    expect(IMAGE_RATES[ID]).toEqual({
      unit: 'per_image', usd: PRICE, service: 'fal', source: 'https://fal.ai/models/reve/2.1/text-to-image/llms.txt', read: '2026-09-24', confidence: 'verified',
    })
    expect(PRICE_BOOK_VERSION).toBe('r3-restyle-lora')
  })

  const examples: { name: string, inputs: Record<string, unknown> }[] = [
    { name: 'at its defaults, 1:1 (the live check)', inputs: gen({ ar: '1:1' }).inputs },
    { name: 'the widest ratio', inputs: gen({ ar: '4:1' }).inputs },
    { name: 'linked options', inputs: { ...gen().inputs, model_options: ['7', 0] } },
    { name: 'a linked ratio', inputs: { ...gen().inputs, aspect_ratio: ['7', 0] } },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $0.25; badge = charge = run estimate`, () => {
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

  it('with the family on: fal\'s reve/2.1/text-to-image, held at the node\'s price, a real output; Replicate untouched', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual([REVE_21_FAL_APP])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a poster that says HELLO', aspect_ratio: '1:1', num_images: 1, output_format: 'png' })
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
    for (const prompt of ['', 'a'.repeat(4001)]) {
      const k = makeKit({ hosted: true, deps: { families: () => ON } })
      await expect(start(k, prompt), JSON.stringify(prompt.length)).rejects.toThrow()
      expect(k.fal.reqs.size).toBe(0)
      expect(k.ledger.holds.size).toBe(0)
    }
  })
})

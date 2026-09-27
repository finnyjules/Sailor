/**
 * Task F13 (model line-up): Muse Image (Meta), runner-only, family
 * `muse-image` (server/runner/generators/museImage.ts): "Generate an image"
 * on fal's meta/muse-image/text-to-image, no backup (Replicate has no Muse).
 *
 * The family contract:
 *  - every payload over the settings grid fits the saved schema; the price
 *    reads what is sent (one flat price per picture);
 *  - hand-written expected payloads: plain (fal's own "Full Example" but
 *    png), every setting there is, and a moodboard picture linked (not sent:
 *    this endpoint takes no picture);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off;
 *  - the price is verified and non-zero, and badge = charge;
 *  - an empty prompt is refused up front (the schema's own minLength 1);
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
  MUSE_IMAGE_FAL_APP, MUSE_IMAGE_FORMAT, MUSE_IMAGE_NEEDS_PROMPT, MUSE_IMAGE_RATIOS,
} from '~~/server/runner/generators/museImage'
import { PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, requestProblems } from '~~/server/runner/requestRules'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'muse-image'
const FAMILY: RunnerFamily = 'muse-image'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
const PRICE = 0.01

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

const schema = () => {
  const f = loadProviderSchema('fal', MUSE_IMAGE_FAL_APP)
  expect(f.endpoint).toBe(MUSE_IMAGE_FAL_APP)
  return f
}
/** The saved schema's input object (its $ref followed). */
function inputSchema(): Record<string, any> {
  const f = schema()
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}

/** A "Generate an image" node on Muse Image. */
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
  it('one endpoint, fal\'s meta/muse-image/text-to-image: prompt, ratio, count, format; no seed, no picture, no web search', () => {
    const props = inputSchema().properties
    expect(inputSchema().required).toEqual(['prompt'])
    expect(Object.keys(props).sort()).toEqual(['aspect_ratio', 'num_images', 'output_format', 'prompt', 'sync_mode'])
    expect(props.output_format.enum).toContain(MUSE_IMAGE_FORMAT)
    // Any "width:height" between 1:16 and 16:1; the catalogue offers the schema's common presets.
    const pattern = new RegExp(props.aspect_ratio.anyOf[0].pattern)
    for (const r of MUSE_IMAGE_RATIOS) expect(pattern.test(r), r).toBe(true)
    expect(props.aspect_ratio.description).toContain('"21:9", "16:9", "4:3", "3:2", "1:1", "2:3", "3:4", "9:16", "9:21"')
    expect([...MUSE_IMAGE_RATIOS].sort()).toEqual(['16:9', '1:1', '21:9', '2:3', '3:2', '3:4', '4:3', '9:16', '9:21'])
    expect(IMAGE_MODELS_BY_ID[ID]!.aspectRatios).toEqual([...MUSE_IMAGE_RATIOS])
    // The price text: one flat price a picture.
    expect(schema().pricingText).toContain('$0.01 per images')
  })

  it('the prompt rule is the schema\'s own minLength 1, not a ruling', () => {
    expect(inputSchema().properties.prompt.minLength).toBe(1)
    expect(inputSchema().properties.prompt.maxLength).toBeUndefined()
    expect(PROMPT_MIN_LENGTH[`fal ${MUSE_IMAGE_FAL_APP}`]).toEqual({ min: 1, message: MUSE_IMAGE_NEEDS_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).not.toContain(`fal ${MUSE_IMAGE_FAL_APP}`)
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

describe('settings grid: every request fits the schema, the price reads what is sent', () => {
  const RATIOS: unknown[] = [...MUSE_IMAGE_RATIOS, '5:4', '1:16', 'auto', '', 7, null, undefined]
  const FORMATS: unknown[] = ['png', 'jpeg', 'webp', '', null, undefined]
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
      expect(p.endpoint, label).toBe(MUSE_IMAGE_FAL_APP)
      expect(p.backup, label).toBeUndefined()
      expect(checkPayload(schema(), p.payload), label).toEqual([])
      // Exactly these fields: never a picture, a seed, or anything that costs extra.
      expect(Object.keys(p.payload).sort(), label).toEqual(['aspect_ratio', 'num_images', 'output_format', 'prompt'])
      expect(p.payload.aspect_ratio, label).toBe(typeof ar === 'string' && (MUSE_IMAGE_RATIOS as readonly string[]).includes(ar) ? ar : '1:1')
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
  it('plain: fal\'s own "Full Example", with a png', async () => {
    // https://fal.ai/models/meta/muse-image/text-to-image/llms.txt (read 2026-09-24), "Full Example":
    // { prompt: "A cinematic editorial portrait in soft window light with crisp typography",
    //   aspect_ratio: "16:9", num_images: 1, output_format: "webp" }
    const prompt = 'A cinematic editorial portrait in soft window light with crisp typography'
    const p = await providerPlan(gen({ prompt, ar: '16:9' }))
    expect(p.endpoint).toBe('meta/muse-image/text-to-image')
    expect(p.payload).toEqual({ prompt, aspect_ratio: '16:9', num_images: 1, output_format: 'png' })
    expect(inputSchema().properties.prompt.examples).toEqual([prompt])
    expect(inputSchema().properties.aspect_ratio.examples).toEqual(['16:9'])
  })

  it('every setting there is: a wide cinema ratio, a seed (not sent: the schema takes none)', async () => {
    const p = await providerPlan(gen({ prompt: 'a festival poster', ar: '21:9', seed: 1234 }))
    expect(p.payload).toEqual({ prompt: 'a festival poster', aspect_ratio: '21:9', num_images: 1, output_format: 'png' })
    expect(checkPayload(schema(), p.payload)).toEqual([])
  })

  it('a linked picture\'s place (a moodboard): Muse takes no picture here, so none is sent', async () => {
    const node = gen({ prompt: 'a tall poster', ar: '9:21' })
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png', 'b.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'a tall poster', aspect_ratio: '9:21', num_images: 1, output_format: 'png' })
  })

  it('the routes table: fal, no backup, and why', () => {
    expect(RUNNER_ROUTES[`image:${ID}`]).toMatchObject({ first: 'fal', backup: null })
    expect(RUNNER_ROUTES[`image:${ID}`]!.why).toMatch(/Replicate/)
    expect(IMAGE_BACKUP_RATES[ID]).toBeUndefined()
  })
})

// ── An empty prompt (the schema's minLength) ──────────────────────────────

describe('an empty prompt is refused up front, in plain words', () => {
  const refusal = [{ nodeId: '1', classType: 'GenerateImageNode', input: 'prompt', message: MUSE_IMAGE_NEEDS_PROMPT }]

  it('the words name the model, ask for a prompt, and carry no ids', () => {
    expect(MUSE_IMAGE_NEEDS_PROMPT).toBe('Muse Image needs a prompt. Describe the picture you want.')
    expect(MUSE_IMAGE_NEEDS_PROMPT).not.toMatch(/_|muse-image|meta\//)
  })

  it('before the hold: an empty prompt, or one that is missing', () => {
    expect(requestProblems({ 1: gen({ prompt: '' }) })).toEqual(refusal)
    const missing = gen()
    delete missing.inputs.prompt
    expect(requestProblems({ 1: missing })).toEqual(refusal)
  })

  it('at planning: the runner refuses it', async () => {
    await expect(plan(gen({ prompt: '' }))).rejects.toThrow(MUSE_IMAGE_NEEDS_PROMPT)
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
    expect(`${r!.title} ${r!.description}`).toContain('Muse Image')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: gen() }, titleOf: () => 'Poster' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family muse-image, with its brand name and plain words, no settings', () => {
    const m = IMAGE_MODELS_BY_ID[ID]!
    expect(m).toMatchObject({ runnerOnly: true, family: FAMILY, label: 'Muse Image', brand: 'Meta', defaultAspectRatio: '1:1', pricePerImage: PRICE })
    expect(m.hidden).toBeUndefined()
    expect(m.advanced).toEqual([])
    for (const s of [m.label, m.pitch, m.description ?? '']) {
      expect(s).not.toMatch(/_|muse-image|meta\//)
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

  it('the card: fal\'s flat $0.01 an image, verified, non-zero; no backup card; the book carries it (lineup-f13, now lineup-g1)', () => {
    expect(IMAGE_RATES[ID]).toEqual({
      unit: 'per_image', usd: PRICE, service: 'fal', source: 'https://fal.ai/models/meta/muse-image/text-to-image/llms.txt', read: '2026-09-24', confidence: 'verified',
    })
    expect(PRICE_BOOK_VERSION).toBe('r3-split')
  })

  const examples: { name: string, inputs: Record<string, unknown> }[] = [
    { name: 'at its defaults, 1:1 (the live check)', inputs: gen({ ar: '1:1' }).inputs },
    { name: 'a wide cinema ratio', inputs: gen({ ar: '21:9' }).inputs },
    { name: 'linked options', inputs: { ...gen().inputs, model_options: ['7', 0] } },
    { name: 'a linked ratio', inputs: { ...gen().inputs, aspect_ratio: ['7', 0] } },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $0.01; badge = charge = run estimate`, () => {
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

  it('with the family on: fal\'s meta/muse-image/text-to-image, held at the node\'s price, a real output; Replicate untouched', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual([MUSE_IMAGE_FAL_APP])
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

  it('an empty prompt with the family on: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    await expect(start(k, '')).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})

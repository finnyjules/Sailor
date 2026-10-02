/**
 * Model line-up: FLUX 3 Image (Black Forest Labs), runner-only, family
 * `flux-3-image` (server/runner/generators/flux3Image.ts): "Generate an
 * image" on fal's blackforestlabs/flux-3/text-to-image, no backup.
 *
 * The family contract:
 *  - every payload over the settings grid fits the saved schema; the price
 *    reads what is sent (the size's megapixels, the most it can bill);
 *  - hand-written expected payloads: plain (the schema's own example
 *    prompt, the defaults), every option set, and a moodboard picture
 *    linked (not sent: this endpoint takes no picture);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off;
 *  - the price is verified, non-zero, at the full rate (never fal's launch
 *    promotion), and badge = charge;
 *  - an empty prompt is refused up front (a ruling: the schema requires a
 *    prompt but sets no minimum);
 *  - the engine, end to end: the family's own endpoint, and the hold.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { EVERY_KNOWN_FAMILY, LATE_FAMILIES, NO_FAMILIES, RUNNER_FAMILIES, parseFamilies, type RunnerFamily } from '#shared/runner/families'
import { RUNNER_NODE_RULES, isRunnerEligible } from '#shared/runner/eligibility'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { RUNNER_TIMEOUTS } from '#shared/runner/timeouts'
import { __resetModelMenusForTests, galleryEntries, menuDefault, modelMenu } from '#shared/runner/modelMenus'
import { creditsForUsd } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { IMAGE_BACKUP_RATES, IMAGE_RATES, imagePriceMaxUsd, imageRateLabel } from '#shared/pricing/imageRates'
import {
  FLUX_3_IMAGE_BILLED_MEGAPIXELS, FLUX_3_IMAGE_MAX_MEGAPIXELS, FLUX_3_IMAGE_RESOLUTIONS, effectiveImageSettings,
} from '#shared/pricing/imageSettings'
import { IMAGE_MODELS, IMAGE_MODELS_BY_ID, IMAGE_MODEL_PREFERENCE } from '~~/app/data/image-models'
import { VIDEO_MODELS } from '~~/app/data/video-models'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import {
  FLUX_3_IMAGE_FAL_APP, FLUX_3_IMAGE_FORMAT, FLUX_3_IMAGE_NEEDS_PROMPT, FLUX_3_IMAGE_RATIOS,
} from '~~/server/runner/generators/flux3Image'
import { PROMPT_MAX_LENGTH, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, requestProblem, requestProblems } from '~~/server/runner/requestRules'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'flux-3-image'
const FAMILY: RunnerFamily = 'flux-3-image'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = EVERY_KNOWN_FAMILY
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set([...EVERY_KNOWN_FAMILY].filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
/** fal's full rate, a megapixel (llms.txt, read 2026-10-02: "$0.048" for a 1 MP picture once the promotion ends). */
const PER_MP = 0.048
const USD_1K = 2 * PER_MP // 0.096
const USD_2K = 5 * PER_MP // 0.24

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

const schema = () => {
  const f = loadProviderSchema('fal', FLUX_3_IMAGE_FAL_APP)
  expect(f.endpoint).toBe(FLUX_3_IMAGE_FAL_APP)
  return f
}
/** The saved schema's input object (its $ref followed). */
function inputSchema(): Record<string, any> {
  const f = schema()
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}

/** A "Generate an image" node on FLUX 3. */
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

// ── The family ─────────────────────────────────────────────────────────────

describe('the family', () => {
  it('is known, off by default, needs nothing else on, and stays out of every pinned list', () => {
    expect(LATE_FAMILIES).toContain(FAMILY)
    expect(RUNNER_FAMILIES).not.toContain(FAMILY)
    expect(parseFamilies(FAMILY)).toEqual(ON)
    expect(parseFamilies('')).toEqual(NO_FAMILIES)
  })

  it('its id is not FLUX 3\'s video model\'s', () => {
    expect(VIDEO_MODELS.some(m => m.id === 'flux-3')).toBe(true)
    expect(VIDEO_MODELS.some(m => m.id === ID)).toBe(false)
    expect(IMAGE_MODELS.some(m => m.id === 'flux-3')).toBe(false)
  })

  it('a picture may take a few minutes: inside the runner\'s picture limit', () => {
    // 45 to 75 seconds a picture is expected; 2K is slower than 1K.
    expect(RUNNER_TIMEOUTS.imageMs).toBeGreaterThanOrEqual(5 * 60_000)
  })
})

// ── The saved schema ───────────────────────────────────────────────────────

describe('the saved schema', () => {
  it('one endpoint, fal\'s blackforestlabs/flux-3/text-to-image: prompt, ratio, size tier, expansion, safety, format; no seed, no picture', () => {
    const props = inputSchema().properties
    expect(inputSchema().required).toEqual(['prompt'])
    expect(Object.keys(props).sort()).toEqual(['aspect_ratio', 'enable_prompt_expansion', 'output_format', 'prompt', 'resolution', 'safety_tolerance', 'sync_mode', 'version'])
    expect(props.aspect_ratio.enum).toEqual(['auto', '21:9', '2:1', '16:9', '3:2', '7:5', '4:3', '5:4', '1:1', '4:5', '3:4', '5:7', '2:3', '9:16', '1:2'])
    expect([...FLUX_3_IMAGE_RATIOS].sort()).toEqual(props.aspect_ratio.enum.filter((r: string) => r !== 'auto').sort())
    expect(IMAGE_MODELS_BY_ID[ID]!.aspectRatios).toEqual([...FLUX_3_IMAGE_RATIOS])
    expect(props.resolution.enum).toEqual(['512sq', '768sq', '1k', '2k', '4k'])
    for (const r of FLUX_3_IMAGE_RESOLUTIONS) expect(props.resolution.enum).toContain(r.toLowerCase())
    expect(props.output_format.enum).toContain(FLUX_3_IMAGE_FORMAT)
    expect(props.enable_prompt_expansion.default).toBe(false)
    expect(props.safety_tolerance.default).toBe(2)
  })

  it('the price text: fal\'s launch promotion, and the full price after it', () => {
    const text = schema().pricingText!
    expect(text).toContain('A 1K (1 MP) image costs $0.024.')
    expect(text).toContain('these promotional launch rates are 50% off for a limited time')
    expect(text).toContain('after which a 1K (1 MP) image will cost $0.048')
  })

  it('the prompt rule is a ruling: the schema requires a prompt but sets no minimum or maximum', () => {
    expect(inputSchema().properties.prompt.minLength).toBeUndefined()
    expect(inputSchema().properties.prompt.maxLength).toBeUndefined()
    expect(PROMPT_MIN_LENGTH[`fal ${FLUX_3_IMAGE_FAL_APP}`]).toEqual({ min: 1, message: FLUX_3_IMAGE_NEEDS_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).toContain(`fal ${FLUX_3_IMAGE_FAL_APP}`)
    expect(PROMPT_MAX_LENGTH[`fal ${FLUX_3_IMAGE_FAL_APP}`]).toBeUndefined()
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

describe('settings grid: every request fits the schema, the price reads what is sent', () => {
  const RATIOS: unknown[] = [...FLUX_3_IMAGE_RATIOS, '9:21', '3:1', 'auto', '', 7, null, undefined]
  const SIZES: unknown[] = [...FLUX_3_IMAGE_RESOLUTIONS, '1k', '2k', '4K', '4k', '512sq', '768sq', '', 2, true, null, undefined]
  const SEEDS: unknown[] = [0, 42, -1, 'x', undefined]

  it('ratio × size × seed', async () => {
    let n = 0
    for (const ar of RATIOS) for (const size of SIZES) for (const seed of SEEDS) {
      const opts: Record<string, unknown> = {}
      if (size !== undefined) opts.resolution = size
      const node = gen({ ar, seed, opts })
      const label = JSON.stringify({ ar, seed, opts })
      const p = await providerPlan(node)
      expect(p.provider, label).toBe('fal')
      expect(p.endpoint, label).toBe(FLUX_3_IMAGE_FAL_APP)
      expect(p.backup, label).toBeUndefined()
      expect(checkPayload(schema(), p.payload), label).toEqual([])
      // Exactly these fields: never a picture, a seed, a safety level or anything that costs extra.
      expect(Object.keys(p.payload).sort(), label).toEqual(['aspect_ratio', 'enable_prompt_expansion', 'output_format', 'prompt', 'resolution'])
      expect(p.payload.aspect_ratio, label).toBe(typeof ar === 'string' && (FLUX_3_IMAGE_RATIOS as readonly string[]).includes(ar) ? ar : '1:1')
      const tier = size === '2K' ? '2K' : '1K'
      expect(p.payload.resolution, label).toBe(tier.toLowerCase())
      expect(p.payload.enable_prompt_expansion, label).toBe(false)
      expect(p.payload.output_format, label).toBe('png')
      // Priced on what is sent: the tier's most billed megapixels, one picture, whatever the ratio.
      expect(effectiveImageSettings(ID, ar, node.inputs.model_options), label)
        .toEqual({ images: 1, tier: null, megapixels: FLUX_3_IMAGE_BILLED_MEGAPIXELS[tier], webSearch: false })
      expect(providerUsd('GenerateImageNode', node.inputs), label).toBeCloseTo(tier === '2K' ? USD_2K : USD_1K, 9)
      expect(requestProblems({ 1: node }), label).toEqual([])
      n++
    }
    expect(n).toBe(RATIOS.length * SIZES.length * SEEDS.length)
  })

  it('moodboard pictures and style text: the text joins the prompt, the pictures are not sent', async () => {
    const node = gen({ prompt: 'a fox' })
    node.inputs.style_block = 'ink wash'
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'ink wash a fox', aspect_ratio: '1:1', resolution: '1k', enable_prompt_expansion: false, output_format: 'png' })
  })
})

// ── Hand-written expected payloads ─────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: the schema\'s own "Full Example" prompt, the defaults (1K, png; a ratio, not auto)', async () => {
    // https://fal.ai/models/blackforestlabs/flux-3/text-to-image/llms.txt (read 2026-10-02), "Full Example":
    // { prompt: "A red fox leaping over a stream in a pine forest, low-angle wildlife photograph.",
    //   aspect_ratio: "auto", resolution: "1k", safety_tolerance: 2, output_format: "jpeg", version: "latest" }
    const prompt = 'A red fox leaping over a stream in a pine forest, low-angle wildlife photograph.'
    expect(inputSchema().properties.prompt.examples).toEqual([prompt])
    const p = await providerPlan(gen({ prompt }))
    expect(p.endpoint).toBe('blackforestlabs/flux-3/text-to-image')
    expect(p.payload).toEqual({ prompt, aspect_ratio: '1:1', resolution: '1k', enable_prompt_expansion: false, output_format: 'png' })
  })

  it('every option set: 2K, 4:3 (fal\'s own page example), a seed (not sent: the schema takes none)', async () => {
    const prompt = 'Two red pandas resting on bamboo beams'
    const p = await providerPlan(gen({ prompt, ar: '4:3', seed: 1234, opts: { resolution: '2K' } }))
    expect(p.payload).toEqual({ prompt, aspect_ratio: '4:3', resolution: '2k', enable_prompt_expansion: false, output_format: 'png' })
    expect(checkPayload(schema(), p.payload)).toEqual([])
  })

  it('a linked picture\'s place (a moodboard): FLUX 3 takes no picture here, so none is sent', async () => {
    const node = gen({ prompt: 'a wide poster', ar: '21:9' })
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png', 'b.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt: 'a wide poster', aspect_ratio: '21:9', resolution: '1k', enable_prompt_expansion: false, output_format: 'png' })
  })

  it('the routes table: fal, no backup, and why', () => {
    expect(RUNNER_ROUTES[`image:${ID}`]).toMatchObject({ first: 'fal', backup: null })
    expect(RUNNER_ROUTES[`image:${ID}`]!.why).toMatch(/Replicate/)
    expect(IMAGE_BACKUP_RATES[ID]).toBeUndefined()
  })
})

// ── An empty prompt (a ruling) ────────────────────────────────────────────

describe('an empty prompt is refused up front, in plain words', () => {
  const refusal = [{ nodeId: '1', classType: 'GenerateImageNode', input: 'prompt', message: FLUX_3_IMAGE_NEEDS_PROMPT }]

  it('the words name the model, ask for a prompt, and carry no ids', () => {
    expect(FLUX_3_IMAGE_NEEDS_PROMPT).toBe('FLUX 3 needs a prompt. Describe the picture you want.')
    expect(FLUX_3_IMAGE_NEEDS_PROMPT).not.toMatch(/_|flux-3|blackforestlabs/)
  })

  it('before the hold: empty, missing, or only spaces (a ruled row trims)', () => {
    expect(requestProblems({ 1: gen({ prompt: '' }) })).toEqual(refusal)
    expect(requestProblems({ 1: gen({ prompt: '   ' }) })).toEqual(refusal)
    const missing = gen()
    delete missing.inputs.prompt
    expect(requestProblems({ 1: missing })).toEqual(refusal)
    expect(requestProblem('fal', FLUX_3_IMAGE_FAL_APP, { prompt: '  a  ' })).toBeNull()
  })

  it('at planning: the runner refuses it', async () => {
    await expect(plan(gen({ prompt: '' }))).rejects.toThrow(FLUX_3_IMAGE_NEEDS_PROMPT)
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
    expect(`${r!.title} ${r!.description}`).toContain('FLUX 3')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: gen() }, titleOf: () => 'Poster' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family flux-3-image, with its brand name, plain words and a labelled Size setting', () => {
    const m = IMAGE_MODELS_BY_ID[ID]!
    expect(m).toMatchObject({ runnerOnly: true, family: FAMILY, label: 'FLUX 3', brand: 'BFL', defaultAspectRatio: '1:1', pricePerImage: USD_1K })
    expect(m.hidden).toBeUndefined()
    expect(m.advanced).toHaveLength(1)
    const size = m.advanced[0]!
    expect(size).toMatchObject({ name: 'resolution', type: 'select', label: 'Size', default: '1K', options: ['1K', '2K'] })
    expect(size.optionLabels).toEqual(['1K', '2K, sharper'])
    for (const s of [m.label, m.pitch, m.description ?? '', size.label, size.description ?? '', ...size.optionLabels!]) {
      expect(s).not.toMatch(/_|flux-3|blackforestlabs/)
    }
  })

  it('hidden from "Generate an image" while the family is off, shown while on; a saved node still shows it, tagged', () => {
    const shown = (f: ReadonlySet<RunnerFamily>) => galleryEntries(IMAGE_MODELS, { classType: 'GenerateImageNode', families: f, current: null }).map(e => e.model.id)
    expect(shown(NO_FAMILIES)).not.toContain(ID)
    expect(shown(ALL_BUT)).not.toContain(ID)
    expect(shown(ON)).toContain(ID)
    expect(shown(ALL)).toContain(ID)
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

  it('the card: fal\'s full $0.048 a megapixel (never the promotion), verified, dated, non-zero; no backup card', () => {
    expect(IMAGE_RATES[ID]).toMatchObject({
      unit: 'per_megapixel', perMegapixel: PER_MP, minMegapixels: 1, maxMegapixels: 5, service: 'fal', confidence: 'verified', read: '2026-10-02',
      source: 'https://fal.ai/models/blackforestlabs/flux-3/text-to-image/llms.txt',
    })
    expect((IMAGE_RATES[ID] as { perMegapixel: number }).perMegapixel).not.toBe(0.024)
    expect(IMAGE_BACKUP_RATES[ID]).toBeUndefined()
    expect(FLUX_3_IMAGE_BILLED_MEGAPIXELS).toEqual({ '1K': 2, '2K': 5 })
    expect(FLUX_3_IMAGE_MAX_MEGAPIXELS).toBe(5)
  })

  it('the most each size can bill covers fal\'s own figures: 1K "1 MP" (1024² is over 1,000,000 pixels), 2K its 2368 × 1776 example', () => {
    expect(FLUX_3_IMAGE_BILLED_MEGAPIXELS['1K']).toBeGreaterThanOrEqual(Math.ceil(1024 * 1024 / 1e6))
    expect(FLUX_3_IMAGE_BILLED_MEGAPIXELS['2K']).toBeGreaterThanOrEqual(Math.ceil(2368 * 1776 / 1e6))
    expect(FLUX_3_IMAGE_BILLED_MEGAPIXELS['2K']).toBeGreaterThanOrEqual(Math.ceil(2048 * 2048 / 1e6))
  })

  const examples: { name: string, inputs: Record<string, unknown>, usd: number }[] = [
    { name: '1K, 1:1 (the defaults; the live check)', inputs: gen({ ar: '1:1' }).inputs, usd: USD_1K },
    { name: '1K, 21:9', inputs: gen({ ar: '21:9', opts: { resolution: '1K' } }).inputs, usd: USD_1K },
    { name: '2K, 4:3', inputs: gen({ ar: '4:3', opts: { resolution: '2K' } }).inputs, usd: USD_2K },
    { name: 'an unknown size (the default)', inputs: gen({ opts: { resolution: '4K' } }).inputs, usd: USD_1K },
    { name: 'linked options (the dearest size)', inputs: { ...gen().inputs, model_options: ['7', 0] }, usd: USD_2K },
    { name: 'a linked ratio (the ratio doesn\'t move the price)', inputs: { ...gen({ opts: { resolution: '2K' } }).inputs, aspect_ratio: ['7', 0] }, usd: USD_2K },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $${ex.usd}; badge = charge = run estimate`, () => {
      expect(providerUsd('GenerateImageNode', ex.inputs)).toBeCloseTo(ex.usd, 9)
      const credits = creditsForUsd(ex.usd)
      expect(credits).toBeGreaterThan(0)
      expect(credits / 100).toBeGreaterThanOrEqual(ex.usd)
      expect(nodeCredits('GenerateImageNode', ex.inputs)).toBe(credits)
      const c = charge(ex.inputs)
      expect(c).toBe(credits + 1) // + base render
      expect(nodeCreditEstimate('GenerateImageNode', ex.inputs)).toBe(c)
      const names = Object.keys(ex.inputs)
      const est = estimateUsdForNodes([{ id: '1', type: 'GenerateImageNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]) }], { hosted: true })!
      expect(est.hostedCredits).toBe(c)
    })
  }

  it('every ratio prices the same at each size', () => {
    for (const ar of FLUX_3_IMAGE_RATIOS) {
      expect(providerUsd('GenerateImageNode', gen({ ar }).inputs), `1K ${ar}`).toBeCloseTo(USD_1K, 9)
      expect(providerUsd('GenerateImageNode', gen({ ar, opts: { resolution: '2K' } }).inputs), `2K ${ar}`).toBeCloseTo(USD_2K, 9)
    }
  })

  it('the gallery: the catalogue figure is 1K\'s, "up to" 2K\'s; the hosted label is the charge', () => {
    expect(IMAGE_MODELS_BY_ID[ID]!.pricePerImage).toBe(USD_1K)
    expect(imagePriceMaxUsd(ID)).toBeCloseTo(USD_2K, 9)
    expect(imageRateLabel(ID, '1:1')).toBe('$0.096, up to $0.24')
    expect(imageRateLabel(ID, '1:1', { hosted: true })).toBe(`${creditsForUsd(USD_1K)} credits, up to ${creditsForUsd(USD_2K)}`)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take = (prompt = 'a poster that says HELLO'): ApiPrompt => ({
    1: gen({ prompt, ar: '1:1' }), 2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  })
  const start = (k: ReturnType<typeof makeKit>, prompt?: string) =>
    k.engine.startRun({ userId: k.userId, takes: [take(prompt)], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: fal\'s blackforestlabs/flux-3/text-to-image, held at the node\'s price, a real output; Replicate untouched', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual([FLUX_3_IMAGE_FAL_APP])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a poster that says HELLO', aspect_ratio: '1:1', resolution: '1k', enable_prompt_expansion: false, output_format: 'png' })
    expect(k.replicate.reqs.size).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([creditsForUsd(USD_1K) + 1])
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

/**
 * Model line-up: Ideogram 4.5, runner-only, family `ideogram-4.5`
 * (server/runner/generators/ideogram45.ts): "Generate an image" on fal's
 * ideogram/v4.5 (text-to-image), no backup (Replicate has no Ideogram 4.5).
 *
 * The family contract:
 *  - every payload over the settings grid fits the saved schema; the price
 *    reads what is sent (the quality is the tier; the size doesn't move it);
 *  - hand-written expected payloads: plain (the schema's own example prompt,
 *    the defaults), every option set, and a moodboard picture linked (not
 *    sent: this endpoint takes no picture);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off;
 *  - the price is verified and non-zero, and badge = charge;
 *  - a prompt the schema refuses (empty, over 10,000 characters) is refused
 *    up front;
 *  - the engine, end to end: the family's own endpoint, and the hold.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { EVERY_KNOWN_FAMILY, LATE_FAMILIES, NO_FAMILIES, RUNNER_FAMILIES, parseFamilies, type RunnerFamily } from '#shared/runner/families'
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
  IDEOGRAM_45_DEFAULT_QUALITY, IDEOGRAM_45_FAL_APP, IDEOGRAM_45_LONG_PROMPT, IDEOGRAM_45_NEEDS_PROMPT, IDEOGRAM_45_PROMPT_MAX,
  IDEOGRAM_45_QUALITIES, IDEOGRAM_45_RATIOS, IDEOGRAM_45_SIZES,
} from '~~/server/runner/generators/ideogram45'
import { PROMPT_MAX_LENGTH, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, requestProblems } from '~~/server/runner/requestRules'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'ideogram-4.5'
const FAMILY: RunnerFamily = 'ideogram-4.5'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = EVERY_KNOWN_FAMILY
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set([...EVERY_KNOWN_FAMILY].filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
/** fal's prices by quality (llms.txt, read 2026-10-02). */
const PRICES: Record<string, number> = { low: 0.03, medium: 0.06, high: 0.22 }

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

const schema = () => {
  const f = loadProviderSchema('fal', IDEOGRAM_45_FAL_APP)
  expect(f.endpoint).toBe(IDEOGRAM_45_FAL_APP)
  return f
}
/** The saved schema's input object (its $ref followed). */
function inputSchema(): Record<string, any> {
  const f = schema()
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}

/** A "Generate an image" node on Ideogram 4.5. */
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
})

// ── The saved schema ───────────────────────────────────────────────────────

describe('the saved schema', () => {
  it('one endpoint, fal\'s ideogram/v4.5: prompt, size, quality, expansion, count, seed; no picture, no format', () => {
    const props = inputSchema().properties
    expect(inputSchema().required).toEqual(['prompt'])
    expect(inputSchema().additionalProperties).toBe(false)
    expect(Object.keys(props).sort()).toEqual(['enable_prompt_expansion', 'image_size', 'num_images', 'prompt', 'quality', 'seed', 'sync_mode'])
    expect(props.quality.enum).toEqual([...IDEOGRAM_45_QUALITIES])
    expect(props.quality.default).toBe('medium')
    expect(IDEOGRAM_45_DEFAULT_QUALITY).toBe('low')
    expect(props.enable_prompt_expansion.default).toBe(true)
    // The price text: the quality alone sets it.
    expect(schema().pricingText).toContain('**$0.03** per image with Low, **$0.06** with Medium, and **$0.22** with High quality')
    expect(schema().pricingText).toContain('The image size does not change the price.')
  })

  it('every size is one the schema lists, at its exact ratio', () => {
    const desc = String(inputSchema().properties.image_size.description)
    const listed = new Set(desc.split('supported size:')[1]!.split(',').map(s => s.trim().replace(/\.$/, '')))
    expect(listed.size).toBeGreaterThan(30)
    for (const [ar, [w, h]] of Object.entries(IDEOGRAM_45_SIZES)) {
      expect(listed.has(`${w}x${h}`), ar).toBe(true)
      const [a, b] = ar.split(':').map(Number) as [number, number]
      expect(w * b, ar).toBe(h * a)
    }
    expect(IMAGE_MODELS_BY_ID[ID]!.aspectRatios).toEqual([...IDEOGRAM_45_RATIOS])
  })

  it('the prompt rules are the schema\'s own minLength 1 and maxLength 10,000, not rulings', () => {
    expect(inputSchema().properties.prompt.minLength).toBe(1)
    expect(inputSchema().properties.prompt.maxLength).toBe(IDEOGRAM_45_PROMPT_MAX)
    expect(PROMPT_MIN_LENGTH[`fal ${IDEOGRAM_45_FAL_APP}`]).toEqual({ min: 1, message: IDEOGRAM_45_NEEDS_PROMPT })
    expect(PROMPT_MAX_LENGTH[`fal ${IDEOGRAM_45_FAL_APP}`]).toEqual({ max: 10000, message: IDEOGRAM_45_LONG_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).not.toContain(`fal ${IDEOGRAM_45_FAL_APP}`)
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

describe('settings grid: every request fits the schema, the price reads what is sent', () => {
  const RATIOS: unknown[] = [...IDEOGRAM_45_RATIOS, '21:9', '3:1', 'auto', '', 7, null, undefined]
  const QUALITIES: unknown[] = [...IDEOGRAM_45_QUALITIES, 'very_low', 'High', 'auto', '', 2, true, null, undefined]
  const SEEDS: unknown[] = [0, 42, -1, 'x', undefined]

  it('ratio × quality × seed', async () => {
    let n = 0
    for (const ar of RATIOS) for (const quality of QUALITIES) for (const seed of SEEDS) {
      const opts: Record<string, unknown> = {}
      if (quality !== undefined) opts.quality = quality
      const node = gen({ ar, seed, opts })
      const label = JSON.stringify({ ar, seed, opts })
      const p = await providerPlan(node)
      expect(p.provider, label).toBe('fal')
      expect(p.endpoint, label).toBe(IDEOGRAM_45_FAL_APP)
      expect(p.backup, label).toBeUndefined()
      expect(checkPayload(schema(), p.payload), label).toEqual([])
      const wantSeed = seed === 42
      expect(Object.keys(p.payload).sort(), label).toEqual(
        ['enable_prompt_expansion', 'image_size', 'num_images', 'prompt', 'quality', ...(wantSeed ? ['seed'] : [])].sort())
      const r = typeof ar === 'string' && (IDEOGRAM_45_RATIOS as readonly string[]).includes(ar) ? ar : '1:1'
      const [w, h] = IDEOGRAM_45_SIZES[r]!
      expect(p.payload.image_size, label).toEqual({ width: w, height: h })
      const q = typeof quality === 'string' && (IDEOGRAM_45_QUALITIES as readonly string[]).includes(quality) ? quality : 'low'
      expect(p.payload.quality, label).toBe(q)
      expect(p.payload.enable_prompt_expansion, label).toBe(false)
      expect(p.payload.num_images, label).toBe(1)
      if (wantSeed) expect(p.payload.seed, label).toBe(42)
      // Priced on what is sent: the quality sent is the tier; one picture; no size reading.
      expect(effectiveImageSettings(ID, ar, node.inputs.model_options), label).toEqual({ images: 1, tier: q, megapixels: null, webSearch: false })
      expect(providerUsd('GenerateImageNode', node.inputs), label).toBeCloseTo(PRICES[q]!, 9)
      expect(requestProblems({ 1: node }), label).toEqual([])
      n++
    }
    expect(n).toBe(RATIOS.length * QUALITIES.length * SEEDS.length)
  })

  it('moodboard pictures and style text: the text joins the prompt, the pictures are not sent', async () => {
    const node = gen({ prompt: 'a fox' })
    node.inputs.style_block = 'ink wash'
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({
      prompt: 'ink wash a fox', image_size: { width: 1024, height: 1024 }, quality: 'low', enable_prompt_expansion: false, num_images: 1,
    })
  })
})

// ── Hand-written expected payloads ─────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: the schema\'s own example prompt, the defaults (1:1, the $0.03 quality)', async () => {
    // https://fal.ai/models/ideogram/v4.5/llms.txt (read 2026-10-02): prompt example
    // "A colorful storefront with a sign reading hello"; image_size default square_hd (1024 × 1024).
    const prompt = 'A colorful storefront with a sign reading hello'
    expect(inputSchema().properties.prompt.examples).toEqual([prompt])
    const p = await providerPlan(gen({ prompt }))
    expect(p.endpoint).toBe('ideogram/v4.5')
    expect(p.payload).toEqual({
      prompt, image_size: { width: 1024, height: 1024 }, quality: 'low', enable_prompt_expansion: false, num_images: 1,
    })
  })

  it('every option set: High, 16:9, a seed', async () => {
    const p = await providerPlan(gen({ prompt: 'a festival poster', ar: '16:9', seed: 1234, opts: { quality: 'high' } }))
    expect(p.payload).toEqual({
      prompt: 'a festival poster', image_size: { width: 1280, height: 720 }, quality: 'high', enable_prompt_expansion: false, num_images: 1, seed: 1234,
    })
    expect(checkPayload(schema(), p.payload)).toEqual([])
  })

  it('a linked picture\'s place (a moodboard): Ideogram 4.5 takes no picture here, so none is sent', async () => {
    const node = gen({ prompt: 'a tall poster', ar: '1:2', opts: { quality: 'medium' } })
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png', 'b.png'] })
    const p = await providerPlan(node)
    expect(p.payload).toEqual({
      prompt: 'a tall poster', image_size: { width: 720, height: 1440 }, quality: 'medium', enable_prompt_expansion: false, num_images: 1,
    })
  })

  it('the routes table: fal, no backup, and why', () => {
    expect(RUNNER_ROUTES[`image:${ID}`]).toMatchObject({ first: 'fal', backup: null })
    expect(RUNNER_ROUTES[`image:${ID}`]!.why).toMatch(/Replicate/)
    expect(IMAGE_BACKUP_RATES[ID]).toBeUndefined()
  })
})

// ── The prompt (the schema's minLength and maxLength) ─────────────────────

describe('a prompt the schema refuses is refused up front, in plain words', () => {
  const refusal = (message: string) => [{ nodeId: '1', classType: 'GenerateImageNode', input: 'prompt', message }]

  it('the words name the model, say what to do, and carry no ids', () => {
    expect(IDEOGRAM_45_NEEDS_PROMPT).toBe('Ideogram 4.5 needs a prompt. Describe the picture you want.')
    expect(IDEOGRAM_45_LONG_PROMPT).toBe('Ideogram 4.5 takes a prompt of at most 10,000 characters. Shorten it.')
    for (const s of [IDEOGRAM_45_NEEDS_PROMPT, IDEOGRAM_45_LONG_PROMPT]) expect(s).not.toMatch(/_|ideogram-4|ideogram\//)
  })

  it('before the hold: empty, missing, or over 10,000 characters as sent', () => {
    expect(requestProblems({ 1: gen({ prompt: '' }) })).toEqual(refusal(IDEOGRAM_45_NEEDS_PROMPT))
    const missing = gen()
    delete missing.inputs.prompt
    expect(requestProblems({ 1: missing })).toEqual(refusal(IDEOGRAM_45_NEEDS_PROMPT))
    expect(requestProblems({ 1: gen({ prompt: 'x'.repeat(10000) }) })).toEqual([])
    expect(requestProblems({ 1: gen({ prompt: 'x'.repeat(10001) }) })).toEqual(refusal(IDEOGRAM_45_LONG_PROMPT))
    // Style text counts: it is sent as part of the prompt.
    const styled = gen({ prompt: 'x'.repeat(9995) })
    styled.inputs.style_block = 'ink wash'
    expect(requestProblems({ 1: styled })).toEqual(refusal(IDEOGRAM_45_LONG_PROMPT))
  })

  it('at planning: the runner refuses both', async () => {
    await expect(plan(gen({ prompt: '' }))).rejects.toThrow(IDEOGRAM_45_NEEDS_PROMPT)
    await expect(plan(gen({ prompt: 'x'.repeat(10001) }))).rejects.toThrow(IDEOGRAM_45_LONG_PROMPT)
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
    expect(`${r!.title} ${r!.description}`).toContain('Ideogram 4.5')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: gen() }, titleOf: () => 'Poster' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family ideogram-4.5, with its brand name, plain words and a labelled Quality setting', () => {
    const m = IMAGE_MODELS_BY_ID[ID]!
    expect(m).toMatchObject({ runnerOnly: true, family: FAMILY, label: 'Ideogram 4.5', brand: 'Ideogram', defaultAspectRatio: '1:1', pricePerImage: 0.03 })
    expect(m.hidden).toBeUndefined()
    expect(m.advanced).toHaveLength(1)
    const q = m.advanced[0]!
    expect(q).toMatchObject({ name: 'quality', type: 'select', label: 'Quality', default: 'low', options: ['low', 'medium', 'high'] })
    expect(q.optionLabels).toEqual(['Standard', 'Fine', 'Finest'])
    for (const s of [m.label, m.pitch, m.description ?? '', q.label, q.description ?? '', ...q.optionLabels!]) {
      expect(s).not.toMatch(/_|ideogram-4|ideogram\//)
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

  it('the card: fal\'s price by quality, verified, dated, non-zero; no backup card', () => {
    expect(IMAGE_RATES[ID]).toEqual({
      unit: 'by_quality', byTier: PRICES, service: 'fal', confidence: 'verified', read: '2026-10-02',
      source: 'https://fal.ai/models/ideogram/v4.5/llms.txt',
    })
    expect(IMAGE_BACKUP_RATES[ID]).toBeUndefined()
  })

  const examples: { name: string, inputs: Record<string, unknown>, usd: number }[] = [
    { name: 'the defaults, 1:1 (the live check)', inputs: gen({ ar: '1:1' }).inputs, usd: 0.03 },
    { name: 'Fine, 16:9', inputs: gen({ ar: '16:9', opts: { quality: 'medium' } }).inputs, usd: 0.06 },
    { name: 'Finest, 1:2', inputs: gen({ ar: '1:2', opts: { quality: 'high' } }).inputs, usd: 0.22 },
    { name: 'an unknown quality (the default)', inputs: gen({ opts: { quality: 'ultra' } }).inputs, usd: 0.03 },
    { name: 'linked options (the dearest quality)', inputs: { ...gen().inputs, model_options: ['7', 0] }, usd: 0.22 },
    { name: 'a linked ratio (the size doesn\'t move the price)', inputs: { ...gen({ opts: { quality: 'medium' } }).inputs, aspect_ratio: ['7', 0] }, usd: 0.06 },
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

  it('every ratio prices the same at each quality', () => {
    for (const q of IDEOGRAM_45_QUALITIES) for (const ar of IDEOGRAM_45_RATIOS) {
      expect(providerUsd('GenerateImageNode', gen({ ar, opts: { quality: q } }).inputs), `${q} ${ar}`).toBeCloseTo(PRICES[q]!, 9)
    }
  })

  it('the gallery: the catalogue figure is the default quality\'s, "up to" the dearest; the hosted label is the charge', () => {
    expect(IMAGE_MODELS_BY_ID[ID]!.pricePerImage).toBe(0.03)
    expect(imagePriceMaxUsd(ID)).toBeCloseTo(0.22, 9)
    expect(imageRateLabel(ID, '1:1')).toBe('$0.03, up to $0.22')
    expect(imageRateLabel(ID, '1:1', { hosted: true })).toBe(`${creditsForUsd(0.03)} credits, up to ${creditsForUsd(0.22)}`)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take = (prompt = 'a poster that says HELLO'): ApiPrompt => ({
    1: gen({ prompt, ar: '1:1' }), 2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } },
  })
  const start = (k: ReturnType<typeof makeKit>, prompt?: string) =>
    k.engine.startRun({ userId: k.userId, takes: [take(prompt)], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: fal\'s ideogram/v4.5, held at the node\'s price, a real output; Replicate untouched', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual([IDEOGRAM_45_FAL_APP])
    expect(submitted[0]!.payload).toEqual({
      prompt: 'a poster that says HELLO', image_size: { width: 1024, height: 1024 }, quality: 'low', enable_prompt_expansion: false, num_images: 1,
    })
    expect(k.replicate.reqs.size).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([creditsForUsd(0.03) + 1])
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

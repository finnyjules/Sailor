/**
 * Task F7 (model line-up): Grok Imagine 2, runner-only, family
 * `grok-imagine-2` (server/runner/generators/grokImagine2.ts): "Generate an
 * image" on Replicate's xai/grok-imagine-image-2, no backup (fal lists the
 * same model but publishes no price and no OpenAPI for it yet).
 *
 * The family contract:
 *  - every payload over the settings grid fits the saved schema; the price
 *    reads what is sent (one flat price per picture);
 *  - hand-written expected payloads: plain (Replicate's own example input),
 *    every option set; the model takes no picture here (text-to-image only);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off;
 *  - the price is verified and non-zero, and badge = charge;
 *  - an empty prompt is refused up front (controller ruling after F6: the
 *    schema requires a prompt but sets no minimum);
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
  GROK_IMAGINE_2_DEFAULT_QUALITY, GROK_IMAGINE_2_DEFAULT_RESOLUTION, GROK_IMAGINE_2_QUALITIES, GROK_IMAGINE_2_RATIOS,
  GROK_IMAGINE_2_RESOLUTIONS, GROK_IMAGINE_2_SLUG,
} from '~~/server/runner/generators/grokImagine2'
import { GROK_IMAGINE_2_NEEDS_PROMPT, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, requestProblems } from '~~/server/runner/requestRules'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'grok-imagine-2'
const FAMILY: RunnerFamily = 'grok-imagine-2'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]
const PRICE = 0.04

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

const schema = () => {
  const f = loadProviderSchema('replicate', GROK_IMAGINE_2_SLUG)
  expect(f.endpoint).toBe(GROK_IMAGINE_2_SLUG)
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

/** A "Generate an image" node on Grok Imagine 2. */
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
  it('one endpoint, Replicate\'s xai/grok-imagine-image-2: the ratios, sizes and qualities, their defaults, no seed, no format', () => {
    const props = inputSchema().properties
    expect(inputSchema().required).toEqual(['prompt'])
    // Every schema ratio but `auto` (the model picks; "ignored when editing").
    expect(enumOf('aspect_ratio')).toEqual([...GROK_IMAGINE_2_RATIOS, 'auto'])
    expect(enumOf('resolution')).toEqual([...GROK_IMAGINE_2_RESOLUTIONS])
    expect(enumOf('quality')).toEqual([...GROK_IMAGINE_2_QUALITIES])
    expect(props.resolution.default).toBe(GROK_IMAGINE_2_DEFAULT_RESOLUTION)
    expect(props.quality.default).toBe(GROK_IMAGINE_2_DEFAULT_QUALITY)
    expect(props.aspect_ratio.default).toBe('1:1')
    expect(Object.keys(props).sort()).toEqual(['aspect_ratio', 'image', 'prompt', 'quality', 'resolution'])
    // The catalogue offers exactly the ratios sent.
    expect(IMAGE_MODELS_BY_ID[ID]!.aspectRatios).toEqual([...GROK_IMAGINE_2_RATIOS])
  })

  it('the prompt rule is a ruling: the schema requires a prompt but sets no minimum (controller ruling after F6)', () => {
    expect(inputSchema().properties.prompt.minLength).toBeUndefined()
    expect(PROMPT_MIN_LENGTH[`replicate ${GROK_IMAGINE_2_SLUG}`]).toEqual({ min: 1, message: GROK_IMAGINE_2_NEEDS_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).toContain(`replicate ${GROK_IMAGINE_2_SLUG}`)
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

describe('settings grid: every request fits the schema, the price reads what is sent', () => {
  const RATIOS: unknown[] = [...GROK_IMAGINE_2_RATIOS, 'auto', '5:4', '21:9', '', undefined]
  const RESOLUTIONS: unknown[] = ['1k', '2k', '4k', '1K', '', null, 2, undefined]
  const QUALITIES: unknown[] = ['low', 'medium', 'high', 'Low', '', null, true, undefined]
  const SEEDS: unknown[] = [0, 42, -1, 'x', undefined]

  it('ratio × size × quality × seed', async () => {
    let n = 0
    const want = providerUsd('GenerateImageNode', gen().inputs)
    for (const ar of RATIOS) for (const resolution of RESOLUTIONS) for (const quality of QUALITIES) for (const seed of SEEDS) {
      const opts: Record<string, unknown> = {}
      if (resolution !== undefined) opts.resolution = resolution
      if (quality !== undefined) opts.quality = quality
      const node = gen({ ar, seed, opts })
      const label = JSON.stringify({ ar, seed, opts })
      const p = await providerPlan(node)
      expect(p.provider, label).toBe('replicate')
      expect(p.endpoint, label).toBe(GROK_IMAGINE_2_SLUG)
      expect(p.backup, label).toBeUndefined()
      expect(checkPayload(schema(), p.payload), label).toEqual([])
      // Exactly these fields: never a picture, never a seed.
      expect(Object.keys(p.payload).sort(), label).toEqual(['aspect_ratio', 'prompt', 'quality', 'resolution'])
      expect(p.payload.aspect_ratio, label).toBe(typeof ar === 'string' && (GROK_IMAGINE_2_RATIOS as readonly string[]).includes(ar) ? ar : '1:1')
      expect(p.payload.resolution, label).toBe(resolution === '1k' || resolution === '2k' ? resolution : '2k')
      expect(p.payload.quality, label).toBe(quality === 'low' || quality === 'medium' ? quality : 'medium')
      // Priced on what is sent: one picture, the same price whatever the settings.
      expect(effectiveImageSettings(ID, ar, node.inputs.model_options), label).toMatchObject({ images: 1, tier: null })
      expect(providerUsd('GenerateImageNode', node.inputs), label).toBe(want)
      expect(requestProblems({ 1: node }), label).toEqual([])
      n++
    }
    expect(n).toBe(RATIOS.length * RESOLUTIONS.length * QUALITIES.length * SEEDS.length)
  })

  it('moodboard pictures and style text: the text joins the prompt, the pictures are not sent', async () => {
    const node = gen({ prompt: 'a fox' })
    node.inputs.style_block = 'ink wash'
    node.inputs.style_refs = JSON.stringify({ folder: 'moodboard_1', files: ['a.png'] })
    const p = await providerPlan(node)
    expect(p.payload.prompt).toBe('ink wash a fox')
    expect(p.payload.image).toBeUndefined()
  })
})

// ── Hand-written expected payloads ─────────────────────────────────────────

describe('hand-written payloads', () => {
  it('plain: Replicate\'s own example input, exactly (its defaults are the builder\'s)', async () => {
    // https://replicate.com/p/rdvnjtp3a5rmy0czzk99phf7s8 (the model's example, read 2026-09-24):
    // { prompt: "a mountain scene", quality: "medium", resolution: "2k", aspect_ratio: "1:1" }
    const p = await providerPlan(gen({ prompt: 'a mountain scene', ar: '1:1' }))
    expect(p.endpoint).toBe('xai/grok-imagine-image-2')
    expect(p.payload).toEqual({ prompt: 'a mountain scene', quality: 'medium', resolution: '2k', aspect_ratio: '1:1' })
    expect(p.backup).toBeUndefined()
  })

  it('every option set: a tall phone ratio, 1K, draft quality', async () => {
    const p = await providerPlan(gen({ prompt: 'a festival poster', ar: '9:19.5', seed: 1234, opts: { resolution: '1k', quality: 'low' } }))
    expect(p.payload).toEqual({ prompt: 'a festival poster', aspect_ratio: '9:19.5', resolution: '1k', quality: 'low' })
    expect(checkPayload(schema(), p.payload)).toEqual([])
  })

  it('the routes table: Replicate, no backup, and why', () => {
    expect(RUNNER_ROUTES[`image:${ID}`]).toMatchObject({ first: 'replicate', backup: null })
    expect(RUNNER_ROUTES[`image:${ID}`]!.why).toMatch(/no price/)
    expect(IMAGE_BACKUP_RATES[ID]).toBeUndefined()
  })

  it('the older Grok Imagine is untouched: its own endpoint and price', () => {
    expect(IMAGE_MODELS_BY_ID['grok-imagine']).toMatchObject({ replicateSlug: 'xai/grok-imagine-image', pricePerImage: 0.02 })
    expect(IMAGE_MODELS_BY_ID['grok-imagine']!.runnerOnly).toBeUndefined()
    expect(IMAGE_RATES['grok-imagine']!.usd).toBe(0.02)
    expect(RUNNER_NODE_RULES.GenerateImageNode!.models!['grok-imagine']).toBe('replicate-image')
  })
})

// ── An empty prompt (controller ruling after F6) ───────────────────────────

describe('an empty prompt is refused up front, in plain words', () => {
  const refusal = [{ nodeId: '1', classType: 'GenerateImageNode', input: 'prompt', message: GROK_IMAGINE_2_NEEDS_PROMPT }]

  it('the words name the model, ask for a prompt, and carry no ids', () => {
    expect(GROK_IMAGINE_2_NEEDS_PROMPT).toBe('Grok Imagine 2 needs a prompt. Describe the picture you want.')
    expect(GROK_IMAGINE_2_NEEDS_PROMPT).not.toMatch(/_|grok-imagine|xai\//)
  })

  it('before the hold: an empty prompt, or one that is missing', () => {
    expect(requestProblems({ 1: gen({ prompt: '' }) })).toEqual(refusal)
    const missing = gen()
    delete missing.inputs.prompt
    expect(requestProblems({ 1: missing })).toEqual(refusal)
  })

  it('at planning: the runner refuses it', async () => {
    await expect(plan(gen({ prompt: '' }))).rejects.toThrow(GROK_IMAGINE_2_NEEDS_PROMPT)
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
    expect(`${r!.title} ${r!.description}`).toContain('Grok Imagine 2')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: gen() }, titleOf: () => 'Poster' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family grok-imagine-2, with its brand name and plain labels', () => {
    const m = IMAGE_MODELS_BY_ID[ID]!
    expect(m).toMatchObject({ runnerOnly: true, family: FAMILY, label: 'Grok Imagine 2', brand: 'xAI', defaultAspectRatio: '1:1', replicateSlug: GROK_IMAGINE_2_SLUG })
    expect(m.hidden).toBeUndefined()
    expect(m.advanced.map(f => [f.name, f.type, f.default, f.options])).toEqual([
      ['resolution', 'select', GROK_IMAGINE_2_DEFAULT_RESOLUTION, [...GROK_IMAGINE_2_RESOLUTIONS]],
      ['quality', 'select', GROK_IMAGINE_2_DEFAULT_QUALITY, [...GROK_IMAGINE_2_QUALITIES]],
    ])
    for (const f of m.advanced) {
      expect(f.label, f.name).toMatch(/^[A-Z][a-z ]+$/)
      expect(f.optionLabels?.length, f.name).toBe(f.options!.length)
    }
    for (const s of [m.label, m.pitch, m.description ?? '', ...m.advanced.flatMap(f => [f.label, f.description ?? '', ...(f.optionLabels ?? [])])]) {
      expect(s).not.toMatch(/_|grok-imagine|xai\//)
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

  it('the card: Replicate\'s flat $0.04 an image, verified, non-zero; no backup card', () => {
    expect(IMAGE_RATES[ID]).toEqual({
      unit: 'per_image', usd: PRICE, service: 'replicate', source: 'https://replicate.com/xai/grok-imagine-image-2', read: '2026-09-24', confidence: 'verified',
    })
    expect(IMAGE_MODELS_BY_ID[ID]!.pricePerImage).toBe(PRICE)
  })

  const examples: { name: string, inputs: Record<string, unknown> }[] = [
    { name: 'at its defaults, 1:1 (the live check)', inputs: gen({ ar: '1:1' }).inputs },
    { name: 'every option set, 9:20, 1K, draft', inputs: gen({ ar: '9:20', opts: { resolution: '1k', quality: 'low' } }).inputs },
    { name: 'linked options', inputs: { ...gen().inputs, model_options: ['7', 0] } },
    { name: 'a linked ratio', inputs: { ...gen().inputs, aspect_ratio: ['7', 0] } },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $0.04; badge = charge = run estimate`, () => {
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

  it('with the family on: the family\'s own Replicate endpoint, held at the node\'s price, a real output', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    expect(k.fal.reqs.size).toBe(0)
    const submitted = [...k.replicate.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual([GROK_IMAGINE_2_SLUG])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a poster that says HELLO', aspect_ratio: '1:1', resolution: '2k', quality: 'medium' })
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

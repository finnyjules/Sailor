/**
 * Task F6 (model line-up): Qwen Image 3, runner-only, family `qwen-image-3`
 * (server/runner/generators/qwenImage3.ts): "Generate an image" on
 * Replicate's alibaba/qwen-image-3, no backup (fal's endpoint of the same
 * name is Qwen Image 3 Pro, a different model).
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
import { QWEN_IMAGE_3_RATIOS, QWEN_IMAGE_3_SEED_MAX, QWEN_IMAGE_3_SLUG, qwenImage3Seed } from '~~/server/runner/generators/qwenImage3'
import { PROMPT_MIN_LENGTH, requestProblems } from '~~/server/runner/requestRules'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'qwen-image-3'
const FAMILY: RunnerFamily = 'qwen-image-3'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const LINK = ['9', 0]

type ProviderPlan = Extract<NodePlan, { kind: 'provider' }>

const schema = () => {
  const f = loadProviderSchema('replicate', QWEN_IMAGE_3_SLUG)
  expect(f.endpoint).toBe(QWEN_IMAGE_3_SLUG)
  return f
}
/** The saved schema's input object (its $ref followed). */
function inputSchema(): Record<string, any> {
  const f = schema()
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}
function ratioEnum(): string[] {
  const f = schema()
  const p = inputSchema().properties.aspect_ratio as Record<string, any>
  return (f.components.schemas[String(p.allOf[0].$ref).split('/').pop()!] as Record<string, any>).enum as string[]
}

/** A "Generate an image" node on Qwen Image 3. */
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
  it('one endpoint, Replicate\'s alibaba/qwen-image-3: the ratios, the seed range, prompt expansion on by default, no output format', () => {
    const props = inputSchema().properties
    expect(inputSchema().required).toEqual(['prompt'])
    expect(ratioEnum()).toEqual([...QWEN_IMAGE_3_RATIOS])
    expect(props.seed.type).toBe('integer')
    expect(props.seed.description).toContain(`Range: 0-${QWEN_IMAGE_3_SEED_MAX}`)
    expect(props.enable_prompt_expansion.default).toBe(true)
    expect(props.negative_prompt.type).toBe('string')
    expect(props.output_format).toBeUndefined()
    // The catalogue offers exactly the schema's ratios.
    expect(IMAGE_MODELS_BY_ID[ID]!.aspectRatios).toEqual([...QWEN_IMAGE_3_RATIOS])
  })

  it('no prompt rule: the schema sets no minimum', () => {
    expect(inputSchema().properties.prompt.minLength).toBeUndefined()
    expect(PROMPT_MIN_LENGTH[`replicate ${QWEN_IMAGE_3_SLUG}`]).toBeUndefined()
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

describe('settings grid: every request fits the schema, the price reads what is sent', () => {
  const RATIOS: unknown[] = [...QWEN_IMAGE_3_RATIOS, '5:4', '21:9', 'match_input_image', '', undefined]
  const EXPANSION: unknown[] = [true, false, 'false', 'true', 0, 1, null, undefined]
  const NEGATIVE: unknown[] = ['blurry, low quality', '', null, 3, undefined]
  const SEEDS: unknown[] = [0, -5, 1, 42, QWEN_IMAGE_3_SEED_MAX, QWEN_IMAGE_3_SEED_MAX + 1, 2 ** 53 - 1, '7', 'x', undefined]

  it('ratio × prompt expansion × leave out × seed', async () => {
    let n = 0
    const want = await providerUsd('GenerateImageNode', gen().inputs)
    for (const ar of RATIOS) for (const expansion of EXPANSION) for (const negative of NEGATIVE) for (const seed of SEEDS) {
      const opts: Record<string, unknown> = {}
      if (expansion !== undefined) opts.enable_prompt_expansion = expansion
      if (negative !== undefined) opts.negative_prompt = negative
      const node = gen({ ar, seed, opts })
      const label = JSON.stringify({ ar, seed, opts })
      const p = await providerPlan(node)
      expect(p.provider, label).toBe('replicate')
      expect(p.endpoint, label).toBe(QWEN_IMAGE_3_SLUG)
      expect(p.backup, label).toBeUndefined()
      expect(checkPayload(schema(), p.payload), label).toEqual([])
      // Only the schema's fields, and never a picture.
      for (const k of Object.keys(p.payload)) expect(['prompt', 'aspect_ratio', 'enable_prompt_expansion', 'negative_prompt', 'seed'], `${label} ${k}`).toContain(k)
      expect(p.payload.aspect_ratio, label).toBe(typeof ar === 'string' && (QWEN_IMAGE_3_RATIOS as readonly string[]).includes(ar) ? ar : '1:1')
      expect(typeof p.payload.enable_prompt_expansion, label).toBe('boolean')
      if ('seed' in p.payload) {
        expect(p.payload.seed as number, label).toBeGreaterThanOrEqual(1)
        expect(p.payload.seed as number, label).toBeLessThanOrEqual(QWEN_IMAGE_3_SEED_MAX)
      }
      // Priced on what is sent: one picture, the same price whatever the settings.
      expect(effectiveImageSettings(ID, ar, node.inputs.model_options), label).toMatchObject({ images: 1, tier: null })
      expect(providerUsd('GenerateImageNode', node.inputs), label).toBe(want)
      expect(requestProblems({ 1: node }), label).toEqual([])
      n++
    }
    expect(n).toBe(RATIOS.length * EXPANSION.length * NEGATIVE.length * SEEDS.length)
  })

  it('a seed above the schema\'s range folds into it, the same way every time', () => {
    expect(qwenImage3Seed(QWEN_IMAGE_3_SEED_MAX)).toBe(QWEN_IMAGE_3_SEED_MAX)
    expect(qwenImage3Seed(QWEN_IMAGE_3_SEED_MAX + 1)).toBe(1)
    expect(qwenImage3Seed(QWEN_IMAGE_3_SEED_MAX + 1)).toBe(qwenImage3Seed(QWEN_IMAGE_3_SEED_MAX + 1))
    expect(qwenImage3Seed(42)).toBe(42)
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
  it('plain: Replicate\'s own example input (its defaults sent as the schema\'s defaults)', async () => {
    // https://replicate.com/p/ft59zn500nrmr0d04khs2gcj9g (the model's example):
    // { prompt: "An unimaginable parallel universe", aspect_ratio: "1:1", negative_prompt: "",
    //   match_input_image: false, enable_prompt_expansion: true }
    const p = await providerPlan(gen({ prompt: 'An unimaginable parallel universe', ar: '1:1' }))
    expect(p.endpoint).toBe('alibaba/qwen-image-3')
    expect(p.payload).toEqual({ prompt: 'An unimaginable parallel universe', aspect_ratio: '1:1', enable_prompt_expansion: true })
    const props = inputSchema().properties
    expect(p.payload.enable_prompt_expansion).toBe(props.enable_prompt_expansion.default)
    expect(p.payload.aspect_ratio).toBe(props.aspect_ratio.default)
    expect(p.backup).toBeUndefined()
  })

  it('every option set: 2:1, prompt rewrite off, something to leave out, a seed', async () => {
    const p = await providerPlan(gen({
      prompt: 'a festival poster', ar: '2:1', seed: 1234,
      opts: { enable_prompt_expansion: false, negative_prompt: 'watermark, blurry' },
    }))
    expect(p.payload).toEqual({
      prompt: 'a festival poster', aspect_ratio: '2:1', enable_prompt_expansion: false, negative_prompt: 'watermark, blurry', seed: 1234,
    })
    expect(checkPayload(schema(), p.payload)).toEqual([])
  })

  it('the routes table: Replicate, no backup, and why', () => {
    expect(RUNNER_ROUTES[`image:${ID}`]).toMatchObject({ first: 'replicate', backup: null })
    expect(RUNNER_ROUTES[`image:${ID}`]!.why).toMatch(/Pro/)
    expect(IMAGE_BACKUP_RATES[ID]).toBeUndefined()
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
    expect(`${r!.title} ${r!.description}`).toContain('Qwen Image 3')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: { 1: gen() }, titleOf: () => 'Poster' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family qwen-image-3, with its brand name and plain labels', () => {
    const m = IMAGE_MODELS_BY_ID[ID]!
    expect(m).toMatchObject({ runnerOnly: true, family: FAMILY, label: 'Qwen Image 3', brand: 'Alibaba', defaultAspectRatio: '1:1', replicateSlug: QWEN_IMAGE_3_SLUG })
    expect(m.hidden).toBeUndefined()
    expect(m.advanced.map(f => [f.name, f.type, f.default])).toEqual([
      ['enable_prompt_expansion', 'boolean', true],
      ['negative_prompt', 'string', ''],
    ])
    for (const f of m.advanced) expect(f.label, f.name).toMatch(/^[A-Z][a-z ]+$/)
    for (const s of [m.label, m.pitch, m.description ?? '', ...m.advanced.map(f => `${f.label} ${f.description ?? ''}`)]) {
      expect(s).not.toMatch(/_|qwen-image/)
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

  it('the card: Replicate\'s flat $0.03 an image, verified, non-zero; no backup card', () => {
    expect(IMAGE_RATES[ID]).toEqual({
      unit: 'per_image', usd: 0.03, service: 'replicate', source: 'https://replicate.com/alibaba/qwen-image-3', read: '2026-09-24', confidence: 'verified',
    })
    expect(IMAGE_MODELS_BY_ID[ID]!.pricePerImage).toBe(0.03)
  })

  const examples: { name: string, inputs: Record<string, unknown> }[] = [
    { name: 'at its defaults, 1:1 (the live check)', inputs: gen({ ar: '1:1' }).inputs },
    { name: 'every option set, 1:2', inputs: gen({ ar: '1:2', seed: 9, opts: { enable_prompt_expansion: false, negative_prompt: 'text' } }).inputs },
    { name: 'linked options', inputs: { ...gen().inputs, model_options: ['7', 0] } },
    { name: 'a linked ratio', inputs: { ...gen().inputs, aspect_ratio: ['7', 0] } },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $0.03; badge = charge = run estimate`, () => {
      expect(providerUsd('GenerateImageNode', ex.inputs)).toBeCloseTo(0.03, 9)
      const credits = creditsForUsd(0.03)
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
    expect(imagePriceMaxUsd(ID)).toBeCloseTo(0.03, 9)
    expect(imageRateLabel(ID, '1:1')).toBe(imageRateLabel('photon', '1:1')) // Photon is also $0.03 flat on Replicate
    expect(imageRateLabel(ID, '1:1', { hosted: true })).toBe(`${creditsForUsd(0.03)} credits`)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = { 1: gen({ ar: '1:1' }), 2: { class_type: 'Image', inputs: { image: '', export: false, images: ['1', 0], batch_index: -1 } } }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: the family\'s own Replicate endpoint, held at the node\'s price, a real output', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    expect(k.fal.reqs.size).toBe(0)
    const submitted = [...k.replicate.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual([QWEN_IMAGE_3_SLUG])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a poster that says HELLO', aspect_ratio: '1:1', enable_prompt_expansion: true })
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
})

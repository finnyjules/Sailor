/**
 * Task F3 (model line-up): Hailuo H3 Max Turbo, runner-only, family
 * `h3-max-turbo`, on fal (server/runner/generators/h3MaxTurbo.ts): H3 Max's
 * builder on Turbo's app, because the two schemas match field for field.
 *
 * The family contract:
 *  - the saved schemas: Turbo's own endpoint ids, fal's pricing text, and the
 *    same input as H3 Max's;
 *  - every payload over the settings grid fits its endpoint's saved schema
 *    (fixtures/provider-schemas/fal/minimax__h3-max-turbo__*.json), is H3
 *    Max's payload, and carries the seconds and resolution the price reads;
 *  - hand-written expected payloads: plain (the schema's own example prompt),
 *    every option set, a picture linked (with a last frame);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off;
 *  - the price is verified and non-zero, and badge = charge;
 *  - the engine, end to end: the family's own endpoint, and the hold.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { __resetModelMenusForTests, galleryEntries, menuDefault, modelMenu } from '#shared/runner/modelMenus'
import { creditsForUsd } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { videoBackupRate, videoRate, videoRateLabel, videoUsd } from '#shared/pricing/videoRates'
import { effectiveVideoSettings, maxVideoSeconds } from '#shared/pricing/videoSettings'
import { FILM_SHOT_MODEL_PREFERENCE, VIDEO_MODELS, VIDEO_MODELS_BY_ID, VIDEO_MODEL_PREFERENCE } from '~~/app/data/video-models'
import { allowedDurations } from '~/lib/videoModelAdapt'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode } from '~~/server/runner/executors'
import { asInt, parseJsonObject } from '~~/server/runner/generators/opts'
import { RUNNER_VIDEO_MODELS, falVideoFn } from '~~/server/runner/generators/video'
import {
  H3_MAX_TURBO, H3_MAX_TURBO_ENDPOINTS, H3_MAX_TURBO_IMAGE_TO_VIDEO, H3_MAX_TURBO_NEEDS_PROMPT, H3_MAX_TURBO_TEXT_TO_VIDEO, RUNNER_ONLY_FAL_VIDEO_MODELS,
} from '~~/server/runner/generators/h3MaxTurbo'
import { PROMPT_MIN_LENGTH, requestProblems } from '~~/server/runner/requestRules'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'hailuo-h3-max-turbo'
const FAMILY: RunnerFamily = 'h3-max-turbo'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const H3_MAX = RUNNER_VIDEO_MODELS['hailuo-h3-max']!

const schema = (endpoint: string) => {
  const f = loadProviderSchema('fal', endpoint)
  expect(f.endpoint).toBe(endpoint)
  return f
}
/** The endpoint's input schema, its $ref followed. */
function inputOf(endpoint: string): Record<string, any> {
  const f = loadProviderSchema('fal', endpoint)
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}

/** A Generate-a-video node on H3 Max Turbo; `image` links a picture from node 9. */
function vid(o: { model?: string, prompt?: string, duration?: unknown, opts?: Record<string, unknown>, image?: boolean, ar?: string, seed?: number } = {}) {
  const inputs: Record<string, unknown> = {
    model: o.model ?? ID, prompt: o.prompt ?? 'a fox in the snow', aspect_ratio: o.ar ?? '16:9', duration: o.duration ?? '5', seed: o.seed ?? 0,
    model_options: JSON.stringify(o.opts ?? {}),
  }
  if (o.image) inputs.image = ['9', 0]
  return { class_type: 'GenerateVideoNode', inputs }
}

/** planNode for one node, with the linked picture handed off as `IMG:<name>`. */
function plan(node: { class_type: string, inputs: Record<string, unknown> }) {
  return planNode({
    prompt: { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, n: node },
    nodeId: 'n',
    filesFrom: () => [{ filename: 'first.png', subfolder: '', type: 'input' }],
    toUrl: async (f: OutputFile) => `IMG:${f.filename}`,
    gateOpen: false,
  })
}

async function providerPlan(node: { class_type: string, inputs: Record<string, unknown> }) {
  const p = await plan(node)
  if (p.kind !== 'provider') throw new Error(`expected a provider call, got ${p.kind}`)
  return p
}

// ── Schemas ─────────────────────────────────────────────────────────────────

describe('the saved schemas', () => {
  it('one per endpoint the family calls, each its own endpoint id, with fal\'s pricing text', () => {
    expect([...H3_MAX_TURBO_ENDPOINTS].sort()).toEqual(['minimax/h3-max-turbo/image-to-video', 'minimax/h3-max-turbo/text-to-video'])
    for (const e of H3_MAX_TURBO_ENDPOINTS) {
      const f = schema(e)
      // The script stamps the UTC date: read on the evening of 24 Sep 2026 (local), 25 Sep in UTC.
      expect(f.fetchedAt, e).toMatch(/^2026-09-2[45]$/)
      expect(f.sources?.schema, e).toBe(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${e}`)
      // The list price after the launch promotion, which the rate card uses.
      expect(f.pricingText, e).toMatch(/after which \*\*480p\*\* is \*\*\$0\.025\*\*\/second, \*\*768p\*\* is \*\*\$0\.04\*\*\/second, and \*\*1080p\*\* is \*\*\$0\.08\*\*\/second/)
    }
  })

  it('Turbo\'s input is H3 Max\'s, field for field (so H3 Max\'s builder is Turbo\'s)', () => {
    expect(inputOf(H3_MAX_TURBO_TEXT_TO_VIDEO)).toEqual(inputOf('minimax/h3-max/text-to-video'))
    expect(inputOf(H3_MAX_TURBO_IMAGE_TO_VIDEO)).toEqual(inputOf('minimax/h3-max/image-to-video'))
  })

  it('the builder is H3 Max\'s, on Turbo\'s app, with H3 Max\'s modes; no other runner-only fal video model rides on it', () => {
    expect(H3_MAX_TURBO).toMatchObject({ id: ID, label: 'Hailuo H3 Max Turbo', app: 'minimax/h3-max-turbo', defaultDuration: H3_MAX.defaultDuration })
    expect(H3_MAX_TURBO.fnByMode).toEqual(H3_MAX.fnByMode)
    expect(Object.keys(RUNNER_ONLY_FAL_VIDEO_MODELS)).toEqual([ID])
    expect(RUNNER_VIDEO_MODELS[ID]).toBeUndefined()
  })

  it('an empty prompt is refused on both endpoints, as the schema\'s minLength says', () => {
    for (const e of H3_MAX_TURBO_ENDPOINTS) {
      expect(inputOf(e).properties.prompt.minLength, e).toBe(1)
      expect(PROMPT_MIN_LENGTH[`fal ${e}`], e).toEqual({ min: 1, message: H3_MAX_TURBO_NEEDS_PROMPT })
    }
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

const MODES = [
  { name: 'text', endpoint: H3_MAX_TURBO_TEXT_TO_VIDEO, image: null, extra: {} },
  { name: 'first frame', endpoint: H3_MAX_TURBO_IMAGE_TO_VIDEO, image: 'https://x/first.png', extra: {} },
  { name: 'first and last frame', endpoint: H3_MAX_TURBO_IMAGE_TO_VIDEO, image: 'https://x/first.png', extra: { end_image_url: 'https://x/last.png' } },
  { name: 'first frame from the options', endpoint: H3_MAX_TURBO_IMAGE_TO_VIDEO, image: null, extra: { image_url: 'https://x/first.png' } },
]

describe('every payload over the settings grid fits its schema, is H3 Max\'s, and carries what the price reads', () => {
  for (const m of MODES) {
    it(`${m.name}: durations × resolutions × prompt rewrite × aspect ratios × seeds`, () => {
      const cat = VIDEO_MODELS_BY_ID[ID]!
      const durations: unknown[] = [...[...new Set([...cat.durations, 1, 4, 7, 8, 15, 16, 60])].flatMap(n => [n, String(n)]), undefined, '', 'eight', '8s']
      const resolutions = [...(cat.resolutions ?? []), '480p', '1080p', '1080P', '2k', '4k', 'nope', undefined]
      const rewrites: unknown[] = ['disabled', 'balanced', 'quality', 'fast', 'nope', undefined]
      const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive', '']
      const seeds = [0, 7, 2147483648]
      const f = schema(m.endpoint)
      let cases = 0
      const bad: string[] = []
      // Every length × resolution × rewrite at 16:9 and no seed, then every ratio × seed at those.
      const combos: [unknown, unknown, unknown, string, number][] = []
      for (const dur of durations) for (const res of resolutions) for (const pem of rewrites) combos.push([dur, res, pem, '16:9', 0])
      for (const dur of ['5', '10']) for (const ar of ratios) for (const seed of seeds) combos.push([dur, undefined, undefined, ar, seed])
      for (const [dur, res, pem, ar, seed] of combos) {
        const adv: Record<string, unknown> = { ...m.extra }
        if (res !== undefined) adv.resolution = res
        if (pem !== undefined) adv.prompt_expansion_mode = pem
        const opts = JSON.stringify(adv)
        // As planNode calls it.
        const args = { prompt: 'p', aspectRatio: ar, duration: asInt(dur, H3_MAX_TURBO.defaultDuration), seed, image: m.image, adv: parseJsonObject(opts) }
        const payload = H3_MAX_TURBO.build(args)
        const fn = falVideoFn(payload, H3_MAX_TURBO.fnByMode)
        cases++
        if (`${H3_MAX_TURBO.app}/${fn}` !== m.endpoint) bad.push(`${opts}: endpoint ${fn}`)
        for (const e of checkPayload(f, payload)) bad.push(`${opts} ${String(dur)} ${ar} ${seed}: ${e}`)
        if (JSON.stringify(payload) !== JSON.stringify(H3_MAX.build(args))) bad.push(`${opts}: not H3 Max's payload`)
        const priced = effectiveVideoSettings(ID, dur, ar, opts, m.image)!
        const sent = { seconds: payload.duration, resolution: String(payload.resolution).toLowerCase() }
        if (priced.seconds !== sent.seconds || priced.resolution !== sent.resolution || priced.audio !== true) {
          bad.push(`${opts} ${String(dur)}: sent ${JSON.stringify(sent)}, priced ${JSON.stringify(priced)}`)
        }
      }
      expect(bad.slice(0, 5)).toEqual([])
      expect(cases).toBeGreaterThan(1000)
    })
  }
})

// ── Expected payloads (through planNode) ───────────────────────────────────

describe('expected payloads', () => {
  it('plain: text-to-video with the schema\'s own example prompt, at the node\'s defaults', async () => {
    const example = inputOf(H3_MAX_TURBO_TEXT_TO_VIDEO).properties.prompt.examples[0] as string
    expect(example).toMatch(/^A white kitten chases a butterfly/)
    const p = await providerPlan(vid({ prompt: example }))
    expect(p.provider).toBe('fal')
    expect(p.endpoint).toBe('minimax/h3-max-turbo/text-to-video')
    expect(p.payload).toEqual({ prompt: example, duration: 5, resolution: '768P', prompt_expansion_mode: 'balanced', aspect_ratio: '16:9' })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('every option set', async () => {
    const p = await providerPlan(vid({ duration: '10', ar: '9:16', seed: 42, opts: { resolution: '1080p', prompt_expansion_mode: 'quality' } }))
    expect(p.endpoint).toBe('minimax/h3-max-turbo/text-to-video')
    expect(p.payload).toEqual({ prompt: 'a fox in the snow', duration: 10, resolution: '1080P', prompt_expansion_mode: 'quality', aspect_ratio: '9:16', seed: 42 })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('a picture linked: image-to-video, the picture as the first frame, the last frame from the options, no ratio', async () => {
    const p = await providerPlan(vid({ image: true, duration: '6', opts: { end_image_url: 'https://x/last.png', prompt_expansion_mode: 'disabled' } }))
    expect(p.endpoint).toBe('minimax/h3-max-turbo/image-to-video')
    expect(p.payload).toEqual({
      prompt: 'a fox in the snow', duration: 6, resolution: '768P', prompt_expansion_mode: 'disabled',
      image_url: 'IMG:first.png', end_image_url: 'https://x/last.png',
    })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })
})

describe('an empty prompt is refused in plain words, before and at planning', () => {
  for (const [name, node] of [['text', vid({ prompt: '' })], ['a picture linked', vid({ prompt: '', image: true })]] as const) {
    it(name, async () => {
      expect(requestProblems({ n: node })).toEqual([{ nodeId: 'n', classType: 'GenerateVideoNode', input: 'prompt', message: H3_MAX_TURBO_NEEDS_PROMPT }])
      await expect(plan(node)).rejects.toThrow(H3_MAX_TURBO_NEEDS_PROMPT)
    })
  }
})

// ── Eligibility and blocking ───────────────────────────────────────────────

describe('eligibility follows the family switch', () => {
  const t2v: ApiPrompt = { 1: vid() }
  const i2v: ApiPrompt = { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, 1: vid({ image: true }) }

  it('off (no families, or every other family): not taken', () => {
    for (const p of [t2v, i2v]) {
      expect(isRunnerEligible(p)).toBe(false)
      expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
      expect(isRunnerEligible(p, ALL_BUT)).toBe(false)
    }
  })

  it('on: taken, with or without a picture; never with the prompt or options wired, or sound linked', () => {
    for (const p of [t2v, i2v]) {
      expect(isRunnerEligible(p, ON)).toBe(true)
      expect(isRunnerEligible(p, ALL)).toBe(true)
    }
    for (const wired of ['prompt', 'model_options', 'audio']) {
      const n = vid()
      n.inputs[wired] = ['9', 0]
      expect(isRunnerEligible({ 9: { class_type: 'Image', inputs: { image: 'a.png' } }, 1: n }, ON), wired).toBe(false)
    }
  })

  it('Film a shot is never taken (the runner does not run it)', () => {
    expect(isRunnerEligible({ 1: { class_type: 'FilmShotNode', inputs: { model: ID } } }, ALL)).toBe(false)
  })
})

describe('blockedModelUses', () => {
  const t2v: ApiPrompt = { 1: vid() }
  const use = (classType = 'GenerateVideoNode') => ({ nodeId: '1', classType, value: ID, reason: 'runner-only' })

  it('refuses the model while the family is off, on either path', () => {
    expect(blockedModelUses(t2v)).toEqual([use()])
    expect(blockedModelUses(t2v, { families: ALL_BUT, runnerTakes: true })).toEqual([use()])
  })

  it('lets it through only on a runner run with the family on', () => {
    expect(blockedModelUses(t2v, { families: ON, runnerTakes: true })).toEqual([])
    // Going to ComfyUI (the family on but the run not the runner's): refused.
    expect(blockedModelUses(t2v, { families: ON })).toEqual([use()])
    // Film a shot: never.
    expect(blockedModelUses({ 1: { class_type: 'FilmShotNode', inputs: { model: ID } } }, { families: ALL, runnerTakes: true }))
      .toEqual([use('FilmShotNode')])
  })

  it('a workflow that needs the engine is refused before it goes there, naming the model and the engine-only node', () => {
    const p: ApiPrompt = { 1: vid(), 2: { class_type: 'KSampler', inputs: {} } }
    const titles: Record<string, string> = { 1: 'Clip', 2: 'Old sampler' }
    const r = blockedRunRefusal([{ prompt: p, titleOf: id => titles[id] ?? 'Unnamed node' }], { runnerOn: true, families: ON })
    expect(r).not.toBeNull()
    expect(`${r!.title} ${r!.description}`).toContain('Hailuo H3 Max Turbo')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: t2v, titleOf: () => 'Clip' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery and the defaults', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family h3-max-turbo, with a plain name and H3 Max\'s settings', () => {
    const m = VIDEO_MODELS_BY_ID[ID]!
    const max = VIDEO_MODELS_BY_ID['hailuo-h3-max']!
    expect(m.runnerOnly).toBe(true)
    expect(m.family).toBe('h3-max-turbo')
    expect(m.hidden).toBeUndefined()
    expect(m.label).toBe('Hailuo H3 Max Turbo')
    expect(m.brand).toBe('MiniMax')
    for (const k of ['modes', 'aspectRatios', 'defaultAspectRatio', 'durations', 'defaultDuration', 'resolutions', 'defaultResolution', 'supportsSeed', 'advanced'] as const) {
      expect(m[k], k).toEqual(max[k])
    }
    // Every length the menu offers is one the builder sends as is.
    expect(m.durations.every(d => H3_MAX_TURBO.build({ prompt: 'p', aspectRatio: '16:9', duration: d, seed: 0, image: null, adv: {} }).duration === d)).toBe(true)
    expect(allowedDurations(ID)).toEqual(m.durations.map(String))
  })

  it('hidden from "Generate a video" while the family is off, shown while on; never on "Film a shot"', () => {
    const shown = (cls: string, f: ReadonlySet<RunnerFamily>) => galleryEntries(VIDEO_MODELS, { classType: cls, families: f, current: null }).map(e => e.model.id)
    expect(shown('GenerateVideoNode', NO_FAMILIES)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ALL_BUT)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ON)).toContain(ID)
    expect(shown('FilmShotNode', ALL)).not.toContain(ID)
    // A saved node on Turbo still shows its model, tagged, while the family is off.
    const saved = galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: NO_FAMILIES, current: ID })
    expect(saved.find(e => e.model.id === ID)).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
  })

  it('a new node\'s default does not move to Turbo', () => {
    expect(VIDEO_MODEL_PREFERENCE).not.toContain(ID)
    expect(FILM_SHOT_MODEL_PREFERENCE).not.toContain(ID)
    expect(menuDefault(modelMenu('GenerateVideoNode')!, ALL)).toBe(VIDEO_MODEL_PREFERENCE[0])
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  /** What priceGraph charges for one node plus an output node. */
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs }, 2: SINK }).credits

  it('fal\'s list rate per second by resolution (after the launch promotion), verified, non-zero, no backup', () => {
    expect(videoRate(ID)).toMatchObject({
      unit: 'per_second', service: 'fal', confidence: 'verified', read: '2026-09-24',
      source: 'https://fal.ai/models/minimax/h3-max-turbo/text-to-video/llms.txt',
      byResolution: { '480p': 0.025, '768p': 0.04, '1080p': 0.08 },
    })
    expect(videoBackupRate(ID)).toBeNull()
    // Half of H3 Max's list rate at every resolution.
    const max = videoRate('hailuo-h3-max')!.byResolution as Record<string, number>
    for (const [res, usd] of Object.entries(videoRate(ID)!.byResolution as Record<string, number>)) expect(usd * 2, res).toBeCloseTo(max[res]!, 9)
  })

  const examples: { name: string, inputs: Record<string, unknown>, usd: number }[] = [
    { name: '5 s at 768p (the live check, the node\'s defaults)', inputs: { model: ID, duration: '5', model_options: '{}' }, usd: 0.20 },
    { name: '10 s at 768p', inputs: { model: ID, duration: '10', model_options: '{}' }, usd: 0.40 },
    { name: '6 s at 480p, a picture linked', inputs: { model: ID, duration: '6', model_options: '{"resolution":"480p"}', image: ['9', 0] }, usd: 0.15 },
    { name: '10 s at 1080p', inputs: { model: ID, duration: '10', model_options: '{"resolution":"1080p"}' }, usd: 0.80 },
    { name: 'a resolution it has no such setting for is sent (and priced) as 768p', inputs: { model: ID, duration: '5', model_options: '{"resolution":"4k"}' }, usd: 0.20 },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $${ex.usd.toFixed(2)}; badge = charge = run estimate`, () => {
      expect(providerUsd('GenerateVideoNode', ex.inputs)).toBeCloseTo(ex.usd, 9)
      const credits = creditsForUsd(ex.usd)
      expect(credits).toBeGreaterThan(0)
      expect(nodeCredits('GenerateVideoNode', ex.inputs)).toBe(credits)
      const c = charge(ex.inputs)
      expect(c).toBe(credits + 1) // + base render
      expect(nodeCreditEstimate('GenerateVideoNode', ex.inputs)).toBe(c)
      const names = Object.keys(ex.inputs)
      const est = estimateUsdForNodes([{ id: '1', type: 'GenerateVideoNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]) }], { hosted: true })!
      expect(est.hostedCredits).toBe(c)
    })
  }

  it('a linked length prices at the longest sent (10 s); linked options at the top rate', () => {
    expect(maxVideoSeconds(ID)).toBe(10)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: ['7', 0], model_options: '{}' })).toBeCloseTo(0.40, 9)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: '5', model_options: ['7', 0] })).toBeCloseTo(0.40, 9)
    for (const inputs of [
      { model: ID, duration: ['7', 0], model_options: '{}' },
      { model: ID, duration: '5', model_options: ['7', 0] },
    ]) expect(nodeCreditEstimate('GenerateVideoNode', inputs)).toBe(charge(inputs))
  })

  it('priced on what is sent: the planned payload\'s seconds and resolution give the price', async () => {
    for (const image of [false, true]) {
      for (const [dur, res] of [['1', '480p'], ['7', '768p'], ['8', '1080p'], ['45', 'nope']] as const) {
        const node = vid({ image, duration: dur, opts: { resolution: res } })
        const p = await providerPlan(node)
        const rate = videoRate(ID)!.byResolution[String(p.payload.resolution).toLowerCase()] as number
        expect(providerUsd('GenerateVideoNode', node.inputs), `${image} ${dur} ${res}`).toBeCloseTo(rate * Number(p.payload.duration), 9)
      }
    }
  })

  it('the gallery label reads the rate at the default resolution', () => {
    expect(videoRateLabel(ID)).toBe('$0.04/s at 768p')
    expect(videoUsd(ID, effectiveVideoSettings(ID, '5', '16:9', '{}')!)).toBeCloseTo(0.2, 9)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = { 1: vid(), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: the family\'s own fal endpoint, held at the node\'s price, a real output', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual(['minimax/h3-max-turbo/text-to-video'])
    expect(submitted[0]!.payload).toMatchObject({ resolution: '768P', duration: 5 })
    expect(k.replicate.reqs.size).toBe(0)
    const holds = [...k.ledger.holds.values()]
    expect(holds.map(h => h.credits)).toEqual([creditsForUsd(0.20) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT } })
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})

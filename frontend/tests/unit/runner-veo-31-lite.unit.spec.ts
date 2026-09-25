/**
 * Task F5 (model line-up): Veo 3.1 Lite, runner-only, family `veo-3.1-lite`,
 * on fal (server/runner/generators/veo31Lite.ts): Veo 3.1's builder on
 * Lite's app, because the two schemas match field for field apart from
 * Lite's resolutions (720p and 1080p, no 4k).
 *
 * The family contract:
 *  - the saved schemas: Lite's own endpoint ids, fal's pricing text, and
 *    Veo 3.1's input bar the resolution enum;
 *  - every payload over the settings grid fits its endpoint's saved schema
 *    (fixtures/provider-schemas/fal/fal-ai__veo3.1__lite*.json), is Veo 3.1's
 *    payload (4k aside), and carries the seconds, resolution and sound the
 *    price reads;
 *  - hand-written expected payloads: plain (the schema's own example prompt),
 *    every option set, a picture linked (the schema's own example picture);
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
import { RUNNER_ONLY_FAL_VIDEO_MODELS } from '~~/server/runner/generators/h3MaxTurbo'
import { RUNNER_GEMINI_OMNI_FLASH_MODELS } from '~~/server/runner/generators/geminiOmniFlash'
import {
  RUNNER_VEO_31_LITE_MODELS, VEO_31_LITE, VEO_31_LITE_ENDPOINTS, VEO_31_LITE_IMAGE_TO_VIDEO, VEO_31_LITE_RESOLUTIONS, VEO_31_LITE_TEXT_TO_VIDEO,
} from '~~/server/runner/generators/veo31Lite'
import { PROMPT_MIN_LENGTH } from '~~/server/runner/requestRules'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'veo-3.1-lite'
const FAMILY: RunnerFamily = 'veo-3.1-lite'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const VEO_31 = RUNNER_VIDEO_MODELS['veo-3.1']!

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
/** The input's fields with the annotations (title, description, examples) left out. */
function fieldsOf(endpoint: string): Record<string, any> {
  const input = inputOf(endpoint)
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(input.properties as Record<string, any>)) {
    const { title: _t, description: _d, examples: _e, ...rest } = v
    out[k] = rest
  }
  return { required: input.required, properties: out }
}

/** A Generate-a-video node on Veo 3.1 Lite; `image` links a picture from node 9. */
function vid(o: { model?: string, prompt?: string, duration?: unknown, opts?: Record<string, unknown>, image?: boolean, ar?: string, seed?: number } = {}) {
  const inputs: Record<string, unknown> = {
    model: o.model ?? ID, prompt: o.prompt ?? 'a fox in the snow', aspect_ratio: o.ar ?? '16:9', duration: o.duration ?? '8', seed: o.seed ?? 0,
    model_options: JSON.stringify(o.opts ?? {}),
  }
  if (o.image) inputs.image = ['9', 0]
  return { class_type: 'GenerateVideoNode', inputs }
}

/** planNode for one node, with the linked picture handed off as `url` (default `IMG:<name>`). */
function plan(node: { class_type: string, inputs: Record<string, unknown> }, url?: string) {
  return planNode({
    prompt: { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, n: node },
    nodeId: 'n',
    filesFrom: () => [{ filename: 'first.png', subfolder: '', type: 'input' }],
    toUrl: async (f: OutputFile) => url ?? `IMG:${f.filename}`,
    gateOpen: false,
  })
}

async function providerPlan(node: { class_type: string, inputs: Record<string, unknown> }, url?: string) {
  const p = await plan(node, url)
  if (p.kind !== 'provider') throw new Error(`expected a provider call, got ${p.kind}`)
  return p
}

// ── Schemas ─────────────────────────────────────────────────────────────────

describe('the saved schemas', () => {
  it('one per endpoint the family calls, each its own endpoint id, with fal\'s pricing text', () => {
    expect([...VEO_31_LITE_ENDPOINTS].sort()).toEqual(['fal-ai/veo3.1/lite', 'fal-ai/veo3.1/lite/image-to-video'])
    for (const e of VEO_31_LITE_ENDPOINTS) {
      const f = schema(e)
      // The script stamps the UTC date: read on the evening of 24 Sep 2026 (local), 25 Sep in UTC.
      expect(f.fetchedAt, e).toMatch(/^2026-09-2[45]$/)
      expect(f.sources?.schema, e).toBe(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${e}`)
      expect(f.pricingText, e).toMatch(/\*\*\$0\.05\*\* for 720p with audio, \*\*\$0\.03\*\* for 720p without audio, \*\*\$0\.08\*\* for 1080p with audio or \*\*\$0\.05\*\* for 1080p without audio/)
    }
  })

  it('Lite\'s input is Veo 3.1\'s, field for field, except that it has no 4k', () => {
    for (const [lite, full] of [[VEO_31_LITE_TEXT_TO_VIDEO, 'fal-ai/veo3.1'], [VEO_31_LITE_IMAGE_TO_VIDEO, 'fal-ai/veo3.1/image-to-video']] as const) {
      const a = fieldsOf(lite)
      const b = fieldsOf(full)
      expect(a.properties.resolution.enum, lite).toEqual(VEO_31_LITE_RESOLUTIONS)
      expect(b.properties.resolution.enum, full).toEqual([...VEO_31_LITE_RESOLUTIONS, '4k'])
      delete a.properties.resolution.enum
      delete b.properties.resolution.enum
      expect(a, lite).toEqual(b)
    }
  })

  it('the builder is Veo 3.1\'s, on Lite\'s app, with Veo 3.1\'s two modes; it is no other table\'s model', () => {
    expect(VEO_31_LITE).toMatchObject({ id: ID, label: 'Veo 3.1 Lite', app: 'fal-ai/veo3.1/lite', defaultDuration: VEO_31.defaultDuration })
    expect(VEO_31_LITE.fnByMode).toEqual({ t2v: VEO_31.fnByMode.t2v, firstLast: VEO_31.fnByMode.firstLast })
    expect(Object.keys(RUNNER_VEO_31_LITE_MODELS)).toEqual([ID])
    expect(RUNNER_VIDEO_MODELS[ID]).toBeUndefined()
    expect(RUNNER_ONLY_FAL_VIDEO_MODELS[ID]).toBeUndefined()
    expect(RUNNER_GEMINI_OMNI_FLASH_MODELS[ID]).toBeUndefined()
  })

  it('no endpoint sets a prompt minimum, so no prompt rule is added (as for Veo 3.1)', () => {
    for (const e of VEO_31_LITE_ENDPOINTS) {
      expect(inputOf(e).properties.prompt.minLength, e).toBeUndefined()
      expect(PROMPT_MIN_LENGTH[`fal ${e}`], e).toBeUndefined()
    }
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

const MODES = [
  { name: 'text', endpoint: VEO_31_LITE_TEXT_TO_VIDEO, image: null },
  { name: 'first frame', endpoint: VEO_31_LITE_IMAGE_TO_VIDEO, image: 'https://x/first.png' },
]

describe('every payload over the settings grid fits its schema, is Veo 3.1\'s, and carries what the price reads', () => {
  for (const m of MODES) {
    it(`${m.name}: durations × resolutions × sound × prompt fix × negative prompt, then aspect ratios × seeds`, () => {
      const cat = VIDEO_MODELS_BY_ID[ID]!
      const durations: unknown[] = [...[...new Set([...cat.durations, 1, 3, 5, 7, 9, 10, 60])].flatMap(n => [n, String(n)]), undefined, '', 'eight', '8s']
      const resolutions = [...(cat.resolutions ?? []), '1080P', '4k', '4K', '480p', 'nope', undefined]
      const sounds: unknown[] = [true, false, 'false', 0, undefined]
      const fixes: unknown[] = [true, false, undefined]
      const negatives: unknown[] = ['blurry', '', undefined]
      const ratios = ['16:9', '9:16', '1:1', 'auto', '']
      const seeds = [0, 7, 2147483648, 2 ** 40]
      const f = schema(m.endpoint)
      let cases = 0
      const bad: string[] = []
      const combos: [unknown, unknown, unknown, unknown, unknown, string, number][] = []
      for (const dur of durations) for (const res of resolutions) for (const snd of sounds) for (const fix of fixes) for (const neg of negatives) combos.push([dur, res, snd, fix, neg, '16:9', 0])
      for (const dur of ['4', '8']) for (const ar of ratios) for (const seed of seeds) combos.push([dur, undefined, undefined, undefined, undefined, ar, seed])
      for (const [dur, res, snd, fix, neg, ar, seed] of combos) {
        const adv: Record<string, unknown> = {}
        if (res !== undefined) adv.resolution = res
        if (snd !== undefined) adv.generate_audio = snd
        if (fix !== undefined) adv.enhance_prompt = fix
        if (neg !== undefined) adv.negative_prompt = neg
        const opts = JSON.stringify(adv)
        // As planNode calls it.
        const args = { prompt: 'p', aspectRatio: ar, duration: asInt(dur, VEO_31_LITE.defaultDuration), seed, image: m.image, adv: parseJsonObject(opts) }
        const payload = VEO_31_LITE.build(args)
        const fn = falVideoFn(payload, VEO_31_LITE.fnByMode)
        cases++
        const endpoint = fn ? `${VEO_31_LITE.app}/${fn}` : VEO_31_LITE.app
        if (endpoint !== m.endpoint) bad.push(`${opts}: endpoint ${endpoint}`)
        for (const e of checkPayload(f, payload)) bad.push(`${opts} ${String(dur)} ${ar} ${seed}: ${e}`)
        // Veo 3.1's payload, but for a resolution Lite lacks, which goes as 720p.
        const full = VEO_31.build(args)
        if (!VEO_31_LITE_RESOLUTIONS.includes(String(full.resolution))) full.resolution = '720p'
        if (JSON.stringify(payload) !== JSON.stringify(full)) bad.push(`${opts}: not Veo 3.1's payload`)
        const priced = effectiveVideoSettings(ID, dur, ar, opts, m.image)!
        const sent = { seconds: Number.parseInt(String(payload.duration), 10), resolution: payload.resolution, audio: payload.generate_audio }
        if (priced.seconds !== sent.seconds || priced.resolution !== sent.resolution || priced.audio !== sent.audio) {
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
    const example = inputOf(VEO_31_LITE_TEXT_TO_VIDEO).properties.prompt.examples[0] as string
    expect(example).toMatch(/^A massive blue whale glides/)
    const p = await providerPlan(vid({ prompt: example }))
    expect(p.provider).toBe('fal')
    expect(p.endpoint).toBe('fal-ai/veo3.1/lite')
    expect(p.payload).toEqual({ prompt: example, duration: '8s', resolution: '720p', generate_audio: true, auto_fix: true, aspect_ratio: '16:9' })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('every option set', async () => {
    const p = await providerPlan(vid({
      duration: '6', ar: '9:16', seed: 42,
      opts: { resolution: '1080p', generate_audio: false, enhance_prompt: false, negative_prompt: 'text, logos' },
    }))
    expect(p.endpoint).toBe('fal-ai/veo3.1/lite')
    expect(p.payload).toEqual({
      prompt: 'a fox in the snow', duration: '6s', resolution: '1080p', generate_audio: false, auto_fix: false,
      negative_prompt: 'text, logos', aspect_ratio: '9:16', seed: 42,
    })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('a picture linked: image-to-video with the schema\'s own example prompt and picture, no ratio (the picture sets it)', async () => {
    const props = inputOf(VEO_31_LITE_IMAGE_TO_VIDEO).properties
    const prompt = props.prompt.examples[0] as string
    const picture = props.image_url.examples[0] as string
    expect(prompt).toBe('The subject turns to face the camera and smiles warmly.')
    const p = await providerPlan(vid({ prompt, image: true, duration: '4' }), picture)
    expect(p.endpoint).toBe('fal-ai/veo3.1/lite/image-to-video')
    expect(p.payload).toEqual({ prompt, duration: '4s', resolution: '720p', generate_audio: true, auto_fix: true, image_url: picture })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('4k (Veo 3.1\'s own top setting, left in a node switched to Lite) is sent as 720p', async () => {
    const p = await providerPlan(vid({ opts: { resolution: '4k' } }))
    expect(p.payload.resolution).toBe('720p')
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
  })
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
    expect(`${r!.title} ${r!.description}`).toContain('Veo 3.1 Lite')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: t2v, titleOf: () => 'Clip' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery and the defaults', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family veo-3.1-lite, with a plain name and Veo 3.1\'s settings at 720p or 1080p', () => {
    const m = VIDEO_MODELS_BY_ID[ID]!
    const veo = VIDEO_MODELS_BY_ID['veo-3.1']!
    expect(m.runnerOnly).toBe(true)
    expect(m.family).toBe('veo-3.1-lite')
    expect(m.hidden).toBeUndefined()
    expect(m.label).toBe('Veo 3.1 Lite')
    expect(m.brand).toBe('Google')
    for (const k of ['modes', 'aspectRatios', 'defaultAspectRatio', 'durations', 'defaultDuration', 'supportsSeed'] as const) {
      expect(m[k], k).toEqual(veo[k])
    }
    expect(m.resolutions).toEqual(VEO_31_LITE_RESOLUTIONS)
    expect(m.defaultResolution).toBe('720p')
    // The settings the builder reads, each with a sentence-case label.
    expect(m.advanced.map(a => a.name)).toEqual(['generate_audio', 'negative_prompt', 'enhance_prompt'])
    for (const a of m.advanced) expect(a.label, a.name).toMatch(/^[A-Z][a-z ]+$/)
    // Every length the menu offers is one the builder sends as is.
    expect(m.durations.every(d => VEO_31_LITE.build({ prompt: 'p', aspectRatio: '16:9', duration: d, seed: 0, image: null, adv: {} }).duration === `${d}s`)).toBe(true)
    expect(allowedDurations(ID)).toEqual(m.durations.map(String))
  })

  it('hidden from "Generate a video" while the family is off, shown while on; never on "Film a shot"', () => {
    const shown = (cls: string, f: ReadonlySet<RunnerFamily>) => galleryEntries(VIDEO_MODELS, { classType: cls, families: f, current: null }).map(e => e.model.id)
    expect(shown('GenerateVideoNode', NO_FAMILIES)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ALL_BUT)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ON)).toContain(ID)
    expect(shown('FilmShotNode', ALL)).not.toContain(ID)
    // A saved node on Lite still shows its model, tagged, while the family is off.
    const saved = galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: NO_FAMILIES, current: ID })
    expect(saved.find(e => e.model.id === ID)).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
  })

  it('a new node\'s default does not move to Lite', () => {
    expect(VIDEO_MODEL_PREFERENCE).not.toContain(ID)
    expect(FILM_SHOT_MODEL_PREFERENCE).not.toContain(ID)
    expect(menuDefault(modelMenu('GenerateVideoNode')!, ALL)).toBe(VIDEO_MODEL_PREFERENCE[0])
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  /** What priceGraph charges for one node plus an output node. */
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs }, 2: SINK }).credits

  it('fal\'s rate per second by resolution and sound, verified, non-zero, no backup', () => {
    expect(videoRate(ID)).toMatchObject({
      unit: 'per_second', service: 'fal', confidence: 'verified', read: '2026-09-24',
      source: 'https://fal.ai/models/fal-ai/veo3.1/lite/llms.txt',
      byResolution: { '720p': { audio: 0.05, silent: 0.03 }, '1080p': { audio: 0.08, silent: 0.05 } },
    })
    expect(videoBackupRate(ID)).toBeNull()
  })

  const examples: { name: string, inputs: Record<string, unknown>, usd: number }[] = [
    { name: '4 s at 720p, sound off (the live check)', inputs: { model: ID, duration: '4', model_options: '{"generate_audio":false}' }, usd: 0.12 },
    { name: '4 s at 720p with sound (fal\'s own example)', inputs: { model: ID, duration: '4', model_options: '{}' }, usd: 0.20 },
    { name: '8 s at 720p with sound (the node\'s defaults)', inputs: { model: ID, duration: '8', model_options: '{}' }, usd: 0.40 },
    { name: '8 s at 1080p with sound, a picture linked', inputs: { model: ID, duration: '8', model_options: '{"resolution":"1080p"}', image: ['9', 0] }, usd: 0.64 },
    { name: '6 s at 1080p, sound off', inputs: { model: ID, duration: '6', model_options: '{"resolution":"1080p","generate_audio":false}' }, usd: 0.30 },
    { name: 'a 4k setting is sent (and priced) as 720p', inputs: { model: ID, duration: '8', model_options: '{"resolution":"4k"}' }, usd: 0.40 },
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

  it('a linked length prices at the longest sent (8 s); linked options at the top rate (1080p with sound)', () => {
    expect(maxVideoSeconds(ID)).toBe(8)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: ['7', 0], model_options: '{}' })).toBeCloseTo(0.40, 9)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: '4', model_options: ['7', 0] })).toBeCloseTo(0.08 * 4, 9)
    for (const inputs of [
      { model: ID, duration: ['7', 0], model_options: '{}' },
      { model: ID, duration: '4', model_options: ['7', 0] },
    ]) expect(nodeCreditEstimate('GenerateVideoNode', inputs)).toBe(charge(inputs))
  })

  it('priced on what is sent: the planned payload\'s seconds, resolution and sound give the price', async () => {
    for (const image of [false, true]) {
      for (const [dur, res, snd] of [['1', '720p', true], ['5', '1080p', false], ['7', '4k', true], ['45', 'nope', false]] as const) {
        const node = vid({ image, duration: dur, opts: { resolution: res, generate_audio: snd } })
        const p = await providerPlan(node)
        const card = videoRate(ID)!.byResolution[String(p.payload.resolution)] as { audio: number, silent: number }
        const rate = p.payload.generate_audio ? card.audio : card.silent
        expect(providerUsd('GenerateVideoNode', node.inputs), `${image} ${dur} ${res}`).toBeCloseTo(rate * Number.parseInt(String(p.payload.duration), 10), 9)
      }
    }
  })

  it('the gallery label reads the rate at the default settings (720p with sound)', () => {
    expect(videoRateLabel(ID)).toBe('$0.05/s at 720p')
    expect(videoUsd(ID, effectiveVideoSettings(ID, '4', '16:9', '{}')!)).toBeCloseTo(0.2, 9)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = { 1: vid({ duration: '4', opts: { generate_audio: false } }), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: the family\'s own fal endpoint, held at the node\'s price, a real output', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual(['fal-ai/veo3.1/lite'])
    expect(submitted[0]!.payload).toMatchObject({ resolution: '720p', duration: '4s', generate_audio: false })
    expect(k.replicate.reqs.size).toBe(0)
    const holds = [...k.ledger.holds.values()]
    expect(holds.map(h => h.credits)).toEqual([creditsForUsd(0.12) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT } })
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})

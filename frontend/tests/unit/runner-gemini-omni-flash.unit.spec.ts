/**
 * Task F4 (model line-up): Gemini Omni Flash, runner-only, family
 * `gemini-omni-flash`, on fal (server/runner/generators/geminiOmniFlash.ts).
 * Text-to-video is the bare app id `google/gemini-omni-flash`; image-to-video
 * is `google/gemini-omni-flash/image-to-video`. No backup.
 *
 * The family contract:
 *  - the saved schemas: the endpoint ids, fal's pricing text, and the fields
 *    the builder relies on;
 *  - every payload over the settings grid fits its endpoint's saved schema
 *    (fixtures/provider-schemas/fal/google__gemini-omni-flash*.json) and
 *    carries the seconds the price reads;
 *  - hand-written expected payloads: plain (the schema's own example prompt),
 *    every option set, a picture linked (the schema's own example prompt);
 *  - a last frame or references are refused in plain words, never dropped;
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
import {
  GEMINI_OMNI_FLASH, GEMINI_OMNI_FLASH_ENDPOINTS, GEMINI_OMNI_FLASH_IMAGE_TO_VIDEO, GEMINI_OMNI_FLASH_ONE_PICTURE,
  GEMINI_OMNI_FLASH_SECONDS, GEMINI_OMNI_FLASH_TEXT_TO_VIDEO, RUNNER_GEMINI_OMNI_FLASH_MODELS,
} from '~~/server/runner/generators/geminiOmniFlash'
import { PROMPT_MIN_LENGTH, requestProblems } from '~~/server/runner/requestRules'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const ID = 'gemini-omni-flash'
const FAMILY: RunnerFamily = 'gemini-omni-flash'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }

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

/** A Generate-a-video node on Gemini Omni Flash; `image` links a picture from node 9. */
function vid(o: { prompt?: string, duration?: unknown, opts?: Record<string, unknown>, image?: boolean, ar?: string, seed?: number } = {}) {
  const inputs: Record<string, unknown> = {
    model: ID, prompt: o.prompt ?? 'a fox in the snow', aspect_ratio: o.ar ?? '16:9', duration: o.duration ?? '8', seed: o.seed ?? 0,
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
    // Text-to-video is the bare app (fal has no google/gemini-omni-flash/text-to-video).
    expect([...GEMINI_OMNI_FLASH_ENDPOINTS].sort()).toEqual(['google/gemini-omni-flash', 'google/gemini-omni-flash/image-to-video'])
    const perSecond: Record<string, string> = {
      [GEMINI_OMNI_FLASH_TEXT_TO_VIDEO]: '0.125',
      [GEMINI_OMNI_FLASH_IMAGE_TO_VIDEO]: '0.13',
    }
    for (const e of GEMINI_OMNI_FLASH_ENDPOINTS) {
      const f = schema(e)
      // The script stamps the UTC date: read on the evening of 24 Sep 2026 (local), 25 Sep in UTC.
      expect(f.fetchedAt, e).toMatch(/^2026-09-2[45]$/)
      expect(f.sources?.schema, e).toBe(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${e}`)
      expect(f.pricingText, e).toContain('total token consumption')
      expect(f.pricingText, e).toContain(`For 720p video this costs **approximately $${perSecond[e]} per second of video**`)
    }
  })

  it('the fields the builder relies on: 16:9 or 9:16, 3–10 whole seconds, no resolution, seed or sound switch', () => {
    const t2v = inputOf(GEMINI_OMNI_FLASH_TEXT_TO_VIDEO)
    const i2v = inputOf(GEMINI_OMNI_FLASH_IMAGE_TO_VIDEO)
    expect(Object.keys(t2v.properties).sort()).toEqual(['aspect_ratio', 'duration', 'prompt'])
    expect(Object.keys(i2v.properties).sort()).toEqual(['aspect_ratio', 'duration', 'image_url', 'prompt'])
    expect(i2v.required.sort()).toEqual(['image_url', 'prompt'])
    for (const s of [t2v, i2v]) {
      expect(s.properties.aspect_ratio.enum).toEqual(['16:9', '9:16'])
      expect(s.properties.duration).toMatchObject({ type: 'integer', minimum: 3, maximum: 10, default: 8 })
      // No minLength in either schema.
      expect(s.properties.prompt.minLength).toBeUndefined()
    }
    // Controller ruling after F4: text-to-video refuses an empty prompt up front all the same
    // (request-refusals.unit.spec.ts); image-to-video takes one.
    expect(PROMPT_MIN_LENGTH[`fal ${GEMINI_OMNI_FLASH_TEXT_TO_VIDEO}`]).toMatchObject({ min: 1 })
    expect(PROMPT_MIN_LENGTH[`fal ${GEMINI_OMNI_FLASH_IMAGE_TO_VIDEO}`]).toBeUndefined()
    expect(GEMINI_OMNI_FLASH_SECONDS.every(s => s >= 3 && s <= 10)).toBe(true)
    expect(GEMINI_OMNI_FLASH.defaultDuration).toBe(t2v.properties.duration.default)
  })

  it('its own builder, found by planNode after the other fal tables', () => {
    expect(GEMINI_OMNI_FLASH).toMatchObject({ id: ID, label: 'Gemini Omni Flash', app: 'google/gemini-omni-flash', fnByMode: { t2v: '', firstLast: 'image-to-video' } })
    expect(Object.keys(RUNNER_GEMINI_OMNI_FLASH_MODELS)).toEqual([ID])
    expect(RUNNER_VIDEO_MODELS[ID]).toBeUndefined()
    expect(RUNNER_ONLY_FAL_VIDEO_MODELS[ID]).toBeUndefined()
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

const MODES = [
  { name: 'text', endpoint: GEMINI_OMNI_FLASH_TEXT_TO_VIDEO, image: null, extra: {} },
  { name: 'first frame', endpoint: GEMINI_OMNI_FLASH_IMAGE_TO_VIDEO, image: 'https://x/first.png', extra: {} },
  { name: 'first frame from the options', endpoint: GEMINI_OMNI_FLASH_IMAGE_TO_VIDEO, image: null, extra: { image_url: 'https://x/first.png' } },
  // Empty reference lists and an empty last frame are nothing to refuse.
  { name: 'empty extras', endpoint: GEMINI_OMNI_FLASH_TEXT_TO_VIDEO, image: null, extra: { image_urls: [], video_urls: [], audio_urls: [], end_image_url: '' } },
]

describe('every payload over the settings grid fits its schema and carries what the price reads', () => {
  for (const m of MODES) {
    it(`${m.name}: durations × aspect ratios × stray options × seeds`, () => {
      const cat = VIDEO_MODELS_BY_ID[ID]!
      const durations: unknown[] = [...[...new Set([...cat.durations, 0, 1, 3, 5, 7, 9, 11, 15, 60, -4])].flatMap(n => [n, String(n)]), undefined, '', 'eight', '8s', 7.9]
      const ratios = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive', '']
      // Settings other models keep in the options: the builder never sends them.
      const strays: Record<string, unknown>[] = [{}, { resolution: '1080p' }, { resolution: '4k' }, { generate_audio: false }, { negative_prompt: 'blur' }, { enhance_prompt: true }]
      const seeds = [0, 7, 2147483648]
      const f = schema(m.endpoint)
      let cases = 0
      const bad: string[] = []
      for (const dur of durations) for (const ar of ratios) for (const stray of strays) for (const seed of seeds) {
        const opts = JSON.stringify({ ...stray, ...m.extra })
        // As planNode calls it.
        const args = { prompt: 'p', aspectRatio: ar, duration: asInt(dur, GEMINI_OMNI_FLASH.defaultDuration), seed, image: m.image, adv: parseJsonObject(opts) }
        const payload = GEMINI_OMNI_FLASH.build(args)
        const fn = falVideoFn(payload, GEMINI_OMNI_FLASH.fnByMode)
        cases++
        if ((fn ? `${GEMINI_OMNI_FLASH.app}/${fn}` : GEMINI_OMNI_FLASH.app) !== m.endpoint) bad.push(`${opts}: endpoint ${fn}`)
        for (const e of checkPayload(f, payload)) bad.push(`${opts} ${String(dur)} ${ar} ${seed}: ${e}`)
        if (!['16:9', '9:16'].includes(payload.aspect_ratio as string) || (ar === '9:16') !== (payload.aspect_ratio === '9:16')) bad.push(`${ar}: sent ${String(payload.aspect_ratio)}`)
        const priced = effectiveVideoSettings(ID, dur, ar, opts, m.image)!
        if (priced.seconds !== payload.duration || priced.resolution !== '720p' || priced.audio !== true) {
          bad.push(`${opts} ${String(dur)}: sent ${String(payload.duration)} s, priced ${JSON.stringify(priced)}`)
        }
      }
      expect(bad.slice(0, 5)).toEqual([])
      expect(cases).toBeGreaterThan(3000)
    })
  }
})

// ── Expected payloads (through planNode) ───────────────────────────────────

describe('expected payloads', () => {
  it('plain: text-to-video with the schema\'s own example prompt, at the node\'s defaults', async () => {
    const example = inputOf(GEMINI_OMNI_FLASH_TEXT_TO_VIDEO).properties.prompt.examples[0] as string
    expect(example).toMatch(/^A cinematic wide shot of a lighthouse/)
    const p = await providerPlan(vid({ prompt: example }))
    expect(p.provider).toBe('fal')
    expect(p.endpoint).toBe('google/gemini-omni-flash')
    expect(p.payload).toEqual({ prompt: example, aspect_ratio: '16:9', duration: 8 })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('every option set (the seed and stray options are never sent)', async () => {
    const p = await providerPlan(vid({ duration: '10', ar: '9:16', seed: 42, opts: { resolution: '1080p', generate_audio: false, negative_prompt: 'blur' } }))
    expect(p.endpoint).toBe('google/gemini-omni-flash')
    expect(p.payload).toEqual({ prompt: 'a fox in the snow', aspect_ratio: '9:16', duration: 10 })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('a picture linked: image-to-video with the schema\'s own example prompt, the picture as the first frame', async () => {
    const example = inputOf(GEMINI_OMNI_FLASH_IMAGE_TO_VIDEO).properties.prompt.examples[0] as string
    expect(example).toMatch(/^The dog turns its head/)
    const p = await providerPlan(vid({ prompt: example, image: true, duration: '4', ar: '9:16' }))
    expect(p.endpoint).toBe('google/gemini-omni-flash/image-to-video')
    expect(p.payload).toEqual({ prompt: example, aspect_ratio: '9:16', duration: 4, image_url: 'IMG:first.png' })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('the linked picture wins over image_url in the options', async () => {
    const p = await providerPlan(vid({ image: true, opts: { image_url: 'https://x/other.png' } }))
    expect(p.payload.image_url).toBe('IMG:first.png')
  })
})

describe('a last frame or references are refused in plain words, before and at planning (never dropped)', () => {
  const cases: [string, Record<string, unknown>, boolean][] = [
    ['a last frame', { end_image_url: 'https://x/last.png' }, true],
    ['reference pictures', { image_urls: ['https://x/a.png'] }, false],
    ['reference videos', { video_urls: ['https://x/a.mp4'] }, false],
    ['reference sounds', { audio_urls: ['https://x/a.mp3'] }, false],
    ['reference pictures beside a first frame', { image_urls: ['https://x/a.png'] }, true],
  ]
  for (const [name, opts, image] of cases) {
    it(name, async () => {
      const node = vid({ opts, image })
      expect(requestProblems({ n: node })).toEqual([{ nodeId: 'n', classType: 'GenerateVideoNode', input: 'model_options', message: GEMINI_OMNI_FLASH_ONE_PICTURE }])
      await expect(plan(node)).rejects.toThrow(GEMINI_OMNI_FLASH_ONE_PICTURE)
    })
  }
  it('the words name the model and say what to do, with no ids', () => {
    expect(GEMINI_OMNI_FLASH_ONE_PICTURE).toMatch(/^Gemini Omni Flash /)
    expect(GEMINI_OMNI_FLASH_ONE_PICTURE).not.toMatch(/_|url/i)
  })
  it('wired options are not judged before the run; plain nodes pass', () => {
    const wired = vid()
    wired.inputs.model_options = ['7', 0]
    expect(requestProblems({ n: wired })).toEqual([])
    expect(requestProblems({ n: vid() })).toEqual([])
    expect(requestProblems({ n: vid({ image: true, prompt: '' }) })).toEqual([])
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
    expect(`${r!.title} ${r!.description}`).toContain('Gemini Omni Flash')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: t2v, titleOf: () => 'Clip' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery and the defaults', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family gemini-omni-flash, with a plain name and the schema\'s settings', () => {
    const m = VIDEO_MODELS_BY_ID[ID]!
    expect(m.runnerOnly).toBe(true)
    expect(m.family).toBe('gemini-omni-flash')
    expect(m.hidden).toBeUndefined()
    expect(m.label).toBe('Gemini Omni Flash')
    expect(m.brand).toBe('Google')
    expect(m.modes).toEqual(['t2v', 'i2v'])
    expect(m.aspectRatios).toEqual(inputOf(GEMINI_OMNI_FLASH_TEXT_TO_VIDEO).properties.aspect_ratio.enum)
    expect(m.durations).toEqual(GEMINI_OMNI_FLASH_SECONDS)
    expect(m.defaultDuration).toBe(8)
    expect(m.resolutions).toEqual(['720p'])
    expect(m.supportsSeed).toBe(false)
    expect(m.advanced).toEqual([])
    // Copy promises no mode the app can't send (no last frame, references or editing).
    expect(`${m.pitch} ${m.description}`).not.toMatch(/last frame|reference|edit/i)
    expect(m.tags).not.toContain('reference')
    // Every length the menu offers is one the builder sends as is.
    expect(m.durations.every(d => GEMINI_OMNI_FLASH.build({ prompt: 'p', aspectRatio: '16:9', duration: d, seed: 0, image: null, adv: {} }).duration === d)).toBe(true)
    expect(allowedDurations(ID)).toEqual(m.durations.map(String))
  })

  it('hidden from "Generate a video" while the family is off, shown while on; never on "Film a shot"', () => {
    const shown = (cls: string, f: ReadonlySet<RunnerFamily>) => galleryEntries(VIDEO_MODELS, { classType: cls, families: f, current: null }).map(e => e.model.id)
    expect(shown('GenerateVideoNode', NO_FAMILIES)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ALL_BUT)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ON)).toContain(ID)
    expect(shown('FilmShotNode', ALL)).not.toContain(ID)
    // A saved node on Gemini Omni Flash still shows its model, tagged, while the family is off.
    const saved = galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: NO_FAMILIES, current: ID })
    expect(saved.find(e => e.model.id === ID)).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
  })

  it('a new node\'s default does not move to Gemini Omni Flash', () => {
    expect(VIDEO_MODEL_PREFERENCE).not.toContain(ID)
    expect(FILM_SHOT_MODEL_PREFERENCE).not.toContain(ID)
    expect(menuDefault(modelMenu('GenerateVideoNode')!, ALL)).toBe(VIDEO_MODEL_PREFERENCE[0])
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  /** What priceGraph charges for one node plus an output node. */
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs }, 2: SINK }).credits

  it('fal\'s own per-second figure at 720p (the higher of its two endpoints), verified, non-zero, no backup', () => {
    expect(videoRate(ID)).toMatchObject({
      unit: 'per_second', service: 'fal', confidence: 'verified', read: '2026-09-24',
      source: 'https://fal.ai/models/google/gemini-omni-flash/image-to-video/llms.txt',
      byResolution: { '720p': 0.13 },
    })
    expect(videoBackupRate(ID)).toBeNull()
  })

  const examples: { name: string, inputs: Record<string, unknown>, usd: number }[] = [
    { name: '4 s (the live check: the shortest clip, its one resolution)', inputs: { model: ID, duration: '4', model_options: '{}' }, usd: 0.52 },
    { name: '8 s (the node\'s default)', inputs: { model: ID, duration: '8', model_options: '{}' }, usd: 1.04 },
    { name: '10 s, portrait', inputs: { model: ID, duration: '10', aspect_ratio: '9:16', model_options: '{}' }, usd: 1.30 },
    { name: '6 s, a picture linked', inputs: { model: ID, duration: '6', model_options: '{}', image: ['9', 0] }, usd: 0.78 },
    { name: 'a resolution it has no setting for is still 720p', inputs: { model: ID, duration: '4', model_options: '{"resolution":"4k"}' }, usd: 0.52 },
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

  it('a linked length prices at the longest sent (10 s); linked options change nothing', () => {
    expect(maxVideoSeconds(ID)).toBe(10)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: ['7', 0], model_options: '{}' })).toBeCloseTo(1.30, 9)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: '4', model_options: ['7', 0] })).toBeCloseTo(0.52, 9)
    for (const inputs of [
      { model: ID, duration: ['7', 0], model_options: '{}' },
      { model: ID, duration: '4', model_options: ['7', 0] },
    ]) expect(nodeCreditEstimate('GenerateVideoNode', inputs)).toBe(charge(inputs))
  })

  it('priced on what is sent: the planned payload\'s seconds give the price', async () => {
    for (const image of [false, true]) {
      for (const dur of ['1', '3', '5', '7', '9', '45']) {
        const node = vid({ image, duration: dur })
        const p = await providerPlan(node)
        expect(providerUsd('GenerateVideoNode', node.inputs), `${image} ${dur}`).toBeCloseTo(0.13 * Number(p.payload.duration), 9)
      }
    }
  })

  it('the gallery label reads the rate at its one resolution', () => {
    expect(videoRateLabel(ID)).toBe('$0.13/s at 720p')
    expect(videoUsd(ID, effectiveVideoSettings(ID, '4', '16:9', '{}')!)).toBeCloseTo(0.52, 9)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = { 1: vid({ duration: '4' }), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: the family\'s own fal endpoint, held at the node\'s price, a real output', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual(['google/gemini-omni-flash'])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a fox in the snow', aspect_ratio: '16:9', duration: 4 })
    expect(k.replicate.reqs.size).toBe(0)
    const holds = [...k.ledger.holds.values()]
    expect(holds.map(h => h.credits)).toEqual([creditsForUsd(0.52) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT } })
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })

  it('a node with a last frame is refused before anything is held', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const refused: ApiPrompt = { 1: vid({ opts: { end_image_url: 'https://x/last.png' } }), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
    await expect(k.engine.startRun({ userId: k.userId, takes: [refused], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toThrow(GEMINI_OMNI_FLASH_ONE_PICTURE)
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})

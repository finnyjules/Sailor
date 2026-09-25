/**
 * Task F1 (model line-up): Wan 3.0 and Wan 3.0 Prime, runner-only, family
 * `wan-3`, on fal (server/runner/generators/wan3.ts).
 *
 * The family contract:
 *  - every payload over the settings grid fits its endpoint's saved schema
 *    (fixtures/provider-schemas/fal/alibaba__wan-3.0*.json), and carries the
 *    seconds, resolution and sound the price reads (settings parity);
 *  - hand-written expected payloads: plain (the schema's own example prompt),
 *    every option set, a picture linked, reference pictures, Prime;
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the models while the family is off;
 *  - the price is verified and non-zero, and badge = charge;
 *  - the engine, end to end: the family's own endpoint, and the hold.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { __resetModelMenusForTests, applyModelOverlay, galleryEntries, menuDefault, modelMenu, runnerOnlyVideoDurations } from '#shared/runner/modelMenus'
import { creditsForUsd } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { videoBackupRate, videoRate, videoRateLabel, videoUsd } from '#shared/pricing/videoRates'
import { effectiveVideoSettings, maxVideoSeconds } from '#shared/pricing/videoSettings'
import { VIDEO_MODELS, VIDEO_MODELS_BY_ID, VIDEO_MODEL_PREFERENCE } from '~~/app/data/video-models'
import { allowedDurations } from '~/lib/videoModelAdapt'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes } from '~/lib/costEstimate'
import { planNode } from '~~/server/runner/executors'
import { asInt, parseJsonObject } from '~~/server/runner/generators/opts'
import {
  WAN_30_IMAGE_TO_VIDEO, WAN_30_PRIME_IMAGE_TO_VIDEO, WAN_30_REFERENCE_TO_VIDEO, WAN_30_TEXT_TO_VIDEO, WAN_3_ENDPOINTS,
  FIRST_FRAME_AND_REFERENCES, WAN_3_NEEDS_PROMPT, WAN_3_PICTURES_ONLY, WAN_3_PRIME_NEEDS_FIRST_FRAME, WAN_3_SECONDS, WAN_3_TOO_MANY_REFERENCES,
  wan3Call, wan3PromptTags, type Wan3Id,
} from '~~/server/runner/generators/wan3'
import { requestProblems } from '~~/server/runner/requestRules'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { makeKit } from './__runner__/kit'

const WAN: RunnerFamily = 'wan-3'
const ON: ReadonlySet<RunnerFamily> = new Set([WAN])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT_WAN: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== WAN))
const IDS: Wan3Id[] = ['wan-3.0', 'wan-3.0-prime']
const SINK = { class_type: 'SaveImage', inputs: {} }

const schema = (endpoint: string) => {
  const f = loadProviderSchema('fal', endpoint)
  expect(f.endpoint).toBe(endpoint)
  return f
}

/** A Generate-a-video node on a Wan model; `image` links a picture from node 9. */
function vid(model: string, o: { prompt?: string, duration?: unknown, opts?: Record<string, unknown>, image?: boolean, ar?: string, seed?: number } = {}) {
  const inputs: Record<string, unknown> = {
    model, prompt: o.prompt ?? 'a fox in the snow', aspect_ratio: o.ar ?? '16:9', duration: o.duration ?? '5', seed: o.seed ?? 0,
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
    expect([...WAN_3_ENDPOINTS].sort()).toEqual([
      'alibaba/wan-3.0-prime/image-to-video', 'alibaba/wan-3.0/image-to-video',
      'alibaba/wan-3.0/reference-to-video', 'alibaba/wan-3.0/text-to-video',
    ])
    for (const e of WAN_3_ENDPOINTS) {
      const f = schema(e)
      // The script stamps the UTC date: read on the evening of 24 Sep 2026 (local), 25 Sep in UTC.
      expect(f.fetchedAt, e).toMatch(/^2026-09-2[45]$/)
      expect(f.sources?.schema, e).toBe(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${e}`)
    }
    for (const e of [WAN_30_TEXT_TO_VIDEO, WAN_30_IMAGE_TO_VIDEO, WAN_30_REFERENCE_TO_VIDEO]) {
      expect(schema(e).pricingText, e).toMatch(/\$0\.05\*\* \*\*480p\*\*, \*\*\$0\.10\*\* \*\*720p\*\*, or \*\*\$0\.20\*\* \*\*1080p/)
    }
    expect(schema(WAN_30_PRIME_IMAGE_TO_VIDEO).pricingText).toMatch(/\$0\.068\*\* at \*\*480p\*\*, \*\*\$0\.14\*\* at \*\*720p\*\*, or \*\*\$0\.28\*\* at \*\*1080p/)
  })

  it('the clip lengths are the schemas\' whole seconds 2–30; the resolutions their enum', () => {
    for (const e of WAN_3_ENDPOINTS) {
      const f = schema(e)
      let input = f.input as Record<string, any>
      while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
      const d = input.properties.duration.anyOf.find((x: any) => x.type === 'integer')
      expect(WAN_3_SECONDS, e).toEqual(Array.from({ length: d.maximum - d.minimum + 1 }, (_, i) => d.minimum + i))
      expect(input.properties.resolution.enum, e).toEqual(['480p', '720p', '1080p'])
      expect(input.properties.audio.default, e).toBe(true)
    }
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

const MODES = [
  { id: 'wan-3.0' as const, name: 'text', endpoint: WAN_30_TEXT_TO_VIDEO, image: null, extra: {} },
  { id: 'wan-3.0' as const, name: 'first frame', endpoint: WAN_30_IMAGE_TO_VIDEO, image: 'https://x/first.png', extra: {} },
  { id: 'wan-3.0' as const, name: 'first and last frame', endpoint: WAN_30_IMAGE_TO_VIDEO, image: 'https://x/first.png', extra: { end_image_url: 'https://x/last.png' } },
  { id: 'wan-3.0' as const, name: 'first frame from the options', endpoint: WAN_30_IMAGE_TO_VIDEO, image: null, extra: { image_url: 'https://x/first.png' } },
  { id: 'wan-3.0' as const, name: 'reference pictures', endpoint: WAN_30_REFERENCE_TO_VIDEO, image: null, extra: { image_urls: Array.from({ length: 10 }, (_, i) => `https://x/ref${i}.png`) } },
  { id: 'wan-3.0-prime' as const, name: 'first frame', endpoint: WAN_30_PRIME_IMAGE_TO_VIDEO, image: 'https://x/first.png', extra: {} },
  { id: 'wan-3.0-prime' as const, name: 'first and last frame', endpoint: WAN_30_PRIME_IMAGE_TO_VIDEO, image: 'https://x/first.png', extra: { end_image_url: 'https://x/last.png' } },
]

describe('every payload over the settings grid fits its schema and carries what the price reads', () => {
  for (const m of MODES) {
    it(`${m.id}, ${m.name}: durations × resolutions × sound × prompt rewrite`, () => {
      const cat = VIDEO_MODELS_BY_ID[m.id]!
      const durations: unknown[] = [...[...new Set([...cat.durations, 1, 2, 7, 29, 30, 31, 60])].flatMap(n => [n, String(n)]), undefined, '', 'eight', 7.6, '8s']
      const resolutions = [...(cat.resolutions ?? []), '720P', '4k', undefined]
      const sounds: unknown[] = [true, false, 'false', 0, undefined]
      const rewrites: unknown[] = [true, false, undefined]
      const f = schema(m.endpoint)
      let cases = 0
      const bad: string[] = []
      for (const dur of durations) {
        for (const res of resolutions) {
          for (const snd of sounds) {
            for (const rw of rewrites) {
              const adv: Record<string, unknown> = { ...m.extra }
              if (res !== undefined) adv.resolution = res
              if (snd !== undefined) adv.generate_audio = snd
              if (rw !== undefined) adv.enhance_prompt = rw
              const opts = JSON.stringify(adv)
              // As planNode calls it.
              const call = wan3Call(m.id, { prompt: 'p', aspectRatio: '16:9', duration: asInt(dur, 5), seed: 0, image: m.image, adv: parseJsonObject(opts) })
              cases++
              expect(call.endpoint).toBe(m.endpoint)
              for (const e of checkPayload(f, call.payload)) bad.push(`${opts} ${String(dur)}: ${e}`)
              const priced = effectiveVideoSettings(m.id, dur, '16:9', opts, m.image)!
              const sent = { seconds: call.payload.duration, resolution: call.payload.resolution, audio: call.payload.audio, inputVideoSeconds: 0 }
              if (JSON.stringify(priced) !== JSON.stringify(sent)) bad.push(`${opts} ${String(dur)}: sent ${JSON.stringify(sent)}, priced ${JSON.stringify(priced)}`)
            }
          }
        }
      }
      expect(bad.slice(0, 5)).toEqual([])
      expect(cases).toBeGreaterThan(1000)
    })

    it(`${m.id}, ${m.name}: every aspect ratio × seed`, () => {
      const f = schema(m.endpoint)
      for (const ar of ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', 'adaptive', '']) {
        for (const seed of [0, 7, 2147483647, 2147483648, 4294967295]) {
          const call = wan3Call(m.id, { prompt: 'p', aspectRatio: ar, duration: 5, seed, image: m.image, adv: { ...m.extra } })
          expect(checkPayload(f, call.payload), `${ar} ${seed}`).toEqual([])
          if (seed === 0) expect(call.payload).not.toHaveProperty('seed')
          else expect(call.payload.seed).toBe(seed > 2147483647 ? ((seed - 1) % 2147483647) + 1 : seed)
          // A first frame sets the shape: no ratio is sent with one.
          if (m.endpoint.endsWith('image-to-video')) expect(call.payload).not.toHaveProperty('aspect_ratio')
          else expect(call.payload.aspect_ratio).toBe(['16:9', '9:16', '1:1', '4:3', '3:4'].includes(ar) ? ar : '16:9')
        }
      }
    })
  }
})

// ── Hand-written payloads ──────────────────────────────────────────────────

describe('expected payloads', () => {
  it('plain: text-to-video with the schema\'s own example prompt, at the node\'s defaults', async () => {
    const example = (schema(WAN_30_TEXT_TO_VIDEO).components.schemas.Wan30TextToVideoInput as any).properties.prompt.examples[0]
    expect(example).toBe('A red panda walking through a bamboo forest at sunrise')
    const p = await providerPlan(vid('wan-3.0', { prompt: example }))
    expect(p.provider).toBe('fal')
    expect(p.endpoint).toBe('alibaba/wan-3.0/text-to-video')
    expect(p.payload).toEqual({
      prompt: 'A red panda walking through a bamboo forest at sunrise',
      resolution: '720p', duration: 5, audio: true, enable_prompt_expansion: true, aspect_ratio: '16:9',
    })
    expect(p.backup).toBeUndefined()
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
  })

  it('every option set', async () => {
    const p = await providerPlan(vid('wan-3.0', {
      prompt: 'a lighthouse in a storm', duration: '30', ar: '9:16', seed: 42,
      opts: { resolution: '1080p', generate_audio: false, enhance_prompt: false },
    }))
    expect(p.endpoint).toBe('alibaba/wan-3.0/text-to-video')
    expect(p.payload).toEqual({
      prompt: 'a lighthouse in a storm', resolution: '1080p', duration: 30, audio: false, enable_prompt_expansion: false,
      seed: 42, aspect_ratio: '9:16',
    })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
  })

  it('a picture linked: image-to-video, the picture as the first frame, the last frame from the options, no ratio', async () => {
    const p = await providerPlan(vid('wan-3.0', { image: true, duration: '8', opts: { resolution: '480p', end_image_url: 'https://x/last.png' } }))
    expect(p.endpoint).toBe('alibaba/wan-3.0/image-to-video')
    expect(p.payload).toEqual({
      prompt: 'a fox in the snow', resolution: '480p', duration: 8, audio: true, enable_prompt_expansion: true,
      start_image_url: 'IMG:first.png', end_image_url: 'https://x/last.png',
    })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
  })

  it('reference pictures (Shot Director\'s image_urls): reference-to-video, in their order', async () => {
    const refs = ['https://x/a.png', 'https://x/b.png']
    const p = await providerPlan(vid('wan-3.0', { prompt: 'the subject in Image 1 walks past Image 2', opts: { image_urls: refs } }))
    expect(p.endpoint).toBe('alibaba/wan-3.0/reference-to-video')
    expect(p.payload).toEqual({
      prompt: 'the subject in Image 1 walks past Image 2', resolution: '720p', duration: 5, audio: true, enable_prompt_expansion: true,
      aspect_ratio: '16:9', reference_image_urls: refs,
    })
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
  })

  it('Shot Director\'s @Image1 / @Video2 / @Audio1 tags become Wan\'s positional words on reference-to-video', async () => {
    const p = await providerPlan(vid('wan-3.0', { prompt: '@Image1 walks past @Image2, lit like @Image10 (@Video2, @Audio1; me@Imagery stays)', opts: { image_urls: ['https://x/a.png', 'https://x/b.png'] } }))
    expect(p.endpoint).toBe('alibaba/wan-3.0/reference-to-video')
    expect(p.payload.prompt).toBe('Image 1 walks past Image 2, lit like Image 10 (Video 2, Audio 1; me@Imagery stays)')
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
    // Other endpoints send the prompt as written.
    expect((await providerPlan(vid('wan-3.0', { prompt: 'see @Image1' }))).payload.prompt).toBe('see @Image1')
  })

  it('a tag inside an email address or a word is left alone (parked minor M3)', () => {
    for (const kept of ['mail me@Image1.com', 'write to first.last@Video2.org', 'a+b@Audio3', 'x-y@Image4', 'id_@Image5', 'mail@Image1', '@Image1a', '@Images2']) {
      expect(wan3PromptTags(kept), kept).toBe(kept)
    }
    expect(wan3PromptTags('@Image1, (@Video2) and "@Audio3". Then @Image10!')).toBe('Image 1, (Video 2) and "Audio 3". Then Image 10!')
    expect(wan3PromptTags('ask me@Image1.com about @Image2')).toBe('ask me@Image1.com about Image 2')
  })

  it('the first-frame-and-references refusal reads in plain words (parked minor M4)', () => {
    expect(FIRST_FRAME_AND_REFERENCES).toBe('Pick either a first frame or references, not both.')
  })

  it('Prime: its own image-to-video endpoint, with the linked picture', async () => {
    const p = await providerPlan(vid('wan-3.0-prime', { image: true, prompt: '' }))
    expect(p.endpoint).toBe('alibaba/wan-3.0-prime/image-to-video')
    expect(p.payload).toEqual({
      prompt: '', resolution: '720p', duration: 5, audio: true, enable_prompt_expansion: true, start_image_url: 'IMG:first.png',
    })
    expect(p.backup).toBeUndefined()
    expect(checkPayload(schema(p.endpoint), p.payload)).toEqual([])
  })
})

// ── Refusals ───────────────────────────────────────────────────────────────

describe('requests Wan 3.0 would refuse are refused in plain words, before and at planning', () => {
  const cases: [string, ReturnType<typeof vid>, string, string][] = [
    ['text-to-video with no prompt', vid('wan-3.0', { prompt: '' }), 'prompt', WAN_3_NEEDS_PROMPT],
    ['more than 10 reference pictures', vid('wan-3.0', { opts: { image_urls: Array.from({ length: 11 }, (_, i) => `https://x/${i}.png`) } }), 'model_options', WAN_3_TOO_MANY_REFERENCES],
    ['reference videos (a later task)', vid('wan-3.0', { opts: { video_urls: ['https://x/v.mp4'] } }), 'model_options', WAN_3_PICTURES_ONLY],
    ['reference sounds beside pictures', vid('wan-3.0', { opts: { image_urls: ['https://x/a.png'], audio_urls: ['https://x/a.mp3'] } }), 'model_options', WAN_3_PICTURES_ONLY],
    // F1 fix round 1: never a silent drop of the references.
    ['a linked first frame and reference pictures', vid('wan-3.0', { image: true, opts: { image_urls: ['https://x/a.png'] } }), 'model_options', FIRST_FRAME_AND_REFERENCES],
    ['a first frame in the options and reference pictures', vid('wan-3.0', { opts: { image_url: 'https://x/f.png', image_urls: ['https://x/a.png'] } }), 'model_options', FIRST_FRAME_AND_REFERENCES],
    ['a first frame and reference videos', vid('wan-3.0', { image: true, opts: { video_urls: ['https://x/v.mp4'] } }), 'model_options', FIRST_FRAME_AND_REFERENCES],
    ['Prime with references', vid('wan-3.0-prime', { image: true, opts: { image_urls: ['https://x/a.png'] } }), 'model_options', FIRST_FRAME_AND_REFERENCES],
  ]
  for (const [name, node, input, message] of cases) {
    it(name, async () => {
      expect(requestProblems({ n: node })).toEqual([{ nodeId: 'n', classType: 'GenerateVideoNode', input, message }])
      await expect(plan(node)).rejects.toThrow(message)
    })
  }

  it('an empty prompt is fine with a first frame or references; empty reference lists beside a first frame are no references', async () => {
    for (const node of [
      vid('wan-3.0', { prompt: '', image: true }),
      vid('wan-3.0', { prompt: '', opts: { image_urls: ['https://x/a.png'] } }),
      vid('wan-3.0', { image: true, opts: { image_urls: [], video_urls: [] } }),
      vid('wan-3.0-prime', { prompt: '', image: true }),
    ]) {
      expect(requestProblems({ n: node })).toEqual([])
      await expect(plan(node)).resolves.toMatchObject({ kind: 'provider' })
    }
  })

  it('Prime with no first frame fails plainly (the family rule already needs the picture linked)', async () => {
    await expect(plan(vid('wan-3.0-prime'))).rejects.toThrow(WAN_3_PRIME_NEEDS_FIRST_FRAME)
  })
})

// ── Eligibility and blocking ───────────────────────────────────────────────

describe('eligibility follows the family switch', () => {
  const t2v: ApiPrompt = { 1: vid('wan-3.0') }
  const i2v: ApiPrompt = { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, 1: vid('wan-3.0', { image: true }) }
  const prime: ApiPrompt = { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, 1: vid('wan-3.0-prime', { image: true }) }
  const primeNoPicture: ApiPrompt = { 1: vid('wan-3.0-prime') }

  it('off (no families, or every other family): not taken', () => {
    for (const p of [t2v, i2v, prime]) {
      expect(isRunnerEligible(p)).toBe(false)
      expect(isRunnerEligible(p, NO_FAMILIES)).toBe(false)
      expect(isRunnerEligible(p, ALL_BUT_WAN)).toBe(false)
    }
  })

  it('on: taken; Prime only with its picture linked; never with the prompt or options wired, or sound linked', () => {
    for (const p of [t2v, i2v, prime]) {
      expect(isRunnerEligible(p, ON)).toBe(true)
      expect(isRunnerEligible(p, ALL)).toBe(true)
    }
    expect(isRunnerEligible(primeNoPicture, ON)).toBe(false)
    for (const wired of ['prompt', 'model_options', 'audio']) {
      const n = vid('wan-3.0')
      n.inputs[wired] = ['9', 0]
      expect(isRunnerEligible({ 9: { class_type: 'Image', inputs: { image: 'a.png' } }, 1: n }, ON), wired).toBe(false)
    }
  })

  it('Film a shot is never taken (the runner does not run it)', () => {
    expect(isRunnerEligible({ 1: { class_type: 'FilmShotNode', inputs: { model: 'wan-3.0' } } }, ALL)).toBe(false)
  })
})

describe('blockedModelUses', () => {
  const t2v: ApiPrompt = { 1: vid('wan-3.0') }
  const use = (value: string, classType = 'GenerateVideoNode') => ({ nodeId: '1', classType, value, reason: 'runner-only' })

  it('refuses both models while the family is off, on either path', () => {
    for (const id of IDS) {
      const p: ApiPrompt = { 1: vid(id) }
      expect(blockedModelUses(p)).toEqual([use(id)])
      expect(blockedModelUses(p, { families: ALL_BUT_WAN, runnerTakes: true })).toEqual([use(id)])
    }
  })

  it('lets them through only on a runner run with the family on', () => {
    expect(blockedModelUses(t2v, { families: ON, runnerTakes: true })).toEqual([])
    // Going to ComfyUI (the family on but the run not the runner's): refused.
    expect(blockedModelUses(t2v, { families: ON })).toEqual([use('wan-3.0')])
    // Film a shot: never.
    expect(blockedModelUses({ 1: { class_type: 'FilmShotNode', inputs: { model: 'wan-3.0' } } }, { families: ALL, runnerTakes: true }))
      .toEqual([use('wan-3.0', 'FilmShotNode')])
  })

  it('a workflow that needs the engine is refused before it goes there, naming the model and the engine-only node', () => {
    const p: ApiPrompt = { 1: vid('wan-3.0'), 2: { class_type: 'KSampler', inputs: {} } }
    const titles: Record<string, string> = { 1: 'Clip', 2: 'Old sampler' }
    const r = blockedRunRefusal([{ prompt: p, titleOf: id => titles[id] ?? 'Unnamed node' }], { runnerOn: true, families: ON })
    expect(r).not.toBeNull()
    expect(`${r!.title} ${r!.description}`).toContain('Wan 3.0')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: t2v, titleOf: () => 'Clip' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery and the defaults', () => {
  afterEach(() => __resetModelMenusForTests())

  it('both are runner-only in family wan-3, with plain names', () => {
    for (const id of IDS) {
      const m = VIDEO_MODELS_BY_ID[id]!
      expect(m.runnerOnly, id).toBe(true)
      expect(m.family, id).toBe('wan-3')
      expect(m.hidden, id).toBeUndefined()
    }
    expect(VIDEO_MODELS_BY_ID['wan-3.0']!.label).toBe('Wan 3.0')
    expect(VIDEO_MODELS_BY_ID['wan-3.0-prime']!.label).toBe('Wan 3.0 Prime')
    expect(VIDEO_MODELS_BY_ID['wan-3.0-prime']!.modes).toEqual(['i2v'])
  })

  it('hidden from "Generate a video" while the family is off, shown while on; never on "Film a shot"', () => {
    const shown = (cls: string, f: ReadonlySet<RunnerFamily>) => galleryEntries(VIDEO_MODELS, { classType: cls, families: f, current: null }).map(e => e.model.id)
    for (const id of IDS) {
      expect(shown('GenerateVideoNode', NO_FAMILIES), id).not.toContain(id)
      expect(shown('GenerateVideoNode', ALL_BUT_WAN), id).not.toContain(id)
      expect(shown('GenerateVideoNode', ON), id).toContain(id)
      expect(shown('FilmShotNode', ALL), id).not.toContain(id)
    }
    // A saved node on Wan 3.0 still shows its model, tagged, while the family is off.
    const saved = galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: NO_FAMILIES, current: 'wan-3.0' })
    expect(saved.find(e => e.model.id === 'wan-3.0')).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
  })

  it('a new node\'s default does not move to Wan 3.0', () => {
    expect(VIDEO_MODEL_PREFERENCE).not.toContain('wan-3.0')
    expect(menuDefault(modelMenu('GenerateVideoNode')!, ALL)).toBe(VIDEO_MODEL_PREFERENCE[0])
  })

  it('"Generate a video" offers Wan 3.0\'s lengths the engine lacks (12, 25 and 30 s), in order, copy on write', () => {
    expect(runnerOnlyVideoDurations().filter(d => !['3', '4', '5', '6', '8', '10', '15', '20'].includes(d)).sort()).toEqual(['12', '25', '30'])
    const engine = ['3', '4', '5', '6', '8', '9', '10', '15', '20', '60']
    const body = {
      GenerateVideoNode: { input: { required: { model: ['COMBO', { options: ['veo-3.1'] }], duration: ['COMBO', { options: engine, default: '5' }] } } },
      FilmShotNode: { input: { required: { duration: ['COMBO', { options: engine }] } } },
    }
    const before = JSON.stringify(body)
    const out = applyModelOverlay(body, NO_FAMILIES) as any
    expect(JSON.stringify(body)).toBe(before)
    expect(out.GenerateVideoNode.input.required.duration).toEqual(['COMBO', { options: ['3', '4', '5', '6', '8', '9', '10', '12', '15', '20', '25', '30', '60'], default: '5' }])
    expect(out.FilmShotNode.input.required.duration).toEqual(['COMBO', { options: engine }])
    // The legacy shape too.
    const legacy = applyModelOverlay({ GenerateVideoNode: { input: { required: { duration: [engine, { default: '5' }] } } } }, NO_FAMILIES) as any
    expect(legacy.GenerateVideoNode.input.required.duration[0]).toContain('30')
    // The node's menu then narrows to the picked model's own lengths, all of them offered.
    const offered = new Set(out.GenerateVideoNode.input.required.duration[1].options)
    for (const id of IDS) for (const d of allowedDurations(id)!) expect(offered.has(d), `${id} ${d}`).toBe(true)
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  /** What priceGraph charges for one node plus an output node. */
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs }, 2: SINK }).credits

  it('fal\'s published rate per second by resolution, verified, non-zero, no backup', () => {
    expect(videoRate('wan-3.0')).toMatchObject({
      unit: 'per_second', service: 'fal', confidence: 'verified', read: '2026-09-24',
      source: 'https://fal.ai/models/alibaba/wan-3.0/text-to-video/llms.txt',
      byResolution: { '480p': 0.05, '720p': 0.10, '1080p': 0.20 },
    })
    expect(videoRate('wan-3.0-prime')).toMatchObject({
      unit: 'per_second', service: 'fal', confidence: 'verified', read: '2026-09-24',
      source: 'https://fal.ai/models/alibaba/wan-3.0-prime/image-to-video/llms.txt',
      byResolution: { '480p': 0.068, '720p': 0.14, '1080p': 0.28 },
    })
    for (const id of IDS) expect(videoBackupRate(id), id).toBeNull()
  })

  const examples: { name: string, inputs: Record<string, unknown>, usd: number }[] = [
    { name: 'Wan 3.0, 5 s at 480p (the live check)', inputs: { model: 'wan-3.0', duration: '5', model_options: '{"resolution":"480p"}' }, usd: 0.25 },
    { name: 'Wan 3.0, 3 s at 480p (the shortest menu length)', inputs: { model: 'wan-3.0', duration: '3', model_options: '{"resolution":"480p"}' }, usd: 0.15 },
    { name: 'Wan 3.0 at its defaults (5 s, 720p)', inputs: { model: 'wan-3.0', duration: '5', model_options: '{}' }, usd: 0.50 },
    { name: 'Wan 3.0, 30 s at 1080p, silent (sound doesn\'t change it)', inputs: { model: 'wan-3.0', duration: '30', model_options: '{"resolution":"1080p","generate_audio":false}' }, usd: 6.00 },
    { name: 'Wan 3.0 Prime, 5 s at 720p', inputs: { model: 'wan-3.0-prime', duration: '5', model_options: '{"resolution":"720p"}', image: ['9', 0] }, usd: 0.70 },
    { name: 'Wan 3.0 Prime, 10 s at 1080p', inputs: { model: 'wan-3.0-prime', duration: '10', model_options: '{"resolution":"1080p"}', image: ['9', 0] }, usd: 2.80 },
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

  it('a linked length prices at 30 s; linked options at the top rate', () => {
    expect(maxVideoSeconds('wan-3.0')).toBe(30)
    expect(providerUsd('GenerateVideoNode', { model: 'wan-3.0', duration: ['7', 0], model_options: '{"resolution":"480p"}' })).toBeCloseTo(1.50, 9)
    expect(providerUsd('GenerateVideoNode', { model: 'wan-3.0-prime', duration: '5', model_options: ['7', 0] })).toBeCloseTo(1.40, 9)
    for (const inputs of [
      { model: 'wan-3.0', duration: ['7', 0], model_options: '{"resolution":"480p"}' },
      { model: 'wan-3.0-prime', duration: '5', model_options: ['7', 0] },
    ]) expect(nodeCreditEstimate('GenerateVideoNode', inputs)).toBe(charge(inputs))
  })

  it('priced on what is sent: the planned payload\'s seconds and resolution give the price', async () => {
    for (const [id, image] of [['wan-3.0', false], ['wan-3.0', true], ['wan-3.0-prime', true]] as const) {
      for (const [dur, res] of [['1', '480p'], ['12', '720p'], ['45', '1080p'], ['7', 'nope']] as const) {
        const node = vid(id, { image, duration: dur, opts: { resolution: res } })
        const p = await providerPlan(node)
        const rate = videoRate(id)!.byResolution[String(p.payload.resolution)] as number
        expect(providerUsd('GenerateVideoNode', node.inputs), `${id} ${dur} ${res}`).toBeCloseTo(rate * Number(p.payload.duration), 9)
      }
    }
  })

  it('the gallery label reads the rate at the default resolution', () => {
    expect(videoRateLabel('wan-3.0')).toBe('$0.10/s at 720p')
    expect(videoRateLabel('wan-3.0-prime')).toBe('$0.14/s at 720p')
    expect(videoUsd('wan-3.0', effectiveVideoSettings('wan-3.0', '5', '16:9', '{}')!)).toBeCloseTo(0.5, 9)
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = { 1: vid('wan-3.0', { opts: { resolution: '480p' } }), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: the family\'s own fal endpoint, held at the node\'s price, a real output', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual(['alibaba/wan-3.0/text-to-video'])
    expect(submitted[0]!.payload).toMatchObject({ resolution: '480p', duration: 5, audio: true })
    expect(k.replicate.reqs.size).toBe(0)
    const holds = [...k.ledger.holds.values()]
    expect(holds.map(h => h.credits)).toEqual([creditsForUsd(0.25) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT_WAN } })
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})

// ── F1 fix round 1 ─────────────────────────────────────────────────────────

describe('Seedance 2.0 refuses a first frame beside references too (before, it dropped them without a word)', () => {
  const seed = (opts: Record<string, unknown>, image = false) => {
    const n = vid('seedance-2.0', { opts })
    if (image) n.inputs.image = ['9', 0]
    return n
  }
  for (const [name, node] of [
    ['a linked first frame and reference pictures', seed({ image_urls: ['https://x/a.png'] }, true)],
    ['image_url in the options and reference videos', seed({ image_url: 'https://x/f.png', video_urls: ['https://x/v.mp4'] })],
    ['a linked first frame and reference sounds', seed({ audio_urls: ['https://x/s.mp3'] }, true)],
  ] as const) {
    it(name, async () => {
      expect(requestProblems({ n: node })).toEqual([{ nodeId: 'n', classType: 'GenerateVideoNode', input: 'model_options', message: FIRST_FRAME_AND_REFERENCES }])
      await expect(plan(node)).rejects.toThrow(FIRST_FRAME_AND_REFERENCES)
    })
  }

  it('a first frame alone, references alone, and empty lists beside a frame still run as before', async () => {
    for (const [node, endpoint] of [
      [seed({}, true), 'bytedance/seedance-2.0/image-to-video'],
      [seed({ image_url: 'https://x/f.png', end_image_url: 'https://x/l.png' }), 'bytedance/seedance-2.0/image-to-video'],
      [seed({ image_urls: ['https://x/a.png'] }), 'bytedance/seedance-2.0/reference-to-video'],
      [seed({ image_urls: [] }, true), 'bytedance/seedance-2.0/image-to-video'],
    ] as const) {
      expect(requestProblems({ n: node })).toEqual([])
      expect((await providerPlan(node)).endpoint).toBe(endpoint)
    }
  })
})

describe('the catalogue text offers only what a control can reach', () => {
  it('Wan 3.0 promises no last frame and no reference pictures, and has no reference tag', () => {
    for (const id of IDS) {
      const m = VIDEO_MODELS_BY_ID[id]!
      const text = `${m.pitch} ${m.description ?? ''}`
      expect(text, id).not.toMatch(/last frame|reference/i)
      expect(m.tags, id).not.toContain('reference')
    }
  })
})

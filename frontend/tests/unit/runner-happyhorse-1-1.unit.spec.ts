/**
 * Task F18 (model line-up): HappyHorse 1.1 (Alibaba), runner-only, family
 * `happyhorse-1.1` (server/runner/generators/happyHorse11.ts): fal first,
 * Replicate's alibaba/happyhorse-1.1 the backup. It makes its own sound,
 * dialogue and lip-sync included, from the prompt; it takes no sound in.
 *
 * The family contract:
 *  - the saved schemas: the endpoint ids, fal's pricing text, Replicate's version;
 *  - every payload over the settings grid fits its endpoint's saved schema
 *    (fixtures/provider-schemas/fal/alibaba__happy-horse__v1.1__*.json), its
 *    backup fits Replicate's (fixtures/provider-schemas/replicate/
 *    alibaba__happyhorse-1.1.json) and asks for the same clip, and both carry
 *    the seconds, resolution and sound the price reads;
 *  - hand-written expected payloads: plain (the schema's own example prompt),
 *    every option set, a picture linked (the schema's own example picture);
 *  - the prompt rule and the plain refusals (a last frame, references, sound);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off;
 *  - the price is verified and non-zero, covers the backup, and badge = charge;
 *  - the engine, end to end: the family's own endpoint, and the hold;
 *  - fix round 1 (controller rulings): a prompt over the descriptions'
 *    2,500 characters is refused; the linked picture is measured before the
 *    hand-off (over 20 MB refused, over 10 MB no backup).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { RUNNER_FAMILIES, NO_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { isRunnerEligible } from '#shared/runner/eligibility'
import { blockedModelUses } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { __resetModelMenusForTests, galleryEntries, menuDefault, modelMenu } from '#shared/runner/modelMenus'
import { creditsForUsd, usdChargedAtCost } from '#shared/pricing/markup'
import { nodeCredits, providerUsd } from '#shared/pricing/nodePrice'
import { videoBackupRate, videoBackupUsd, videoRate, videoRateLabel, videoUsd } from '#shared/pricing/videoRates'
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
import { RUNNER_VEO_31_LITE_MODELS } from '~~/server/runner/generators/veo31Lite'
import { RUNNER_ROUTES, VIDEO_BACKUPS } from '~~/server/runner/generators/twins'
import {
  HAPPYHORSE_11, HAPPYHORSE_11_ENDPOINTS, HAPPYHORSE_11_IMAGE_TO_VIDEO, HAPPYHORSE_11_NEEDS_PROMPT, HAPPYHORSE_11_ONE_PICTURE,
  HAPPYHORSE_11_REPLICATE_RATIOS, HAPPYHORSE_11_REPLICATE_SLUG, HAPPYHORSE_11_SECONDS, HAPPYHORSE_11_TEXT_TO_VIDEO,
  RUNNER_HAPPYHORSE_11_MODELS, happyHorse11OnReplicate,
  HAPPYHORSE_11_BACKUP_MAX_PICTURE_BYTES, HAPPYHORSE_11_LONG_PROMPT, HAPPYHORSE_11_MAX_PICTURE_BYTES, HAPPYHORSE_11_PICTURE_TOO_LARGE, HAPPYHORSE_11_PROMPT_MAX,
} from '~~/server/runner/generators/happyHorse11'
import {
  PROMPT_MAX_LENGTH, PROMPT_MAX_LENGTH_RULINGS, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, backupInputProblem, checkedInputFile, inputFileProblem,
  linkedFileCheck, linkedFileProblem, requestProblem, requestProblems,
} from '~~/server/runner/requestRules'
import { DEFAULT_BACKUP_STALL_MS } from '~~/server/runner/config'
import { FalError } from '~~/server/runner/falQueue'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema, type ProviderSchemaFixture } from './helpers/providerSchema'
import { makeKit, ofType } from './__runner__/kit'

const ID = 'happyhorse-1.1'
const FAMILY: RunnerFamily = 'happyhorse-1.1'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }

const falSchema = (endpoint: string) => {
  const f = loadProviderSchema('fal', endpoint)
  expect(f.endpoint).toBe(endpoint)
  return f
}
const REPLICATE = loadProviderSchema('replicate', HAPPYHORSE_11_REPLICATE_SLUG)
/** The fixture's input schema, its $ref followed. */
function inputOf(f: ProviderSchemaFixture): Record<string, any> {
  let input = f.input as Record<string, any>
  while (input.$ref) input = f.components.schemas[String(input.$ref).split('/').pop()!] as Record<string, any>
  return input
}
/** An enum behind Replicate's `allOf: [{ $ref }]`. */
function replicateEnum(field: string): unknown[] {
  const ref = inputOf(REPLICATE).properties[field].allOf[0].$ref as string
  return (REPLICATE.components.schemas[ref.split('/').pop()!] as Record<string, any>).enum
}

/** A Generate-a-video node on HappyHorse 1.1; `image` links a picture from node 9. */
function vid(o: { model?: string, prompt?: string, duration?: unknown, opts?: Record<string, unknown>, image?: boolean, ar?: string, seed?: number } = {}) {
  const inputs: Record<string, unknown> = {
    model: o.model ?? ID, prompt: o.prompt ?? 'a fox says hello', aspect_ratio: o.ar ?? '16:9', duration: o.duration ?? '5', seed: o.seed ?? 0,
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
    toUrl: async (f: OutputFile) => url ?? `https://pics.test/${f.filename}`,
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
  it('fal: one per endpoint the family calls, each its own endpoint id, with fal\'s pricing text', () => {
    expect([...HAPPYHORSE_11_ENDPOINTS].sort()).toEqual(['alibaba/happy-horse/v1.1/image-to-video', 'alibaba/happy-horse/v1.1/text-to-video'])
    for (const e of HAPPYHORSE_11_ENDPOINTS) {
      const f = falSchema(e)
      expect(f.fetchedAt, e).toBe('2026-09-25')
      expect(f.sources?.schema, e).toBe(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${e}`)
      expect(f.pricingText, e).toMatch(/720p video you generated, you will be charged \*\*\$0\.14\/second\*\*\.\s+For 1080p video you will be charged \*\*\$0\.18\/second\*\*/)
    }
  })

  it('Replicate: Alibaba\'s own alibaba/happyhorse-1.1, the same lengths and resolutions, five of the ratios', () => {
    expect(REPLICATE.endpoint).toBe('alibaba/happyhorse-1.1')
    expect(REPLICATE.fetchedAt).toBe('2026-09-25')
    expect(REPLICATE.versionId).toMatch(/^57e8eee0/)
    expect(replicateEnum('duration')).toEqual([...HAPPYHORSE_11_SECONDS])
    expect(replicateEnum('resolution')).toEqual(['720p', '1080p'])
    expect(replicateEnum('aspect_ratio')).toEqual([...HAPPYHORSE_11_REPLICATE_RATIOS])
    for (const e of HAPPYHORSE_11_ENDPOINTS) {
      const p = inputOf(falSchema(e)).properties
      expect(p.duration.enum, e).toEqual([...HAPPYHORSE_11_SECONDS])
      expect(p.resolution.enum, e).toEqual(['720p', '1080p'])
    }
    // fal's text-to-video takes every ratio Replicate does, and four more.
    const falRatios = inputOf(falSchema(HAPPYHORSE_11_TEXT_TO_VIDEO)).properties.aspect_ratio.enum as string[]
    for (const r of HAPPYHORSE_11_REPLICATE_RATIOS) expect(falRatios).toContain(r)
    expect(falRatios.filter(r => !HAPPYHORSE_11_REPLICATE_RATIOS.has(r))).toEqual(['21:9', '9:21', '5:4', '4:5'])
  })

  it('no sound input on any endpoint: the model makes its own', () => {
    for (const f of [falSchema(HAPPYHORSE_11_TEXT_TO_VIDEO), falSchema(HAPPYHORSE_11_IMAGE_TO_VIDEO), REPLICATE]) {
      expect(Object.keys(inputOf(f).properties).filter(k => /audio|sound/i.test(k)), f.endpoint).toEqual([])
    }
  })

  it('its own builder, on fal, with text- and image-to-video; it is no other table\'s model', () => {
    expect(HAPPYHORSE_11).toMatchObject({ id: ID, label: 'HappyHorse 1.1', app: 'alibaba/happy-horse/v1.1', defaultDuration: 5 })
    expect(HAPPYHORSE_11.fnByMode).toEqual({ t2v: 'text-to-video', firstLast: 'image-to-video' })
    expect(Object.keys(RUNNER_HAPPYHORSE_11_MODELS)).toEqual([ID])
    for (const table of [RUNNER_VIDEO_MODELS, RUNNER_ONLY_FAL_VIDEO_MODELS, RUNNER_GEMINI_OMNI_FLASH_MODELS, RUNNER_VEO_31_LITE_MODELS]) {
      expect(table[ID]).toBeUndefined()
    }
    expect(RUNNER_ROUTES[`video:${ID}`]).toEqual({ first: 'fal', backup: 'replicate' })
    expect(VIDEO_BACKUPS[ID]).toBe(happyHorse11OnReplicate)
  })

  it('the prompt minimum is text-to-video\'s own minLength 1', () => {
    const t2v = inputOf(falSchema(HAPPYHORSE_11_TEXT_TO_VIDEO)).properties.prompt
    expect(t2v.minLength).toBe(1)
    expect(PROMPT_MIN_LENGTH[`fal ${HAPPYHORSE_11_TEXT_TO_VIDEO}`]).toEqual({ min: 1, message: HAPPYHORSE_11_NEEDS_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).not.toContain(`fal ${HAPPYHORSE_11_TEXT_TO_VIDEO}`)
    expect(inputOf(falSchema(HAPPYHORSE_11_IMAGE_TO_VIDEO)).required).not.toContain('prompt')
    expect(PROMPT_MIN_LENGTH[`fal ${HAPPYHORSE_11_IMAGE_TO_VIDEO}`]).toBeUndefined()
    expect(PROMPT_MIN_LENGTH[`replicate ${HAPPYHORSE_11_REPLICATE_SLUG}`]).toBeUndefined()
  })

  it('the prompt maximum (fix round 1): a ruling on each fal endpoint, tied to "Max 2500 characters" in its saved description', () => {
    expect(HAPPYHORSE_11_PROMPT_MAX).toBe(2500)
    expect(PROMPT_MAX_LENGTH_RULINGS).toEqual(HAPPYHORSE_11_ENDPOINTS.map(e => `fal ${e}`))
    for (const e of HAPPYHORSE_11_ENDPOINTS) {
      const prompt = inputOf(falSchema(e)).properties.prompt
      // No schema maxLength (else the row would be the schema's, not a ruling), and the limit in the description.
      expect(JSON.stringify(prompt), e).not.toContain('maxLength')
      expect(prompt.description, e).toMatch(/Max 2500 characters\./)
      expect(PROMPT_MAX_LENGTH[`fal ${e}`], e).toEqual({ max: 2500, message: HAPPYHORSE_11_LONG_PROMPT })
    }
    // Replicate states no limit: no row (the backup is built from a request that passed fal's).
    expect(JSON.stringify(inputOf(REPLICATE).properties.prompt)).not.toMatch(/maxLength|2500/)
    expect(PROMPT_MAX_LENGTH[`replicate ${HAPPYHORSE_11_REPLICATE_SLUG}`]).toBeUndefined()
    expect(HAPPYHORSE_11_LONG_PROMPT).toBe('HappyHorse 1.1 takes a prompt of at most 2,500 characters. Shorten it.')
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

const MODES = [
  { name: 'text', endpoint: HAPPYHORSE_11_TEXT_TO_VIDEO, image: null as string | null, opts: {} as Record<string, unknown> },
  { name: 'a linked first frame', endpoint: HAPPYHORSE_11_IMAGE_TO_VIDEO, image: 'https://pics.test/first.png', opts: {} },
  { name: 'a first frame in the options', endpoint: HAPPYHORSE_11_IMAGE_TO_VIDEO, image: null, opts: { image_url: 'https://pics.test/opt.png' } },
]

describe('every payload over the settings grid fits its schema, its backup fits Replicate\'s, and both carry what the price reads', () => {
  for (const m of MODES) {
    it(`${m.name}: durations × resolutions × ratios, then seeds`, () => {
      const cat = VIDEO_MODELS_BY_ID[ID]!
      const durations: unknown[] = [...[...new Set([...cat.durations, ...HAPPYHORSE_11_SECONDS, 1, 2, 16, 20, 60])].flatMap(n => [n, String(n)]), undefined, '', 'five']
      const resolutions = [...(cat.resolutions ?? []), '1080P', '720P', '480p', '4k', 'nope', undefined]
      const ratios = [...cat.aspectRatios, '9:21', '5:4', '4:5', 'auto', '']
      const seeds = [0, 7, 2147483647, 2147483648, 4294967295, 2 ** 40]
      const f = falSchema(m.endpoint)
      let cases = 0
      let backups = 0
      const bad: string[] = []
      const combos: [unknown, unknown, string, number][] = []
      for (const dur of durations) for (const res of resolutions) for (const ar of ratios) combos.push([dur, res, ar, 0])
      for (const ar of ['16:9', '21:9']) for (const seed of seeds) combos.push(['5', undefined, ar, seed])
      for (const [dur, res, ar, seed] of combos) {
        const adv: Record<string, unknown> = { ...m.opts }
        if (res !== undefined) adv.resolution = res
        const opts = JSON.stringify(adv)
        const label = `${opts} ${String(dur)} ${ar} ${seed}`
        // As planNode calls it.
        const payload = HAPPYHORSE_11.build({ prompt: 'p', aspectRatio: ar, duration: asInt(dur, HAPPYHORSE_11.defaultDuration), seed, image: m.image, adv: parseJsonObject(opts) })
        cases++
        const fn = falVideoFn(payload, HAPPYHORSE_11.fnByMode)
        if (`${HAPPYHORSE_11.app}/${fn}` !== m.endpoint) bad.push(`${label}: endpoint ${fn}`)
        for (const e of checkPayload(f, payload)) bad.push(`${label}: ${e}`)
        const priced = effectiveVideoSettings(ID, dur, ar, opts, m.image)!
        const sent = { seconds: payload.duration, resolution: payload.resolution, audio: true }
        if (priced.seconds !== sent.seconds || priced.resolution !== sent.resolution || priced.audio !== sent.audio) {
          bad.push(`${label}: sent ${JSON.stringify(sent)}, priced ${JSON.stringify(priced)}`)
        }
        // The backup: the same clip on Replicate, or none for a ratio Replicate lacks.
        const backup = happyHorse11OnReplicate(payload)
        const replicateHasRatio = HAPPYHORSE_11_REPLICATE_RATIOS.has(String(payload.aspect_ratio))
        if (!m.endpoint.endsWith('text-to-video') || replicateHasRatio) {
          if (!backup) {
            bad.push(`${label}: no backup`)
            continue
          }
          backups++
          if (backup.provider !== 'replicate' || backup.endpoint !== HAPPYHORSE_11_REPLICATE_SLUG) bad.push(`${label}: backup to ${backup.endpoint}`)
          for (const e of checkPayload(REPLICATE, backup.payload)) bad.push(`${label} backup: ${e}`)
          const b = backup.payload
          if (b.prompt !== payload.prompt || b.duration !== payload.duration || b.resolution !== payload.resolution || b.seed !== payload.seed) {
            bad.push(`${label}: backup ${JSON.stringify(b)} is not ${JSON.stringify(payload)}`)
          }
          if (payload.image_url ? (b.images as string[])?.[0] !== payload.image_url || (b.images as string[]).length !== 1 || 'aspect_ratio' in b : b.aspect_ratio !== payload.aspect_ratio || 'images' in b) {
            bad.push(`${label}: backup frame or ratio ${JSON.stringify(b)}`)
          }
        }
        else if (backup) bad.push(`${label}: a backup at ${String(payload.aspect_ratio)}`)
      }
      expect(bad.slice(0, 5)).toEqual([])
      expect(cases).toBeGreaterThan(1000)
      expect(backups).toBeGreaterThan(500)
    })
  }
})

// ── Expected payloads (through planNode) ───────────────────────────────────

describe('expected payloads', () => {
  it('plain: text-to-video with the schema\'s own example prompt, at the node\'s defaults; Replicate the backup', async () => {
    const example = inputOf(falSchema(HAPPYHORSE_11_TEXT_TO_VIDEO)).properties.prompt.examples[0] as string
    expect(example).toMatch(/^A little girl walking on the road at sunset/)
    const p = await providerPlan(vid({ prompt: example }))
    expect(p.provider).toBe('fal')
    expect(p.endpoint).toBe('alibaba/happy-horse/v1.1/text-to-video')
    expect(p.payload).toEqual({ prompt: example, aspect_ratio: '16:9', resolution: '720p', duration: 5 })
    expect(checkPayload(falSchema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toEqual({
      provider: 'replicate', endpoint: 'alibaba/happyhorse-1.1',
      payload: { prompt: example, aspect_ratio: '16:9', resolution: '720p', duration: 5 },
    })
    expect(checkPayload(REPLICATE, p.backup!.payload)).toEqual([])
  })

  it('every option set: 1080p, portrait, 12 s, a seed', async () => {
    const prompt = 'Two friends at a café. She says: "You came!" He laughs: "Wouldn\'t miss it."'
    const p = await providerPlan(vid({ prompt, duration: '12', ar: '9:16', seed: 42, opts: { resolution: '1080p' } }))
    expect(p.endpoint).toBe('alibaba/happy-horse/v1.1/text-to-video')
    expect(p.payload).toEqual({ prompt, aspect_ratio: '9:16', resolution: '1080p', duration: 12, seed: 42 })
    expect(checkPayload(falSchema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup!.payload).toEqual({ prompt, aspect_ratio: '9:16', resolution: '1080p', duration: 12, seed: 42 })
    expect(checkPayload(REPLICATE, p.backup!.payload)).toEqual([])
  })

  it('a picture linked: image-to-video with the schema\'s own example prompt and picture, no ratio (the picture sets it)', async () => {
    const props = inputOf(falSchema(HAPPYHORSE_11_IMAGE_TO_VIDEO)).properties
    const prompt = props.prompt.examples[0] as string
    const picture = props.image_url.examples[0] as string
    expect(prompt).toBe('Bring the scene in the image to life.')
    const p = await providerPlan(vid({ prompt, image: true, duration: '3', ar: '21:9' }), picture)
    expect(p.endpoint).toBe('alibaba/happy-horse/v1.1/image-to-video')
    expect(p.payload).toEqual({ image_url: picture, prompt, resolution: '720p', duration: 3 })
    expect(checkPayload(falSchema(p.endpoint), p.payload)).toEqual([])
    // Replicate: one picture in `images` is image-to-video; its ratio is the picture's too.
    expect(p.backup!.payload).toEqual({ prompt, images: [picture], resolution: '720p', duration: 3 })
    expect(checkPayload(REPLICATE, p.backup!.payload)).toEqual([])
  })

  it('a picture linked with no prompt: sent (image-to-video\'s prompt is optional)', async () => {
    const p = await providerPlan(vid({ prompt: '', image: true }))
    expect(p.payload).toEqual({ image_url: 'https://pics.test/first.png', prompt: '', resolution: '720p', duration: 5 })
    expect(checkPayload(falSchema(p.endpoint), p.payload)).toEqual([])
    expect(checkPayload(REPLICATE, p.backup!.payload)).toEqual([])
  })

  it('21:9 text-to-video: fal only (Replicate has no 21:9)', async () => {
    const p = await providerPlan(vid({ ar: '21:9' }))
    expect(p.payload.aspect_ratio).toBe('21:9')
    expect(checkPayload(falSchema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('a seed above the schemas\' 2³¹ − 1 wraps (still repeatable); 0 sends none', async () => {
    expect((await providerPlan(vid({ seed: 2147483647 }))).payload.seed).toBe(2147483647)
    expect((await providerPlan(vid({ seed: 2147483648 }))).payload.seed).toBe(1)
    expect((await providerPlan(vid({ seed: 4294967295 }))).payload.seed).toBe(1)
    expect('seed' in (await providerPlan(vid({ seed: 0 }))).payload).toBe(false)
  })
})

// ── Refusals ───────────────────────────────────────────────────────────────

describe('what HappyHorse 1.1 can\'t take is refused in plain words, never dropped', () => {
  const extras: Record<string, unknown>[] = [
    { end_image_url: 'https://pics.test/last.png' },
    { image_urls: ['https://pics.test/ref.png'] },
    { video_urls: ['https://pics.test/ref.mp4'] },
    { audio_urls: ['https://pics.test/voice.mp3'] },
  ]
  for (const opts of extras) {
    it(`${Object.keys(opts)[0]}: refused at planning and before the hold, with or without a first frame`, async () => {
      for (const image of [false, true]) {
        await expect(plan(vid({ opts, image }))).rejects.toThrow(HAPPYHORSE_11_ONE_PICTURE)
        expect(requestProblems({ 1: vid({ opts, image }) })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'model_options', message: HAPPYHORSE_11_ONE_PICTURE }])
      }
    })
  }

  it('the words: plain, sentence case, naming the model, no identifiers', () => {
    expect(HAPPYHORSE_11_ONE_PICTURE).toBe('HappyHorse 1.1 starts from one picture at most and takes no sound. Remove the last frame and any reference pictures, videos or sounds, or pick another model.')
    expect(HAPPYHORSE_11_NEEDS_PROMPT).toBe('HappyHorse 1.1 needs a prompt. Describe the clip, or link a picture to start from it.')
  })

  it('text-to-video with an empty prompt: refused at planning and before the hold; one character runs', async () => {
    await expect(plan(vid({ prompt: '' }))).rejects.toThrow(HAPPYHORSE_11_NEEDS_PROMPT)
    expect(requestProblems({ 1: vid({ prompt: '' }) })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'prompt', message: HAPPYHORSE_11_NEEDS_PROMPT }])
    expect(requestProblems({ 1: vid({ prompt: 'a' }) })).toEqual([])
    // With a first frame (linked, or in the options) the prompt is optional.
    expect(requestProblems({ 1: vid({ prompt: '', image: true }) })).toEqual([])
    expect(requestProblems({ 1: vid({ prompt: '', opts: { image_url: 'https://pics.test/a.png' } }) })).toEqual([])
    // A wired prompt or wired options can't be read before the run.
    const wiredPrompt = vid({ prompt: '' })
    wiredPrompt.inputs.prompt = ['9', 0]
    const wiredOpts = vid({ prompt: '' })
    wiredOpts.inputs.model_options = ['9', 0]
    expect(requestProblems({ 1: wiredPrompt })).toEqual([])
    expect(requestProblems({ 1: wiredOpts })).toEqual([])
  })

  it('a linked sound: the runner never takes the node, and the engine path refuses the runner-only model', () => {
    const n = vid()
    n.inputs.audio = ['8', 0]
    const p: ApiPrompt = { 8: { class_type: 'LoadAudio', inputs: {} }, 1: n }
    expect(isRunnerEligible(p, ON)).toBe(false)
    expect(blockedModelUses(p, { families: ON })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', value: ID, reason: 'runner-only' }])
    expect(blockedPromptRefusal(p)).not.toBeNull()
  })
})

// ── Fix round 1: the prompt's 2,500 characters ─────────────────────────────

describe('a prompt over 2,500 characters is refused at planning and before the hold, in either mode (fix round 1)', () => {
  // Code points, as JSON Schema and the other rows count: 2,500 emoji are 5,000 UTF-16 units and still fit.
  const atMax = ['a'.repeat(2500), '🐴'.repeat(2500)]
  const over = ['a'.repeat(2501), '🐴'.repeat(2501)]

  it('the payload check (planNode\'s): 2,500 fit, 2,501 don\'t, on both fal endpoints', () => {
    for (const e of HAPPYHORSE_11_ENDPOINTS) {
      for (const prompt of atMax) expect(requestProblem('fal', e, { prompt }), e).toBeNull()
      for (const prompt of over) expect(requestProblem('fal', e, { prompt }), e).toBe(HAPPYHORSE_11_LONG_PROMPT)
    }
  })

  it('planNode refuses it, text- or image-to-video', async () => {
    for (const image of [false, true]) {
      for (const prompt of atMax) await expect(providerPlan(vid({ prompt, image }))).resolves.toBeTruthy()
      for (const prompt of over) await expect(plan(vid({ prompt, image }))).rejects.toThrow(HAPPYHORSE_11_LONG_PROMPT)
    }
  })

  it('requestProblems (before the hold; the gate) refuses it in either mode, and with the options wired', () => {
    const long = 'a'.repeat(2501)
    const wiredOpts = vid({ prompt: long })
    wiredOpts.inputs.model_options = ['9', 0]
    for (const n of [vid({ prompt: long }), vid({ prompt: long, image: true }), vid({ prompt: long, opts: { image_url: 'https://pics.test/a.png' } }), wiredOpts]) {
      expect(requestProblems({ 1: n })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'prompt', message: HAPPYHORSE_11_LONG_PROMPT }])
    }
    for (const prompt of atMax) expect(requestProblems({ 1: vid({ prompt }) })).toEqual([])
    // A wired prompt can't be read before the run.
    const wiredPrompt = vid()
    wiredPrompt.inputs.prompt = ['9', 0]
    expect(requestProblems({ 1: wiredPrompt })).toEqual([])
  })

  it('the engine: refused before the hold, nothing sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const take: ApiPrompt = { 1: vid({ prompt: 'a'.repeat(2501) }), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
    await expect(k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toThrow(HAPPYHORSE_11_LONG_PROMPT)
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})

// ── Fix round 1: the picture's size ────────────────────────────────────────

describe('the linked picture is measured before the hand-off (fix round 1)', () => {
  const MB10 = HAPPYHORSE_11_BACKUP_MAX_PICTURE_BYTES
  const MB20 = HAPPYHORSE_11_MAX_PICTURE_BYTES
  const node = (o: { model?: string } = {}) => vid({ image: true, ...o })

  it('the limits are the schemas\', read as the smaller number of bytes', () => {
    expect(MB20).toBe(20_000_000)
    expect(MB10).toBe(10_000_000)
    expect(inputOf(falSchema(HAPPYHORSE_11_IMAGE_TO_VIDEO)).properties.image_url.description).toContain('Max 20 MB.')
    expect(inputOf(REPLICATE).properties.images.description).toContain('<=10MB each')
    expect(HAPPYHORSE_11_PICTURE_TOO_LARGE).toBe('HappyHorse 1.1 takes pictures up to 20 MB. Make this one smaller first.')
  })

  it('only HappyHorse 1.1 with its switch on reads the file', () => {
    expect(checkedInputFile('GenerateVideoNode', ON, ID)).toBe('image')
    expect(checkedInputFile('GenerateVideoNode', ALL, ID)).toBe('image')
    expect(checkedInputFile('GenerateVideoNode', ALL_BUT, ID)).toBeNull()
    expect(checkedInputFile('GenerateVideoNode', ALL, 'veo-3.1-lite')).toBeNull()
    expect(checkedInputFile('GenerateVideoNode', ALL)).toBeNull()
    expect(checkedInputFile('FilmShotNode', ALL, ID)).toBeNull()
  })

  it('over 20 MB is refused; 20 MB is not; nothing else is judged (fal checks the format)', () => {
    expect(inputFileProblem('GenerateVideoNode', new Uint8Array(MB20), ON, ID)).toBeNull()
    expect(inputFileProblem('GenerateVideoNode', new Uint8Array(MB20 + 1), ON, ID)).toBe(HAPPYHORSE_11_PICTURE_TOO_LARGE)
    expect(inputFileProblem('GenerateVideoNode', new Uint8Array(MB20 + 1), ALL_BUT, ID)).toBeNull()
    expect(inputFileProblem('GenerateVideoNode', new Uint8Array(MB20 + 1), ALL, 'veo-3.1-lite')).toBeNull()
  })

  it('linkedFileCheck reads the linked file once and hands back its size; nothing is read without a link or the switch', async () => {
    const reads: string[] = []
    const read = (size: number) => async (f: { filename: string }) => { reads.push(f.filename); return new Uint8Array(size) }
    const files = () => [{ filename: 'first.png' }]
    expect(await linkedFileCheck(node(), files, read(MB10 + 1), ON)).toEqual({ problem: null, bytes: MB10 + 1 })
    expect(await linkedFileCheck(node(), files, read(MB20 + 1), ON)).toEqual({ problem: HAPPYHORSE_11_PICTURE_TOO_LARGE, bytes: MB20 + 1 })
    expect(await linkedFileProblem(node(), files, read(MB20 + 1), ON)).toBe(HAPPYHORSE_11_PICTURE_TOO_LARGE)
    expect(reads).toEqual(['first.png', 'first.png', 'first.png'])
    reads.length = 0
    expect(await linkedFileCheck(vid(), files, read(MB20 + 1), ON)).toEqual({ problem: null })
    expect(await linkedFileCheck(node(), files, read(MB20 + 1), ALL_BUT)).toEqual({ problem: null })
    expect(await linkedFileCheck(node({ model: 'veo-3.1-lite' }), files, read(MB20 + 1), ALL)).toEqual({ problem: null })
    expect(reads).toEqual([])
    // A file that can't be read is left to the hand-off, which reads it too.
    expect(await linkedFileCheck(node(), files, async () => { throw new Error('gone') }, ON)).toEqual({ problem: null })
  })

  it('over 10 MB the plan carries no backup (Replicate takes 10 MB); up to 10 MB, or unmeasured, it keeps it', async () => {
    const withBytes = async (inputBytes?: number) => {
      const p = await planNode({
        prompt: { 9: { class_type: 'Image', inputs: { image: 'first.png' } }, n: node() },
        nodeId: 'n',
        filesFrom: () => [{ filename: 'first.png', subfolder: '', type: 'input' }],
        toUrl: async (f: OutputFile) => `https://pics.test/${f.filename}`,
        gateOpen: false,
        ...(inputBytes !== undefined ? { inputBytes } : {}),
      })
      if (p.kind !== 'provider') throw new Error('no call')
      return p
    }
    for (const b of [undefined, 1, MB10]) expect((await withBytes(b)).backup?.endpoint, String(b)).toBe(HAPPYHORSE_11_REPLICATE_SLUG)
    for (const b of [MB10 + 1, MB20]) {
      const p = await withBytes(b)
      expect(p.endpoint).toBe(HAPPYHORSE_11_IMAGE_TO_VIDEO)
      expect(p.backup, String(b)).toBeUndefined()
    }
    // Only a backup that carries the picture is judged.
    expect(backupInputProblem({ provider: 'replicate', endpoint: HAPPYHORSE_11_REPLICATE_SLUG, payload: { prompt: 'p', aspect_ratio: '16:9' } }, MB20)).toBeNull()
    expect(backupInputProblem({ provider: 'replicate', endpoint: 'black-forest-labs/flux-3', payload: { images: ['x'] } }, MB20)).toBeNull()
  })

  describe('the engine', () => {
    const take: ApiPrompt = {
      11: { class_type: 'Image', inputs: { image: 'first.png' } },
      1: vid({ image: false }),
      2: { class_type: 'Video', inputs: { source: ['1', 0] } },
    }
    take[1]!.inputs.image = ['11', 0]
    const kit = (bytes: number) => {
      const k = makeKit({ hosted: true, deps: { families: () => ON, backup: () => ({ enabled: true, stallMs: DEFAULT_BACKUP_STALL_MS }) } })
      const b = Buffer.alloc(bytes)
      Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).copy(b)
      fs.writeFileSync(path.join(k.root, 'input', 'first.png'), b)
      return k
    }
    const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    /** fal's submit fails with no job (a 503): the engine goes to the backup, if the plan has one. */
    const falDown = (k: ReturnType<typeof makeKit>) => k.fal.client.submit.mockRejectedValueOnce(new FalError('fal submit 503: unavailable', 503))

    it('over 20 MB: the node fails in plain words before the hand-off; nothing uploaded or sent, the hold released', async () => {
      const k = kit(HAPPYHORSE_11_MAX_PICTURE_BYTES + 1)
      const { runId } = await start(k)
      await k.engine.settled(runId)
      // The call count, not toHaveBeenCalled: a failing matcher would print the 20 MB it was called with (out of memory).
      expect(k.upload.mock.calls.length).toBe(0)
      expect(k.fal.reqs.size).toBe(0)
      expect(k.replicate.reqs.size).toBe(0)
      expect(ofType(k.seen, 'execution_error').map(m => m.data.exception_message)).toEqual([HAPPYHORSE_11_PICTURE_TOO_LARGE])
      expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
    })

    it('10–20 MB: runs on fal with no backup; fal down → the node fails, Replicate never called, nothing charged', async () => {
      const k = kit(HAPPYHORSE_11_BACKUP_MAX_PICTURE_BYTES + 1)
      falDown(k)
      const { runId } = await start(k)
      await k.engine.settled(runId)
      expect(k.fal.client.submit).toHaveBeenCalledTimes(1)
      expect(k.fal.client.submit.mock.calls[0]![0]).toBe(HAPPYHORSE_11_IMAGE_TO_VIDEO)
      expect(k.replicate.client.submit).not.toHaveBeenCalled()
      expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
    })

    it('up to 10 MB: fal down → the backup on Replicate carries the same picture and serves it, charged once', async () => {
      const k = kit(1024)
      falDown(k)
      const { runId } = await start(k)
      await k.engine.settled(runId)
      const sent = k.replicate.submitted()
      expect(sent.map(r => r.endpoint)).toEqual([HAPPYHORSE_11_REPLICATE_SLUG])
      expect(sent[0]!.payload).toEqual({ prompt: 'a fox says hello', images: ['https://fal.storage/first.png'], resolution: '720p', duration: 5 })
      const credits = creditsForUsd(0.70) + 1
      expect([...k.ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', credits]])
      expect((await k.store.get(runId))!.status).toBe('done')
    })
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
    expect(`${r!.title} ${r!.description}`).toContain('HappyHorse 1.1')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: t2v, titleOf: () => 'Clip' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery and the defaults', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family happyhorse-1.1, with a plain name and the schemas\' settings', () => {
    const m = VIDEO_MODELS_BY_ID[ID]!
    expect(m.runnerOnly).toBe(true)
    expect(m.family).toBe('happyhorse-1.1')
    expect(m.hidden).toBeUndefined()
    expect(m.label).toBe('HappyHorse 1.1')
    expect(m.brand).toBe('Alibaba')
    expect(m.modes).toEqual(['t2v', 'i2v'])
    expect(m.supportsSeed).toBe(true)
    expect(m.aspectRatios).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'])
    expect(m.defaultAspectRatio).toBe('16:9')
    expect(m.resolutions).toEqual(['720p', '1080p'])
    expect(m.defaultResolution).toBe('720p')
    expect(m.defaultDuration).toBe(5)
    // Sound is always on and there is no sound input: it is tagged as making sound, not as lip-syncing a sound file.
    expect(m.tags).toContain('audio')
    expect(m.tags).not.toContain('lip-sync')
    // No setting the schemas lack (no sound switch, no negative prompt).
    expect(m.advanced).toEqual([])
    for (const text of [m.pitch, m.description!]) {
      expect(text).toMatch(/^[A-Z]/)
      expect(text).not.toMatch(/happyhorse-1\.1|alibaba\/|_/)
    }
    // Every length the menu offers is one the builder sends as is.
    expect(m.durations.every(d => HAPPYHORSE_11.build({ prompt: 'p', aspectRatio: '16:9', duration: d, seed: 0, image: null, adv: {} }).duration === d)).toBe(true)
    expect(allowedDurations(ID)).toEqual(m.durations.map(String))
  })

  it('hidden from "Generate a video" while the family is off, shown while on; never on "Film a shot"', () => {
    const shown = (cls: string, f: ReadonlySet<RunnerFamily>) => galleryEntries(VIDEO_MODELS, { classType: cls, families: f, current: null }).map(e => e.model.id)
    expect(shown('GenerateVideoNode', NO_FAMILIES)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ALL_BUT)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ON)).toContain(ID)
    expect(shown('FilmShotNode', ALL)).not.toContain(ID)
    // A saved node on HappyHorse still shows its model, tagged, while the family is off.
    const saved = galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: NO_FAMILIES, current: ID })
    expect(saved.find(e => e.model.id === ID)).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
  })

  it('a new node\'s default does not move to HappyHorse', () => {
    expect(VIDEO_MODEL_PREFERENCE).not.toContain(ID)
    expect(FILM_SHOT_MODEL_PREFERENCE).not.toContain(ID)
    expect(menuDefault(modelMenu('GenerateVideoNode')!, ALL)).toBe(VIDEO_MODEL_PREFERENCE[0])
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  /** What priceGraph charges for one node plus an output node. */
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs }, 2: SINK }).credits

  it('fal\'s rate per second by resolution, verified, non-zero; Replicate\'s the same, the backup card', () => {
    expect(videoRate(ID)).toMatchObject({
      unit: 'per_second', service: 'fal', confidence: 'verified', read: '2026-09-25',
      source: 'https://fal.ai/models/alibaba/happy-horse/v1.1/text-to-video/llms.txt',
      byResolution: { '720p': 0.14, '1080p': 0.18 },
    })
    expect(videoBackupRate(ID)).toMatchObject({
      unit: 'per_second', service: 'replicate', confidence: 'verified', read: '2026-09-25',
      source: 'https://replicate.com/alibaba/happyhorse-1.1',
      byResolution: { '720p': 0.14, '1080p': 0.18 },
    })
  })

  const examples: { name: string, inputs: Record<string, unknown>, usd: number }[] = [
    { name: '3 s at 720p (the shortest clip: the live check)', inputs: { model: ID, duration: '3', model_options: '{}' }, usd: 0.42 },
    { name: '5 s at 720p (the node\'s defaults)', inputs: { model: ID, duration: '5', model_options: '{}' }, usd: 0.70 },
    { name: '8 s at 1080p, a picture linked', inputs: { model: ID, duration: '8', model_options: '{"resolution":"1080p"}', image: ['9', 0] }, usd: 1.44 },
    { name: '15 s at 1080p (the dearest)', inputs: { model: ID, duration: '15', model_options: '{"resolution":"1080p"}' }, usd: 2.70 },
    { name: '21:9 (fal only) costs the same', inputs: { model: ID, duration: '5', aspect_ratio: '21:9', model_options: '{}' }, usd: 0.70 },
    { name: 'a 4k setting is sent (and priced) as 720p', inputs: { model: ID, duration: '5', model_options: '{"resolution":"4k"}' }, usd: 0.70 },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $${ex.usd.toFixed(2)}; covers the backup; badge = charge = run estimate`, () => {
      expect(providerUsd('GenerateVideoNode', ex.inputs)).toBeCloseTo(ex.usd, 9)
      const s = effectiveVideoSettings(ID, ex.inputs.duration, ex.inputs.aspect_ratio ?? '16:9', ex.inputs.model_options)!
      expect(videoUsd(ID, s)).toBeCloseTo(ex.usd, 9)
      expect(videoBackupUsd(ID, s)).toBeCloseTo(ex.usd, 9)
      // The same rate on both services: the first service's marked-up price stands.
      expect(usdChargedAtCost(ex.usd)).toBeLessThan(ex.usd)
      const credits = creditsForUsd(ex.usd)
      expect(credits).toBeGreaterThan(0)
      expect(credits).toBeGreaterThanOrEqual(Math.round(ex.usd * 100))
      expect(nodeCredits('GenerateVideoNode', ex.inputs)).toBe(credits)
      const c = charge(ex.inputs)
      expect(c).toBe(credits + 1) // + base render
      expect(nodeCreditEstimate('GenerateVideoNode', ex.inputs)).toBe(c)
      const names = Object.keys(ex.inputs)
      const est = estimateUsdForNodes([{ id: '1', type: 'GenerateVideoNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]) }], { hosted: true })!
      expect(est.hostedCredits).toBe(c)
    })
  }

  it('the live check: 3 s at 720p is $0.42, 63 credits (64 with the base render)', () => {
    expect(creditsForUsd(0.42)).toBe(63)
    expect(charge({ model: ID, duration: '3', model_options: '{}' })).toBe(64)
  })

  it('a linked length prices at the longest sent (15 s); linked options at the top rate (1080p)', () => {
    expect(maxVideoSeconds(ID)).toBe(15)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: ['7', 0], model_options: '{}' })).toBeCloseTo(0.14 * 15, 9)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: '4', model_options: ['7', 0] })).toBeCloseTo(0.18 * 4, 9)
    for (const inputs of [
      { model: ID, duration: ['7', 0], model_options: '{}' },
      { model: ID, duration: '4', model_options: ['7', 0] },
    ]) expect(nodeCreditEstimate('GenerateVideoNode', inputs)).toBe(charge(inputs))
  })

  it('priced on what is sent: the planned payload\'s seconds and resolution give the price, on either service', async () => {
    for (const image of [false, true]) {
      for (const [dur, res] of [['1', '720p'], ['7', '1080p'], ['9', '4k'], ['45', 'nope'], ['15', '1080P']] as const) {
        const node = vid({ image, duration: dur, opts: { resolution: res } })
        const p = await providerPlan(node)
        const rate = videoRate(ID)!.byResolution[String(p.payload.resolution)] as number
        expect(providerUsd('GenerateVideoNode', node.inputs), `${image} ${dur} ${res}`).toBeCloseTo(rate * Number(p.payload.duration), 9)
        const backupRate = videoBackupRate(ID)!.byResolution[String(p.backup!.payload.resolution)] as number
        expect(backupRate * Number(p.backup!.payload.duration)).toBeCloseTo(rate * Number(p.payload.duration), 9)
      }
    }
  })

  it('the gallery label reads the rate at the default settings (720p)', () => {
    expect(videoRateLabel(ID)).toBe('$0.14/s at 720p')
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = { 1: vid({ duration: '3' }), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
  const start = (k: ReturnType<typeof makeKit>) => k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: the family\'s own fal endpoint, held at the node\'s price, a real output; Replicate not called', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual(['alibaba/happy-horse/v1.1/text-to-video'])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a fox says hello', aspect_ratio: '16:9', resolution: '720p', duration: 3 })
    expect(k.replicate.reqs.size).toBe(0)
    const holds = [...k.ledger.holds.values()]
    expect(holds.map(h => h.credits)).toEqual([creditsForUsd(0.42) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT } })
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })

  it('an empty text-to-video prompt: refused before the hold, nothing sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const empty: ApiPrompt = { 1: vid({ prompt: '' }), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
    await expect(k.engine.startRun({ userId: k.userId, takes: [empty], workflow: null, canvasId: null, projectUuid: null, projectName: null }))
      .rejects.toThrow(HAPPYHORSE_11_NEEDS_PROMPT)
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })
})

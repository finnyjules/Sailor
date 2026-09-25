/**
 * Task F19 (model line-up): Grok Imagine Video 1.5 (xAI), runner-only, family
 * `grok-imagine-video-1.5` (server/runner/generators/grokImagineVideo15.ts):
 * fal first (it alone takes text-to-video and 1080p), Replicate's
 * xai/grok-imagine-video-1.5 the backup for image-to-video at 480p or 720p.
 * It makes its own sound from the prompt; it takes no sound in.
 *
 * The family contract:
 *  - the saved schemas: the endpoint ids, fal's pricing text, Replicate's version;
 *  - every payload over the settings grid fits its endpoint's saved schema
 *    (fixtures/provider-schemas/fal/xai__grok-imagine-video__v1.5__*.json), its
 *    backup, where there is one, fits Replicate's (fixtures/provider-schemas/
 *    replicate/xai__grok-imagine-video-1.5.json) and asks for the same clip,
 *    and both carry the seconds, resolution, sound and picture the price reads;
 *  - hand-written expected payloads: plain (the schema's own example prompt),
 *    every option set, a picture linked (the schema's own example picture);
 *  - the prompt rules (a ruled minimum, the schemas' maximum) and the plain
 *    refusals (a last frame, references, sound);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off;
 *  - the price is verified and non-zero, covers the backup, and badge = charge;
 *  - the engine, end to end: the family's own endpoint, the hold, the backup.
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
import { videoBackupRate, videoBackupUsd, videoPriceUsd, videoRate, videoRateLabel, videoUsd } from '#shared/pricing/videoRates'
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
import { RUNNER_HAPPYHORSE_11_MODELS } from '~~/server/runner/generators/happyHorse11'
import { RUNNER_ROUTES, VIDEO_BACKUPS } from '~~/server/runner/generators/twins'
import {
  GROK_IMAGINE_VIDEO_15, GROK_IMAGINE_VIDEO_15_ENDPOINTS, GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO, GROK_IMAGINE_VIDEO_15_LONG_PROMPT,
  GROK_IMAGINE_VIDEO_15_NEEDS_PROMPT, GROK_IMAGINE_VIDEO_15_ONE_PICTURE, GROK_IMAGINE_VIDEO_15_PROMPT_MAX,
  GROK_IMAGINE_VIDEO_15_REPLICATE_RESOLUTIONS, GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG, GROK_IMAGINE_VIDEO_15_SECONDS,
  GROK_IMAGINE_VIDEO_15_TEXT_TO_VIDEO, RUNNER_GROK_IMAGINE_VIDEO_15_MODELS, grokImagineVideo15OnReplicate,
} from '~~/server/runner/generators/grokImagineVideo15'
import {
  PROMPT_MAX_LENGTH, PROMPT_MAX_LENGTH_RULINGS, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, checkedInputFile, requestProblem, requestProblems,
} from '~~/server/runner/requestRules'
import { DEFAULT_BACKUP_STALL_MS } from '~~/server/runner/config'
import { FalError } from '~~/server/runner/falQueue'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema, type ProviderSchemaFixture } from './helpers/providerSchema'
import { makeKit, ofType } from './__runner__/kit'

const ID = 'grok-imagine-video-1.5'
const FAMILY: RunnerFamily = 'grok-imagine-video-1.5'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }

const falSchema = (endpoint: string) => {
  const f = loadProviderSchema('fal', endpoint)
  expect(f.endpoint).toBe(endpoint)
  return f
}
const REPLICATE = loadProviderSchema('replicate', GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG)
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

/** A Generate-a-video node on Grok Imagine Video 1.5; `image` links a picture from node 9. */
function vid(o: { model?: string, prompt?: string, duration?: unknown, opts?: Record<string, unknown>, image?: boolean, ar?: string } = {}) {
  const inputs: Record<string, unknown> = {
    model: o.model ?? ID, prompt: o.prompt ?? 'a fox runs through snow', aspect_ratio: o.ar ?? '16:9', duration: o.duration ?? '6', seed: 0,
    model_options: JSON.stringify(o.opts ?? {}),
  }
  if (o.image) inputs.image = ['9', 0]
  return { class_type: 'GenerateVideoNode', inputs }
}

/** planNode for one node, with the linked picture handed off as `url` (default `https://pics.test/<name>`). */
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
    expect([...GROK_IMAGINE_VIDEO_15_ENDPOINTS].sort()).toEqual(['xai/grok-imagine-video/v1.5/image-to-video', 'xai/grok-imagine-video/v1.5/text-to-video'])
    for (const e of GROK_IMAGINE_VIDEO_15_ENDPOINTS) {
      const f = falSchema(e)
      expect(f.fetchedAt, e).toBe('2026-09-25')
      expect(f.sources?.schema, e).toBe(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${e}`)
      expect(f.pricingText!.replaceAll('**', ''), e).toContain('480p at $0.08/sec, 720p at $0.14/sec, 1080p at $0.25/sec')
    }
    // Image-to-video's extra line, priced on its one picture (videoRates.ts inputImageUsd); text-to-video has none.
    expect(falSchema(GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO).pricingText).toContain('Each reference image adds $0.01')
    expect(falSchema(GROK_IMAGINE_VIDEO_15_TEXT_TO_VIDEO).pricingText).toContain('No input images or references, so no per-image charges apply.')
  })

  it('fal: 1–15 s, 480p/720p/1080p, seven ratios on text-to-video, a prompt required up to 4,096 characters', () => {
    for (const e of GROK_IMAGINE_VIDEO_15_ENDPOINTS) {
      const input = inputOf(falSchema(e))
      expect(input.properties.duration, e).toMatchObject({ type: 'integer', minimum: 1, maximum: 15, default: 6 })
      expect(input.properties.resolution.enum, e).toEqual(['480p', '720p', '1080p'])
      expect(input.properties.resolution.default, e).toBe('720p')
      expect(input.properties.prompt.maxLength, e).toBe(GROK_IMAGINE_VIDEO_15_PROMPT_MAX)
      expect(input.properties.prompt.minLength, e).toBeUndefined()
      expect(input.required, e).toContain('prompt')
    }
    expect(inputOf(falSchema(GROK_IMAGINE_VIDEO_15_TEXT_TO_VIDEO)).properties.aspect_ratio.enum).toEqual(['16:9', '4:3', '3:2', '1:1', '2:3', '3:4', '9:16'])
    expect(inputOf(falSchema(GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO)).properties.aspect_ratio).toBeUndefined()
    expect(inputOf(falSchema(GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO)).required).toContain('image_url')
    expect(GROK_IMAGINE_VIDEO_15_SECONDS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  })

  it('Replicate: xAI\'s own xai/grok-imagine-video-1.5, image-to-video only, 480p or 720p, the same lengths', () => {
    expect(REPLICATE.endpoint).toBe('xai/grok-imagine-video-1.5')
    expect(REPLICATE.fetchedAt).toBe('2026-09-25')
    expect(REPLICATE.versionId).toMatch(/^2378f08d/)
    const input = inputOf(REPLICATE)
    expect([...input.required].sort()).toEqual(['image', 'prompt'])
    expect(input.properties.duration).toMatchObject({ type: 'integer', minimum: 1, maximum: 15 })
    expect(replicateEnum('resolution')).toEqual(['720p', '480p'])
    expect([...GROK_IMAGINE_VIDEO_15_REPLICATE_RESOLUTIONS].sort()).toEqual(['480p', '720p'])
    expect(replicateEnum('aspect_ratio')).toContain('auto')
    expect(JSON.stringify(input.properties.prompt)).not.toMatch(/maxLength|minLength/)
  })

  it('no sound input and no seed on any endpoint', () => {
    for (const f of [falSchema(GROK_IMAGINE_VIDEO_15_TEXT_TO_VIDEO), falSchema(GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO), REPLICATE]) {
      expect(Object.keys(inputOf(f).properties).filter(k => /audio|sound|seed/i.test(k)), f.endpoint).toEqual([])
    }
  })

  it('its own builder, on fal, with text- and image-to-video; it is no other table\'s model', () => {
    expect(GROK_IMAGINE_VIDEO_15).toMatchObject({ id: ID, label: 'Grok Imagine Video 1.5', app: 'xai/grok-imagine-video/v1.5', defaultDuration: 6 })
    expect(GROK_IMAGINE_VIDEO_15.fnByMode).toEqual({ t2v: 'text-to-video', firstLast: 'image-to-video' })
    expect(Object.keys(RUNNER_GROK_IMAGINE_VIDEO_15_MODELS)).toEqual([ID])
    for (const table of [RUNNER_VIDEO_MODELS, RUNNER_ONLY_FAL_VIDEO_MODELS, RUNNER_GEMINI_OMNI_FLASH_MODELS, RUNNER_VEO_31_LITE_MODELS, RUNNER_HAPPYHORSE_11_MODELS]) {
      expect(table[ID]).toBeUndefined()
    }
    expect(RUNNER_ROUTES[`video:${ID}`]).toMatchObject({ first: 'fal', backup: 'replicate' })
    expect(RUNNER_ROUTES[`video:${ID}`]!.why).toMatch(/image-to-video at 480p or 720p only/)
    expect(VIDEO_BACKUPS[ID]).toBe(grokImagineVideo15OnReplicate)
  })

  it('the prompt minimum is a ruling on both fal endpoints (required, no minLength); the maximum is the schemas\' own 4,096', () => {
    for (const e of GROK_IMAGINE_VIDEO_15_ENDPOINTS) {
      expect(PROMPT_MIN_LENGTH[`fal ${e}`], e).toEqual({ min: 1, message: GROK_IMAGINE_VIDEO_15_NEEDS_PROMPT })
      expect(PROMPT_MIN_LENGTH_RULINGS, e).toContain(`fal ${e}`)
      expect(PROMPT_MAX_LENGTH[`fal ${e}`], e).toEqual({ max: 4096, message: GROK_IMAGINE_VIDEO_15_LONG_PROMPT })
      expect(PROMPT_MAX_LENGTH_RULINGS, e).not.toContain(`fal ${e}`)
    }
    // Replicate (the backup) states neither; it is built from a request that passed fal's.
    expect(PROMPT_MIN_LENGTH[`replicate ${GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG}`]).toBeUndefined()
    expect(PROMPT_MAX_LENGTH[`replicate ${GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG}`]).toBeUndefined()
  })

  it('no picture is read before the hand-off: neither schema states a size limit', () => {
    expect(JSON.stringify(inputOf(falSchema(GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO)).properties.image_url)).not.toMatch(/MB/)
    expect(JSON.stringify(inputOf(REPLICATE).properties.image)).not.toMatch(/MB/)
    expect(checkedInputFile('GenerateVideoNode', ALL, ID)).toBeNull()
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

const MODES = [
  { name: 'text', endpoint: GROK_IMAGINE_VIDEO_15_TEXT_TO_VIDEO, image: null as string | null, opts: {} as Record<string, unknown> },
  { name: 'a linked first frame', endpoint: GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO, image: 'https://pics.test/first.png', opts: {} },
  { name: 'a first frame in the options', endpoint: GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO, image: null, opts: { image_url: 'https://pics.test/opt.png' } },
]

describe('every payload over the settings grid fits its schema, its backup fits Replicate\'s, and both carry what the price reads', () => {
  for (const m of MODES) {
    it(`${m.name}: durations × resolutions × ratios`, () => {
      const cat = VIDEO_MODELS_BY_ID[ID]!
      const durations: unknown[] = [...[...new Set([...cat.durations, ...GROK_IMAGINE_VIDEO_15_SECONDS, 0, -3, 16, 20, 60])].flatMap(n => [n, String(n)]), undefined, '', 'six']
      const resolutions = [...(cat.resolutions ?? []), '1080P', '720P', '480P', '4k', 'nope', undefined]
      const ratios = [...cat.aspectRatios, '3:2', '2:3', '21:9', 'auto', '']
      const f = falSchema(m.endpoint)
      const firstFrame = m.image ?? (m.opts.image_url as string | undefined) ?? null
      let cases = 0
      let backups = 0
      const bad: string[] = []
      for (const dur of durations) for (const res of resolutions) for (const ar of ratios) {
        const adv: Record<string, unknown> = { ...m.opts }
        if (res !== undefined) adv.resolution = res
        const opts = JSON.stringify(adv)
        const label = `${opts} ${String(dur)} ${ar}`
        // As planNode calls it.
        const payload = GROK_IMAGINE_VIDEO_15.build({ prompt: 'p', aspectRatio: ar, duration: asInt(dur, GROK_IMAGINE_VIDEO_15.defaultDuration), seed: 7, image: m.image, adv: parseJsonObject(opts) })
        cases++
        const fn = falVideoFn(payload, GROK_IMAGINE_VIDEO_15.fnByMode)
        if (`${GROK_IMAGINE_VIDEO_15.app}/${fn}` !== m.endpoint) bad.push(`${label}: endpoint ${fn}`)
        for (const e of checkPayload(f, payload)) bad.push(`${label}: ${e}`)
        if ('seed' in payload) bad.push(`${label}: a seed`)
        // Priced on what is sent: the node's picture input as nodePrice passes it (a link, or none).
        const priced = effectiveVideoSettings(ID, dur, ar, opts, m.image ? ['9', 0] : undefined)!
        const sent = { seconds: payload.duration, resolution: payload.resolution, audio: true, inputImages: payload.image_url ? 1 : 0 }
        if (priced.seconds !== sent.seconds || priced.resolution !== sent.resolution || priced.audio !== sent.audio || priced.inputImages !== sent.inputImages) {
          bad.push(`${label}: sent ${JSON.stringify(sent)}, priced ${JSON.stringify(priced)}`)
        }
        // The backup: the same clip on Replicate for image-to-video at 480p or 720p; none otherwise.
        const backup = grokImagineVideo15OnReplicate(payload)
        if (firstFrame && GROK_IMAGINE_VIDEO_15_REPLICATE_RESOLUTIONS.has(String(payload.resolution))) {
          if (!backup) {
            bad.push(`${label}: no backup`)
            continue
          }
          backups++
          if (backup.provider !== 'replicate' || backup.endpoint !== GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG) bad.push(`${label}: backup to ${backup.endpoint}`)
          for (const e of checkPayload(REPLICATE, backup.payload)) bad.push(`${label} backup: ${e}`)
          const b = backup.payload
          if (b.prompt !== payload.prompt || b.duration !== payload.duration || b.resolution !== payload.resolution
            || b.image !== firstFrame || b.image !== payload.image_url || b.aspect_ratio !== 'auto') {
            bad.push(`${label}: backup ${JSON.stringify(b)} is not ${JSON.stringify(payload)}`)
          }
        }
        else if (backup) bad.push(`${label}: a backup at ${String(payload.resolution)} ${firstFrame ? 'i2v' : 't2v'}`)
      }
      expect(bad.slice(0, 5)).toEqual([])
      expect(cases).toBeGreaterThan(1000)
      if (firstFrame) expect(backups).toBeGreaterThan(300)
      else expect(backups).toBe(0)
    })
  }
})

// ── Expected payloads (through planNode) ───────────────────────────────────

describe('expected payloads', () => {
  it('plain: text-to-video with the schema\'s own example prompt, at the node\'s defaults; no backup (Replicate has no text-to-video)', async () => {
    const example = inputOf(falSchema(GROK_IMAGINE_VIDEO_15_TEXT_TO_VIDEO)).properties.prompt.examples[0] as string
    expect(example).toMatch(/^Anime schoolgirl bursting out of house door/)
    const p = await providerPlan(vid({ prompt: example }))
    expect(p.provider).toBe('fal')
    expect(p.endpoint).toBe('xai/grok-imagine-video/v1.5/text-to-video')
    expect(p.payload).toEqual({ prompt: example, aspect_ratio: '16:9', resolution: '720p', duration: 6 })
    expect(checkPayload(falSchema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('every option set: 1080p, portrait, 15 s; a seed on the node is not sent (neither service takes one)', async () => {
    const prompt = 'A lighthouse in a storm, waves crashing, the beam sweeping through rain. AUDIO: thunder, a foghorn.'
    const node = vid({ prompt, duration: '15', ar: '9:16', opts: { resolution: '1080p' } })
    node.inputs.seed = 42
    const p = await providerPlan(node)
    expect(p.endpoint).toBe('xai/grok-imagine-video/v1.5/text-to-video')
    expect(p.payload).toEqual({ prompt, aspect_ratio: '9:16', resolution: '1080p', duration: 15 })
    expect(checkPayload(falSchema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('a picture linked: image-to-video with the schema\'s own example prompt and picture, no ratio; the Replicate backup at the picture\'s shape', async () => {
    const props = inputOf(falSchema(GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO)).properties
    const prompt = props.prompt.examples[0] as string
    const picture = props.image_url.examples[0] as string
    expect(prompt).toMatch(/^Medieval knight in ornate armor/)
    const p = await providerPlan(vid({ prompt, image: true, duration: '1', ar: '9:16', opts: { resolution: '480p' } }), picture)
    expect(p.endpoint).toBe('xai/grok-imagine-video/v1.5/image-to-video')
    expect(p.payload).toEqual({ image_url: picture, prompt, resolution: '480p', duration: 1 })
    expect(checkPayload(falSchema(p.endpoint), p.payload)).toEqual([])
    expect(p.backup).toEqual({
      provider: 'replicate', endpoint: 'xai/grok-imagine-video-1.5',
      payload: { prompt, image: picture, duration: 1, resolution: '480p', aspect_ratio: 'auto' },
    })
    expect(checkPayload(REPLICATE, p.backup!.payload)).toEqual([])
  })

  it('a picture linked at 1080p: fal only (Replicate makes 480p or 720p)', async () => {
    const p = await providerPlan(vid({ image: true, opts: { resolution: '1080p' } }))
    expect(p.payload).toEqual({ image_url: 'https://pics.test/first.png', prompt: 'a fox runs through snow', resolution: '1080p', duration: 6 })
    expect(p.backup).toBeUndefined()
  })

  it('a ratio fal doesn\'t take is sent as 16:9', async () => {
    expect((await providerPlan(vid({ ar: '21:9' }))).payload.aspect_ratio).toBe('16:9')
  })
})

// ── Refusals ───────────────────────────────────────────────────────────────

describe('what Grok Imagine Video 1.5 can\'t take is refused in plain words, never dropped', () => {
  const extras: Record<string, unknown>[] = [
    { end_image_url: 'https://pics.test/last.png' },
    { image_urls: ['https://pics.test/ref.png'] },
    { video_urls: ['https://pics.test/ref.mp4'] },
    { audio_urls: ['https://pics.test/voice.mp3'] },
  ]
  for (const opts of extras) {
    it(`${Object.keys(opts)[0]}: refused at planning and before the hold, with or without a first frame`, async () => {
      for (const image of [false, true]) {
        await expect(plan(vid({ opts, image }))).rejects.toThrow(GROK_IMAGINE_VIDEO_15_ONE_PICTURE)
        expect(requestProblems({ 1: vid({ opts, image }) })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'model_options', message: GROK_IMAGINE_VIDEO_15_ONE_PICTURE }])
      }
    })
  }

  it('the words: plain, sentence case, naming the model, no identifiers', () => {
    expect(GROK_IMAGINE_VIDEO_15_ONE_PICTURE).toBe('Grok Imagine Video 1.5 starts from one picture at most and takes no sound. Remove the last frame and any reference pictures, videos or sounds, or pick another model.')
    expect(GROK_IMAGINE_VIDEO_15_NEEDS_PROMPT).toBe('Grok Imagine Video 1.5 needs a prompt. Describe the clip, or how the picture should move.')
    expect(GROK_IMAGINE_VIDEO_15_LONG_PROMPT).toBe('Grok Imagine Video 1.5 takes a prompt of at most 4,096 characters. Shorten it.')
  })

  it('an empty or spaces-only prompt: refused at planning and before the hold, in either mode; one character runs', async () => {
    for (const prompt of ['', '   ']) {
      for (const n of [vid({ prompt }), vid({ prompt, image: true }), vid({ prompt, opts: { image_url: 'https://pics.test/a.png' } })]) {
        await expect(plan(n)).rejects.toThrow(GROK_IMAGINE_VIDEO_15_NEEDS_PROMPT)
        expect(requestProblems({ 1: n })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'prompt', message: GROK_IMAGINE_VIDEO_15_NEEDS_PROMPT }])
      }
    }
    expect(requestProblems({ 1: vid({ prompt: 'a' }) })).toEqual([])
    expect(requestProblems({ 1: vid({ prompt: 'a', image: true }) })).toEqual([])
    // Wired options: the mode can't be read, but both endpoints have the same rules, so the prompt is judged.
    const wiredOpts = vid({ prompt: '' })
    wiredOpts.inputs.model_options = ['9', 0]
    expect(requestProblems({ 1: wiredOpts })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'prompt', message: GROK_IMAGINE_VIDEO_15_NEEDS_PROMPT }])
    // A wired prompt can't be read before the run.
    const wiredPrompt = vid({ prompt: '' })
    wiredPrompt.inputs.prompt = ['9', 0]
    expect(requestProblems({ 1: wiredPrompt })).toEqual([])
  })

  it('a prompt over the schemas\' 4,096 characters (code points, as sent): refused at planning and before the hold', async () => {
    const atMax = ['a'.repeat(4096), '🦊'.repeat(4096)]
    const over = ['a'.repeat(4097), '🦊'.repeat(4097)]
    for (const e of GROK_IMAGINE_VIDEO_15_ENDPOINTS) {
      for (const prompt of atMax) expect(requestProblem('fal', e, { prompt }), e).toBeNull()
      for (const prompt of over) expect(requestProblem('fal', e, { prompt }), e).toBe(GROK_IMAGINE_VIDEO_15_LONG_PROMPT)
    }
    for (const image of [false, true]) {
      for (const prompt of atMax) await expect(providerPlan(vid({ prompt, image }))).resolves.toBeTruthy()
      for (const prompt of over) await expect(plan(vid({ prompt, image }))).rejects.toThrow(GROK_IMAGINE_VIDEO_15_LONG_PROMPT)
    }
    const long = 'a'.repeat(4097)
    const wiredOpts = vid({ prompt: long })
    wiredOpts.inputs.model_options = ['9', 0]
    for (const n of [vid({ prompt: long }), vid({ prompt: long, image: true }), wiredOpts]) {
      expect(requestProblems({ 1: n })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'prompt', message: GROK_IMAGINE_VIDEO_15_LONG_PROMPT }])
    }
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
    expect(blockedModelUses(t2v, { families: ON })).toEqual([use()])
    expect(blockedModelUses({ 1: { class_type: 'FilmShotNode', inputs: { model: ID } } }, { families: ALL, runnerTakes: true }))
      .toEqual([use('FilmShotNode')])
  })

  it('a workflow that needs the engine is refused before it goes there, naming the model and the engine-only node', () => {
    const p: ApiPrompt = { 1: vid(), 2: { class_type: 'KSampler', inputs: {} } }
    const titles: Record<string, string> = { 1: 'Clip', 2: 'Old sampler' }
    const r = blockedRunRefusal([{ prompt: p, titleOf: id => titles[id] ?? 'Unnamed node' }], { runnerOn: true, families: ON })
    expect(r).not.toBeNull()
    expect(`${r!.title} ${r!.description}`).toContain('Grok Imagine Video 1.5')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: t2v, titleOf: () => 'Clip' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery and the defaults', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family grok-imagine-video-1.5, with a plain name and the schemas\' settings', () => {
    const m = VIDEO_MODELS_BY_ID[ID]!
    expect(m.runnerOnly).toBe(true)
    expect(m.family).toBe(FAMILY)
    expect(m.hidden).toBeUndefined()
    expect(m.label).toBe('Grok Imagine Video 1.5')
    expect(m.brand).toBe('xAI')
    expect(m.replicateSlug).toBe(GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG)
    expect(m.modes).toEqual(['t2v', 'i2v'])
    expect(m.supportsSeed).toBe(false)
    // The node's ratios fal's text-to-video lists (3:2 and 2:3 aren't in the node's list; 21:9 isn't in fal's).
    expect(m.aspectRatios).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4'])
    expect(m.defaultAspectRatio).toBe('16:9')
    expect(m.resolutions).toEqual(['480p', '720p', '1080p'])
    expect(m.defaultResolution).toBe('720p')
    expect(m.defaultDuration).toBe(6)
    expect(m.tags).toContain('audio')
    expect(m.tags).not.toContain('lip-sync')
    expect(m.advanced).toEqual([])
    for (const text of [m.pitch, m.description!]) {
      expect(text).toMatch(/^[A-Z]/)
      expect(text).not.toMatch(/grok-imagine|xai\/|_/)
    }
    // Every length the menu offers is one the builder sends as is.
    expect(m.durations.every(d => GROK_IMAGINE_VIDEO_15.build({ prompt: 'p', aspectRatio: '16:9', duration: d, seed: 0, image: null, adv: {} }).duration === d)).toBe(true)
    expect(allowedDurations(ID)).toEqual(m.durations.map(String))
  })

  it('hidden from "Generate a video" while the family is off, shown while on; never on "Film a shot"', () => {
    const shown = (cls: string, f: ReadonlySet<RunnerFamily>) => galleryEntries(VIDEO_MODELS, { classType: cls, families: f, current: null }).map(e => e.model.id)
    expect(shown('GenerateVideoNode', NO_FAMILIES)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ALL_BUT)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ON)).toContain(ID)
    expect(shown('FilmShotNode', ALL)).not.toContain(ID)
    const saved = galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: NO_FAMILIES, current: ID })
    expect(saved.find(e => e.model.id === ID)).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
  })

  it('a new node\'s default does not move to Grok Imagine Video 1.5', () => {
    expect(VIDEO_MODEL_PREFERENCE).not.toContain(ID)
    expect(FILM_SHOT_MODEL_PREFERENCE).not.toContain(ID)
    expect(menuDefault(modelMenu('GenerateVideoNode')!, ALL)).toBe(VIDEO_MODEL_PREFERENCE[0])
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  /** What priceGraph charges for one node plus an output node. */
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs }, 2: SINK }).credits

  it('fal\'s rate per second by resolution, plus $0.01 for image-to-video\'s picture, verified; Replicate\'s flat $0.08, the backup card', () => {
    expect(videoRate(ID)).toMatchObject({
      unit: 'per_second', service: 'fal', confidence: 'verified', read: '2026-09-25',
      source: 'https://fal.ai/models/xai/grok-imagine-video/v1.5/image-to-video/llms.txt',
      byResolution: { '480p': 0.08, '720p': 0.14, '1080p': 0.25 },
      inputImageUsd: 0.01,
    })
    expect(videoBackupRate(ID)).toMatchObject({
      unit: 'per_second', service: 'replicate', confidence: 'verified', read: '2026-09-25',
      source: 'https://replicate.com/xai/grok-imagine-video-1.5',
      byResolution: { '*': 0.08 },
    })
    expect(videoBackupRate(ID)!.inputImageUsd).toBeUndefined()
  })

  const examples: { name: string, inputs: Record<string, unknown>, usd: number, backupUsd: number }[] = [
    { name: '1 s at 480p (the shortest, cheapest clip: the live check)', inputs: { model: ID, duration: '1', model_options: '{"resolution":"480p"}' }, usd: 0.08, backupUsd: 0.08 },
    { name: '6 s at 720p (the node\'s defaults)', inputs: { model: ID, duration: '6', model_options: '{}' }, usd: 0.84, backupUsd: 0.48 },
    { name: '6 s at 720p, a picture linked (+ $0.01)', inputs: { model: ID, duration: '6', model_options: '{}', image: ['9', 0] }, usd: 0.85, backupUsd: 0.48 },
    { name: '5 s at 480p, a picture in the options (+ $0.01)', inputs: { model: ID, duration: '5', model_options: '{"resolution":"480p","image_url":"https://pics.test/a.png"}' }, usd: 0.41, backupUsd: 0.40 },
    { name: '15 s at 1080p (the dearest)', inputs: { model: ID, duration: '15', model_options: '{"resolution":"1080p"}' }, usd: 3.75, backupUsd: 1.20 },
    { name: 'a 4k setting is sent (and priced) as 720p', inputs: { model: ID, duration: '5', model_options: '{"resolution":"4k"}' }, usd: 0.70, backupUsd: 0.40 },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $${ex.usd.toFixed(2)}; covers the backup; badge = charge = run estimate`, () => {
      expect(providerUsd('GenerateVideoNode', ex.inputs)).toBeCloseTo(ex.usd, 9)
      const s = effectiveVideoSettings(ID, ex.inputs.duration, ex.inputs.aspect_ratio ?? '16:9', ex.inputs.model_options, ex.inputs.image)!
      expect(videoUsd(ID, s)).toBeCloseTo(ex.usd, 9)
      expect(videoBackupUsd(ID, s)).toBeCloseTo(ex.backupUsd, 9)
      // Replicate is never dearer than fal: fal's marked-up price stands.
      expect(usdChargedAtCost(ex.backupUsd)).toBeLessThan(ex.usd)
      expect(videoPriceUsd(ID, s)).toBeCloseTo(ex.usd, 9)
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

  it('the live check: 1 s at 480p is $0.08, 16 credits (17 with the base render)', () => {
    expect(creditsForUsd(0.08)).toBe(16)
    expect(charge({ model: ID, duration: '1', model_options: '{"resolution":"480p"}' })).toBe(17)
  })

  it('a linked length prices at the longest sent (15 s); linked options at the top rate (1080p) with a picture', () => {
    expect(maxVideoSeconds(ID)).toBe(15)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: ['7', 0], model_options: '{}' })).toBeCloseTo(0.14 * 15, 9)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: '4', model_options: ['7', 0] })).toBeCloseTo(0.25 * 4 + 0.01, 9)
    for (const inputs of [
      { model: ID, duration: ['7', 0], model_options: '{}' },
      { model: ID, duration: '4', model_options: ['7', 0] },
    ]) expect(nodeCreditEstimate('GenerateVideoNode', inputs)).toBe(charge(inputs))
  })

  it('priced on what is sent: the planned payload\'s seconds, resolution and picture give the price', async () => {
    for (const image of [false, true]) {
      for (const [dur, res] of [['1', '480p'], ['7', '1080p'], ['9', '4k'], ['45', 'nope'], ['15', '1080P'], ['0', '480P']] as const) {
        const node = vid({ image, duration: dur, opts: { resolution: res } })
        const p = await providerPlan(node)
        const rate = videoRate(ID)!.byResolution[String(p.payload.resolution)] as number
        const picture = p.payload.image_url ? 0.01 : 0
        expect(providerUsd('GenerateVideoNode', node.inputs), `${image} ${dur} ${res}`).toBeCloseTo(rate * Number(p.payload.duration) + picture, 9)
        if (p.backup) expect(0.08 * Number(p.backup.payload.duration)).toBeLessThanOrEqual(rate * Number(p.payload.duration))
      }
    }
  })

  it('the gallery label reads the rate at the default settings (720p)', () => {
    expect(videoRateLabel(ID)).toBe('$0.14/s at 720p')
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = { 1: vid({ duration: '1', opts: { resolution: '480p' } }), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
  const start = (k: ReturnType<typeof makeKit>, t: ApiPrompt = take) => k.engine.startRun({ userId: k.userId, takes: [t], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: the family\'s own fal endpoint, held at the node\'s price, a real output; Replicate not called', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = [...k.fal.reqs.values()]
    expect(submitted.map(r => r.endpoint)).toEqual(['xai/grok-imagine-video/v1.5/text-to-video'])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a fox runs through snow', aspect_ratio: '16:9', resolution: '480p', duration: 1 })
    expect(k.replicate.reqs.size).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([creditsForUsd(0.08) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT } })
    await expect(start(k)).rejects.toThrow()
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })

  it('an empty prompt: refused before the hold, nothing sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const empty: ApiPrompt = { 1: vid({ prompt: '' }), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
    await expect(start(k, empty)).rejects.toThrow(GROK_IMAGINE_VIDEO_15_NEEDS_PROMPT)
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })

  it('a picture linked, fal down: the backup on Replicate carries the same picture and serves it, charged once', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON, backup: () => ({ enabled: true, stallMs: DEFAULT_BACKUP_STALL_MS }) } })
    fs.writeFileSync(path.join(k.root, 'input', 'first.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]))
    const i2v: ApiPrompt = {
      11: { class_type: 'Image', inputs: { image: 'first.png' } },
      1: vid(),
      2: { class_type: 'Video', inputs: { source: ['1', 0] } },
    }
    i2v[1]!.inputs.image = ['11', 0]
    k.fal.client.submit.mockRejectedValueOnce(new FalError('fal submit 503: unavailable', 503))
    const { runId } = await start(k, i2v)
    await k.engine.settled(runId)
    expect(k.fal.client.submit.mock.calls[0]![0]).toBe(GROK_IMAGINE_VIDEO_15_IMAGE_TO_VIDEO)
    const sent = k.replicate.submitted()
    expect(sent.map(r => r.endpoint)).toEqual([GROK_IMAGINE_VIDEO_15_REPLICATE_SLUG])
    expect(sent[0]!.payload).toEqual({ prompt: 'a fox runs through snow', image: 'https://fal.storage/first.png', duration: 6, resolution: '720p', aspect_ratio: 'auto' })
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    // 6 s at 720p on fal, + $0.01 for the picture: the price that covers either service.
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', creditsForUsd(0.85) + 1]])
    expect((await k.store.get(runId))!.status).toBe('done')
  })
})

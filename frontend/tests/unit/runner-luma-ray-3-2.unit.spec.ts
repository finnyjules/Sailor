/**
 * Task F21 (model line-up): Luma Ray 3.2, runner-only, family `luma-ray-3.2`
 * (server/runner/generators/lumaRay32.ts): Replicate's luma/ray-3.2 first,
 * fal's luma/agent/ray/v3.2/image-to-video the backup for image-to-video only
 * (the same price there; fal's text-to-video is 1.7–3.3 times Replicate's and
 * would raise the price, so text has no backup). It replaces the hidden Luma
 * Ray 2 (720p), which stays hidden, runnable and priced as before.
 *
 * The family contract:
 *  - the saved schemas: the endpoint ids, fal's pricing text, Replicate's version;
 *  - every payload over the settings grid fits its saved schema, the backup
 *    only where it should be, and carries the seconds and resolution the
 *    price reads;
 *  - hand-written expected payloads: plain (Replicate's own example
 *    defaults), every option set, a picture linked with a last frame;
 *  - the prompt rules and the plain refusals (references, a last frame alone,
 *    10 s from a picture, a loop it can't make, sound);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off; Ray 2 stays hidden;
 *  - the price is Replicate's verified card with the markup (the backup at
 *    cost never raises it), and badge = charge;
 *  - the engine, end to end: the family's own endpoint, the hold, and the
 *    backup on fal when Replicate is down.
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
import { RUNNER_REPLICATE_VIDEO_MODELS, RUNNER_VIDEO_MODELS } from '~~/server/runner/generators/video'
import { RUNNER_ROUTES, VIDEO_BACKUPS } from '~~/server/runner/generators/twins'
import {
  LUMA_RAY_32_DEFAULT_SECONDS, LUMA_RAY_32_EXTRAS, LUMA_RAY_32_FAL_IMAGE_TO_VIDEO, LUMA_RAY_32_FAL_PROMPT_MAX, LUMA_RAY_32_LAST_NEEDS_FIRST,
  LUMA_RAY_32_LONG_FROM_PICTURE, LUMA_RAY_32_LONG_PROMPT, LUMA_RAY_32_LOOP_TOO_LONG, LUMA_RAY_32_LOOP_WITH_LAST, LUMA_RAY_32_NEEDS_PROMPT,
  LUMA_RAY_32_REPLICATE_SLUG, LUMA_RAY_32_SECONDS, lumaRay32, lumaRay32OnFal,
} from '~~/server/runner/generators/lumaRay32'
import {
  PROMPT_MAX_LENGTH, PROMPT_MAX_LENGTH_RULINGS, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, checkedInputFile, requestProblems,
} from '~~/server/runner/requestRules'
import { DEFAULT_BACKUP_STALL_MS } from '~~/server/runner/config'
import { ReplicateError } from '~~/server/runner/replicateQueue'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema, type ProviderSchemaFixture } from './helpers/providerSchema'
import { FIXTURE_DIR, fixtureFileName } from '../../scripts/snapshot_provider_schemas.mjs'
import { makeKit, ofType } from './__runner__/kit'

const ID = 'luma-ray-3.2'
const FAMILY: RunnerFamily = 'luma-ray-3.2'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }
const RATIOS = ['9:16', '3:4', '1:1', '4:3', '16:9', '21:9']

const REPLICATE = loadProviderSchema('replicate', LUMA_RAY_32_REPLICATE_SLUG)
const FAL = loadProviderSchema('fal', LUMA_RAY_32_FAL_IMAGE_TO_VIDEO)
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

/** A Generate-a-video node on Luma Ray 3.2; `image` links a picture from node 9. */
function vid(o: { prompt?: string, duration?: unknown, opts?: Record<string, unknown>, image?: boolean, ar?: string } = {}) {
  const inputs: Record<string, unknown> = {
    model: ID, prompt: o.prompt ?? 'a fox runs through snow', aspect_ratio: o.ar ?? '16:9', duration: o.duration ?? '5', seed: 0,
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
  it('Replicate: Luma\'s own luma/ray-3.2, one model for both modes, its lengths, ratios and resolutions', () => {
    expect(REPLICATE.endpoint).toBe('luma/ray-3.2')
    expect(REPLICATE.fetchedAt).toBe('2026-09-25')
    expect(REPLICATE.versionId).toMatch(/^6e0a5501/)
    const input = inputOf(REPLICATE)
    expect(input.required).toEqual(['prompt'])
    expect(replicateEnum('duration')).toEqual([...LUMA_RAY_32_SECONDS])
    expect(input.properties.duration.default).toBe(LUMA_RAY_32_DEFAULT_SECONDS)
    expect(input.properties.duration.description).toContain('10s is not supported with hdr, start_image, end_image, or loop.')
    expect(replicateEnum('resolution')).toEqual(['540p', '720p', '1080p'])
    expect(input.properties.resolution.default).toBe('720p')
    expect(replicateEnum('aspect_ratio')).toEqual(RATIOS)
    expect(input.properties.loop).toMatchObject({ type: 'boolean', default: false })
    expect(input.properties.loop.description).toContain('Not supported with 10s duration, hdr, or end_image.')
    expect(input.properties.end_image.description).toContain('Only valid with 5s duration; not supported with loop.')
    expect(input.properties.aspect_ratio.description).toContain('Ignored when start_image or end_image is set')
    // One output file (the MP4): an EXR file could not come back, so HDR and EXR are not offered.
    expect(inputOf({ ...REPLICATE, input: REPLICATE.output })).toMatchObject({ type: 'string', format: 'uri' })
    expect(JSON.stringify(input.properties.prompt)).not.toMatch(/maxLength|minLength/)
  })

  it('fal: luma/agent/ray/v3.2/image-to-video (no fal-ai/ prefix), the same settings, 5 s from a picture, and its price', () => {
    expect(FAL.endpoint).toBe('luma/agent/ray/v3.2/image-to-video')
    expect(FAL.fetchedAt).toBe('2026-09-25')
    const input = inputOf(FAL)
    expect(input.required).toEqual(['prompt'])
    expect(input.properties.prompt).toMatchObject({ minLength: 1, maxLength: LUMA_RAY_32_FAL_PROMPT_MAX })
    expect(input.properties.duration).toMatchObject({ enum: ['5s', '10s'], default: '5s' })
    expect(input.properties.duration.description).toContain('it is not supported with a single image_url / end_image_url anchor')
    expect(input.properties.resolution).toMatchObject({ enum: ['540p', '720p', '1080p'], default: '540p' })
    expect([...input.properties.aspect_ratio.enum].sort()).toEqual([...RATIOS].sort())
    expect(input.properties.loop.description).toContain('without an end frame or keyframes')
    expect(FAL.pricingText).toContain('For 5s video your request will cost **$0.15** for 540p, **$0.30** for 720p and **$1.20** for 1080p.')
    expect(FAL.pricingText).toContain('10s is not available for image-to-video')
  })

  it('no seed and no sound input on either', () => {
    for (const f of [REPLICATE, FAL]) {
      expect(Object.keys(inputOf(f).properties).filter(k => /seed|audio/i.test(k)), f.endpoint).toEqual([])
    }
  })

  it('fal\'s text-to-video is not kept: the runner never calls it', () => {
    expect(fs.existsSync(path.join(FIXTURE_DIR, 'fal', fixtureFileName('luma/agent/ray/v3.2/text-to-video')))).toBe(false)
  })

  it('its own builder, Replicate first and fal the backup; it is in no other table', () => {
    expect(RUNNER_VIDEO_MODELS[ID]).toBeUndefined()
    expect(RUNNER_REPLICATE_VIDEO_MODELS[ID]).toBeUndefined()
    expect(VIDEO_BACKUPS[ID]).toBeUndefined()
    expect(RUNNER_ROUTES[`video:${ID}`]).toMatchObject({ first: 'replicate', backup: 'fal' })
    expect(RUNNER_ROUTES[`video:${ID}`]!.why).toMatch(/image-to-video only/)
    // The older model stays hidden, on its own route, with no backup, its builder and price unchanged.
    expect(VIDEO_MODELS_BY_ID['luma-ray-2-720p']!.hidden).toBe(true)
    expect(RUNNER_ROUTES['video:luma-ray-2-720p']).toMatchObject({ first: 'replicate', backup: null })
    expect(RUNNER_REPLICATE_VIDEO_MODELS['luma-ray-2-720p']!.slug).toBe('luma/ray-2-720p')
    expect(videoRate('luma-ray-2-720p')).toMatchObject({ unit: 'per_second', service: 'replicate', byResolution: { '*': 0.18 } })
    expect(videoBackupRate('luma-ray-2-720p')).toBeNull()
  })

  it('the prompt: a ruled minimum on Replicate; fal\'s own minimum and 6,000 maximum (they only drop the backup)', () => {
    expect(PROMPT_MIN_LENGTH[`replicate ${LUMA_RAY_32_REPLICATE_SLUG}`]).toEqual({ min: 1, message: LUMA_RAY_32_NEEDS_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).toContain(`replicate ${LUMA_RAY_32_REPLICATE_SLUG}`)
    expect(PROMPT_MAX_LENGTH[`replicate ${LUMA_RAY_32_REPLICATE_SLUG}`]).toBeUndefined()
    expect(PROMPT_MIN_LENGTH[`fal ${LUMA_RAY_32_FAL_IMAGE_TO_VIDEO}`]).toEqual({ min: 1, message: LUMA_RAY_32_NEEDS_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).not.toContain(`fal ${LUMA_RAY_32_FAL_IMAGE_TO_VIDEO}`)
    expect(PROMPT_MAX_LENGTH[`fal ${LUMA_RAY_32_FAL_IMAGE_TO_VIDEO}`]).toEqual({ max: 6000, message: LUMA_RAY_32_LONG_PROMPT })
    expect(PROMPT_MAX_LENGTH_RULINGS).not.toContain(`fal ${LUMA_RAY_32_FAL_IMAGE_TO_VIDEO}`)
  })

  it('no picture is read before the hand-off: neither schema states a size limit', () => {
    expect(JSON.stringify(inputOf(REPLICATE).properties.start_image)).not.toMatch(/MB/)
    expect(JSON.stringify(inputOf(FAL).properties.image_url)).not.toMatch(/MB/)
    expect(checkedInputFile('GenerateVideoNode', ALL, ID)).toBeNull()
  })
})

// ── The settings grid ──────────────────────────────────────────────────────

const MODES = [
  { name: 'text', image: null as string | null, opts: {} as Record<string, unknown>, first: null as string | null, last: null as string | null },
  { name: 'a linked first frame', image: 'https://pics.test/first.png', opts: {}, first: 'https://pics.test/first.png', last: null },
  { name: 'a first frame in the options', image: null, opts: { image_url: 'https://pics.test/opt.png' }, first: 'https://pics.test/opt.png', last: null },
  { name: 'first and last frames', image: 'https://pics.test/first.png', opts: { end_image_url: 'https://pics.test/last.png' }, first: 'https://pics.test/first.png', last: 'https://pics.test/last.png' },
]
const REFUSALS = [LUMA_RAY_32_LONG_FROM_PICTURE, LUMA_RAY_32_LOOP_TOO_LONG, LUMA_RAY_32_LOOP_WITH_LAST]

describe('every payload over the settings grid fits its schema, the backup only for a picture, priced on what is sent', () => {
  for (const m of MODES) {
    it(`${m.name}: durations × resolutions × ratios × loop`, () => {
      const cat = VIDEO_MODELS_BY_ID[ID]!
      const durations: unknown[] = [...[...new Set([...cat.durations, 0, 1, 4, 6, 7, 8, 9, 11, 15, 60])].flatMap(n => [n, String(n)]), undefined, '', 'five']
      const resolutions = [...(cat.resolutions ?? []), '1080P', '540P', '480p', '4k', 'nope', undefined]
      const ratios = [...cat.aspectRatios, '2:3', 'auto', '']
      const loops = [true, false, 'true', undefined]
      let cases = 0
      let refused = 0
      let backups = 0
      const bad: string[] = []
      for (const dur of durations) for (const res of resolutions) for (const ar of ratios) for (const loop of loops) {
        const adv: Record<string, unknown> = { ...m.opts }
        if (res !== undefined) adv.resolution = res
        if (loop !== undefined) adv.loop = loop
        const opts = JSON.stringify(adv)
        const label = `${opts} ${String(dur)} ${ar}`
        const args = { prompt: 'p', aspectRatio: ar, duration: asInt(dur, LUMA_RAY_32_DEFAULT_SECONDS), seed: 7, image: m.image, adv: parseJsonObject(opts) }
        cases++
        // 10 s from a picture, a loop at 10 s or to a last frame: refused in plain words, never sent otherwise.
        let payload: Record<string, unknown>
        try { payload = lumaRay32(args) }
        catch (e) {
          refused++
          if (!REFUSALS.includes((e as Error).message)) bad.push(`${label}: ${(e as Error).message}`)
          continue
        }
        for (const e of checkPayload(REPLICATE, payload)) bad.push(`${label}: ${e}`)
        if ('seed' in payload || 'hdr' in payload || 'exr_export' in payload) bad.push(`${label}: a seed or HDR`)
        if ((payload.start_image ?? null) !== m.first || (payload.end_image ?? null) !== m.last) bad.push(`${label}: frames ${JSON.stringify(payload)}`)
        if (payload.duration === 10 && (m.first || payload.loop)) bad.push(`${label}: 10 s with a picture or a loop`)
        if (payload.loop === true && payload.end_image) bad.push(`${label}: a loop to a last frame`)
        const backup = lumaRay32OnFal(payload)
        if (m.first) {
          if (!backup) { bad.push(`${label}: no backup for a picture`); continue }
          backups++
          if (backup.provider !== 'fal' || backup.endpoint !== LUMA_RAY_32_FAL_IMAGE_TO_VIDEO) bad.push(`${label}: backup ${backup.endpoint}`)
          for (const e of checkPayload(FAL, backup.payload)) bad.push(`${label}: backup ${e}`)
          // The same clip on both: prompt, frames, length, resolution, ratio and loop.
          const b = backup.payload
          if (b.prompt !== payload.prompt || b.image_url !== payload.start_image || (b.end_image_url ?? null) !== (payload.end_image ?? null)
            || b.duration !== `${String(payload.duration)}s` || b.resolution !== payload.resolution || b.aspect_ratio !== payload.aspect_ratio || b.loop !== payload.loop) {
            bad.push(`${label}: backup differs ${JSON.stringify(b)}`)
          }
        }
        else if (backup) bad.push(`${label}: a backup for text-to-video`)
        // Priced on what is sent: the node's picture input as nodePrice passes it (a link, or none).
        const priced = effectiveVideoSettings(ID, dur, ar, opts, m.image ? ['9', 0] : undefined)!
        if (priced.seconds !== payload.duration || priced.resolution !== payload.resolution || priced.audio !== false) {
          bad.push(`${label}: sent ${String(payload.duration)} ${String(payload.resolution)}, priced ${JSON.stringify(priced)}`)
        }
        // The backup at cost never raises the price: it is Replicate's with the markup.
        if (Math.abs(videoPriceUsd(ID, priced)! - videoUsd(ID, priced)!) > 1e-9) bad.push(`${label}: price is not Replicate's`)
      }
      expect(bad.slice(0, 5)).toEqual([])
      expect(cases).toBeGreaterThan(1000)
      expect(refused).toBeGreaterThan(100)
      if (m.first) expect(backups).toBeGreaterThan(100)
    })
  }
})

// ── Expected payloads (through planNode) ───────────────────────────────────

describe('expected payloads', () => {
  it('plain: text-to-video at the node\'s defaults (5 s, 720p, 16:9, no loop); no backup', async () => {
    const prompt = 'A herd of wild horses galloping across a dusty desert plain under a blazing midday sun, their manes flying in the wind; wide tracking shot.'
    const p = await providerPlan(vid({ prompt }))
    expect(p.provider).toBe('replicate')
    expect(p.endpoint).toBe('luma/ray-3.2')
    expect(p.payload).toEqual({ prompt, duration: 5, resolution: '720p', aspect_ratio: '16:9', loop: false })
    expect(checkPayload(REPLICATE, p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
  })

  it('every option set: 10 s at 1080p in 21:9 from text; a seed on the node is not sent; no backup', async () => {
    const prompt = 'A lighthouse in a storm, waves crashing, the beam sweeping through rain.'
    const node = vid({ prompt, duration: '10', ar: '21:9', opts: { resolution: '1080p' } })
    node.inputs.seed = 42
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt, duration: 10, resolution: '1080p', aspect_ratio: '21:9', loop: false })
    expect(checkPayload(REPLICATE, p.payload)).toEqual([])
    expect(p.backup).toBeUndefined()
    // A seamless loop, 540p, portrait, 5 s.
    const loop = await providerPlan(vid({ prompt, ar: '9:16', opts: { resolution: '540p', loop: true } }))
    expect(loop.payload).toEqual({ prompt, duration: 5, resolution: '540p', aspect_ratio: '9:16', loop: true })
    expect(checkPayload(REPLICATE, loop.payload)).toEqual([])
  })

  it('a picture linked, with a last frame: both frames on Replicate; fal\'s image-to-video the backup with the same clip', async () => {
    const prompt = 'Low-angle shot of a majestic tiger prowling through a snowy landscape, leaving paw prints on the white blanket.'
    const picture = 'https://pics.test/tiger.png'
    const p = await providerPlan(vid({ prompt, image: true, ar: '4:3', opts: { resolution: '1080p', end_image_url: 'https://pics.test/last.png' } }), picture)
    expect(p.provider).toBe('replicate')
    expect(p.endpoint).toBe('luma/ray-3.2')
    expect(p.payload).toEqual({
      prompt, start_image: picture, end_image: 'https://pics.test/last.png', duration: 5, resolution: '1080p', aspect_ratio: '4:3', loop: false,
    })
    expect(checkPayload(REPLICATE, p.payload)).toEqual([])
    expect(p.backup).toEqual({
      provider: 'fal',
      endpoint: 'luma/agent/ray/v3.2/image-to-video',
      payload: { prompt, image_url: picture, end_image_url: 'https://pics.test/last.png', aspect_ratio: '4:3', resolution: '1080p', duration: '5s', loop: false },
    })
    expect(checkPayload(FAL, p.backup!.payload)).toEqual([])
    // fal's own example request, as our backup would send it.
    const ex = inputOf(FAL).properties
    expect(checkPayload(FAL, { prompt: ex.prompt.examples[0], image_url: ex.image_url.examples[0], aspect_ratio: '16:9', resolution: '540p', duration: '5s', loop: false })).toEqual([])
  })

  it('a first frame in the options, looping: the backup carries the loop', async () => {
    const p = await providerPlan(vid({ opts: { image_url: 'https://pics.test/a.png', loop: true } }))
    expect(p.payload).toMatchObject({ start_image: 'https://pics.test/a.png', loop: true, duration: 5 })
    expect(p.backup!.payload).toMatchObject({ image_url: 'https://pics.test/a.png', loop: true, duration: '5s' })
  })

  it('a length it doesn\'t make goes to the closer; a ratio or resolution it doesn\'t take goes as 16:9 / 720p', async () => {
    expect((await providerPlan(vid({ duration: '7' }))).payload.duration).toBe(5)
    expect((await providerPlan(vid({ duration: '8' }))).payload.duration).toBe(10)
    expect((await providerPlan(vid({ duration: '1' }))).payload.duration).toBe(5)
    expect((await providerPlan(vid({ duration: '45' }))).payload.duration).toBe(10)
    expect((await providerPlan(vid({ ar: '2:3' }))).payload.aspect_ratio).toBe('16:9')
    expect((await providerPlan(vid({ opts: { resolution: '4k' } }))).payload.resolution).toBe('720p')
    expect((await providerPlan(vid({ opts: { resolution: '1080P' } }))).payload.resolution).toBe('1080p')
  })

  it('a prompt over fal\'s 6,000 characters runs on Replicate with no backup (Replicate states no limit)', async () => {
    const long = await providerPlan(vid({ prompt: '🦊'.repeat(6001), image: true }))
    expect(long.provider).toBe('replicate')
    expect(long.backup).toBeUndefined()
    const fits = await providerPlan(vid({ prompt: '🦊'.repeat(6000), image: true }))
    expect(fits.backup?.provider).toBe('fal')
    expect(requestProblems({ 1: vid({ prompt: 'a'.repeat(7000), image: true }) })).toEqual([])
  })
})

// ── Refusals ───────────────────────────────────────────────────────────────

describe('what Luma Ray 3.2 can\'t take is refused in plain words, never dropped', () => {
  const extras: Record<string, unknown>[] = [
    { image_urls: ['https://pics.test/ref.png'] },
    { video_urls: ['https://pics.test/ref.mp4'] },
    { audio_urls: ['https://pics.test/voice.mp3'] },
  ]
  for (const opts of extras) {
    it(`${Object.keys(opts)[0]}: refused at planning and before the hold, with or without a first frame`, async () => {
      for (const image of [false, true]) {
        await expect(plan(vid({ opts, image }))).rejects.toThrow(LUMA_RAY_32_EXTRAS)
        expect(requestProblems({ 1: vid({ opts, image }) })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'model_options', message: LUMA_RAY_32_EXTRAS }])
      }
    })
  }

  it('a last frame with no first frame: refused; with one (linked or in the options) it is sent', async () => {
    const opts = { end_image_url: 'https://pics.test/last.png' }
    await expect(plan(vid({ opts }))).rejects.toThrow(LUMA_RAY_32_LAST_NEEDS_FIRST)
    expect(requestProblems({ 1: vid({ opts }) })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'model_options', message: LUMA_RAY_32_LAST_NEEDS_FIRST }])
    expect(requestProblems({ 1: vid({ opts, image: true }) })).toEqual([])
    const inOpts = { ...opts, image_url: 'https://pics.test/a.png' }
    expect(requestProblems({ 1: vid({ opts: inOpts }) })).toEqual([])
    expect((await providerPlan(vid({ opts: inOpts }))).payload).toMatchObject({ start_image: 'https://pics.test/a.png', end_image: 'https://pics.test/last.png' })
  })

  it('10 s from a picture: refused at planning and before the hold (on the length); 10 s from text runs', async () => {
    for (const n of [vid({ duration: '10', image: true }), vid({ duration: '9', opts: { image_url: 'https://pics.test/a.png' } })]) {
      await expect(plan(n)).rejects.toThrow(LUMA_RAY_32_LONG_FROM_PICTURE)
      expect(requestProblems({ 1: n })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'duration', message: LUMA_RAY_32_LONG_FROM_PICTURE }])
    }
    expect(requestProblems({ 1: vid({ duration: '10' }) })).toEqual([])
    // 7 s goes as 5 (the closer), so it runs from a picture.
    expect(requestProblems({ 1: vid({ duration: '7', image: true }) })).toEqual([])
    // A wired length can't be read before the run: judged at planning.
    const wired = vid({ image: true })
    wired.inputs.duration = ['9', 0]
    expect(requestProblems({ 1: wired })).toEqual([])
  })

  it('a loop at 10 s, or ending on a last frame: refused at planning and before the hold', async () => {
    const long = vid({ duration: '10', opts: { loop: true } })
    await expect(plan(long)).rejects.toThrow(LUMA_RAY_32_LOOP_TOO_LONG)
    expect(requestProblems({ 1: long })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'duration', message: LUMA_RAY_32_LOOP_TOO_LONG }])
    const toLast = vid({ image: true, opts: { loop: true, end_image_url: 'https://pics.test/last.png' } })
    await expect(plan(toLast)).rejects.toThrow(LUMA_RAY_32_LOOP_WITH_LAST)
    expect(requestProblems({ 1: toLast })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'model_options', message: LUMA_RAY_32_LOOP_WITH_LAST }])
    expect(requestProblems({ 1: vid({ opts: { loop: true } }) })).toEqual([])
    expect(requestProblems({ 1: vid({ image: true, opts: { loop: true } }) })).toEqual([])
  })

  it('the words: plain, sentence case, naming the model, no identifiers', () => {
    const all = [LUMA_RAY_32_EXTRAS, LUMA_RAY_32_LAST_NEEDS_FIRST, LUMA_RAY_32_LONG_FROM_PICTURE, LUMA_RAY_32_LOOP_TOO_LONG, LUMA_RAY_32_LOOP_WITH_LAST, LUMA_RAY_32_NEEDS_PROMPT, LUMA_RAY_32_LONG_PROMPT]
    expect(LUMA_RAY_32_LONG_FROM_PICTURE).toBe('Luma Ray 3.2 makes 10-second clips from a prompt alone. Pick 5 seconds, or remove the picture.')
    expect(LUMA_RAY_32_NEEDS_PROMPT).toBe('Luma Ray 3.2 needs a prompt. Describe the clip, or how the picture should move.')
    for (const m of all) {
      expect(m).toMatch(/^Luma Ray 3\.2 /)
      expect(m).not.toMatch(/_|ray-3|luma\/|hdr|\bloop\b.*_/)
    }
  })

  it('an empty or spaces-only prompt: refused at planning and before the hold, in either mode; one character runs', async () => {
    for (const prompt of ['', '   ']) {
      for (const n of [vid({ prompt }), vid({ prompt, image: true }), vid({ prompt, opts: { image_url: 'https://pics.test/a.png' } })]) {
        await expect(plan(n)).rejects.toThrow(LUMA_RAY_32_NEEDS_PROMPT)
        expect(requestProblems({ 1: n })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'prompt', message: LUMA_RAY_32_NEEDS_PROMPT }])
      }
    }
    expect(requestProblems({ 1: vid({ prompt: 'a' }) })).toEqual([])
    expect(requestProblems({ 1: vid({ prompt: 'a', image: true }) })).toEqual([])
    // Wired options: the prompt is still judged (it goes to Replicate either way).
    const wiredOpts = vid({ prompt: '' })
    wiredOpts.inputs.model_options = ['9', 0]
    expect(requestProblems({ 1: wiredOpts })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'prompt', message: LUMA_RAY_32_NEEDS_PROMPT }])
    // A wired prompt can't be read before the run.
    const wiredPrompt = vid({ prompt: '' })
    wiredPrompt.inputs.prompt = ['9', 0]
    expect(requestProblems({ 1: wiredPrompt })).toEqual([])
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
    expect(`${r!.title} ${r!.description}`).toContain('Luma Ray 3.2')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: t2v, titleOf: () => 'Clip' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })

  it('the hidden Ray 2 is not blocked: it still runs on either path', () => {
    const ray2: ApiPrompt = { 1: { class_type: 'GenerateVideoNode', inputs: { model: 'luma-ray-2-720p', prompt: 'a fox', duration: '5' } } }
    expect(blockedModelUses(ray2)).toEqual([])
    expect(blockedModelUses(ray2, { families: NO_FAMILIES, runnerTakes: true })).toEqual([])
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery and the defaults', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family luma-ray-3.2, with a plain name and the schemas\' settings', () => {
    const m = VIDEO_MODELS_BY_ID[ID]!
    expect(m.runnerOnly).toBe(true)
    expect(m.family).toBe(FAMILY)
    expect(m.hidden).toBeUndefined()
    expect(m.label).toBe('Luma Ray 3.2')
    expect(m.brand).toBe('Luma')
    expect(m.replicateSlug).toBe(LUMA_RAY_32_REPLICATE_SLUG)
    expect(m.modes).toEqual(['t2v', 'i2v'])
    expect(m.supportsSeed).toBe(false)
    expect([...m.aspectRatios].sort()).toEqual([...RATIOS].sort())
    expect(m.defaultAspectRatio).toBe('16:9')
    expect(m.resolutions).toEqual(['540p', '720p', '1080p'])
    expect(m.defaultResolution).toBe('720p')
    expect(m.durations).toEqual([...LUMA_RAY_32_SECONDS])
    expect(m.defaultDuration).toBe(5)
    expect(m.tags).not.toContain('audio')
    expect(m.advanced).toEqual([
      { name: 'loop', type: 'boolean', label: 'Seamless loop', default: false, description: 'Ends where it starts, for a clip that repeats smoothly. 5-second clips only.' },
    ])
    for (const text of [m.pitch, m.description!]) {
      expect(text).toMatch(/^[A-Z]/)
      expect(text).not.toMatch(/ray-3|luma\/|_/)
    }
    // Every length the menu offers is one the builder sends as is.
    expect(m.durations.every(d => lumaRay32({ prompt: 'p', aspectRatio: '16:9', duration: d, seed: 0, image: null, adv: {} }).duration === d)).toBe(true)
    expect(allowedDurations(ID)).toEqual(m.durations.map(String))
  })

  it('hidden from "Generate a video" while the family is off, shown while on; never on "Film a shot"; Ray 2 stays hidden', () => {
    const shown = (cls: string, f: ReadonlySet<RunnerFamily>) => galleryEntries(VIDEO_MODELS, { classType: cls, families: f, current: null }).map(e => e.model.id)
    expect(shown('GenerateVideoNode', NO_FAMILIES)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ALL_BUT)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ON)).toContain(ID)
    expect(shown('FilmShotNode', ALL)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ALL)).not.toContain('luma-ray-2-720p')
    const saved = galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: NO_FAMILIES, current: ID })
    expect(saved.find(e => e.model.id === ID)).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
  })

  it('a new node\'s default does not move to Luma Ray 3.2', () => {
    expect(VIDEO_MODEL_PREFERENCE).not.toContain(ID)
    expect(FILM_SHOT_MODEL_PREFERENCE).not.toContain(ID)
    expect(menuDefault(modelMenu('GenerateVideoNode')!, ALL)).toBe(VIDEO_MODEL_PREFERENCE[0])
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  /** What priceGraph charges for one node plus an output node. */
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs }, 2: SINK }).credits

  it('Replicate\'s price per clip by resolution and length, verified; fal\'s image-to-video the backup card, 5 s only', () => {
    expect(videoRate(ID)).toMatchObject({
      unit: 'per_clip', service: 'replicate', confidence: 'verified', read: '2026-09-25',
      source: 'https://replicate.com/luma/ray-3.2',
      byResolution: { '540p': { 5: 0.15, 10: 0.45 }, '720p': { 5: 0.30, 10: 0.90 }, '1080p': { 5: 1.20, 10: 3.60 } },
    })
    expect(videoBackupRate(ID)).toMatchObject({
      unit: 'per_clip', service: 'fal', confidence: 'verified', read: '2026-09-25',
      source: 'https://fal.ai/models/luma/agent/ray/v3.2/image-to-video/llms.txt',
      byResolution: { '540p': { 5: 0.15 }, '720p': { 5: 0.30 }, '1080p': { 5: 1.20 } },
      maxSeconds: 5,
    })
  })

  // Replicate's card with the markup; the backup at cost is always below it.
  const examples: { name: string, inputs: Record<string, unknown>, usd: number, backup: number | null, credits: number }[] = [
    { name: '5 s at 540p', inputs: { model: ID, duration: '5', model_options: '{"resolution":"540p"}' }, usd: 0.15, backup: 0.15, credits: 23 },
    { name: '5 s at 720p (the node\'s defaults; the live check)', inputs: { model: ID, duration: '5', model_options: '{}' }, usd: 0.30, backup: 0.30, credits: 45 },
    { name: '5 s at 720p, a picture linked, looping (the same)', inputs: { model: ID, duration: '5', model_options: '{"loop":true}', image: ['9', 0] }, usd: 0.30, backup: 0.30, credits: 45 },
    { name: '5 s at 1080p', inputs: { model: ID, duration: '5', model_options: '{"resolution":"1080p"}' }, usd: 1.20, backup: 1.20, credits: 180 },
    { name: '10 s at 540p (no backup)', inputs: { model: ID, duration: '10', model_options: '{"resolution":"540p"}' }, usd: 0.45, backup: null, credits: 68 },
    { name: '10 s at 720p (no backup)', inputs: { model: ID, duration: '10', model_options: '{"resolution":"720p"}' }, usd: 0.90, backup: null, credits: 135 },
    { name: '10 s at 1080p (the dearest; no backup)', inputs: { model: ID, duration: '10', model_options: '{"resolution":"1080p"}' }, usd: 3.60, backup: null, credits: 540 },
  ]
  for (const ex of examples) {
    it(`${ex.name}: $${ex.usd.toFixed(2)}, ${ex.credits} credits; badge = charge = run estimate`, () => {
      const s = effectiveVideoSettings(ID, ex.inputs.duration, ex.inputs.aspect_ratio ?? '16:9', ex.inputs.model_options, ex.inputs.image)!
      expect(videoUsd(ID, s)).toBeCloseTo(ex.usd, 9)
      if (ex.backup == null) expect(videoBackupUsd(ID, s)).toBeNull()
      else {
        expect(videoBackupUsd(ID, s)).toBeCloseTo(ex.backup, 9)
        expect(usdChargedAtCost(ex.backup)).toBeLessThan(ex.usd)
      }
      expect(videoPriceUsd(ID, s)).toBeCloseTo(ex.usd, 9)
      expect(providerUsd('GenerateVideoNode', ex.inputs)).toBeCloseTo(ex.usd, 9)
      expect(creditsForUsd(ex.usd)).toBe(ex.credits)
      expect(nodeCredits('GenerateVideoNode', ex.inputs)).toBe(ex.credits)
      const c = charge(ex.inputs)
      expect(c).toBe(ex.credits + 1) // + base render
      expect(nodeCreditEstimate('GenerateVideoNode', ex.inputs)).toBe(c)
      const names = Object.keys(ex.inputs)
      const est = estimateUsdForNodes([{ id: '1', type: 'GenerateVideoNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]) }], { hosted: true })!
      expect(est.hostedCredits).toBe(c)
    })
  }

  it('the live check (5 s at 720p from text) holds 46 credits (45 + the base render)', () => {
    expect(charge({ model: ID, duration: '5', model_options: '{"resolution":"720p"}' })).toBe(46)
  })

  it('a linked length prices at the longest (10 s); linked options at the dearest second (1080p at 10 s)', () => {
    expect(maxVideoSeconds(ID)).toBe(10)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: ['7', 0], model_options: '{}' })).toBeCloseTo(0.90, 9)
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: '5', model_options: ['7', 0] })).toBeCloseTo(0.36 * 5, 9)
    for (const inputs of [
      { model: ID, duration: ['7', 0], model_options: '{}' },
      { model: ID, duration: '5', model_options: ['7', 0] },
    ]) expect(nodeCreditEstimate('GenerateVideoNode', inputs)).toBe(charge(inputs))
  })

  it('priced on what is sent: the planned payload\'s seconds and resolution give the price', async () => {
    for (const image of [false, true]) {
      for (const [dur, res] of [['5', '540p'], ['7', '1080p'], ['9', '720p'], ['45', 'nope'], ['1', '1080P'], ['0', '540P']] as const) {
        const node = vid({ image, duration: dur, opts: { resolution: res } })
        let p
        try { p = await providerPlan(node) }
        catch (e) {
          expect((e as Error).message).toBe(LUMA_RAY_32_LONG_FROM_PICTURE)
          continue
        }
        const row = (videoRate(ID)!.byResolution as Record<string, Record<string, number>>)[String(p.payload.resolution)]!
        expect(providerUsd('GenerateVideoNode', node.inputs), `${image} ${dur} ${res}`).toBeCloseTo(row[String(p.payload.duration)]!, 9)
      }
    }
  })

  it('the gallery label reads Replicate\'s price at the default settings (5 s at 720p)', () => {
    expect(videoRateLabel(ID)).toBe('$0.30 for 5 s at 720p')
    expect(videoRateLabel(ID, { hosted: true })).toBe('45 credits for 5 s at 720p')
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = { 1: vid({ opts: { resolution: '720p' } }), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
  const start = (k: ReturnType<typeof makeKit>, t: ApiPrompt = take) => k.engine.startRun({ userId: k.userId, takes: [t], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: the family\'s own Replicate model, held at the node\'s price (46), a real output; fal not called', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = k.replicate.submitted()
    expect(submitted.map(r => r.endpoint)).toEqual(['luma/ray-3.2'])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a fox runs through snow', duration: 5, resolution: '720p', aspect_ratio: '16:9', loop: false })
    expect(k.fal.reqs.size).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([creditsForUsd(0.30) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT } })
    await expect(start(k)).rejects.toThrow()
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })

  it('an empty prompt, or a loop at 10 s: refused before the hold, nothing sent', async () => {
    for (const [n, message] of [[vid({ prompt: '' }), LUMA_RAY_32_NEEDS_PROMPT], [vid({ duration: '10', opts: { loop: true } }), LUMA_RAY_32_LOOP_TOO_LONG]] as const) {
      const k = makeKit({ hosted: true, deps: { families: () => ON } })
      await expect(start(k, { 1: n, 2: { class_type: 'Video', inputs: { source: ['1', 0] } } })).rejects.toThrow(message)
      expect(k.replicate.reqs.size).toBe(0)
      expect(k.ledger.holds.size).toBe(0)
    }
  })

  it('a picture linked, Replicate down: the backup on fal carries the same picture and serves it, charged once at Replicate\'s price', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON, backup: () => ({ enabled: true, stallMs: DEFAULT_BACKUP_STALL_MS }) } })
    fs.writeFileSync(path.join(k.root, 'input', 'first.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0]))
    const i2v: ApiPrompt = {
      11: { class_type: 'Image', inputs: { image: 'first.png' } },
      1: vid(),
      2: { class_type: 'Video', inputs: { source: ['1', 0] } },
    }
    i2v[1]!.inputs.image = ['11', 0]
    ;(k.replicate.client.submit as any).mockRejectedValueOnce(new ReplicateError('replicate submit 503: unavailable', 503))
    const { runId } = await start(k, i2v)
    await k.engine.settled(runId)
    const repCalls = (k.replicate.client.submit as any).mock.calls as unknown[][]
    expect(repCalls.length).toBe(1)
    expect(repCalls[0]![0]).toBe(LUMA_RAY_32_REPLICATE_SLUG)
    const sent = [...k.fal.reqs.values()]
    expect(sent.map(r => r.endpoint)).toEqual([LUMA_RAY_32_FAL_IMAGE_TO_VIDEO])
    expect(sent[0]!.payload).toEqual({
      prompt: 'a fox runs through snow', image_url: 'https://fal.storage/first.png', aspect_ratio: '16:9', resolution: '720p', duration: '5s', loop: false,
    })
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    // 5 s at 720p: the same $0.30 on both services, so Replicate's marked-up price stands.
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', creditsForUsd(0.30) + 1]])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('text-to-video, Replicate down: no backup to send, so the node fails and nothing is charged', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON, backup: () => ({ enabled: true, stallMs: DEFAULT_BACKUP_STALL_MS }) } })
    ;(k.replicate.client.submit as any).mockRejectedValue(new ReplicateError('replicate submit 503: unavailable', 503))
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const repCalls = (k.replicate.client.submit as any).mock.calls as unknown[][]
    expect(repCalls.length).toBeGreaterThanOrEqual(1)
    expect(repCalls.every(c => c[0] === LUMA_RAY_32_REPLICATE_SLUG)).toBe(true)
    expect(k.fal.reqs.size).toBe(0)
    expect(ofType(k.seen, 'execution_error').length).toBeGreaterThan(0)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })
})

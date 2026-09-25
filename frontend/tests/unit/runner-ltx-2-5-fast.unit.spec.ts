/**
 * Task F20 (model line-up): LTX-2.5 Fast (Lightricks), runner-only, family
 * `ltx-2.5-fast` (server/runner/generators/ltx25Fast.ts): Replicate first
 * (lightricks/ltx-2.5-fast: a third to a half of fal's rate, and the only one
 * with 2–5 s clips), fal's lightricks/ltx-2.5/{text,image}-to-video/fast the
 * backup for clips of 6 s or more. It replaces the hidden LTX-Video, which
 * stays hidden and priced as before.
 *
 * The family contract:
 *  - the saved schemas: the endpoint ids, fal's pricing text, Replicate's version;
 *  - every payload over the settings grid fits Replicate's saved schema
 *    (fixtures/provider-schemas/replicate/lightricks__ltx-2.5-fast.json), its
 *    backup, where there is one, fits fal's (fixtures/provider-schemas/fal/
 *    lightricks__ltx-2.5__*__fast.json) and asks for the same clip, and both
 *    carry the seconds, resolution and sound the price reads;
 *  - hand-written expected payloads: plain (fal's example prompt), every
 *    option set, a picture linked (fal's example picture);
 *  - the prompt rules (a ruled minimum on Replicate; fal's own limits drop
 *    only the backup) and the plain refusals (references, a last frame alone,
 *    over 10 s at 4k, sound);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the model when the family is off or the run
 *    goes to the engine;
 *  - the gallery hides the model while the family is off; LTX-Video stays hidden;
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
import { RUNNER_REPLICATE_VIDEO_MODELS, RUNNER_VIDEO_MODELS } from '~~/server/runner/generators/video'
import { RUNNER_ROUTES, VIDEO_BACKUPS } from '~~/server/runner/generators/twins'
import {
  LTX_25_FAST_DEFAULT_SECONDS, LTX_25_FAST_EXTRAS, LTX_25_FAST_FAL_ENDPOINTS, LTX_25_FAST_FAL_PROMPT_MAX, LTX_25_FAST_FAL_RESOLUTION,
  LTX_25_FAST_FAL_SECONDS, LTX_25_FAST_IMAGE_TO_VIDEO, LTX_25_FAST_LAST_NEEDS_FIRST, LTX_25_FAST_LONG_PROMPT, LTX_25_FAST_NEEDS_PROMPT,
  LTX_25_FAST_REPLICATE_SLUG, LTX_25_FAST_SECONDS, LTX_25_FAST_TEXT_TO_VIDEO, LTX_25_FAST_TOO_LONG_AT_4K, ltx25Fast, ltx25FastOnFal,
} from '~~/server/runner/generators/ltx25Fast'
import {
  PROMPT_MAX_LENGTH, PROMPT_MAX_LENGTH_RULINGS, PROMPT_MIN_LENGTH, PROMPT_MIN_LENGTH_RULINGS, checkedInputFile, requestProblem, requestProblems,
} from '~~/server/runner/requestRules'
import { DEFAULT_BACKUP_STALL_MS } from '~~/server/runner/config'
import { ReplicateError } from '~~/server/runner/replicateQueue'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import { priceGraph } from '~~/server/utils/priceBook'
import type { OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema, type ProviderSchemaFixture } from './helpers/providerSchema'
import { makeKit, ofType } from './__runner__/kit'

const ID = 'ltx-2.5-fast'
const FAMILY: RunnerFamily = 'ltx-2.5-fast'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SINK = { class_type: 'SaveImage', inputs: {} }

const falSchema = (endpoint: string) => {
  const f = loadProviderSchema('fal', endpoint)
  expect(f.endpoint).toBe(endpoint)
  return f
}
const REPLICATE = loadProviderSchema('replicate', LTX_25_FAST_REPLICATE_SLUG)
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

/** A Generate-a-video node on LTX-2.5 Fast; `image` links a picture from node 9. */
function vid(o: { prompt?: string, duration?: unknown, opts?: Record<string, unknown>, image?: boolean, ar?: string } = {}) {
  const inputs: Record<string, unknown> = {
    model: ID, prompt: o.prompt ?? 'a fox runs through snow', aspect_ratio: o.ar ?? '16:9', duration: o.duration ?? '6', seed: 0,
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
  it('Replicate: Lightricks\' own lightricks/ltx-2.5-fast, one model for both modes, its lengths, ratios and resolutions', () => {
    expect(REPLICATE.endpoint).toBe('lightricks/ltx-2.5-fast')
    expect(REPLICATE.fetchedAt).toBe('2026-09-25')
    expect(REPLICATE.versionId).toMatch(/^52475fac/)
    const input = inputOf(REPLICATE)
    expect(input.required).toEqual(['prompt'])
    expect(replicateEnum('duration')).toEqual([...LTX_25_FAST_SECONDS])
    expect(input.properties.duration.default).toBe(LTX_25_FAST_DEFAULT_SECONDS)
    expect(input.properties.duration.description).toContain('Durations longer than 10 seconds are only available at 720p or 1080p resolution with 24 or 25 FPS.')
    expect(replicateEnum('resolution')).toEqual(['720p', '1080p', '2k', '4k'])
    expect(input.properties.resolution.default).toBe('1080p')
    expect(replicateEnum('aspect_ratio')).toEqual(['16:9', '9:16'])
    // No frame-rate setting is sent: the default, 25, is one that allows clips over 10 s.
    expect(replicateEnum('fps')).toEqual([24, 25, 48, 50])
    expect(input.properties.fps.default).toBe(25)
    expect(input.properties.generate_audio).toMatchObject({ type: 'boolean', default: true })
    expect(input.properties.image.description).toMatch(/First frame/)
    expect(input.properties.last_frame_image.description).toMatch(/interpolates between the first frame and this last frame/)
    expect(JSON.stringify(input.properties.prompt)).not.toMatch(/maxLength|minLength/)
  })

  it('fal: one per endpoint the family calls, each its own endpoint id, with fal\'s pricing text', () => {
    expect([...LTX_25_FAST_FAL_ENDPOINTS].sort()).toEqual(['lightricks/ltx-2.5/image-to-video/fast', 'lightricks/ltx-2.5/text-to-video/fast'])
    for (const e of LTX_25_FAST_FAL_ENDPOINTS) {
      const f = falSchema(e)
      expect(f.fetchedAt, e).toBe('2026-09-25')
      expect(f.sources?.schema, e).toBe(`https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=${e}`)
      expect(f.pricingText!.replaceAll('**', ''), e)
        .toContain('For 720p, your request will cost $0.09 per second; for 1080p, $0.13 per second; for 1440p, $0.19 per second; and for 4K, $0.30 per second.')
    }
  })

  it('fal: 6–20 s, 720p to 2160p, 16:9 or 9:16, a prompt of 1 to 5,000 characters; image-to-video takes a last frame', () => {
    for (const e of LTX_25_FAST_FAL_ENDPOINTS) {
      const input = inputOf(falSchema(e))
      expect(input.properties.duration.enum, e).toEqual([6, 8, 10, 12, 14, 16, 18, 20, 'auto'])
      expect([...LTX_25_FAST_FAL_SECONDS], e).toEqual([6, 8, 10, 12, 14, 16, 18, 20])
      expect(input.properties.duration.description, e).toContain('At 1440p and 2160p, all frame rates support up to 10 seconds.')
      expect(input.properties.resolution.enum, e).toEqual(['720p', '1080p', '1440p', '2160p'])
      expect(input.properties.fps.default, e).toBe(25)
      expect(input.properties.prompt.minLength, e).toBe(1)
      expect(input.properties.prompt.maxLength, e).toBe(LTX_25_FAST_FAL_PROMPT_MAX)
      expect(input.properties.generate_audio.default, e).toBe(true)
    }
    expect(inputOf(falSchema(LTX_25_FAST_TEXT_TO_VIDEO)).properties.aspect_ratio.enum).toEqual(['16:9', '9:16'])
    expect(inputOf(falSchema(LTX_25_FAST_IMAGE_TO_VIDEO)).properties.aspect_ratio.enum).toEqual(['auto', '16:9', '9:16'])
    expect(inputOf(falSchema(LTX_25_FAST_IMAGE_TO_VIDEO)).required).toEqual(['prompt', 'image_url'])
    expect(inputOf(falSchema(LTX_25_FAST_IMAGE_TO_VIDEO)).properties.end_image_url).toBeTruthy()
    expect(inputOf(falSchema(LTX_25_FAST_TEXT_TO_VIDEO)).properties.end_image_url).toBeUndefined()
    // Replicate's 4k is fal's 2160p; 2k (fal's 1440p?) is never sent.
    expect(LTX_25_FAST_FAL_RESOLUTION).toEqual({ '720p': '720p', '1080p': '1080p', '4k': '2160p' })
  })

  it('no seed and no sound input on any endpoint', () => {
    for (const f of [falSchema(LTX_25_FAST_TEXT_TO_VIDEO), falSchema(LTX_25_FAST_IMAGE_TO_VIDEO), REPLICATE]) {
      expect(Object.keys(inputOf(f).properties).filter(k => /seed|audio_url|audio_file|^audio$/i.test(k)), f.endpoint).toEqual([])
    }
  })

  it('its own builder, Replicate first with fal behind; it is in no other table', () => {
    expect(RUNNER_VIDEO_MODELS[ID]).toBeUndefined()
    expect(RUNNER_REPLICATE_VIDEO_MODELS[ID]).toBeUndefined()
    expect(VIDEO_BACKUPS[ID]).toBeUndefined()
    expect(RUNNER_ROUTES[`video:${ID}`]).toMatchObject({ first: 'replicate', backup: 'fal' })
    expect(RUNNER_ROUTES[`video:${ID}`]!.why).toMatch(/clips of 6 s or more only/)
    // The older model stays hidden, on its own route, with no backup.
    expect(VIDEO_MODELS_BY_ID['ltx-video']!.hidden).toBe(true)
    expect(RUNNER_ROUTES['video:ltx-video']).toMatchObject({ first: 'replicate', backup: null })
  })

  it('the prompt: a ruled minimum on Replicate (required, no minLength); fal\'s own minLength 1 and maxLength 5,000 on the backup', () => {
    expect(PROMPT_MIN_LENGTH[`replicate ${LTX_25_FAST_REPLICATE_SLUG}`]).toEqual({ min: 1, message: LTX_25_FAST_NEEDS_PROMPT })
    expect(PROMPT_MIN_LENGTH_RULINGS).toContain(`replicate ${LTX_25_FAST_REPLICATE_SLUG}`)
    expect(PROMPT_MAX_LENGTH[`replicate ${LTX_25_FAST_REPLICATE_SLUG}`]).toBeUndefined()
    for (const e of LTX_25_FAST_FAL_ENDPOINTS) {
      expect(PROMPT_MIN_LENGTH[`fal ${e}`], e).toEqual({ min: 1, message: LTX_25_FAST_NEEDS_PROMPT })
      expect(PROMPT_MIN_LENGTH_RULINGS, e).not.toContain(`fal ${e}`)
      expect(PROMPT_MAX_LENGTH[`fal ${e}`], e).toEqual({ max: 5000, message: LTX_25_FAST_LONG_PROMPT })
      expect(PROMPT_MAX_LENGTH_RULINGS, e).not.toContain(`fal ${e}`)
    }
  })

  it('no picture is read before the hand-off: neither schema states a size limit', () => {
    expect(JSON.stringify(inputOf(falSchema(LTX_25_FAST_IMAGE_TO_VIDEO)).properties.image_url)).not.toMatch(/MB/)
    expect(JSON.stringify(inputOf(REPLICATE).properties.image)).not.toMatch(/MB/)
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

describe('every payload over the settings grid fits Replicate\'s schema, its backup fits fal\'s, and both carry what the price reads', () => {
  for (const m of MODES) {
    it(`${m.name}: durations × resolutions × ratios × sound`, () => {
      const cat = VIDEO_MODELS_BY_ID[ID]!
      const durations: unknown[] = [...[...new Set([...cat.durations, ...LTX_25_FAST_SECONDS, 0, 1, 7, 9, 11, 15, 19, 21, 60])].flatMap(n => [n, String(n)]), undefined, '', 'six']
      const resolutions = [...(cat.resolutions ?? []), '1080P', '4K', '720P', '2k', '1440p', '2160p', 'nope', undefined]
      const ratios = [...cat.aspectRatios, '1:1', '4:3', '21:9', 'auto', '']
      const sounds = [true, false, undefined]
      let cases = 0
      let backups = 0
      let refused = 0
      const bad: string[] = []
      for (const dur of durations) for (const res of resolutions) for (const ar of ratios) for (const sound of sounds) {
        const adv: Record<string, unknown> = { ...m.opts }
        if (res !== undefined) adv.resolution = res
        if (sound !== undefined) adv.generate_audio = sound
        const opts = JSON.stringify(adv)
        const label = `${opts} ${String(dur)} ${ar}`
        const args = { prompt: 'p', aspectRatio: ar, duration: asInt(dur, LTX_25_FAST_DEFAULT_SECONDS), seed: 7, image: m.image, adv: parseJsonObject(opts) }
        cases++
        // Over 10 s at 4k: refused in plain words, never sent shorter.
        let payload: Record<string, unknown>
        try { payload = ltx25Fast(args) }
        catch (e) {
          refused++
          if ((e as Error).message !== LTX_25_FAST_TOO_LONG_AT_4K) bad.push(`${label}: ${(e as Error).message}`)
          continue
        }
        for (const e of checkPayload(REPLICATE, payload)) bad.push(`${label}: ${e}`)
        if ('seed' in payload || 'fps' in payload) bad.push(`${label}: a seed or frame rate`)
        if ((payload.image ?? null) !== m.first || (payload.last_frame_image ?? null) !== m.last) bad.push(`${label}: frames ${JSON.stringify(payload)}`)
        if (Number(payload.duration) > 10 && !['720p', '1080p'].includes(String(payload.resolution))) bad.push(`${label}: over 10 s at ${String(payload.resolution)}`)
        // Priced on what is sent: the node's picture input as nodePrice passes it (a link, or none).
        const priced = effectiveVideoSettings(ID, dur, ar, opts, m.image ? ['9', 0] : undefined)!
        const sent = { seconds: payload.duration, resolution: payload.resolution, audio: payload.generate_audio }
        if (priced.seconds !== sent.seconds || priced.resolution !== sent.resolution || priced.audio !== sent.audio) {
          bad.push(`${label}: sent ${JSON.stringify(sent)}, priced ${JSON.stringify(priced)}`)
        }
        // The backup: the same clip on fal for 6 s or more; none for a shorter clip.
        const backup = ltx25FastOnFal(payload)
        const priceHasBackup = videoBackupUsd(ID, priced) != null
        if (Number(payload.duration) >= 6) {
          if (!backup || !priceHasBackup) {
            bad.push(`${label}: no backup (priced with one: ${priceHasBackup})`)
            continue
          }
          backups++
          const endpoint = m.first ? LTX_25_FAST_IMAGE_TO_VIDEO : LTX_25_FAST_TEXT_TO_VIDEO
          if (backup.provider !== 'fal' || backup.endpoint !== endpoint) bad.push(`${label}: backup to ${backup.endpoint}`)
          for (const e of checkPayload(falSchema(endpoint), backup.payload)) bad.push(`${label} backup: ${e}`)
          const b = backup.payload
          if (b.prompt !== payload.prompt || b.duration !== payload.duration || b.resolution !== LTX_25_FAST_FAL_RESOLUTION[String(payload.resolution)]
            || b.aspect_ratio !== payload.aspect_ratio || b.generate_audio !== payload.generate_audio
            || (b.image_url ?? null) !== m.first || (b.end_image_url ?? null) !== m.last) {
            bad.push(`${label}: backup ${JSON.stringify(b)} is not ${JSON.stringify(payload)}`)
          }
        }
        else if (backup || priceHasBackup) bad.push(`${label}: a backup for ${String(payload.duration)} s`)
      }
      expect(bad.slice(0, 5)).toEqual([])
      expect(cases).toBeGreaterThan(3000)
      expect(backups).toBeGreaterThan(1000)
      expect(refused).toBeGreaterThan(100)
    })
  }
})

// ── Expected payloads (through planNode) ───────────────────────────────────

describe('expected payloads', () => {
  it('plain: text-to-video with fal\'s own example prompt, at the node\'s defaults (6 s, 1080p); fal\'s text-to-video behind', async () => {
    const example = inputOf(falSchema(LTX_25_FAST_TEXT_TO_VIDEO)).properties.prompt.examples[0] as string
    expect(example).toMatch(/^Through-the-veil shot of a bride's face/)
    const p = await providerPlan(vid({ prompt: example }))
    expect(p.provider).toBe('replicate')
    expect(p.endpoint).toBe('lightricks/ltx-2.5-fast')
    expect(p.payload).toEqual({ prompt: example, duration: 6, resolution: '1080p', aspect_ratio: '16:9', generate_audio: true })
    expect(checkPayload(REPLICATE, p.payload)).toEqual([])
    expect(p.backup).toEqual({
      provider: 'fal', endpoint: 'lightricks/ltx-2.5/text-to-video/fast',
      payload: { prompt: example, duration: 6, resolution: '1080p', aspect_ratio: '16:9', generate_audio: true },
    })
    expect(checkPayload(falSchema(p.backup!.endpoint), p.backup!.payload)).toEqual([])
  })

  it('every option set: 4k, portrait, 10 s, silent; a seed on the node is not sent (neither service takes one)', async () => {
    const prompt = 'A lighthouse in a storm, waves crashing, the beam sweeping through rain.'
    const node = vid({ prompt, duration: '10', ar: '9:16', opts: { resolution: '4k', generate_audio: false } })
    node.inputs.seed = 42
    const p = await providerPlan(node)
    expect(p.payload).toEqual({ prompt, duration: 10, resolution: '4k', aspect_ratio: '9:16', generate_audio: false })
    expect(checkPayload(REPLICATE, p.payload)).toEqual([])
    expect(p.backup).toEqual({
      provider: 'fal', endpoint: 'lightricks/ltx-2.5/text-to-video/fast',
      payload: { prompt, duration: 10, resolution: '2160p', aspect_ratio: '9:16', generate_audio: false },
    })
    expect(checkPayload(falSchema(p.backup!.endpoint), p.backup!.payload)).toEqual([])
  })

  it('a picture linked, with a last frame: fal\'s example prompt and picture on Replicate, the same frames on fal\'s image-to-video', async () => {
    const props = inputOf(falSchema(LTX_25_FAST_IMAGE_TO_VIDEO)).properties
    const prompt = props.prompt.examples[0] as string
    const picture = props.image_url.examples[0] as string
    expect(prompt).toMatch(/^Periscope-level shot from behind tall grass/)
    const p = await providerPlan(vid({ prompt, image: true, duration: '8', opts: { resolution: '720p', end_image_url: 'https://pics.test/last.png' } }), picture)
    expect(p.endpoint).toBe('lightricks/ltx-2.5-fast')
    expect(p.payload).toEqual({
      prompt, image: picture, last_frame_image: 'https://pics.test/last.png', duration: 8, resolution: '720p', aspect_ratio: '16:9', generate_audio: true,
    })
    expect(checkPayload(REPLICATE, p.payload)).toEqual([])
    expect(p.backup).toEqual({
      provider: 'fal', endpoint: 'lightricks/ltx-2.5/image-to-video/fast',
      payload: { image_url: picture, end_image_url: 'https://pics.test/last.png', prompt, duration: 8, resolution: '720p', aspect_ratio: '16:9', generate_audio: true },
    })
    expect(checkPayload(falSchema(p.backup!.endpoint), p.backup!.payload)).toEqual([])
  })

  it('a clip under 6 s: Replicate only (fal\'s shortest is 6 s)', async () => {
    for (const d of ['2', '3', '4', '5']) {
      const p = await providerPlan(vid({ duration: d, image: d === '3' }))
      expect(p.provider).toBe('replicate')
      expect(p.payload.duration).toBe(Number(d))
      expect(p.backup, d).toBeUndefined()
    }
  })

  it('a length it doesn\'t make goes to the closest; a ratio or resolution it doesn\'t take goes as 16:9 / 1080p', async () => {
    expect((await providerPlan(vid({ duration: '7' }))).payload.duration).toBe(6)
    expect((await providerPlan(vid({ duration: '15' }))).payload.duration).toBe(14)
    expect((await providerPlan(vid({ duration: '1' }))).payload.duration).toBe(2)
    expect((await providerPlan(vid({ duration: '45' }))).payload.duration).toBe(20)
    expect((await providerPlan(vid({ ar: '1:1' }))).payload.aspect_ratio).toBe('16:9')
    expect((await providerPlan(vid({ opts: { resolution: '2k' } }))).payload.resolution).toBe('1080p')
    expect((await providerPlan(vid({ opts: { resolution: '4K' } }))).payload.resolution).toBe('4k')
  })

  it('a prompt over fal\'s 5,000 characters runs on Replicate with no backup (Replicate states no limit)', async () => {
    const at = await providerPlan(vid({ prompt: 'a'.repeat(5000) }))
    expect(at.backup?.provider).toBe('fal')
    const over = await providerPlan(vid({ prompt: '🦊'.repeat(5001) }))
    expect(over.provider).toBe('replicate')
    expect(over.backup).toBeUndefined()
    expect(requestProblems({ 1: vid({ prompt: 'a'.repeat(5001) }) })).toEqual([])
    for (const e of LTX_25_FAST_FAL_ENDPOINTS) expect(requestProblem('fal', e, { prompt: 'a'.repeat(5001) })).toBe(LTX_25_FAST_LONG_PROMPT)
  })
})

// ── Refusals ───────────────────────────────────────────────────────────────

describe('what LTX-2.5 Fast can\'t take is refused in plain words, never dropped', () => {
  const extras: Record<string, unknown>[] = [
    { image_urls: ['https://pics.test/ref.png'] },
    { video_urls: ['https://pics.test/ref.mp4'] },
    { audio_urls: ['https://pics.test/voice.mp3'] },
  ]
  for (const opts of extras) {
    it(`${Object.keys(opts)[0]}: refused at planning and before the hold, with or without a first frame`, async () => {
      for (const image of [false, true]) {
        await expect(plan(vid({ opts, image }))).rejects.toThrow(LTX_25_FAST_EXTRAS)
        expect(requestProblems({ 1: vid({ opts, image }) })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'model_options', message: LTX_25_FAST_EXTRAS }])
      }
    })
  }

  it('a last frame with no first frame: refused; with one (linked or in the options) it is sent', async () => {
    const opts = { end_image_url: 'https://pics.test/last.png' }
    await expect(plan(vid({ opts }))).rejects.toThrow(LTX_25_FAST_LAST_NEEDS_FIRST)
    expect(requestProblems({ 1: vid({ opts }) })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'model_options', message: LTX_25_FAST_LAST_NEEDS_FIRST }])
    expect(requestProblems({ 1: vid({ opts, image: true }) })).toEqual([])
    const inOpts = { ...opts, image_url: 'https://pics.test/a.png' }
    expect(requestProblems({ 1: vid({ opts: inOpts }) })).toEqual([])
    expect((await providerPlan(vid({ opts: inOpts }))).payload).toMatchObject({ image: 'https://pics.test/a.png', last_frame_image: 'https://pics.test/last.png' })
  })

  it('over 10 s at 4k: refused at planning and before the hold; 10 s at 4k and 20 s at 1080p run', async () => {
    for (const d of ['12', '14', '20', '13']) {
      await expect(plan(vid({ duration: d, opts: { resolution: '4k' } }))).rejects.toThrow(LTX_25_FAST_TOO_LONG_AT_4K)
      expect(requestProblems({ 1: vid({ duration: d, opts: { resolution: '4k' } }) }))
        .toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'duration', message: LTX_25_FAST_TOO_LONG_AT_4K }])
    }
    expect(requestProblems({ 1: vid({ duration: '10', opts: { resolution: '4k' } }) })).toEqual([])
    // 11 s goes as 10 (the closest, the shorter on a tie), so it runs at 4k.
    expect(requestProblems({ 1: vid({ duration: '11', opts: { resolution: '4k' } }) })).toEqual([])
    expect((await providerPlan(vid({ duration: '11', opts: { resolution: '4k' } }))).payload.duration).toBe(10)
    expect(requestProblems({ 1: vid({ duration: '20', opts: { resolution: '1080p' } }) })).toEqual([])
    expect(requestProblems({ 1: vid({ duration: '20', opts: { resolution: '720p' } }) })).toEqual([])
    // A wired length can't be read before the run: judged at planning.
    const wired = vid({ opts: { resolution: '4k' } })
    wired.inputs.duration = ['9', 0]
    expect(requestProblems({ 1: wired })).toEqual([])
  })

  it('the words: plain, sentence case, naming the model, no identifiers', () => {
    expect(LTX_25_FAST_EXTRAS).toBe('LTX-2.5 Fast starts from a first picture and, if you like, a last one. It takes no reference pictures, videos or sounds. Remove them, or pick another model.')
    expect(LTX_25_FAST_LAST_NEEDS_FIRST).toBe('LTX-2.5 Fast needs a first picture to end on a last one. Link a first picture, or remove the last one.')
    expect(LTX_25_FAST_TOO_LONG_AT_4K).toBe('LTX-2.5 Fast makes clips over 10 seconds only at 720p or 1080p. Pick a shorter clip or a lower resolution.')
    expect(LTX_25_FAST_NEEDS_PROMPT).toBe('LTX-2.5 Fast needs a prompt. Describe the clip, or how the picture should move.')
    expect(LTX_25_FAST_LONG_PROMPT).toBe('LTX-2.5 Fast takes a prompt of at most 5,000 characters. Shorten it.')
    for (const m of [LTX_25_FAST_EXTRAS, LTX_25_FAST_LAST_NEEDS_FIRST, LTX_25_FAST_TOO_LONG_AT_4K, LTX_25_FAST_NEEDS_PROMPT, LTX_25_FAST_LONG_PROMPT]) {
      expect(m).not.toMatch(/_|ltx-2|lightricks\//)
    }
  })

  it('an empty or spaces-only prompt: refused at planning and before the hold, in either mode; one character runs', async () => {
    for (const prompt of ['', '   ']) {
      for (const n of [vid({ prompt }), vid({ prompt, image: true }), vid({ prompt, opts: { image_url: 'https://pics.test/a.png' } })]) {
        await expect(plan(n)).rejects.toThrow(LTX_25_FAST_NEEDS_PROMPT)
        expect(requestProblems({ 1: n })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'prompt', message: LTX_25_FAST_NEEDS_PROMPT }])
      }
    }
    expect(requestProblems({ 1: vid({ prompt: 'a' }) })).toEqual([])
    expect(requestProblems({ 1: vid({ prompt: 'a', image: true }) })).toEqual([])
    // Wired options: the prompt is still judged (it goes to Replicate either way).
    const wiredOpts = vid({ prompt: '' })
    wiredOpts.inputs.model_options = ['9', 0]
    expect(requestProblems({ 1: wiredOpts })).toEqual([{ nodeId: '1', classType: 'GenerateVideoNode', input: 'prompt', message: LTX_25_FAST_NEEDS_PROMPT }])
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
    expect(`${r!.title} ${r!.description}`).toContain('LTX-2.5 Fast')
    expect(r!.description).toContain('Old sampler')
    const off = blockedRunRefusal([{ prompt: t2v, titleOf: () => 'Clip' }], { runnerOn: true, families: NO_FAMILIES })
    expect(off!.description).toContain('switch is off')
  })
})

// ── Menus ──────────────────────────────────────────────────────────────────

describe('the gallery and the defaults', () => {
  afterEach(() => __resetModelMenusForTests())

  it('runner-only in family ltx-2.5-fast, with a plain name and the schemas\' settings', () => {
    const m = VIDEO_MODELS_BY_ID[ID]!
    expect(m.runnerOnly).toBe(true)
    expect(m.family).toBe(FAMILY)
    expect(m.hidden).toBeUndefined()
    expect(m.label).toBe('LTX-2.5 Fast')
    expect(m.brand).toBe('Lightricks')
    expect(m.replicateSlug).toBe(LTX_25_FAST_REPLICATE_SLUG)
    expect(m.modes).toEqual(['t2v', 'i2v'])
    expect(m.supportsSeed).toBe(false)
    expect(m.aspectRatios).toEqual(['16:9', '9:16'])
    expect(m.defaultAspectRatio).toBe('16:9')
    expect(m.resolutions).toEqual(['720p', '1080p', '4k'])
    expect(m.defaultResolution).toBe('1080p')
    expect(m.durations).toEqual([...LTX_25_FAST_SECONDS])
    expect(m.defaultDuration).toBe(6)
    expect(m.tags).toContain('audio')
    expect(m.advanced).toEqual([
      { name: 'generate_audio', type: 'boolean', label: 'Generate audio', default: true, description: 'Off makes a silent clip. The price is the same.' },
    ])
    for (const text of [m.pitch, m.description!]) {
      expect(text).toMatch(/^[A-Z]/)
      expect(text).not.toMatch(/ltx-2|lightricks\/|_/)
    }
    // Every length the menu offers is one the builder sends as is.
    expect(m.durations.every(d => ltx25Fast({ prompt: 'p', aspectRatio: '16:9', duration: d, seed: 0, image: null, adv: {} }).duration === d)).toBe(true)
    expect(allowedDurations(ID)).toEqual(m.durations.map(String))
  })

  it('hidden from "Generate a video" while the family is off, shown while on; never on "Film a shot"; LTX-Video stays hidden', () => {
    const shown = (cls: string, f: ReadonlySet<RunnerFamily>) => galleryEntries(VIDEO_MODELS, { classType: cls, families: f, current: null }).map(e => e.model.id)
    expect(shown('GenerateVideoNode', NO_FAMILIES)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ALL_BUT)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ON)).toContain(ID)
    expect(shown('FilmShotNode', ALL)).not.toContain(ID)
    expect(shown('GenerateVideoNode', ALL)).not.toContain('ltx-video')
    const saved = galleryEntries(VIDEO_MODELS, { classType: 'GenerateVideoNode', families: NO_FAMILIES, current: ID })
    expect(saved.find(e => e.model.id === ID)).toMatchObject({ hiddenTag: true, tag: 'Hidden' })
  })

  it('a new node\'s default does not move to LTX-2.5 Fast', () => {
    expect(VIDEO_MODEL_PREFERENCE).not.toContain(ID)
    expect(FILM_SHOT_MODEL_PREFERENCE).not.toContain(ID)
    expect(menuDefault(modelMenu('GenerateVideoNode')!, ALL)).toBe(VIDEO_MODEL_PREFERENCE[0])
  })
})

// ── Price ──────────────────────────────────────────────────────────────────

describe('the price', () => {
  /** What priceGraph charges for one node plus an output node. */
  const charge = (inputs: Record<string, unknown>) => priceGraph({ 1: { class_type: 'GenerateVideoNode', inputs }, 2: SINK }).credits

  it('Replicate\'s rate per second by resolution, verified; fal\'s the backup card, from 6 s', () => {
    expect(videoRate(ID)).toMatchObject({
      unit: 'per_second', service: 'replicate', confidence: 'verified', read: '2026-09-25',
      source: 'https://replicate.com/lightricks/ltx-2.5-fast',
      byResolution: { '720p': 0.03, '1080p': 0.06, '4k': 0.24 },
    })
    expect(videoBackupRate(ID)).toMatchObject({
      unit: 'per_second', service: 'fal', confidence: 'verified', read: '2026-09-25',
      source: 'https://fal.ai/models/lightricks/ltx-2.5/text-to-video/fast/llms.txt',
      byResolution: { '720p': 0.09, '1080p': 0.13, '4k': 0.30 },
      minSeconds: 6,
    })
    // The older LTX-Video keeps its flat 50-step ceiling (controller ruling, S1b fix round 1).
    expect(videoRate('ltx-video')).toMatchObject({ unit: 'per_clip', byResolution: { '*': { '*': 0.1365 } } })
  })

  // [name, inputs, Replicate USD, fal USD (null: no backup), basis USD]
  const examples: { name: string, inputs: Record<string, unknown>, usd: number, backupUsd: number | null, basis: number }[] = [
    { name: '2 s at 720p (the shortest, cheapest clip: the live check), no backup', inputs: { model: ID, duration: '2', model_options: '{"resolution":"720p"}' }, usd: 0.06, backupUsd: null, basis: 0.06 },
    { name: '5 s at 720p, no backup', inputs: { model: ID, duration: '5', model_options: '{"resolution":"720p"}' }, usd: 0.15, backupUsd: null, basis: 0.15 },
    { name: '6 s at 720p: fal at cost sets it', inputs: { model: ID, duration: '6', model_options: '{"resolution":"720p"}' }, usd: 0.18, backupUsd: 0.54, basis: 0.36 },
    { name: '6 s at 1080p (the node\'s defaults): fal at cost sets it', inputs: { model: ID, duration: '6', model_options: '{}' }, usd: 0.36, backupUsd: 0.78, basis: 0.52 },
    { name: '6 s at 1080p, a picture linked, silent (the same)', inputs: { model: ID, duration: '6', model_options: '{"generate_audio":false}', image: ['9', 0] }, usd: 0.36, backupUsd: 0.78, basis: 0.52 },
    { name: '10 s at 4k: Replicate marked up sets it', inputs: { model: ID, duration: '10', model_options: '{"resolution":"4k"}' }, usd: 2.4, backupUsd: 3.0, basis: 2.4 },
    { name: '20 s at 1080p (the longest)', inputs: { model: ID, duration: '20', model_options: '{"resolution":"1080p"}' }, usd: 1.2, backupUsd: 2.6, basis: 2.6 / 1.5 },
  ]
  for (const ex of examples) {
    it(`${ex.name}: basis $${ex.basis.toFixed(4)}; covers the backup; badge = charge = run estimate`, () => {
      const s = effectiveVideoSettings(ID, ex.inputs.duration, ex.inputs.aspect_ratio ?? '16:9', ex.inputs.model_options, ex.inputs.image)!
      expect(videoUsd(ID, s)).toBeCloseTo(ex.usd, 9)
      const b = videoBackupUsd(ID, s)
      if (ex.backupUsd == null) expect(b).toBeNull()
      else expect(b).toBeCloseTo(ex.backupUsd, 9)
      expect(videoPriceUsd(ID, s)).toBeCloseTo(Math.max(ex.usd, ex.backupUsd == null ? 0 : usdChargedAtCost(ex.backupUsd)), 9)
      expect(videoPriceUsd(ID, s)).toBeCloseTo(ex.basis, 6)
      expect(providerUsd('GenerateVideoNode', ex.inputs)).toBeCloseTo(videoPriceUsd(ID, s)!, 9)
      const credits = creditsForUsd(videoPriceUsd(ID, s)!)
      expect(credits).toBeGreaterThan(0)
      // Never below either service's cost (1 credit = $0.01).
      expect(credits).toBeGreaterThanOrEqual(Math.round(Math.max(ex.usd, ex.backupUsd ?? 0) * 100))
      expect(nodeCredits('GenerateVideoNode', ex.inputs)).toBe(credits)
      const c = charge(ex.inputs)
      expect(c).toBe(credits + 1) // + base render
      expect(nodeCreditEstimate('GenerateVideoNode', ex.inputs)).toBe(c)
      const names = Object.keys(ex.inputs)
      const est = estimateUsdForNodes([{ id: '1', type: 'GenerateVideoNode', widgetDefs: names.map(name => ({ name })), widgetsValues: names.map(n => ex.inputs[n]) }], { hosted: true })!
      expect(est.hostedCredits).toBe(c)
    })
  }

  it('the credits: 12 for the live check (13 held), 54 at 6 s 720p, 78 at the defaults, 360 at 10 s 4k', () => {
    expect(charge({ model: ID, duration: '2', model_options: '{"resolution":"720p"}' })).toBe(13)
    expect(nodeCredits('GenerateVideoNode', { model: ID, duration: '6', model_options: '{"resolution":"720p"}' })).toBe(54)
    expect(nodeCredits('GenerateVideoNode', { model: ID, duration: '6', model_options: '{}' })).toBe(78)
    expect(nodeCredits('GenerateVideoNode', { model: ID, duration: '10', model_options: '{"resolution":"4k"}' })).toBe(360)
  })

  it('a linked length prices at the longest (20 s); linked options at the top rate, with the backup covered from 6 s', () => {
    expect(maxVideoSeconds(ID)).toBe(20)
    // 20 s at 1080p: fal's $2.60 at cost.
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: ['7', 0], model_options: '{}' })).toBeCloseTo(usdChargedAtCost(2.6), 9)
    // Linked options, 6 s: Replicate's top $0.24 × 6 = $1.44 against fal's $1.80 at cost ($1.20).
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: '6', model_options: ['7', 0] })).toBeCloseTo(1.44, 9)
    // Linked options, 4 s: no backup, Replicate's top rate alone.
    expect(providerUsd('GenerateVideoNode', { model: ID, duration: '4', model_options: ['7', 0] })).toBeCloseTo(0.96, 9)
    for (const inputs of [
      { model: ID, duration: ['7', 0], model_options: '{}' },
      { model: ID, duration: '4', model_options: ['7', 0] },
    ]) expect(nodeCreditEstimate('GenerateVideoNode', inputs)).toBe(charge(inputs))
  })

  it('priced on what is sent: the planned payload\'s seconds and resolution give the price, and the backup is covered when planned', async () => {
    for (const image of [false, true]) {
      for (const [dur, res] of [['2', '720p'], ['7', '1080p'], ['9', '4k'], ['45', 'nope'], ['15', '1080P'], ['0', '720P'], ['5', '4K']] as const) {
        const node = vid({ image, duration: dur, opts: { resolution: res } })
        const p = await providerPlan(node)
        const rate = videoRate(ID)!.byResolution[String(p.payload.resolution)] as number
        const first = rate * Number(p.payload.duration)
        const usd = providerUsd('GenerateVideoNode', node.inputs)!
        if (p.backup) {
          const falRate = videoBackupRate(ID)!.byResolution[String(p.payload.resolution)] as number
          expect(usd, `${image} ${dur} ${res}`).toBeCloseTo(Math.max(first, usdChargedAtCost(falRate * Number(p.backup.payload.duration))), 9)
        }
        else expect(usd, `${image} ${dur} ${res}`).toBeCloseTo(first, 9)
      }
    }
  })

  it('the gallery label reads Replicate\'s rate at the default settings (1080p)', () => {
    expect(videoRateLabel(ID)).toBe('$0.06/s at 1080p')
  })
})

// ── The engine, end to end ─────────────────────────────────────────────────

describe('the runner engine', () => {
  const take: ApiPrompt = { 1: vid({ duration: '2', opts: { resolution: '720p' } }), 2: { class_type: 'Video', inputs: { source: ['1', 0] } } }
  const start = (k: ReturnType<typeof makeKit>, t: ApiPrompt = take) => k.engine.startRun({ userId: k.userId, takes: [t], workflow: null, canvasId: null, projectUuid: null, projectName: null })

  it('with the family on: the family\'s own Replicate model, held at the node\'s price, a real output; fal not called', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ON } })
    const { runId } = await start(k)
    await k.engine.settled(runId)
    const submitted = k.replicate.submitted()
    expect(submitted.map(r => r.endpoint)).toEqual(['lightricks/ltx-2.5-fast'])
    expect(submitted[0]!.payload).toEqual({ prompt: 'a fox runs through snow', duration: 2, resolution: '720p', aspect_ratio: '16:9', generate_audio: true })
    expect(k.fal.reqs.size).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.credits)).toEqual([creditsForUsd(0.06) + 1])
    expect((await k.store.get(runId))!.status).toBe('done')
  })

  it('with the family off: refused, nothing held or sent', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => ALL_BUT } })
    await expect(start(k)).rejects.toThrow()
    expect(k.replicate.reqs.size).toBe(0)
    expect(k.fal.reqs.size).toBe(0)
    expect(k.ledger.holds.size).toBe(0)
  })

  it('an empty prompt, or 12 s at 4k: refused before the hold, nothing sent', async () => {
    for (const [n, message] of [[vid({ prompt: '' }), LTX_25_FAST_NEEDS_PROMPT], [vid({ duration: '12', opts: { resolution: '4k' } }), LTX_25_FAST_TOO_LONG_AT_4K]] as const) {
      const k = makeKit({ hosted: true, deps: { families: () => ON } })
      await expect(start(k, { 1: n, 2: { class_type: 'Video', inputs: { source: ['1', 0] } } })).rejects.toThrow(message)
      expect(k.replicate.reqs.size).toBe(0)
      expect(k.ledger.holds.size).toBe(0)
    }
  })

  it('a picture linked, Replicate down: the backup on fal carries the same picture and serves it, charged once', async () => {
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
    expect(repCalls[0]![0]).toBe(LTX_25_FAST_REPLICATE_SLUG)
    const sent = [...k.fal.reqs.values()]
    expect(sent.map(r => r.endpoint)).toEqual([LTX_25_FAST_IMAGE_TO_VIDEO])
    expect(sent[0]!.payload).toEqual({
      image_url: 'https://fal.storage/first.png', prompt: 'a fox runs through snow', duration: 6, resolution: '1080p', aspect_ratio: '16:9', generate_audio: true,
    })
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    // 6 s at 1080p: fal's $0.78 at cost is the price that covers either service.
    expect([...k.ledger.holds.values()].map(h => [h.state, h.actual])).toEqual([['settled', creditsForUsd(usdChargedAtCost(0.78)) + 1]])
    expect((await k.store.get(runId))!.status).toBe('done')
  })
})

/**
 * Task F23 (model line-up): Topaz video upscale on fal for "Enhance a video"
 * (EnhanceVideoNode), family `topaz-video`, which moves the whole node while
 * it is on (Ruling 10; off, the node runs on ComfyUI on Replicate's Topaz at
 * its flat price, unchanged). No backup.
 * (shared/runner/topazVideo.ts, server/runner/generators/topazVideo.ts,
 * server/runner/topazMedia.ts, server/runner/nodeMedia.ts.)
 *
 * The family contract:
 *  - the saved schema: the endpoint id and fal's pricing text;
 *  - every payload over the settings grid fits the schema, and carries the
 *    factor and frame rate the price reads;
 *  - hand-written expected payloads: plain, every option set, and the video
 *    from Sailor's files through the hand-off (the node takes no picture);
 *  - eligibility with the family on and off;
 *  - blockedModelUses refuses the node on the ComfyUI path while the family
 *    is on, and never while it is off;
 *  - the price is verified and non-zero, badge ≥ charge (the canvas can't
 *    read the video: "up to"), the charge is the video measured, hold = charge;
 *  - the media hand-off: the video is read and measured before the hold and
 *    again before the call; what Topaz can't take is refused plainly;
 *  - the engine, end to end: the family's own endpoint, the hold and charge.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, Mp4OutputFormat, Output } from 'mediabunny'
import type { ApiPrompt } from '#shared/runner/graph'
import { NO_FAMILIES, RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { PROVIDER_TYPES, RUNNER_NODE_RULES, SWITCHED_CLASSES, classUpgradeOn, isRunnerEligible, runnerTakesNode } from '#shared/runner/eligibility'
import { blockedModelUses, blockedModelsResponse } from '#shared/runner/blockedModels'
import { blockedRunRefusal } from '#shared/runner/needsEngine'
import { pruneInvalidOutputs, runnerTakesWorkflow } from '#shared/runner/validate'
import {
  TOPAZ_VIDEO_ENDPOINT, TOPAZ_VIDEO_FPS, TOPAZ_VIDEO_MAX_SECONDS, TOPAZ_VIDEO_TARGETS, TOPAZ_VIDEO_TOO_LARGE, TOPAZ_VIDEO_TOO_LONG,
  TOPAZ_VIDEO_OUTPUT_TOO_LARGE, TOPAZ_VIDEO_SWITCHED_OFF, TOPAZ_VIDEO_TARGET_LONG_SIDES,
  TOPAZ_VIDEO_UNKNOWN_SETTING, TOPAZ_VIDEO_UNMEASURED, topazVideoBand, topazVideoPlan, topazVideoRateKey, topazVideoTooSmall,
  type TopazVideoPlan,
} from '#shared/runner/topazVideo'
import { CLIP_RATES, clipRate } from '#shared/pricing/clipRates'
import { VIEW_REF_REFUSED, topazVideoCalls } from '#shared/pricing/clipSettings'
import { creditsForUsd } from '#shared/pricing/markup'
import { FAMILY_PRICED_CLASSES, familyPricedClass, priceNode } from '#shared/pricing/nodePrice'
import { nodeCreditEstimate } from '~/lib/nodeCreditEstimate'
import { estimateUsdForNodes, upstreamInputSeconds } from '~/lib/costEstimate'
import { planNode, type NodePlan } from '~~/server/runner/executors'
import {
  TOPAZ_VIDEO_APP, TOPAZ_VIDEO_NEEDS_VIDEO, TOPAZ_VIDEO_NOT_A_FILE, topazVideoSource, topazVideoUpscale,
} from '~~/server/runner/generators/topazVideo'
import { RUNNER_ROUTES } from '~~/server/runner/generators/twins'
import {
  TOPAZ_VIDEO_CHANGED, TOPAZ_VIDEO_FILE_MISSING, TOPAZ_VIDEO_MAX_BYTES, TOPAZ_VIDEO_RULE, topazInputFiles, topazMediaCheck,
} from '~~/server/runner/topazMedia'
import { mediaNodeKind, nodeMediaChangedWords, nodeMediaFiles } from '~~/server/runner/nodeMedia'
import { switchedSinceHold } from '~~/server/runner/switches'
import { mediaFacts, measuredMediaChanged } from '~~/server/runner/mediaInputs'
import { requestProblem, requestProblems } from '~~/server/runner/requestRules'
import { createEngineResultStore } from '~~/server/runner/results'
import { nodeCredits, stageEstimate } from '~~/server/runner/metering'
import { GRAPH_NODE_CREDITS, PRICE_BOOK_VERSION, priceGraph } from '~~/server/utils/priceBook'
import { blockedPromptRefusal } from '~~/server/utils/blockedModels'
import type { MeasuredMedia, OutputFile } from '~~/server/runner/types'
import { checkPayload, loadProviderSchema } from './helpers/providerSchema'
import { createFakeFal, createFakeLedger, makeKit, ofType, until } from './__runner__/kit'

const FAMILY: RunnerFamily = 'topaz-video'
const ON: ReadonlySet<RunnerFamily> = new Set([FAMILY])
const ALL: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES)
const ALL_BUT: ReadonlySet<RunnerFamily> = new Set(RUNNER_FAMILIES.filter(f => f !== FAMILY))
const SCHEMA = loadProviderSchema('fal', TOPAZ_VIDEO_APP)
const CLIP_VIEW = '/view?filename=clip.mp4&type=input'

/** A picture-only MP4 whose video track lasts `seconds` at `fps`, `width` × `height`, muxed without an encoder. */
async function mp4(seconds: number, width = 1280, height = 720, fps = 24): Promise<Buffer> {
  const out = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() })
  const src = new EncodedVideoPacketSource('avc')
  out.addVideoTrack(src, { frameRate: fps })
  await out.start()
  const description = new Uint8Array([1, 0x42, 0xC0, 0x1E, 0xFF, 0xE1, 0, 0x0A, 0x67, 0x42, 0xC0, 0x1E, 0xDA, 0x02, 0x80, 0xBF, 0xE5, 0x84, 1, 0, 4, 0x68, 0xCE, 0x3C, 0x80])
  const frames = Math.round(seconds * fps)
  for (let i = 0; i < frames; i++) {
    await src.add(new EncodedPacket(new Uint8Array([0, 0, 0, 1, 0x65]), i === 0 ? 'key' : 'delta', i / fps, 1 / fps),
      i === 0 ? { decoderConfig: { codec: 'avc1.42c01e', codedWidth: width, codedHeight: height, description } } : undefined)
  }
  await out.finalize()
  return Buffer.from((out.target as BufferTarget).buffer!)
}

/** A 16-bit mono PCM WAV of `seconds` (a file that isn't a video). */
function wav(seconds: number, rate = 8000): Buffer {
  const n = Math.round(seconds * rate)
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  return b
}

/** An EnhanceVideoNode as the canvas sends it, the node's defaults unless told. */
function enhance(o: Record<string, unknown> = {}) {
  return { class_type: 'EnhanceVideoNode', inputs: { model: 'Topaz Video Upscale', video_url: CLIP_VIEW, target_resolution: '1080p', fps: 'original', ...o } }
}
const videoCard = (from = '1') => ({ class_type: 'Video', inputs: { file: '', export: false, filename_prefix: 'video/ComfyUI', source: [from, 0] } })
/** What the engine measured of a video (clipSettings.ts InputSeconds). */
const measured = (seconds: number, width: number, height: number, fps: number | null) => ({ video: seconds, videoWidth: width, videoHeight: height, videoFps: fps })

async function plan(node = enhance(), m: ReturnType<typeof measured> | null = measured(3, 1280, 720, 24)): Promise<Extract<NodePlan, { kind: 'provider' }>> {
  const p = await planNode({
    prompt: { 1: node }, nodeId: '1', gateOpen: false, filesFrom: () => [],
    toUrl: async (f: OutputFile) => `https://fal.storage/${f.filename}`, families: ON,
    ...(m ? { measured: m } : {}),
  })
  if (p.kind !== 'provider') throw new Error('no call')
  return p
}

afterEach(() => {
  delete process.env.NUXT_RUNNER_ENABLED
  delete process.env.NUXT_RUNNER_FAMILIES
})

// ── 1. The saved schema ─────────────────────────────────────────────────────

describe('the saved schema', () => {
  it('is fal-ai/topaz/upscale/video (its x-fal-metadata id), read 2026-09-25, with fal\'s pricing text', () => {
    expect(TOPAZ_VIDEO_APP).toBe('fal-ai/topaz/upscale/video')
    expect(TOPAZ_VIDEO_APP).toBe(TOPAZ_VIDEO_ENDPOINT)
    expect(SCHEMA.endpoint).toBe(TOPAZ_VIDEO_APP)
    expect(SCHEMA.fetchedAt).toBe('2026-09-25')
    expect(SCHEMA.pricingText).toContain('**$0.01** for up to **720p**, **$0.02** for **720p** to **1080p**, and **$0.08** for above **1080p** output. Price doubles for **60fps** output.')
    const input = SCHEMA.components.schemas.TopazUpscaleVideoInput as { required: string[], properties: Record<string, any> }
    expect(input.required).toEqual(['video_url'])
    expect(input.properties.upscale_factor).toMatchObject({ type: 'number', minimum: 1, maximum: 4 })
    expect(input.properties.target_fps.anyOf[0]).toEqual({ type: 'integer', minimum: 16, maximum: 60 })
    expect(input.properties.model.enum).toContain('Proteus')
    expect(input.properties.model.default).toBe('Proteus')
    expect(input.properties.H264_output).toMatchObject({ type: 'boolean', default: false })
  })

  it('the route: fal first, no backup, and why', () => {
    expect(RUNNER_ROUTES['EnhanceVideoNode+topaz-video']!.first).toBe('fal')
    expect(RUNNER_ROUTES['EnhanceVideoNode+topaz-video']!.backup).toBeNull()
    expect(RUNNER_ROUTES['EnhanceVideoNode+topaz-video']!.why).toContain('unspecified unit')
  })
})

// ── 2. Reading the node and the video ───────────────────────────────────────

describe('topazVideoPlan: the factor, the size made and the frame rate, from the node and the measured video', () => {
  const at = (target: string, fps: string, w: number, h: number, rate: number | null) =>
    topazVideoPlan(enhance({ target_resolution: target, fps }).inputs, { width: w, height: h, fps: rate })

  it('the factor is the target\'s short side over the video\'s, rounded down; 1 when the video is already that size or larger', () => {
    expect(at('1080p', 'original', 1280, 720, 24)).toEqual({ factor: 1.5, width: 1920, height: 1080, targetFps: null, band: '1080p', highFps: false })
    expect(at('4k', 'original', 1920, 1080, 30)).toEqual({ factor: 2, width: 3840, height: 2160, targetFps: null, band: '4k', highFps: false })
    expect(at('720p', 'original', 640, 360, 24)).toEqual({ factor: 2, width: 1280, height: 720, targetFps: null, band: '720p', highFps: false })
    // Portrait: the short side is the width, banded by its longer side like a landscape (Task C live check).
    expect(at('1080p', 'original', 720, 1280, 24)).toEqual({ factor: 1.5, width: 1080, height: 1920, targetFps: null, band: '1080p', highFps: false })
    // Already larger than asked: enhanced at its own size (Topaz can't make a video smaller).
    expect(at('720p', 'original', 1920, 1080, 24)).toEqual({ factor: 1, width: 1920, height: 1080, targetFps: null, band: '1080p', highFps: false })
    // An odd size: rounded down, so never a pixel above the target.
    const odd = at('720p', 'original', 952, 540, 24) as TopazVideoPlan
    expect(odd.factor).toBe(1.3333)
    expect(odd.height).toBeLessThanOrEqual(720)
    expect(odd.band).toBe('720p')
  })

  it('the size band: the 16:9 box of each; ultra-wide or square takes the next band up (the safe side)', () => {
    expect(topazVideoBand(1280, 720)).toBe('720p')
    expect(topazVideoBand(720, 1280)).toBe('720p') // portrait: the same band as landscape (Task C live check)
    expect(topazVideoBand(1281, 720)).toBe('1080p')
    expect(topazVideoBand(1680, 720)).toBe('1080p')
    expect(topazVideoBand(1080, 1080)).toBe('1080p')
    expect(topazVideoBand(1920, 1080)).toBe('1080p')
    expect(topazVideoBand(1920, 1081)).toBe('4k')
    expect(topazVideoBand(2560, 1080)).toBe('4k')
    expect(topazVideoBand(3840, 2160)).toBe('4k')
  })

  it('the frame rate: 60 asked, a video above 32 frames a second, or one not measured, is priced at fal\'s 60 fps rate', () => {
    expect((at('1080p', '60', 1280, 720, 24) as TopazVideoPlan)).toMatchObject({ targetFps: 60, highFps: true })
    expect((at('1080p', '30', 1280, 720, 24) as TopazVideoPlan)).toMatchObject({ targetFps: 30, highFps: false })
    expect((at('1080p', '30', 1280, 720, 60) as TopazVideoPlan)).toMatchObject({ targetFps: 30, highFps: true })
    expect((at('1080p', 'original', 1280, 720, 59.94) as TopazVideoPlan)).toMatchObject({ targetFps: null, highFps: true })
    expect((at('1080p', 'original', 1280, 720, 50) as TopazVideoPlan)).toMatchObject({ highFps: true })
    expect((at('1080p', 'original', 1280, 720, 30) as TopazVideoPlan)).toMatchObject({ highFps: false })
    expect((at('1080p', 'original', 1280, 720, null) as TopazVideoPlan)).toMatchObject({ highFps: true })
    expect(topazVideoRateKey('720p', false)).toBe('720p')
    expect(topazVideoRateKey('4k', true)).toBe('4k/60fps')
  })

  it('refused in plain words: more than 4 times, above 4K, not measured, a setting the node doesn\'t offer', () => {
    expect(at('4k', 'original', 640, 360, 24)).toEqual({ refused: 'Topaz can make a video at most 4 times larger, and this one is 640 × 360. Choose 1080p or lower.' })
    expect(at('720p', 'original', 160, 120, 24)).toEqual({ refused: 'Topaz can make a video at most 4 times larger, and this one is 160 × 120, too small even for 720p. Use a larger video.' })
    expect(topazVideoTooSmall(480, 270)).toBe('Topaz can make a video at most 4 times larger, and this one is 480 × 270. Choose 1080p or lower.')
    expect(topazVideoTooSmall(960, 540)).toBe('Topaz can make a video at most 4 times larger, and this one is 960 × 540. Choose 4K or lower.')
    expect(at('4k', 'original', 4096, 2304, 24)).toEqual({ refused: TOPAZ_VIDEO_TOO_LARGE })
    expect(at('4k', 'original', 5000, 2000, 24)).toEqual({ refused: TOPAZ_VIDEO_TOO_LARGE })
    expect(at('4k', 'original', 4096, 2160, 24)).toMatchObject({ factor: 1, band: '4k' })
    expect(topazVideoPlan(enhance().inputs, { width: null, height: 720, fps: 24 })).toEqual({ refused: TOPAZ_VIDEO_UNMEASURED })
    expect(at('8k', 'original', 1280, 720, 24)).toEqual({ refused: TOPAZ_VIDEO_UNKNOWN_SETTING })
    expect(at('1080p', '24', 1280, 720, 24)).toEqual({ refused: TOPAZ_VIDEO_UNKNOWN_SETTING })
  })
})

// ── 3. The request ──────────────────────────────────────────────────────────

describe('the request', () => {
  const SIZES: [number, number][] = [[640, 360], [854, 480], [952, 540], [1280, 720], [720, 1280], [1920, 1080], [1080, 1920], [1440, 1080], [2560, 1440], [3840, 2160]]
  const RATES = [24, 30, 60, null]

  it('every setting over sizes and frame rates: fits the schema, and sends the factor and frame rate the price reads', async () => {
    let planned = 0
    let refused = 0
    for (const target of Object.keys(TOPAZ_VIDEO_TARGETS)) {
      for (const fps of TOPAZ_VIDEO_FPS) {
        for (const [w, h] of SIZES) {
          for (const rate of RATES) {
            const node = enhance({ target_resolution: target, fps })
            const m = measured(4.2, w, h, rate)
            const expected = topazVideoPlan(node.inputs, { width: w, height: h, fps: rate })
            if ('refused' in expected) {
              await expect(plan(node, m)).rejects.toThrow(expected.refused)
              expect(topazVideoCalls(node.inputs, m)).toEqual({ refused: expected.refused })
              refused++
              continue
            }
            const p = await plan(node, m)
            expect(p.endpoint).toBe(TOPAZ_VIDEO_APP)
            expect(p.provider).toBe('fal')
            expect(p.media).toBe('video')
            expect(p.backup).toBeUndefined()
            expect(checkPayload(SCHEMA, p.payload), `${target} ${fps} ${w}x${h} ${rate}`).toEqual([])
            expect(requestProblem('fal', TOPAZ_VIDEO_APP, p.payload)).toBeNull()
            // Priced on what is sent: the size band of the video × the factor sent, and the frame rate sent.
            const f = p.payload.upscale_factor as number
            const band = topazVideoBand(Math.ceil(w * f - 1e-6), Math.ceil(h * f - 1e-6))
            const high = p.payload.target_fps === 60 || rate == null || rate > 32
            expect(topazVideoCalls(node.inputs, m)).toEqual([{ endpoint: TOPAZ_VIDEO_APP, seconds: 5, resolution: topazVideoRateKey(band, high), audio: false }])
            expect(p.payload.target_fps).toBe(fps === 'original' ? undefined : Number(fps))
            planned++
          }
        }
      }
    }
    expect(planned + refused).toBe(3 * 3 * SIZES.length * RATES.length)
    expect(planned).toBeGreaterThan(200)
    expect(refused).toBeGreaterThan(0)
  })

  it('plain (the node\'s defaults: 1080p, original frame rate), checked against the schema\'s own example', async () => {
    const p = await plan()
    expect(p.payload).toEqual({ video_url: 'https://fal.storage/clip.mp4', model: 'Proteus', upscale_factor: 1.5, H264_output: true })
    expect(checkPayload(SCHEMA, p.payload)).toEqual([])
    // The schema's own "Full Example" is the same shape: the URL, the model and the factor.
    const input = SCHEMA.components.schemas.TopazUpscaleVideoInput as { properties: Record<string, { examples?: string[] }> }
    const example = input.properties.video_url!.examples![0]!
    const call = topazVideoUpscale({ videoUrl: example, plan: { factor: 2, width: 2560, height: 1440, targetFps: null, band: '4k', highFps: false } })
    expect(call).toEqual({ provider: 'fal', endpoint: TOPAZ_VIDEO_APP, payload: { video_url: example, model: 'Proteus', upscale_factor: 2, H264_output: true } })
    expect(checkPayload(SCHEMA, call.payload)).toEqual([])
    expect(p.prefix).toBe('enhance_video')
    expect(p.uiFor([{ filename: 'x.mp4', subfolder: '', type: 'output' }])).toBeNull()
  })

  it('every option set (4K at 60 frames a second, from 720p)', async () => {
    const p = await plan(enhance({ target_resolution: '4k', fps: '60' }), measured(2, 1280, 720, 30))
    expect(p.payload).toEqual({ video_url: 'https://fal.storage/clip.mp4', model: 'Proteus', upscale_factor: 3, target_fps: 60, H264_output: true })
    expect(checkPayload(SCHEMA, p.payload)).toEqual([])
  })

  it('the video from Sailor\'s files (the node takes no picture): the /view link\'s input file, handed off', async () => {
    const node = enhance({ video_url: '/view?filename=holiday%20clip.mov&type=input&subfolder=' })
    expect(topazVideoSource({ 1: node }, '1')).toEqual({ file: { filename: 'holiday clip.mov', subfolder: '', type: 'input' } })
    const handed: OutputFile[] = []
    const p = await planNode({
      prompt: { 1: node }, nodeId: '1', gateOpen: false, filesFrom: () => [], families: ON, measured: measured(3, 1280, 720, 24),
      toUrl: async (f) => { handed.push(f); return 'https://fal.storage/holiday-clip.mov' },
    })
    expect(handed).toEqual([{ filename: 'holiday clip.mov', subfolder: '', type: 'input' }])
    expect((p as any).payload.video_url).toBe('https://fal.storage/holiday-clip.mov')
  })

  it('never planned without the engine\'s measurement, a video, or with a web link', async () => {
    await expect(plan(enhance(), null)).rejects.toThrow(TOPAZ_VIDEO_UNMEASURED)
    await expect(plan(enhance({ video_url: 'https://example.com/a.mp4' }))).rejects.toThrow(TOPAZ_VIDEO_NOT_A_FILE)
    await expect(plan(enhance({ video_url: '' }))).rejects.toThrow(TOPAZ_VIDEO_NEEDS_VIDEO)
  })

  it('the request check: the factor within 1–4, the frame rate 30 or 60, or refused', () => {
    const ok = { video_url: 'u', model: 'Proteus', upscale_factor: 2, H264_output: true }
    expect(requestProblem('fal', TOPAZ_VIDEO_APP, ok)).toBeNull()
    expect(requestProblem('fal', TOPAZ_VIDEO_APP, { ...ok, target_fps: 60 })).toBeNull()
    expect(requestProblem('fal', TOPAZ_VIDEO_APP, { ...ok, upscale_factor: 4.5 })).toBe(TOPAZ_VIDEO_UNKNOWN_SETTING)
    expect(requestProblem('fal', TOPAZ_VIDEO_APP, { ...ok, upscale_factor: 0.5 })).toBe(TOPAZ_VIDEO_UNKNOWN_SETTING)
    expect(requestProblem('fal', TOPAZ_VIDEO_APP, { ...ok, upscale_factor: undefined })).toBe(TOPAZ_VIDEO_UNKNOWN_SETTING)
    expect(requestProblem('fal', TOPAZ_VIDEO_APP, { ...ok, target_fps: 45 })).toBe(TOPAZ_VIDEO_UNKNOWN_SETTING)
  })
})

// ── 4. Eligibility ──────────────────────────────────────────────────────────

describe('eligibility', () => {
  const alone = (node = enhance()): ApiPrompt => ({ 1: node, 2: videoCard() })

  it('the row: no family of its own, moved by topaz-video (Ruling 10), a provider type, switched', () => {
    const rule = RUNNER_NODE_RULES.EnhanceVideoNode!
    expect(rule.family).toBeUndefined()
    expect(rule.models).toBeUndefined()
    expect(rule.upgrade).toEqual({ family: 'topaz-video', label: 'Topaz Video Upscale' })
    expect(classUpgradeOn('EnhanceVideoNode', ON)).toEqual(rule.upgrade)
    expect(classUpgradeOn('EnhanceVideoNode', ALL_BUT)).toBeNull()
    expect(PROVIDER_TYPES.has('EnhanceVideoNode')).toBe(true)
    expect(SWITCHED_CLASSES.EnhanceVideoNode).toBe('topaz-video')
  })

  it('on: taken (alone, or with every family); off (no families, or every other one): not', () => {
    expect(isRunnerEligible(alone(), ON)).toBe(true)
    expect(isRunnerEligible(alone(), ALL)).toBe(true)
    expect(runnerTakesWorkflow(alone(), ON)).toBe(true)
    expect(isRunnerEligible(alone(), NO_FAMILIES)).toBe(false)
    expect(isRunnerEligible(alone(), ALL_BUT)).toBe(false)
    expect(runnerTakesWorkflow(alone(), ALL_BUT)).toBe(false)
  })

  it('a web link is still taken (and refused plainly before the hold, below), not quietly sent to ComfyUI', () => {
    expect(isRunnerEligible(alone(enhance({ video_url: 'https://example.com/a.mp4' })), ON)).toBe(true)
  })

  it('what it reads before the run must not be wired, and each widget must pass ComfyUI\'s validation', () => {
    for (const name of ['model', 'video_url', 'target_resolution', 'fps']) {
      const p = { ...alone(enhance({ [name]: ['5', 0] })), 5: { class_type: 'PrimitiveString', inputs: { value: 'x' } } }
      expect(runnerTakesNode(p, '1', ALL), name).toBe(false)
    }
    for (const [name, v] of [['model', 'Topaz Video Upscale 2'], ['target_resolution', '8k'], ['fps', '24']] as const) {
      expect(runnerTakesNode(alone(enhance({ [name]: v })), '1', ALL), name).toBe(false)
    }
  })

  it('switched: off, a workflow with it is left whole by the pruning (exactly as before); on, pruned as ComfyUI would', () => {
    const bad: ApiPrompt = { 1: enhance({ fps: '24' }), 2: videoCard(), 3: { class_type: 'Image', inputs: { image: 'a.png' } } }
    expect(pruneInvalidOutputs(bad, NO_FAMILIES)).toEqual({ prompt: bad, dropped: [], nodeErrors: {}, failed: false })
    expect(pruneInvalidOutputs(bad, ALL_BUT).dropped).toEqual([])
    const on = pruneInvalidOutputs(bad, ON)
    expect(on.dropped).toEqual(['2'])
    expect(Object.keys(on.prompt)).toEqual(['3'])
  })
})

// ── 5. The ComfyUI path refuses it while the switch is on ───────────────────

describe('blockedModelUses: while topaz-video is on, Enhance a video runs only in Sailor', () => {
  const use = { nodeId: '1', classType: 'EnhanceVideoNode', value: 'Topaz Video Upscale', reason: 'runner-only', upgrade: true }

  it('off: never refused (ComfyUI runs it on Replicate, as before); on: refused on the ComfyUI path, fine in the runner', () => {
    const p: ApiPrompt = { 1: enhance(), 2: videoCard() }
    expect(blockedModelUses(p, { families: NO_FAMILIES })).toEqual([])
    expect(blockedModelUses(p, { families: ALL_BUT })).toEqual([])
    expect(blockedModelUses(p, { families: ON })).toEqual([use])
    expect(blockedModelUses(p, { families: ON, runnerTakes: true })).toEqual([])
  })

  it('the refusal, in plain words, with and without another node to blame', () => {
    const body = blockedModelsResponse({ 1: enhance() }, [use as any], { families: ON })
    expect(body.error.message).toBe('“Enhance a video” uses Topaz Video Upscale, which only runs in Sailor. Sailor can’t run it as it is set up here.')
    expect((body.node_errors['1'] as any).errors[0].extra_info).toEqual({})
    const r = blockedRunRefusal([{ prompt: { 1: enhance() }, titleOf: () => 'Sharpen the clip' }], { runnerOn: true, families: ON })
    expect(r?.title).toBe('“Sharpen the clip” uses Topaz Video Upscale, which only runs in Sailor')
  })

  it('the server\'s /prompt gate: refused with the switch on, left alone with it off', () => {
    process.env.NUXT_RUNNER_ENABLED = 'true'
    process.env.NUXT_RUNNER_FAMILIES = 'topaz-video'
    expect(blockedPromptRefusal({ 1: enhance(), 2: videoCard() })).toBeTruthy()
    process.env.NUXT_RUNNER_FAMILIES = RUNNER_FAMILIES.filter(f => f !== FAMILY).join(',')
    expect(blockedPromptRefusal({ 1: enhance(), 2: videoCard() })).toBeNull()
  })
})

// ── 6. The price ────────────────────────────────────────────────────────────

describe('the price', () => {
  const at = (inputs: Record<string, unknown>, m: Record<string, number | null> = {}, families: ReadonlySet<RunnerFamily> = ON) =>
    priceNode('EnhanceVideoNode', inputs, { inputSeconds: m, families })

  it('the card: per second by band and frame rate, from fal\'s page, verified, non-zero; the book carries it (lineup-f23, now lineup-g1)', () => {
    const rate = clipRate(TOPAZ_VIDEO_ENDPOINT)!
    expect(rate).toEqual({
      unit: 'per_second', service: 'fal', source: 'https://fal.ai/models/fal-ai/topaz/upscale/video/llms.txt', read: '2026-09-25', confidence: 'verified',
      byResolution: { '720p': 0.01, '1080p': 0.02, '4k': 0.08, '720p/60fps': 0.02, '1080p/60fps': 0.04, '4k/60fps': 0.16 },
    })
    expect(CLIP_RATES[TOPAZ_VIDEO_ENDPOINT]).toBe(rate)
    expect(PRICE_BOOK_VERSION).toBe('r3-audio-gen')
    // + PersonSwapVideo (person-swap-video), added by Task 3 (non-commercial face models replacement).
    expect(FAMILY_PRICED_CLASSES).toEqual({ EnhanceVideoNode: 'topaz-video', PersonSwapVideo: 'person-swap-video' })
  })

  it('the video measured: whole seconds rounded up × the band\'s rate, doubled at 60 frames a second', () => {
    // 3 s of 720p at 24 fps → 1080p: 3 × $0.02.
    expect(at(enhance().inputs, measured(3, 1280, 720, 24))).toEqual({ usd: 0.06, credits: 12 })
    // 2.1 s → 3 s.
    expect(at(enhance().inputs, measured(2.1, 1280, 720, 24))).toEqual({ usd: 0.06, credits: 12 })
    // 60 frames a second asked: doubled.
    expect(at(enhance({ fps: '60' }).inputs, measured(3, 1280, 720, 24))).toEqual({ usd: 0.12, credits: 18 })
    // 4K, 5 s: 5 × $0.08.
    expect(at(enhance({ target_resolution: '4k' }).inputs, measured(5, 1920, 1080, 30))).toEqual({ usd: 0.4, credits: 60 })
    // The cheapest: 2 s up to 720p.
    expect(at(enhance({ target_resolution: '720p' }).inputs, measured(2, 640, 360, 24))).toEqual({ usd: 0.02, credits: 4 })
    // 60 s at 4K and 60 fps: the most any video costs.
    expect(at(enhance({ target_resolution: '4k', fps: '60' }).inputs, measured(60, 1920, 1080, 60))).toEqual({ usd: 9.6, credits: 1440 })
  })

  it('unmeasured: the ceiling (60 s, above 1080p, 60 fps) — the hold for a node with no record and the badge\'s "up to"', () => {
    expect(at(enhance().inputs)).toEqual({ usd: 9.6, credits: 1440 })
    expect(TOPAZ_VIDEO_MAX_SECONDS).toBe(60)
    for (const target of Object.keys(TOPAZ_VIDEO_TARGETS)) {
      for (const fps of TOPAZ_VIDEO_FPS) {
        for (const [w, h] of [[640, 360], [1280, 720], [1920, 1080], [720, 1280]]) {
          for (const rate of [24, 60, null]) {
            const p = at(enhance({ target_resolution: target, fps }).inputs, measured(60, w!, h!, rate))
            if ('refused' in p) continue
            expect(p.credits).toBeLessThanOrEqual(1440)
          }
        }
      }
    }
  })

  it('a setting or video Topaz can\'t take is refused, with the runner\'s words', () => {
    expect(at(enhance({ fps: '24' }).inputs)).toEqual({ refused: TOPAZ_VIDEO_UNKNOWN_SETTING })
    expect(at(enhance({ target_resolution: '4k' }).inputs, measured(3, 320, 180, 24))).toEqual({ refused: topazVideoTooSmall(320, 180) })
  })

  it('with the switch off: not priced here; the charge is the flat 150 credits, as before', () => {
    expect(familyPricedClass('EnhanceVideoNode', NO_FAMILIES)).toBe(false)
    expect(familyPricedClass('EnhanceVideoNode', ALL_BUT)).toBe(false)
    expect(familyPricedClass('EnhanceVideoNode', ON)).toBe(true)
    expect(at(enhance().inputs, measured(3, 1280, 720, 24), NO_FAMILIES)).toEqual({ refused: 'not a model-priced class' })
    expect(nodeCreditEstimate('EnhanceVideoNode', enhance().inputs, { families: NO_FAMILIES })).toBeNull()
    expect(GRAPH_NODE_CREDITS.EnhanceVideoNode).toBe(150)
    expect(priceGraph({ 1: enhance(), 2: videoCard() }).credits).toBe(150 + 1)
    expect(priceGraph({ 1: enhance(), 2: videoCard() }, { families: ALL_BUT }).credits).toBe(150 + 1)
  })

  it('badge = charge for a measured video; the canvas (which can\'t read it) shows the ceiling as "up to"', () => {
    for (const [inputs, m] of [
      [enhance().inputs, measured(3, 1280, 720, 24)],
      [enhance({ target_resolution: '4k', fps: '60' }).inputs, measured(7.5, 1920, 1080, 30)],
      [enhance({ target_resolution: '720p', fps: '30' }).inputs, measured(2, 640, 360, 60)],
    ] as const) {
      const price = priceNode('EnhanceVideoNode', inputs, { inputSeconds: m, families: ON })
      if ('refused' in price) throw new Error('refused')
      expect(price.usd).toBeGreaterThan(0)
      expect(nodeCreditEstimate('EnhanceVideoNode', inputs, { inputSeconds: m, families: ON })).toBe(price.credits + 1)
      expect(priceGraph({ n: { class_type: 'EnhanceVideoNode', inputs }, out: videoCard('n') }, { inputSeconds: { n: m }, families: ON }).credits).toBe(price.credits + 1)
      expect(nodeCredits({ class_type: 'EnhanceVideoNode', inputs }, undefined, ON, m)).toBe(price.credits)
      // Hold ≥ charge: a node with no record holds the ceiling.
      expect(nodeCredits({ class_type: 'EnhanceVideoNode', inputs }, undefined, ON)).toBeGreaterThanOrEqual(price.credits)
    }
    // The canvas node: "up to" the ceiling (ComfyNode.vue reads upstreamInputSeconds' upTo).
    const canvasNode = { id: '1', data: { nodeType: 'EnhanceVideoNode', widgetDefs: [], widgetsValues: [], inputs: [] } }
    expect(upstreamInputSeconds(canvasNode, [canvasNode], [])).toEqual({ seconds: {}, upTo: true })
    expect(nodeCreditEstimate('EnhanceVideoNode', enhance().inputs, { inputSeconds: {}, families: ON })).toBe(1440 + 1)
    // The hosted run estimate: the same ceiling while on; Python's static badge while off.
    const est = (families: ReadonlySet<RunnerFamily>) => estimateUsdForNodes([{
      id: '1', type: 'EnhanceVideoNode', badgeExpr: '{"type":"usd","usd":1.00,"format":{"approximate":true}}', category: 'api node/video/Replicate',
      widgetDefs: [{ name: 'model' }, { name: 'video_url' }, { name: 'target_resolution' }, { name: 'fps' }],
      widgetsValues: ['Topaz Video Upscale', CLIP_VIEW, '1080p', 'original'],
    }], { hosted: true, families })
    expect(est(ON)!.hostedCredits).toBe(1440 + 1)
    expect(est(NO_FAMILIES)!.hostedCredits).toBe(creditsForUsd(1) + 1)
  })
})

// ── 7. Before the hold: the node's own settings ─────────────────────────────

describe('requestProblems (a runner run): what stops the node before anything is read', () => {
  const problems = (node: ReturnType<typeof enhance>) => requestProblems({ 1: node, 2: videoCard() }, { runner: true })

  it('no video, a web link, a data URL, a link that names its file twice, a setting it doesn\'t offer', () => {
    expect(problems(enhance())).toEqual([])
    const one = (input: string, message: string) => [{ nodeId: '1', classType: 'EnhanceVideoNode', input, message }]
    expect(problems(enhance({ video_url: '' }))).toEqual(one('video_url', TOPAZ_VIDEO_NEEDS_VIDEO))
    expect(problems(enhance({ video_url: '   ' }))).toEqual(one('video_url', TOPAZ_VIDEO_NEEDS_VIDEO))
    expect(problems(enhance({ video_url: 'https://example.com/a.mp4' }))).toEqual(one('video_url', TOPAZ_VIDEO_NOT_A_FILE))
    expect(problems(enhance({ video_url: 'data:video/mp4;base64,AAAA' }))).toEqual(one('video_url', TOPAZ_VIDEO_NOT_A_FILE))
    expect(problems(enhance({ video_url: '/view?filename=a.mp4&type=output' }))).toEqual(one('video_url', TOPAZ_VIDEO_NOT_A_FILE))
    expect(problems(enhance({ video_url: '/view?filename=a.mp4&filename=b.mp4&type=input' }))).toEqual(one('video_url', VIEW_REF_REFUSED))
    expect(problems(enhance({ target_resolution: '8k' }))).toEqual(one('target_resolution', TOPAZ_VIDEO_UNKNOWN_SETTING))
    expect(problems(enhance({ fps: '24' }))).toEqual(one('fps', TOPAZ_VIDEO_UNKNOWN_SETTING))
  })

  it('none on the ComfyUI path (with the switch off it runs there, as before)', () => {
    expect(requestProblems({ 1: enhance({ video_url: 'https://example.com/a.mp4' }), 2: videoCard() })).toEqual([])
  })
})

// ── 8. The media ────────────────────────────────────────────────────────────

describe('the video: read, measured and judged (topazMediaCheck)', () => {
  const file = (bytes: Buffer | null, size?: number | null) => {
    const read = vi.fn(async () => { if (!bytes) throw new Error('gone'); return new Uint8Array(bytes) })
    return { read, ...(size !== undefined ? { size: async () => size } : {}), strict: false }
  }

  it('the rule: MP4, MOV or WebM, 100 MB, 4K, the frame rate read', () => {
    expect(TOPAZ_VIDEO_RULE).toMatchObject({ kind: 'video', formats: ['mp4', 'mov', 'webm'], maxBytes: 100_000_000, maxLongSide: 4096, maxShortSide: 2160, frameRate: true })
    expect(TOPAZ_VIDEO_MAX_BYTES).toBe(100_000_000)
  })

  it('the length, size and frame rate come from the bytes (mediabunny, never decoded)', async () => {
    const f24 = await mediaFacts(await mp4(3, 1280, 720, 24), TOPAZ_VIDEO_RULE)
    expect(f24).toMatchObject({ format: 'mp4', width: 1280, height: 720 })
    expect(f24.seconds).toBeCloseTo(3, 1)
    expect(f24.fps).toBeCloseTo(24, 0)
    const f60 = await mediaFacts(await mp4(2, 640, 360, 60), TOPAZ_VIDEO_RULE)
    expect(f60.fps).toBeCloseTo(60, 0)
  })

  it('fits: the file, what was measured (with the sha256 of the bytes) and the request\'s settings', async () => {
    const bytes = await mp4(3, 1280, 720, 24)
    const c = await topazMediaCheck({ 1: enhance() }, '1', file(bytes))
    if (c.problem !== null) throw new Error(c.problem)
    expect(c.video).toEqual({ filename: 'clip.mp4', subfolder: '', type: 'input' })
    expect(c.measured.seconds.video).toBeCloseTo(3, 1)
    expect(c.measured.seconds).toMatchObject({ videoWidth: 1280, videoHeight: 720 })
    expect(c.measured.seconds.videoFps).toBeCloseTo(24, 0)
    expect(c.measured.sha.video).toMatch(/^[0-9a-f]{64}$/)
    expect(c.measured.sha.audio).toBeUndefined()
    expect(c.plan).toMatchObject({ factor: 1.5, band: '1080p', highFps: false })
  })

  it('refused plainly: too long, the wrong file, too big (never read), missing, above 4K, too small, not measurable (in local mode too)', async () => {
    expect(await topazMediaCheck({ 1: enhance() }, '1', file(await mp4(61, 640, 360, 10)))).toEqual({ problem: TOPAZ_VIDEO_TOO_LONG })
    expect(await topazMediaCheck({ 1: enhance() }, '1', file(wav(3)))).toEqual({ problem: TOPAZ_VIDEO_RULE.words.wrongFormat })
    const big = file(await mp4(1), TOPAZ_VIDEO_MAX_BYTES + 1)
    expect(await topazMediaCheck({ 1: enhance() }, '1', big)).toEqual({ problem: TOPAZ_VIDEO_RULE.words.tooLarge })
    expect(big.read.mock.calls.length).toBe(0)
    expect(await topazMediaCheck({ 1: enhance() }, '1', file(null))).toEqual({ problem: TOPAZ_VIDEO_FILE_MISSING })
    expect(await topazMediaCheck({ 1: enhance({ target_resolution: '4k' }) }, '1', file(await mp4(1, 4096, 2304, 10)))).toEqual({ problem: TOPAZ_VIDEO_TOO_LARGE })
    expect(await topazMediaCheck({ 1: enhance({ target_resolution: '4k' }) }, '1', file(await mp4(1, 320, 180, 10)))).toEqual({ problem: topazVideoTooSmall(320, 180) })
    // An MP4 header over bytes mediabunny can't read: its size and length are unknown, refused even locally.
    const junk = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)])
    expect(await topazMediaCheck({ 1: enhance() }, '1', file(junk))).toEqual({ problem: TOPAZ_VIDEO_UNMEASURED })
    // A web link never reads anything.
    const web = file(await mp4(1))
    expect(await topazMediaCheck({ 1: enhance({ video_url: 'https://example.com/a.mp4' }) }, '1', web)).toEqual({ problem: TOPAZ_VIDEO_NOT_A_FILE })
    expect(web.read.mock.calls.length).toBe(0)
  })

  it('the media node dispatch: Topaz and sync-3 only; the files for the ownership check; the change words', () => {
    expect(mediaNodeKind(enhance())).toBe('topaz-video')
    expect(mediaNodeKind({ class_type: 'GenerateVideoNode', inputs: {} })).toBeNull()
    expect(nodeMediaFiles({ 1: enhance() }, '1')).toEqual([{ filename: 'clip.mp4', subfolder: '', type: 'input' }])
    expect(topazInputFiles({ 1: enhance({ video_url: 'https://x' }) }, '1')).toEqual([])
    expect(nodeMediaChangedWords(enhance())).toBe(TOPAZ_VIDEO_CHANGED)
  })

  it('a change between the start and the node\'s turn: the length, the size, the frame rate or the bytes', () => {
    const rec: MeasuredMedia = { seconds: measured(3, 1280, 720, 24), sha: { video: 'a' } }
    expect(measuredMediaChanged(rec, { seconds: measured(3.0000001, 1280, 720, 24), sha: { video: 'a' } })).toBe(false)
    expect(measuredMediaChanged(rec, { seconds: measured(4, 1280, 720, 24), sha: { video: 'a' } })).toBe(true)
    expect(measuredMediaChanged(rec, { seconds: measured(3, 1920, 1080, 24), sha: { video: 'a' } })).toBe(true)
    expect(measuredMediaChanged(rec, { seconds: measured(3, 1280, 720, 60), sha: { video: 'a' } })).toBe(true)
    expect(measuredMediaChanged(rec, { seconds: measured(3, 1280, 720, null), sha: { video: 'a' } })).toBe(true)
    expect(measuredMediaChanged(rec, { seconds: measured(3, 1280, 720, 24), sha: { video: 'b' } })).toBe(true)
  })

  it('stageEstimate: a record holds its price; none holds the ceiling', () => {
    const p: ApiPrompt = { 1: enhance(), 2: videoCard() }
    expect(stageEstimate(p, ['1', '2'], true, ON, { 1: { seconds: measured(3, 1280, 720, 24) } })).toBe(12 + 1)
    expect(stageEstimate(p, ['1', '2'], true, ON)).toBe(1440 + 1)
  })
})

// ── 9. The engine, end to end ───────────────────────────────────────────────

describe('the engine', () => {
  const start = (k: ReturnType<typeof makeKit>, take: ApiPrompt) =>
    k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })
  const done = (k: ReturnType<typeof makeKit>) =>
    until(() => ofType(k.seen, 'execution_success').length + ofType(k.seen, 'execution_error').length >= 1)

  /** A kit on real files; `later`: what a file holds from its second read on (it changed after the run started). */
  const kitWith = (entries: Record<string, Buffer>, o: { families?: ReadonlySet<RunnerFamily>, later?: Record<string, Buffer>, hosted?: boolean } = {}) => {
    const hosted = o.hosted ?? true
    const root = mkdtempSync(join(tmpdir(), 'topaz-engine-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
    for (const [name, bytes] of Object.entries(entries)) writeFileSync(join(root, 'input', name), bytes)
    const store = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => hosted })
    const reads = new Map<string, number>()
    const results = {
      ...store,
      read: async (f: OutputFile) => {
        const n = (reads.get(f.filename) ?? 0) + 1
        reads.set(f.filename, n)
        if (n > 1 && o.later?.[f.filename]) return new Uint8Array(o.later[f.filename]!)
        return store.read(f)
      },
    }
    return { k: makeKit({ hosted, available: 5000, root, deps: { families: () => o.families ?? ON, results } }), reads }
  }

  it('sends the family\'s own endpoint with the handed-off video; holds and charges the video measured', async () => {
    const { k, reads } = kitWith({ 'clip.mp4': await mp4(3, 1280, 720, 24) })
    await start(k, { 1: enhance(), 2: videoCard() })
    await done(k)
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    const sent = k.fal.submitted()
    expect(sent.map(r => r.endpoint)).toEqual([TOPAZ_VIDEO_APP])
    expect(sent[0]!.payload).toEqual({ video_url: 'https://fal.storage/clip.mp4', model: 'Proteus', upscale_factor: 1.5, H264_output: true })
    expect(checkPayload(SCHEMA, sent[0]!.payload)).toEqual([])
    expect(k.upload.mock.calls.map(c => [c[1], c[2]])).toEqual([['clip.mp4', 'video/mp4']])
    // One read at the start (before the hold) and one at the node's turn, which the hand-off shares.
    expect(reads.get('clip.mp4')).toBe(2)
    // The tight hold: 3 s at 1080p, $0.06, 12 credits + the render credit, held and charged alike.
    const holds = [...k.ledger.holds.values()]
    expect(holds.map(h => h.credits)).toEqual([13])
    expect(holds.map(h => h.actual)).toEqual([13])
  })

  it('60 frames a second from a 4K ask: the doubled rate, held and charged', async () => {
    const { k } = kitWith({ 'clip.mp4': await mp4(2, 1920, 1080, 30) })
    await start(k, { 1: enhance({ target_resolution: '4k', fps: '60' }), 2: videoCard() })
    await done(k)
    expect(ofType(k.seen, 'execution_error')).toEqual([])
    expect(k.fal.submitted()[0]!.payload).toEqual({ video_url: 'https://fal.storage/clip.mp4', model: 'Proteus', upscale_factor: 2, target_fps: 60, H264_output: true })
    // 2 s × $0.16 = $0.32 → 48 credits, + 1.
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.actual])).toEqual([[49, 49]])
  })

  it('refused before the hold: too long, the wrong file, a web link, too small, switched off; nothing held, sent or uploaded', async () => {
    const cases: [Record<string, Buffer>, ApiPrompt, string, ReadonlySet<RunnerFamily>?][] = [
      [{ 'clip.mp4': await mp4(61, 640, 360, 10) }, { 1: enhance(), 2: videoCard() }, TOPAZ_VIDEO_TOO_LONG],
      [{ 'clip.mp4': wav(3) }, { 1: enhance(), 2: videoCard() }, TOPAZ_VIDEO_RULE.words.wrongFormat],
      [{ 'clip.mp4': await mp4(1) }, { 1: enhance({ video_url: 'https://example.com/a.mp4' }), 2: videoCard() }, TOPAZ_VIDEO_NOT_A_FILE],
      [{ 'clip.mp4': await mp4(1, 320, 180, 10) }, { 1: enhance({ target_resolution: '4k' }), 2: videoCard() }, 'at most 4 times larger'],
      [{ 'clip.mp4': await mp4(1) }, { 1: enhance(), 2: videoCard() }, 'can’t run on the Sailor runner', ALL_BUT],
    ]
    for (const [entries, take, message, families] of cases) {
      const { k } = kitWith(entries, { families })
      await expect(start(k, take)).rejects.toThrow(message)
      expect(k.fal.reqs.size).toBe(0)
      expect(k.ledger.holds.size).toBe(0)
      expect(k.upload.mock.calls.length).toBe(0)
    }
  })

  it('local mode refuses a video it can\'t measure too (the factor needs its size)', async () => {
    const junk = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64, 7)])
    const { k } = kitWith({ 'clip.mp4': junk }, { hosted: false })
    await expect(start(k, { 1: enhance(), 2: videoCard() })).rejects.toThrow(TOPAZ_VIDEO_UNMEASURED)
    expect(k.fal.reqs.size).toBe(0)
  })

  it('a video that changed after the run started (same length, other size) fails the node before the hand-off; the hold is released', async () => {
    const { k } = kitWith({ 'clip.mp4': await mp4(3, 1280, 720, 24) }, { later: { 'clip.mp4': await mp4(3, 1920, 1080, 24) } })
    await start(k, { 1: enhance(), 2: videoCard() })
    await done(k)
    expect(JSON.stringify(ofType(k.seen, 'execution_error'))).toContain(TOPAZ_VIDEO_CHANGED)
    expect(k.fal.reqs.size).toBe(0)
    expect(k.upload.mock.calls.length).toBe(0)
    expect([...k.ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })

  it('the video is the caller\'s own (hosted)', async () => {
    const { k } = kitWith({ 'clip.mp4': await mp4(3) })
    const owned: string[] = []
    k.deps.ownership.ownsInput = async (_u, f) => { owned.push(f.filename); return false }
    await expect(start(k, { 1: enhance(), 2: videoCard() })).rejects.toThrow('This workflow uses a file that isn’t one of yours')
    expect(owned).toContain('clip.mp4')
    expect(k.ledger.holds.size).toBe(0)
  })
})

// ── Fix round 1 (review of 6e26cd464; controller rulings 1–5) ───────────────

describe('fix round 1: the factor fits the target\'s box; the band from the longer side', () => {
  const at = (target: string, w: number, h: number, fps = 'original', rate: number | null = 24) =>
    topazVideoPlan(enhance({ target_resolution: target, fps }).inputs, { width: w, height: h, fps: rate }) as TopazVideoPlan

  it('the target boxes (720 × 1280, 1080 × 1920, 2160 × 3840)', () => {
    expect(TOPAZ_VIDEO_TARGET_LONG_SIDES).toEqual({ '720p': 1280, '1080p': 1920, '4k': 3840 })
  })

  it('854 × 480 lands in the band it asks for: 720p → 1280 × 720, 1080p → 1920 × 1080 (not one pixel over)', () => {
    expect(at('720p', 854, 480)).toEqual({ factor: 1.4988, width: 1280, height: 720, targetFps: null, band: '720p', highFps: false })
    expect(at('1080p', 854, 480)).toEqual({ factor: 2.2482, width: 1920, height: 1080, targetFps: null, band: '1080p', highFps: false })
    expect(priceNode('EnhanceVideoNode', enhance({ target_resolution: '720p' }).inputs, { inputSeconds: measured(2, 854, 480, 24), families: ON })).toEqual({ usd: 0.02, credits: 4 })
    expect(priceNode('EnhanceVideoNode', enhance().inputs, { inputSeconds: measured(2, 854, 480, 24), families: ON })).toEqual({ usd: 0.04, credits: 8 })
  })

  it('portrait: fitted by its longer side (720 × 1280 → 1080 × 1920; 1080 × 1920 asking 720p stays as it is), banded by its longer side (Task C)', () => {
    expect(at('1080p', 720, 1280)).toMatchObject({ factor: 1.5, width: 1080, height: 1920, band: '1080p' })
    expect(at('720p', 1080, 1920)).toMatchObject({ factor: 1, width: 1080, height: 1920, band: '1080p' })
    expect(at('4k', 1080, 1920)).toMatchObject({ factor: 2, width: 2160, height: 3840, band: '4k' })
  })

  it('square: never banded under its own height (720 × 720 asking 1080p makes 1080 × 1080: 1080p)', () => {
    expect(at('1080p', 720, 720)).toMatchObject({ factor: 1.5, width: 1080, height: 1080, band: '1080p' })
    expect(at('720p', 540, 540)).toMatchObject({ factor: 1.3333, width: 720, height: 720, band: '720p' })
    expect(topazVideoBand(1000, 1000)).toBe('1080p')
  })

  it('ultra-wide: fitted inside the box by its long side (1680 × 720 asking 1080p → 1920 × 823); 2560 × 1080 asking 4K makes 3840 × 1620, not a refusal', () => {
    expect(at('1080p', 1680, 720)).toMatchObject({ factor: 1.1428, width: 1920, height: 823, band: '1080p' })
    expect(at('4k', 2560, 1080)).toMatchObject({ factor: 1.5, width: 3840, height: 1620, band: '4k' })
    expect(topazVideoTooSmall(480, 100)).toBe('Topaz can make a video at most 4 times larger, and this one is 480 × 100. Choose 1080p or lower.')
  })

  it('the output never passes the target\'s box, and the band is never above the target\'s, over a grid of sizes', () => {
    const rank = { '720p': 0, '1080p': 1, '4k': 2 } as const
    for (const target of Object.keys(TOPAZ_VIDEO_TARGETS)) {
      for (let w = 160; w <= 4096; w += 97) {
        for (let h = 120; h <= 2304; h += 89) {
          const p = topazVideoPlan(enhance({ target_resolution: target }).inputs, { width: w, height: h, fps: 24 })
          if ('refused' in p) continue
          if (p.factor > 1) {
            expect(Math.min(p.width, p.height), `${target} ${w}x${h}`).toBeLessThanOrEqual(TOPAZ_VIDEO_TARGETS[target]!)
            expect(Math.max(p.width, p.height), `${target} ${w}x${h}`).toBeLessThanOrEqual(TOPAZ_VIDEO_TARGET_LONG_SIDES[target]!)
            // Either way round (Task C: fal bands a portrait by its longer side too).
            expect(rank[p.band], `${target} ${w}x${h}`).toBeLessThanOrEqual(rank[target as keyof typeof rank])
          }
        }
      }
    }
  })

  it('the words: a video already above 4K, and (separately) an output that would be', () => {
    expect(TOPAZ_VIDEO_TOO_LARGE).toContain('already larger')
    expect(TOPAZ_VIDEO_OUTPUT_TOO_LARGE).toBe('At this size the upscaled video would be larger than 4K (4096 × 2160). Choose a smaller size.')
    expect(at('4k', 4097, 2000) as unknown).toEqual({ refused: TOPAZ_VIDEO_TOO_LARGE })
  })
})

describe('fix round 1: a length without a size prices at the whole ceiling', () => {
  it('60 s at 4K and 60 fps whatever the length, so it is never below any charge', () => {
    for (const seconds of [0.5, 3, 42, 60]) {
      expect(priceNode('EnhanceVideoNode', enhance().inputs, { inputSeconds: { video: seconds }, families: ON })).toEqual({ usd: 9.6, credits: 1440 })
      expect(topazVideoCalls(enhance().inputs, { video: seconds, videoWidth: 1280 })).toEqual([{ endpoint: TOPAZ_VIDEO_APP, seconds: 60, resolution: '4k/60fps', audio: false }])
    }
  })
})

describe('fix round 1: the engine', () => {
  const run = (k: ReturnType<typeof makeKit>, take: ApiPrompt) =>
    k.engine.startRun({ userId: k.userId, takes: [take], workflow: null, canvasId: null, projectUuid: null, projectName: null })
  const rootWith = async (entries: Record<string, Buffer>) => {
    const root = mkdtempSync(join(tmpdir(), 'topaz-fix1-'))
    for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
    for (const [name, bytes] of Object.entries(entries)) writeFileSync(join(root, 'input', name), bytes)
    return root
  }

  it('resuming a Topaz node whose request was sent before a restart: planned from the recorded measurement, the request and credits kept, one job', async () => {
    const root = await rootWith({ 'clip.mp4': await mp4(3, 1280, 720, 24) })
    const fal = createFakeFal()
    const ledger = createFakeLedger(5000)
    const state = { crashed: false }
    const k1 = makeKit({
      hosted: true, fal, ledger, root, deps: {
        families: () => ON,
        sleep: () => (state.crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))),
      },
    })
    fal.holdNext(1)
    const { runId } = await run(k1, { 1: enhance(), 2: videoCard() })
    await until(() => (fal.submitted()[0]?.polls ?? 0) >= 2)
    state.crashed = true
    await new Promise(r => setTimeout(r, 20))
    // While the server is down the video is replaced (larger, other bytes): the running job is not re-checked.
    writeFileSync(join(root, 'input', 'clip.mp4'), await mp4(9, 1920, 1080, 60))
    const k2 = makeKit({ hosted: true, dir: k1.dir, root, fal, ledger, deps: { families: () => ON } })
    expect(await k2.engine.reattach()).toBe(1)
    fal.release()
    await k2.engine.settled(runId)
    expect(ofType(k2.seen, 'execution_error')).toEqual([])
    expect(fal.submitted()).toHaveLength(1)
    const stored = (await k2.store.get(runId))!
    expect(stored.status).toBe('done')
    expect(stored.takes[0]!.nodes['1']!.payload).toEqual(fal.submitted()[0]!.payload)
    expect(stored.takes[0]!.nodes['1']!.payload).toMatchObject({ upscale_factor: 1.5 })
    // The credits written at submit: 3 s at 1080p ($0.06, 12) + the render credit.
    expect(stored.takes[0]!.nodes['1']!.credits).toBe(12)
    expect([...ledger.holds.values()].map(h => [h.credits, h.state, h.actual])).toEqual([[13, 'settled', 13]])
  })

  // F23 re-review minor 1 (final fix F12): a resumed node whose plan can't be
  // rebuilt at all (here its recorded measurement is gone) cancels the job it
  // sent before the restart, then fails: no provider job is left billing.
  it('resuming a node whose plan can\'t be rebuilt: its sent job is cancelled before it fails; the hold is released', async () => {
    const root = await rootWith({ 'clip.mp4': await mp4(3, 1280, 720, 24) })
    const fal = createFakeFal()
    const ledger = createFakeLedger(5000)
    const state = { crashed: false }
    const k1 = makeKit({
      hosted: true, fal, ledger, root, deps: {
        families: () => ON,
        sleep: () => (state.crashed ? new Promise<void>(() => {}) : new Promise<void>(r => setTimeout(r, 1))),
      },
    })
    fal.holdNext(1)
    const { runId } = await run(k1, { 1: enhance(), 2: videoCard() })
    await until(() => (fal.submitted()[0]?.polls ?? 0) >= 2)
    state.crashed = true
    await new Promise(r => setTimeout(r, 20))
    const saved = (await k1.store.get(runId))!
    delete saved.takes[0]!.measured
    await k1.store.save(saved)
    const k2 = makeKit({ hosted: true, dir: k1.dir, root, fal, ledger, deps: { families: () => ON } })
    expect(await k2.engine.reattach()).toBe(1)
    await k2.engine.settled(runId)
    expect(ofType(k2.seen, 'execution_error')).toHaveLength(1)
    expect(fal.submitted()).toHaveLength(1)
    expect(fal.submitted()[0]!.cancelled).toBe(true)
    expect([...ledger.holds.values()].map(h => h.state)).toEqual(['released'])
  })

  it('the switch turned off after Run: the node is refused before anything is read at its turn or sent; the hold is released', async () => {
    const root = await rootWith({ 'clip.mp4': await mp4(3, 1280, 720, 24) })
    const store = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => true })
    let families: ReadonlySet<RunnerFamily> = ON
    let reads = 0
    const results = { ...store, read: async (f: OutputFile) => { reads++; return store.read(f) } }
    // The switch goes off right after the hold (taken at the Topaz price).
    const ledger = createFakeLedger(5000)
    const hold = ledger.hold
    ledger.hold = (async (...a: Parameters<typeof hold>) => { const res = await hold(...a); families = ALL_BUT; return res }) as typeof hold
    const k = makeKit({ hosted: true, ledger, root, deps: { families: () => families, results } })
    await run(k, { 1: enhance(), 2: videoCard() })
    await until(() => ofType(k.seen, 'execution_error').length + ofType(k.seen, 'execution_success').length >= 1)
    expect(JSON.stringify(ofType(k.seen, 'execution_error'))).toContain(TOPAZ_VIDEO_SWITCHED_OFF)
    expect(reads).toBe(1)
    expect(k.fal.reqs.size).toBe(0)
    expect(k.upload.mock.calls.length).toBe(0)
    expect([...k.ledger.holds.values()].map(h => [h.credits, h.state])).toEqual([[13, 'released']])
    // The shared check (switches.ts, final fix F2): on at the hold, off now; and a leg written before the families were recorded.
    expect(switchedSinceHold(enhance(), ON, ON)).toBeNull()
    expect(switchedSinceHold(enhance(), NO_FAMILIES, ON)).toBe(TOPAZ_VIDEO_SWITCHED_OFF)
    expect(switchedSinceHold(enhance(), ON)).toBeNull()
    expect(switchedSinceHold(enhance(), NO_FAMILIES)).toBe(TOPAZ_VIDEO_SWITCHED_OFF)
    expect(switchedSinceHold({ class_type: 'LipSyncNode', inputs: {} }, NO_FAMILIES)).toBeNull()
  })
})

// ── Task C fix (live check 2026-09-25): fal bands a portrait by its longer side ──
// F23 fix round 2 priced by the dearer of the longer side and the height. The
// portrait live check (360 × 640 → 720 × 1280, fal request
// 01a0da8f-a0d5-7a20-a41e-b242ccd27ffe) billed 2 units for 2 s, the same as
// the landscape one, so the height reading is dropped.

describe('Task C: the band is the longer side\'s, either way round', () => {
  it('portrait: the same band as the landscape of the same size', () => {
    expect(topazVideoBand(1080, 1920)).toBe('1080p')
    expect(topazVideoBand(720, 1280)).toBe('720p')
    expect(topazVideoBand(405, 720)).toBe('720p')
    expect(topazVideoBand(608, 1080)).toBe('720p')
    expect(topazVideoBand(2160, 3840)).toBe('4k')
    for (const [w, h] of [[1280, 720], [1920, 1080], [1680, 720], [2560, 1080], [3840, 2160], [1281, 720]] as const) {
      expect(topazVideoBand(h, w), `${h}x${w}`).toBe(topazVideoBand(w, h))
    }
    // The portrait live check (360 × 640 → 720p): 720 × 1280, 2 s × $0.01 = 4 credits, the same as the landscape.
    const port = { inputSeconds: measured(2, 360, 640, 24), families: ON }
    expect(priceNode('EnhanceVideoNode', enhance({ target_resolution: '720p' }).inputs, port)).toEqual({ usd: 0.02, credits: 4 })
    expect(nodeCreditEstimate('EnhanceVideoNode', enhance({ target_resolution: '720p' }).inputs, port)).toBe(5)
  })

  it('landscape unchanged; the live check is still 4 + 1 credits', () => {
    for (const [w, h, band] of [[1280, 720, '720p'], [1920, 1080, '1080p'], [3840, 2160, '4k'], [1680, 720, '1080p'], [2560, 1080, '4k']] as const) {
      expect(topazVideoBand(w, h), `${w}x${h}`).toBe(band)
    }
    const p = priceNode('EnhanceVideoNode', enhance({ target_resolution: '720p' }).inputs, { inputSeconds: measured(2, 640, 360, 24), families: ON })
    expect(p).toEqual({ usd: 0.02, credits: 4 })
    expect(nodeCreditEstimate('EnhanceVideoNode', enhance({ target_resolution: '720p' }).inputs, { inputSeconds: measured(2, 640, 360, 24), families: ON })).toBe(5)
  })

  it('square: its height\'s band (720² → 720p, 1080² → 1080p, 2160² → 4k)', () => {
    expect(topazVideoBand(720, 720)).toBe('720p')
    expect(topazVideoBand(1080, 1080)).toBe('1080p')
    expect(topazVideoBand(2160, 2160)).toBe('4k')
  })
})

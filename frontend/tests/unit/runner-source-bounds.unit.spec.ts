/**
 * Step 3, R11.8: every source has a bound (ruling (k): an unknown one is held
 * at the cap, never left to the engine).
 *
 *  - Each maker's bound is at least its real output: every R2 effect's
 *    picture against Python's own outputs over the effects fixtures (the
 *    effect sized from its first picture and settings, the generators from
 *    theirs), R7's classes and the cards; music, speech and a cloned voice
 *    from their settings, against what was measured live (music) and the
 *    model's own reading (speech's pause markers).
 *  - What can't be known is held at the cap: a picture count, a picture's
 *    size for Upscale (2×), a clip (a paid video model's), Slow motion (AI)'s
 *    clip; the node's turn refuses past the cap, in the start's words.
 *  - Music, speech and a cloned voice now reach a sound effect, Create
 *    video, Whisper, Vocal separator and Kling's lip-sync, held on their
 *    bound, never the engine; a bound from a maker's settings is never a
 *    fact a refusal rests on.
 *  - R7.7's parked cap + 1: a sound is refused past a whole-sound node's
 *    ceiling at its bound, plus a second only where a header source is in it.
 *
 * No paid calls: the providers are fakes; keys unset.
 */
import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, LOCAL_MODEL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { EFFECT_MAX_PICTURE_PIXELS, effectSchemaOf } from '#shared/runner/effects'
import { MEDIA_CAPS } from '#shared/runner/media'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import {
  BG_REMOVE_CLASS, FRAME_INTERP_AI_CLASS, LOCAL_MODEL_MAX_FRAMES, OBJECT_REMOVE_CLASS, SLOW_MOTION_AI_MAX_FRAMES, SUBJECT_MASK_CLASS,
  UPSCALE_2X_CLASS, UPSCALE_2X_TILED_MAX_PIXELS, UPSCALE_2X_TILED_MAX_TILES, WHISPER_CLASS, moreThanHeldWords, overCapWords,
} from '#shared/runner/localModels'
import {
  CLONE_RATE_BOUND, MUSIC_RATE, SPEECH_PAUSE_MAX_SECONDS, SPEECH_RATE, cloneSecondsBound, musicChannelsBound, musicSecondsBound,
  speechPauseSeconds, speechSecondsBound, speechSpeedOf,
} from '#shared/runner/sourceBounds'
import { SPEECH_MAX_CHARS } from '#shared/runner/audioGen'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { graphInputSizes, linkPictureSize, pictureSize } from '~~/server/utils/graphInputPixels'
import { localModelStartProblems, soundBoundOf } from '~~/server/runner/localModelStart'
import { PAID_VIDEO_FPS_CEILING, VEO_FPS, frameShapes, paidVideoClipBound, videoSourceShapeOf } from '~~/server/runner/video/shapes'
import { rifePricedPixels } from '#shared/runner/localModels'
import { soundEffectRaises, soundEffectStartProblems, soundShapes, soundSourceShapeOf } from '~~/server/runner/video/soundShapes'
import { pythonWavBytesBound, KLING_LIPSYNC_MAX_SOUND_BYTES } from '#shared/runner/lipSyncEngines'
import { makeKit } from './__runner__/kit'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'
import { pictureRgb } from '~~/server/runner/generators/repairTiles'

const FIXTURES = join(__dirname, 'fixtures')
const EVERY = new Set<RunnerFamily>([...ALL_RUNNER_FAMILIES, ...LOCAL_MODEL_FAMILIES])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

// ── Pictures: every R2 effect against Python's own outputs ───────────────────

interface FixtureCase {
  class_type: string
  name: string
  inputs: Record<string, { files: string[]; source: string }>
  widgets: Record<string, unknown>
  outputs?: { kind: string; items: { w: number; h: number }[] }[]
  error?: unknown
}

const FAMILIES = ['tone', 'blur', 'cells', 'warp', 'mask', 'noise'] as const

describe('every R2 effect\'s picture bound is at least Python\'s output, over the effects fixtures', () => {
  for (const family of FAMILIES) {
    it(`effects-${family}`, async () => {
      const fx = JSON.parse(readFileSync(join(FIXTURES, `runner-effects-${family}.json`), 'utf8')) as { assets: Record<string, string>; cases: FixtureCase[] }
      const sizes = new Map<string, Awaited<ReturnType<typeof pictureSize>>>()
      const reader = async (value: string) => {
        if (!sizes.has(value)) sizes.set(value, await pictureSize(new Uint8Array(Buffer.from(fx.assets[value]!, 'base64'))))
        return sizes.get(value)!
      }
      let checked = 0
      let exact = 0
      for (const c of fx.cases) {
        if (c.error || !c.outputs) continue
        const schema = effectSchemaOf(c.class_type)
        if (!schema) continue
        const outs = c.outputs.filter(o => o.kind === 'image').flatMap(o => o.items)
        if (!outs.length) continue
        // Each picture input from a loader of its first file (Python's batch is one size); masks are not pictures here.
        const prompt: ApiPrompt = { fx: { class_type: c.class_type, inputs: { ...c.widgets } } }
        for (const [name, v] of Object.entries(c.inputs)) {
          if (!schema.images.some(i => i.name === name)) continue
          // Python's 1×1 blank (a wire that brought no picture): a 1 × 1 picture.
          prompt[`in_${name}`] = v.files.length
            ? { class_type: 'LoadImage', inputs: { image: v.files[0] } }
            : { class_type: 'EmptyImage', inputs: { width: 1, height: 1, batch_size: 1, color: 0 } }
          prompt.fx!.inputs[name] = [`in_${name}`, 0]
        }
        const bound = await linkPictureSize(prompt, ['fx', 0], reader)
        const most = Math.max(...outs.map(o => o.w * o.h))
        if (!bound) {
          // Only an effect whose size rests on a mask alone is left unsized here (held at the cap where it is read).
          expect(schema.images.some(i => i.name in c.inputs), `${c.name}: unsized`).toBe(false)
          continue
        }
        expect(bound.px, c.name).toBeGreaterThanOrEqual(most)
        // Cheap stays exact: an exact bound is Python's own size.
        if (bound.exact) {
          expect(outs.every(o => o.w * o.h === bound.px), `${c.name}: exact`).toBe(true)
          exact++
        }
        checked++
      }
      expect(checked).toBeGreaterThan(50)
      expect(exact).toBeGreaterThan(checked / 2)
    }, 120_000)
  }

  it('an effect whose picture can\'t be sized is at most the effects\' largest (the runner refuses past it)', async () => {
    const p: ApiPrompt = {
      g: { class_type: 'GenerateImageNode', inputs: { prompt: ['t', 0] } },
      b: { class_type: 'Blur', inputs: { image: ['x', 0], radius: 2 } },
    }
    expect(await linkPictureSize(p, ['b', 0], async () => null)).toEqual({ px: EFFECT_MAX_PICTURE_PIXELS, exact: false })
    // Painter with no base: its width × height; a generator: its own.
    expect(await linkPictureSize({ p: { class_type: 'Painter', inputs: { mask: '', width: 640, height: 480, bg_color: '#000000' } } }, ['p', 0])).toEqual({ px: 640 * 480, exact: true })
    expect(await linkPictureSize({ g: { class_type: 'PerlinNoise', inputs: { width: 300, height: 200, scale: 64, octaves: 4, seed: 0 } } }, ['g', 0])).toEqual({ px: 60_000, exact: true })
  })
})

// ── Pictures: R7's classes and the cards ─────────────────────────────────────

describe('R7\'s classes and the cards declare their picture\'s size', () => {
  const file = async (w: number, h: number) => ({ pixels: w * h, width: w, height: h })
  const load: ApiPrompt = { l: { class_type: 'LoadImage', inputs: { image: 'a.png' } } }

  it('a cut-out, a fill, a subject and a still picture handed on are their picture\'s size; Upscale (2×) twice each side', async () => {
    for (const cls of [BG_REMOVE_CLASS, OBJECT_REMOVE_CLASS, SUBJECT_MASK_CLASS, FRAME_INTERP_AI_CLASS]) {
      expect(await linkPictureSize({ ...load, n: { class_type: cls, inputs: { frames: ['l', 0] } } }, ['n', 0], () => file(100, 60)), cls).toEqual({ px: 6000, exact: true })
    }
    expect(await linkPictureSize({ ...load, n: { class_type: UPSCALE_2X_CLASS, inputs: { frames: ['l', 0] } } }, ['n', 0], () => file(100, 60))).toEqual({ px: 24_000, exact: true })
    // A chain: a cut-out, then blurred, then upscaled.
    const chain: ApiPrompt = {
      ...load, c: { class_type: BG_REMOVE_CLASS, inputs: { frames: ['l', 0] } },
      b: { class_type: 'Blur', inputs: { image: ['c', 0], radius: 3, mode: 'gaussian' } },
      u: { class_type: UPSCALE_2X_CLASS, inputs: { frames: ['b', 0] } },
    }
    expect(await linkPictureSize(chain, ['u', 0], () => file(100, 60))).toEqual({ px: 24_000, exact: true })
  })

  it('the bake cards: Text mask by its baked file (over a source, the source\'s size); the Shader effect by its picture or its aspect', async () => {
    const params = JSON.stringify({ rendered: 'text_mask_1.png [input]' })
    expect(await linkPictureSize({ t: { class_type: 'TextMask', inputs: { params } } }, ['t', 0], () => file(512, 256))).toEqual({ px: 512 * 256, exact: true })
    expect(await linkPictureSize({ ...load, t: { class_type: 'TextMask', inputs: { params, source: ['l', 0] } } }, ['t', 0], async v => (v === 'a.png' ? file(30, 20) : file(512, 256)))).toEqual({ px: 600, exact: true })
    const shader = await linkPictureSize({ s: { class_type: 'ShaderEffect', inputs: { effect: 'x', params: '{}', time: 0, duration: 0, fps: 24, seed: 0, resolution: 1024, aspect: '16:9' } } }, ['s', 0])
    expect(shader?.exact).toBe(true)
    expect(shader!.px).toBeLessThanOrEqual(1024 * 1024)
    expect(await linkPictureSize({ ...load, s: { class_type: 'ShaderEffect', inputs: { image: ['l', 0], resolution: 1024, aspect: '1:1' } } }, ['s', 0], () => file(40, 30))).toEqual({ px: 1200, exact: true })
  })
})

// ── Unknown pictures and clips: held at the cap ──────────────────────────────

describe('what can\'t be known before the run is held at the cap, never left to the engine (ruling (k))', () => {
  const noShapes = async () => new Map()

  it('a picture count that can\'t be known: held at the frame cap; the turn\'s words past it name the cap', async () => {
    const p: ApiPrompt = { s: { class_type: 'SmartLayout', inputs: {} }, n: { class_type: BG_REMOVE_CLASS, inputs: { frames: ['s', 0], output: 'transparent', edge_softness: 0 } } }
    for (const hosted of [true, false]) {
      const got = await localModelStartProblems(p, EVERY, { hosted, shapes: noShapes })
      const cap = LOCAL_MODEL_MAX_FRAMES[hosted ? 'hosted' : 'local']
      expect(got).toMatchObject({ counts: { n: cap }, problem: null })
      expect(moreThanHeldWords(BG_REMOVE_CLASS, cap + 1, hosted)).toBe(overCapWords(BG_REMOVE_CLASS, cap))
    }
  })

  it('Upscale (2×) on a picture whose size can\'t be known: held at the largest tiled, its most tiles', async () => {
    const p: ApiPrompt = { g: { class_type: 'GenerateImageNode', inputs: { prompt: ['t', 0], model: ['m', 0] } }, n: { class_type: UPSCALE_2X_CLASS, inputs: { frames: ['g', 0], tile_size: 512 } } }
    const got = await localModelStartProblems(p, EVERY, { hosted: true, shapes: noShapes })
    expect(got).toMatchObject({ problem: null, counts: { n: 1 }, pictures: { n: UPSCALE_2X_TILED_MAX_PIXELS }, tiles: { n: UPSCALE_2X_TILED_MAX_TILES } })
  })

  it('a paid video model\'s clip (through its Video card) is bounded by its own settings (R11.9a fix round 1, I1); Slow motion (AI) on it within its cap', async () => {
    const p: ApiPrompt = {
      v: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'a boat', aspect_ratio: '16:9', duration: '8', seed: 0 } },
      c: { class_type: 'Video', inputs: { source: ['v', 0], file: 'stale.mp4', export: false } },
      g: { class_type: 'GetVideoComponents', inputs: { video: ['c', 0] } },
      n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: 2 } },
      b: { class_type: BG_REMOVE_CLASS, inputs: { frames: ['g', 0], output: 'transparent', edge_softness: 0 } },
    }
    const access = { exists: async () => { throw new Error('not read') } } as never
    for (const hosted of [true, false]) {
      const caps = hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local
      const shapes = await frameShapes(p, EVERY, videoSourceShapeOf({ prompt: p, access, userId: null, hosted }))
      // The card's own (stale) file is never read: a paid video always brings its own. Veo 3.1 at 8 s, 720p (its
      // default): at most 8 × 24 fps + 1 frames of 1280 × 720 (fix round 2, N2: Veo's real frame), a bound.
      const g = shapes.get('g:0')!
      expect(g).toMatchObject({ count: 8 * VEO_FPS + 1, w: 1280, h: 720, exact: false })
      expect(g.capped).toBeUndefined()
      expect(g.count).toBeLessThanOrEqual(caps.batchFrames)
      const got = await localModelStartProblems(p, EVERY, { hosted, shapes: async () => shapes })
      expect(got.problem).toBeNull()
      expect(got.counts).toMatchObject({ b: Math.min(g.count, LOCAL_MODEL_MAX_FRAMES[hosted ? 'hosted' : 'local']) })
      expect(got.counts.n).toBeLessThanOrEqual(SLOW_MOTION_AI_MAX_FRAMES[hosted ? 'hosted' : 'local'])
      expect(got.sizes?.n).toMatchObject({ w: 1280, h: 720 })
      // Its sound stays unknown (fix round 1): its readers keep their pre-task routes.
      const sounds = await soundShapes(p, EVERY, soundSourceShapeOf({ prompt: p, access, userId: null, hosted }))
      expect(sounds.has('g:1')).toBe(false)
    }
    // A wired length takes the model's longest (8 s); a wired model, or a model the settings table doesn't bound,
    // is held at the place's caps, as before.
    expect(paidVideoClipBound({ ...p, v: { ...p.v!, inputs: { ...p.v!.inputs, duration: ['x', 0] } } }, ['c', 0])).toMatchObject({ count: 8 * VEO_FPS + 1 })
    expect(paidVideoClipBound({ ...p, v: { ...p.v!, inputs: { ...p.v!.inputs, model: ['x', 0] } } }, ['c', 0])).toBeNull()
    // Fix round 2 (N2): never the typed aspect. Veo renders 16:9 or 9:16 whatever is typed (or a first frame's shape).
    for (const aspect_ratio of [['x', 0], '1:1', '21:9', '9:16']) {
      expect(paidVideoClipBound({ ...p, v: { ...p.v!, inputs: { ...p.v!.inputs, aspect_ratio } } }, ['c', 0]), JSON.stringify(aspect_ratio)).toMatchObject({ w: 1280, h: 720 })
    }
    expect(paidVideoClipBound({ ...p, v: { ...p.v!, inputs: { ...p.v!.inputs, model_options: JSON.stringify({ resolution: '1080p' }) } } }, ['c', 0])).toMatchObject({ w: 1920, h: 1080 })
  })

  it('fix round 2 (N2): Veo 1:1 → Slow motion (AI): the hold covers the 1280 × 720 clip Veo really renders, either way round', async () => {
    const p: ApiPrompt = {
      v: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'a boat', aspect_ratio: '1:1', duration: '8', seed: 0 } },
      c: { class_type: 'Video', inputs: { source: ['v', 0], file: '', export: false } },
      g: { class_type: 'GetVideoComponents', inputs: { video: ['c', 0] } },
      n: { class_type: FRAME_INTERP_AI_CLASS, inputs: { frames: ['g', 0], multiplier: 2 } },
    }
    const access = { exists: async () => { throw new Error('not read') } } as never
    for (const hosted of [true, false]) {
      const shapes = await frameShapes(p, EVERY, videoSourceShapeOf({ prompt: p, access, userId: null, hosted }))
      const got = await localModelStartProblems(p, EVERY, { hosted, shapes: async () => shapes })
      expect(got.problem).toBeNull()
      const held = got.sizes!.n!
      // The turn's own check (generators/localModels.ts: rifePricedPixels(real) > rifePricedPixels(held) throws
      // "more than held" after Veo is paid): what Veo delivers, landscape or portrait, never passes it.
      for (const [w, h] of [[1280, 720], [720, 1280]] as const) expect(rifePricedPixels(w, h)).toBeLessThanOrEqual(rifePricedPixels(held.w, held.h))
      expect(8 * VEO_FPS).toBeLessThanOrEqual(got.counts.n!)
    }
  })

  it('fix round 2 (N2, I1 gap): every other model bounded by its largest frame, never the typed aspect; models with no resolution by their documented largest', () => {
    const clip = (model: string, inputs: Record<string, unknown> = {}): ApiPrompt => ({
      v: { class_type: 'GenerateVideoNode', inputs: { model, prompt: 'a boat', aspect_ratio: '1:1', duration: '5', seed: 0, ...inputs } },
      c: { class_type: 'Video', inputs: { source: ['v', 0], file: '', export: false } },
    })
    // Hailuo 2.3 at 768p renders 1366 × 768 (or the picture's shape): bounded as 768 × 21/9 = 1792 square, whatever is typed.
    expect(paidVideoClipBound(clip('hailuo-2.3', { duration: '6' }), ['c', 0])).toMatchObject({ w: 1792, h: 1792, count: 6 * PAID_VIDEO_FPS_CEILING + 1 })
    expect(1792 * 1792).toBeGreaterThanOrEqual(1366 * 768)
    // Seedance 2.0 at 1080p (1920 × 1088 at 16:9, 2176 × 928 at 21:9 on its table): 2520 square covers both.
    expect(paidVideoClipBound(clip('seedance-2.0', { model_options: JSON.stringify({ resolution: '1080p' }) }), ['c', 0])).toMatchObject({ w: 2520, h: 2520 })
    // No resolution setting: Runway Gen-4.5 (1584 at its widest), Kling 2.5 Turbo Pro (1080p: 1920), LTX-Video (1280, 24 fps, 5 s).
    expect(paidVideoClipBound(clip('runway-gen-4.5'), ['c', 0])).toMatchObject({ w: 1584, h: 1584, count: 5 * PAID_VIDEO_FPS_CEILING + 1 })
    expect(paidVideoClipBound(clip('kling-v2.5-turbo-pro'), ['c', 0])).toMatchObject({ w: 1920, h: 1920 })
    expect(paidVideoClipBound(clip('ltx-video'), ['c', 0])).toMatchObject({ w: 1280, h: 1280, count: 5 * 24 + 1 })
  })
})

// ── Sounds: music, speech, a cloned voice ────────────────────────────────────

describe('music, speech and a cloned voice are bounded by their settings', () => {
  it('music: the duration asked, plus a second, at MusicGen\'s 32 kHz; at least what the live check measured (1 s and 8 s)', () => {
    for (const asked of [1, 8, 30]) {
      expect(musicSecondsBound(asked)).toBe(asked + 1)
      expect(musicSecondsBound(asked)).toBeGreaterThanOrEqual(asked)
    }
    expect(musicSecondsBound(['x', 0])).toBe(31)
    expect(musicChannelsBound('stereo-melody-large')).toBe(2)
    expect(musicChannelsBound('large')).toBe(1)
    expect(MUSIC_RATE).toBe(32_000)
  })

  it('speech: every character at one a second (speed 1, slower below it), every pause marker, and a second; a text made in the run, its longest', () => {
    // The live check's 20 characters: at most 21 s at speed 1 (live length check owed: R11.8's report).
    expect(speechSecondsBound('x'.repeat(20), 1)).toBe(21)
    expect(speechSecondsBound('x'.repeat(20), 0.5)).toBe(41)
    expect(speechSecondsBound('x'.repeat(20), 2)).toBe(11)
    expect(speechSpeedOf(undefined)).toBe(1)
    expect(speechSpeedOf(['s', 0])).toBe(0.5)
    // Pause markers, each at most the model's 99.99 s.
    expect(speechPauseSeconds('Hi <#2.5#> there <# 1 #> and <#500#>')).toBeCloseTo(2.5 + 1 + SPEECH_PAUSE_MAX_SECONDS, 9)
    expect(speechSecondsBound('a<#3#>b', 1)).toBeCloseTo(7 + 3 + 1, 9)
    // Made in the run: the longest text, every character a full pause at its densest.
    expect(speechSecondsBound(null, 1)).toBeGreaterThanOrEqual(SPEECH_MAX_CHARS * 2)
    expect(speechSecondsBound(null, 1)).toBeGreaterThanOrEqual(Math.floor(SPEECH_MAX_CHARS / 6) * SPEECH_PAUSE_MAX_SECONDS)
    expect(SPEECH_RATE).toBe(32_000)
  })

  it('a cloned voice: its input\'s first 60 s, plus a second', () => {
    expect(cloneSecondsBound(10)).toBe(11)
    expect(cloneSecondsBound(600)).toBe(61)
    expect(cloneSecondsBound(null)).toBe(61)
  })

  it('the sound start pass shapes them `upTo`, through Gates and Audio cards; a text card\'s text is read as typed', async () => {
    const p: ApiPrompt = {
      m: { class_type: 'GenerateMusicNode', inputs: { prompt: 'x', duration: 8, model_version: 'stereo-large' } },
      t: { class_type: 'PrimitiveStringMultiline', inputs: { value: 'Hello there.' } },
      sp: { class_type: 'GenerateSpeechNode', inputs: { text: ['t', 0], speed: 1 } },
      l: { class_type: 'LoadAudio', inputs: { audio: 'a.wav' } },
      cl: { class_type: 'CloneSingingVoiceNode', inputs: { audio: ['l', 0] } },
      a: { class_type: 'Audio', inputs: { source: ['sp', 0], audio: '' } },
    }
    const shapes = await soundShapes(p, EVERY, async () => ({ rate: 8000, channels: 1, samples: 8000 * 11, exact: false, header: true }))
    expect(shapes.get('m:0')).toEqual({ rate: MUSIC_RATE, channels: 2, samples: 9 * MUSIC_RATE, exact: false, upTo: true })
    expect(shapes.get('a:0')).toEqual({ rate: SPEECH_RATE, channels: 1, samples: 13 * SPEECH_RATE, exact: false, upTo: true })
    expect(shapes.get('cl:0')).toEqual({ rate: CLONE_RATE_BOUND, channels: 2, samples: 12 * CLONE_RATE_BOUND, exact: false, upTo: true })
    expect(soundBoundOf(p, ['a', 0], shapes)).toMatchObject({ seconds: 13 + 1e-3, upTo: true })
    expect(soundBoundOf(p, ['l', 0], shapes)).toMatchObject({ seconds: 11 + 1e-3, header: true })
  })

  it('fix round 1 (I2): a maker\'s bound past a sound effect\'s limits goes to the engine before the hold, as before the task; one within them is taken', async () => {
    const speech: ApiPrompt = {
      sp: { class_type: 'GenerateSpeechNode', inputs: { text: ['x', 0] } },
      e: { class_type: 'SplitAudioChannels', inputs: { audio: ['sp', 0] } },
      s: { class_type: 'SaveAudio', inputs: { audio: ['e', 0], filename_prefix: 'audio/ComfyUI' } },
    }
    const shapes = await soundShapes(speech, EVERY, async () => null)
    // Hours of speech by its bound: past hosted's effect limits, the engine (never the maker charged, then refused).
    expect(shapes.get('sp:0')!.samples).toBeGreaterThan(MEDIA_CAPS.hosted.soundSamples)
    expect(soundEffectStartProblems(speech, EVERY, { hosted: true, sounds: shapes })).toMatchObject({ engine: true, nodeId: 'e' })
    // A short typed text: within them, taken.
    const short: ApiPrompt = { ...speech, sp: { class_type: 'GenerateSpeechNode', inputs: { text: 'Hello there.' } } }
    expect(soundEffectStartProblems(short, EVERY, { hosted: true, sounds: await soundShapes(short, EVERY, async () => null) })).toBeNull()
    // Mono speech into Split: Python raises, but on a bound that is the turn's to say (L1, parked).
    expect(soundEffectRaises('SplitAudioChannels', {}, [shapes.get('sp:0')!])).toBeNull()
    expect(soundEffectRaises('SplitAudioChannels', {}, [{ rate: 32000, channels: 1, samples: 32000, exact: false }])).not.toBeNull()
    // Kling's 5 MB on its WAV: music's 31 s at 32 kHz stereo is under it.
    expect(pythonWavBytesBound({ rate: MUSIC_RATE, channels: 2, samples: 31 * MUSIC_RATE, exact: false })).toBeLessThan(KLING_LIPSYNC_MAX_SOUND_BYTES)
  })

  it('music, speech and a cloned voice reach a sound effect, Create video, Whisper and Vocal separator once their families are on', () => {
    const music = { class_type: 'GenerateMusicNode', inputs: { model: 'MusicGen', prompt: 'calm piano', duration: 8, model_version: 'stereo-large', temperature: 1, top_p: 0, seed: 0 } }
    const fade: ApiPrompt = {
      m: music,
      f: { class_type: 'AudioFade', inputs: { audio: ['m', 0], fade_in: 0.5, fade_out: 0.5, curve: 'linear' } },
      s: { class_type: 'SaveAudio', inputs: { audio: ['f', 0], filename_prefix: 'audio/ComfyUI' } },
    }
    expect(runnerTakesWorkflow(fade, EVERY)).toBe(true)
    // With the sound effects off it stays with the engine, as before (switching on never makes a working graph fail).
    const noEffects = new Set([...EVERY].filter(f => f !== 'sound-effects'))
    expect(runnerTakesWorkflow(fade, noEffects)).toBe(false)
    const whisper: ApiPrompt = {
      m: music,
      w: { class_type: WHISPER_CLASS, inputs: { audio: ['m', 0], model_size: 'large-v3', language: 'auto', fps: 30 } },
      t: { class_type: 'Text', inputs: { source: ['w', 0], text: '' } },
    }
    expect(runnerTakesWorkflow(whisper, EVERY)).toBe(runnerTakesWorkflow({ ...whisper, m: { class_type: 'LoadAudio', inputs: { audio: 'a.wav' } } }, EVERY))
  })
})

// ── In the engine: no maker sends the workflow to the engine for want of a size ──

describe('in the engine (hosted, fake providers): music, speech and a cloned voice into a sound effect are held, never left', () => {
  const save = (from: string) => ({ class_type: 'SaveAudio', inputs: { audio: [from, 0], filename_prefix: 'audio/ComfyUI' } })
  const cases: Record<string, ApiPrompt> = {
    'music → Fade': {
      m: { class_type: 'GenerateMusicNode', inputs: { model: 'MusicGen', prompt: 'calm piano', duration: 8, model_version: 'stereo-large', temperature: 1, top_p: 0, seed: 0 } },
      f: { class_type: 'AudioFade', inputs: { audio: ['m', 0], fade_in: 0.5, fade_out: 0.5, curve: 'linear' } }, s: save('f'),
    },
    'speech → Adjust volume': {
      sp: { class_type: 'GenerateSpeechNode', inputs: { model: 'MiniMax Speech-02 HD', text: 'Hello there, this is a test.', voice_id: 'Wise_Woman', emotion: 'auto', speed: 1, volume: 1, pitch: 0, language_boost: 'auto' } },
      v: { class_type: 'AudioAdjustVolume', inputs: { audio: ['sp', 0], volume: 2 } }, s: save('v'),
    },
  }
  for (const [name, p] of Object.entries(cases)) {
    it(name, async () => {
      const k = makeKit({ hosted: true, deps: { families: () => EVERY } })
      k.replicate.holdNext(1)
      const started = await k.engine.startRun({ userId: k.userId, takes: [p], ...START }).catch(e => e)
      expect(started?.data?.reason, `${name}: ${started?.message ?? ''}`).not.toBe(RUNNER_NOT_ELIGIBLE)
      expect(started).toHaveProperty('runId')
      expect(k.ledger.hold).toHaveBeenCalledTimes(1)
      await k.engine.stop(k.userId)
      await k.engine.settled(started.runId)
    }, 60_000)
  }
})

// ── R7.7's parked cap + 1 ────────────────────────────────────────────────────

describe('R7.7\'s parked cap + 1: past a whole-sound node\'s ceiling at its bound, a second more only with a header source', () => {
  it('soundBoundOf says which: a header source carries `header`, an exact chain and a maker\'s settings do not', async () => {
    const p: ApiPrompt = {
      e: { class_type: 'EmptyAudio', inputs: { duration: 10, sample_rate: 44100, channels: 2 } },
      l: { class_type: 'LoadAudio', inputs: { audio: 'a.wav' } },
      c: { class_type: 'AudioConcat', inputs: { audio1: ['e', 0], audio2: ['l', 0], direction: 'after' } },
      m: { class_type: 'GenerateMusicNode', inputs: { prompt: 'x', duration: 8 } },
      c2: { class_type: 'AudioConcat', inputs: { audio1: ['e', 0], audio2: ['m', 0], direction: 'after' } },
    }
    const shapes = await soundShapes(p, EVERY, async () => ({ rate: 44100, channels: 2, samples: 44100 * 3, exact: false, header: true }))
    expect(soundBoundOf(p, ['e', 0], shapes)).toEqual({ seconds: 10 + 1e-3, exact: true })
    expect(soundBoundOf(p, ['c', 0], shapes)).toMatchObject({ exact: false, header: true })
    expect(soundBoundOf(p, ['c', 0], shapes)!.upTo).toBeUndefined()
    expect(soundBoundOf(p, ['c2', 0], shapes)).toMatchObject({ exact: false, upTo: true })
    expect(soundBoundOf(p, ['c2', 0], shapes)!.header).toBeUndefined()
  })

  it('in the engine (hosted): an exact chain half a second past Whisper\'s ceiling is refused plainly before the hold (no header second to allow it)', async () => {
    const k = makeKit({ hosted: true, deps: { families: () => EVERY } })
    const ceiling = 3 * 60 * 60
    const p = (seconds: number): ApiPrompt => ({
      e: { class_type: 'EmptyAudio', inputs: { duration: seconds, sample_rate: 8000, channels: 1 } },
      w: { class_type: WHISPER_CLASS, inputs: { audio: ['e', 0], model_size: 'large-v3', language: 'auto', fps: 30 } },
      t: { class_type: 'Text', inputs: { source: ['w', 0], text: '' } },
    })
    expect(runnerTakesWorkflow(p(ceiling + 0.5), EVERY)).toBe(true)
    const err = await k.engine.startRun({ userId: k.userId, takes: [p(ceiling + 0.5)], ...START }).catch(e => e)
    expect(err?.message).toMatch(/too long to transcribe/)
    expect(err?.data?.reason).not.toBe(RUNNER_NOT_ELIGIBLE)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  }, 60_000)
})


// ── R11.6 re-review: Upscale on Real-ESRGAN with a picture sharp can't read ──

describe('R3.5\'s Upscale on Real-ESRGAN: a picture whose header sharp can\'t read keeps its one untouched call (R11.6 re-review)', () => {
  it('pictureRgb answers null (no tiles) rather than failing the node', async () => {
    const ctx = { prompt: { u: { class_type: 'UpscaleImageNode', inputs: {} } }, nodeId: 'u', readFile: async () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) } as never
    await expect(pictureRgb(ctx, { filename: 'odd.bin', subfolder: '', type: 'input' }, null)).resolves.toBeNull()
  })
})

// ── Fix round 1 (I1): a wired size setting is never exact ────────────────────

describe('fix round 1 (I1): an effect\'s wired size setting is only a bound, never exact, never 0 pixels', () => {
  const load: ApiPrompt = {
    l: { class_type: 'LoadImage', inputs: { image: 'big.png' } },
    k: { class_type: 'PrimitiveFloat', inputs: { value: 4 } },
  }
  const file = async () => ({ pixels: 3000 * 2000, width: 3000, height: 2000 })

  it('the reviewer\'s probe: LoadImage 3000 × 2000 → Resize (scale wired to 4) → Upscale: the 96 MP bound, refused by the hosted gate', async () => {
    const p: ApiPrompt = {
      ...load,
      r: { class_type: 'ResizeImage', inputs: { image: ['l', 0], scale: ['k', 0], mode: 'bilinear' } },
      u: { class_type: 'UpscaleImageNode', inputs: { image: ['r', 0], model: 'Real-ESRGAN', scale_factor: 2 } },
    }
    expect(await linkPictureSize(p, ['r', 0], file)).toEqual({ px: 12_000 * 8000, exact: false })
    const gate = await graphInputSizes(p, file)
    expect(gate.pixels.u).toBeUndefined()
    expect(gate.problems.map(x => x.nodeId)).toEqual(['u'])
  })

  it('Kuwahara\'s wired radius, Crop\'s wired sides and Film grain\'s wired size: bounded, not exact', async () => {
    for (const fx of [
      { class_type: 'Kuwahara', inputs: { image: ['l', 0], radius: ['k', 0] } },
      { class_type: 'CropImage', inputs: { image: ['l', 0], left: ['k', 0], right: 0, top: 0, bottom: 0 } },
      { class_type: 'FilmGrain', inputs: { image: ['l', 0], amount: 0.2, size: ['k', 0], seed: 1 } },
    ]) {
      const got = await linkPictureSize({ ...load, f: fx }, ['f', 0], file)
      expect(got?.exact, fx.class_type).toBe(false)
      expect(got!.px, fx.class_type).toBeGreaterThanOrEqual(3001 * 2001)
    }
    // A wired setting that doesn't change the size (Blur's radius) keeps the picture's exact size.
    expect(await linkPictureSize({ ...load, f: { class_type: 'Blur', inputs: { image: ['l', 0], radius: ['k', 0] } } }, ['f', 0], file)).toEqual({ px: 6_000_000, exact: true })
  })
})

// ── Fix round 1 (I2): the named graphs, in the engine ────────────────────────

describe('fix round 1 (I2), R11.9a: a maker\'s bound past a length-capped reader is refused plainly before the hold, naming the setting to shorten; nothing charged (hosted)', () => {
  const speech = (chars: number) => ({ class_type: 'GenerateSpeechNode', inputs: { model: 'MiniMax Speech-02 HD', text: 'x'.repeat(chars), voice_id: 'Wise_Woman', emotion: 'auto', speed: 1, volume: 1, pitch: 0, language_boost: 'auto' } })
  const graphs: Record<string, ApiPrompt> = {
    'long speech → Fade → Save audio': {
      sp: speech(2500),
      f: { class_type: 'AudioFade', inputs: { audio: ['sp', 0], fade_in: 0.5, fade_out: 0.5, curve: 'linear' } },
      s: { class_type: 'SaveAudio', inputs: { audio: ['f', 0], filename_prefix: 'audio/ComfyUI' } },
    },
    'long speech → Vocal separator (wired directly)': {
      sp: speech(2500),
      v: { class_type: 'VocalSeparator', inputs: { audio: ['sp', 0], model: 'htdemucs', shifts: 1 } },
      a: { class_type: 'SaveAudio', inputs: { audio: ['v', 0], filename_prefix: 'audio/ComfyUI' } },
    },
    'very long speech → Create video': {
      l: { class_type: 'LoadVideo', inputs: { file: 'a.mp4' } },
      g: { class_type: 'GetVideoComponents', inputs: { video: ['l', 0] } },
      sp: speech(9000),
      c: { class_type: 'CreateVideo', inputs: { images: ['g', 0], fps: 24, audio: ['sp', 0] } },
      s: { class_type: 'SaveVideo', inputs: { video: ['c', 0], filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } },
    },
  }
  // The node whose cap the maker's bound passes (the engine's route names it).
  const at: Record<string, string> = { 'long speech → Fade → Save audio': 'f', 'long speech → Vocal separator (wired directly)': 'v', 'very long speech → Create video': 'c' }
  for (const [name, p] of Object.entries(graphs)) {
    it(name, async () => {
      await requireMediaTools()
      expect(runnerTakesWorkflow(p, EVERY), `${name}: the rows take it`).toBe(true)
      const k = makeKit({ hosted: true, deps: { families: () => EVERY } })
      if (p.l) copyFileSync(clipPath('e_stitch_0.mp4'), join(k.root, 'input', 'a.mp4'))
      const err = await k.engine.startRun({ userId: k.userId, takes: [p], ...START }).catch(e => e)
      // R11.9a: never the engine; plain words naming the text to shorten, with the figure.
      expect(err?.data?.reason, `${name}: ${err?.message}`).toBeUndefined()
      expect(err?.data?.code, `${name}: ${err?.message}`).toBe('made-sound-too-long')
      expect(err?.data?.nodeId, `${name}: ${err?.message}`).toBe(at[name])
      expect(err?.message).toMatch(/^(“[^”]+”: )?This speech could run past .+, which is the most .+ takes here\. Shorten the text to under [\d,]+ characters\.$/)
      expect(k.ledger.hold).not.toHaveBeenCalled()
      expect(k.replicate.submitted()).toEqual([])
      // The figure is true: the text shortened to it is no longer refused for its length.
      const under = Number(/under ([\d,]+) characters/.exec(err.message)![1]!.replaceAll(',', ''))
      const shorter = { ...p, sp: speech(under) }
      const again = await k.engine.quoteRun({ userId: k.userId, takes: [shorter], ...START }).catch(e => e)
      expect(again?.data?.code, `${name} at ${under}: ${again?.message}`).not.toBe('made-sound-too-long')
    }, 60_000)
  }
})

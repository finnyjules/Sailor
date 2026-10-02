/**
 * Made clips, family `video-draw` (server/runner/video/, R6.7): Animated
 * noise and Audio waveform, against the real Python
 * (scripts/runner_media_fixtures.py --group vfx-draw).
 *
 * The user's matching rule, applied to R6.7 by the controller:
 *   - Animated noise is EXACT where that is cheap, and it is: every frame
 *     bit for bit (float32, round-8, trunc-8, the preview), and each frame's
 *     window equal to Python's (BAND on breathe and swirl: an int() of a sin
 *     or cos, none flagged in the fixture).
 *   - Audio waveform only has to LOOK the same (VISUAL): the bands within a
 *     loose float bound of Python's, and the frames compared pixel by pixel
 *     with a written bound on how many pixels differ (the look numbers are
 *     printed). Pillow's rectangle and wide line are drawn exactly (checked
 *     on their own); its ellipse is fitted.
 *   - Python's squeezed stereo is FIXED: a stereo file is drawn from its
 *     channels mixed, and judged against Python's drawing of that mix (the
 *     fixture's `mixed`), and shown far from Python's squeezed drawing.
 *
 * Plus: the plan's frames (the sound streamed under the lease) equal the
 * core's from the whole sound; effect → Create video → Save video; the
 * family off leaves the workflow to the engine; rule 12; the limits; the
 * sound's file judged by name and owner (hosted) and left to the engine
 * where the runner can't draw it; Stop and an early leave leave no process
 * and no kept file. The plan parts need the real tools (R5 rule 10).
 */
import { appendFileSync, copyFileSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/** Every tool process started, by pid (a spy on the process table's side of spawn). */
const PROCS = vi.hoisted(() => ({ pids: [] as number[] }))
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: ((...a: Parameters<typeof real.spawn>) => {
      const c = real.spawn(...a)
      if (c.pid) PROCS.pids.push(c.pid)
      return c
    }) as typeof real.spawn,
  }
})

/** A hook in the writer: on its Nth frame, Stop the node, or fail the write (an early leave). */
const HOOK = vi.hoisted(() => ({ puts: 0, at: 0, mode: 'stop' as 'stop' | 'fail', ctl: null as AbortController | null, firedAt: 0 }))
vi.mock('~~/server/media/values', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/values')>()
  return {
    ...real,
    framesSink: ((...a: Parameters<typeof real.framesSink>) => {
      const sink = real.framesSink(...a)
      return {
        ...sink,
        async put(rgb: Uint8Array) {
          if (HOOK.at && ++HOOK.puts === HOOK.at) {
            HOOK.firedAt = Date.now()
            if (HOOK.mode === 'fail') throw new Error('the writer failed (test)')
            HOOK.ctl?.abort()
          }
          return sink.put(rgb)
        },
      }
    }) as typeof real.framesSink,
  }
})

import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { FRAMES_OUTPUTS, MEDIA_EFFECTS_PORTED, MEDIA_EFFECT_OUTPUT_NODES, MEDIA_EFFECT_WORDS, mediaEffectRows, mediaEffectSwitchedClasses } from '#shared/runner/mediaEffects'
import { PICTURE_OUTPUTS } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { SOUND_RATE_ADVICE, withAdvice } from '#shared/runner/messages'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import { decodeAudio, decodeFrames } from '~~/server/media/decode'
import { probeMedia, pyFrameCount, pyFrameRate } from '~~/server/media/probe'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { LOCAL_LIVE_PREVIEW_SUBFOLDER } from '~~/server/runner/results'
import { workerScript } from '~~/server/runner/compositor/worker'
import { videoCores } from '~~/server/runner/video/cores'
import { VIDEO_EFFECTS, mediaEffectParams } from '~~/server/runner/video/table'
import { WAVE_SOUND_OUTSIDE_WORDS, mediaEffectStartProblems, waveformStartProblems } from '~~/server/runner/video/start'
import { WAVE_MAX_RATE, waveSamplesPerFrame } from '~~/server/runner/video/waveSound'
import { NOT_YOURS, assertFilesOwned, collectInputFiles, unsafeWaveformNames } from '~~/server/runner/inputs'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'
import { makeKit } from './__runner__/kit'
import {
  b64, batchBytes, hash16, hwc, invariantAnswers, mediaIo, previewPixels, rule12Pin, runVfxNode, sha256, vfxFixture, vfxHarness, vfxRunId,
  type VfxHarness, type VfxRun,
} from './__runner__/mediaEffectsParity'

type DrawRun = VfxRun & { offsets?: [number, number][]; bands?: string; u8z?: string; mixed?: { out: VfxRun['out']; u8z: string; bands: string } }
interface DrawFixture { waveSounds: string[]; primitives: { kind: string; xy: unknown[]; w: number; h: number; u8z: string }[] }
const FX = vfxFixture('vfx-draw') as ReturnType<typeof vfxFixture> & DrawFixture
const RUNS = FX.runs as DrawRun[]
const NOISE = RUNS.filter(r => r.class_type === 'AnimatedNoise')
const WAVES = RUNS.filter(r => r.class_type === 'AudioWaveform')
const LONG = { timeout: 120_000 }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-draw'])
const OFF: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-time', 'video-join', 'video-look', 'video-stabilize', 'video-flow'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const scratch = mkdtempSync(join(tmpdir(), 'media-vfx-draw-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let runs = 0

type Link = [string, number]
const unz = (s: string) => new Uint8Array(inflateSync(Buffer.from(s, 'base64')))
const f32Of = (s: string) => { const b = b64(s); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4) }
const bytesOf = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength)
const concat = (list: Uint8Array[]) => {
  const out = new Uint8Array(list.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const f of list) { out.set(f, at); at += f.length }
  return out
}

/** The look numbers: printed, and written where VFX_FIGURES names (for the task's report). */
function figuresOut(text: string): void {
  console.info(text)
  if (process.env.VFX_FIGURES) appendFileSync(process.env.VFX_FIGURES, `${text}\n`)
}

/** Python's ui as the runner writes it locally (its previews in their own temp subfolder). */
const localUi = (c: DrawRun) => ({ ...c.ui, images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: LOCAL_LIVE_PREVIEW_SUBFOLDER, type: im.type })) })

// ── The graph ────────────────────────────────────────────────────────────────

const made = (cls: string, widgets: Record<string, unknown>) => ({ class_type: cls, inputs: { ...widgets } })
const trimOf = (from: string) => ({ class_type: 'VideoTrim', inputs: { frames: [from, 0] as Link, start: 0, end: -1 } })
const createVideo = (from: string) => ({ class_type: 'CreateVideo', inputs: { images: [from, 0] as Link, fps: 24 } })
const saveVideo = (from: string) => ({ class_type: 'SaveVideo', inputs: { video: [from, 0] as Link, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })
const saveFrames = (from: string) => ({ class_type: 'SaveVideoFrames', inputs: { frames: [from, 0] as Link, fps: 24, filename_prefix: 'video/ComfyUI', crf: 20, audio_file: '(none)' } })
const paramsOf = (cls: string, w: Record<string, unknown>) => mediaEffectParams(MEDIA_EFFECT_SCHEMAS[cls], w)

/** The whole sound a case names, its channels mixed (the runner's fix), as the plan streams it: null for silence. */
const sounds = new Map<string, { rate: number; mono: Float32Array } | null>()
async function monoOf(name: string): Promise<{ rate: number; mono: Float32Array } | null> {
  if (sounds.has(name)) return sounds.get(name)!
  let got: { rate: number; mono: Float32Array } | null = null
  if (FX.waveSounds.includes(name) && name !== 'nothing_here.wav') {
    const path = clipPath(name)
    const s = await decodeAudio(path, { decoder: 'load', userId: null, maxSamples: 1e9, roots: [join(path, '..')] })
    const C = s.channels.length
    const n = s.channels[0]!.length
    const mono = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      let acc = s.channels[0]![i]!
      for (let c = 1; c < C; c++) acc = Math.fround(acc + s.channels[c]![i]!)
      mono[i] = Math.fround(acc / C)
    }
    got = { rate: s.rate, mono }
  }
  sounds.set(name, got)
  return got
}

/** A made clip's whole batch from its core on this thread, frame by frame as the plan makes it (the windows the feed hands on). */
async function genBatch(cls: string, widgets: Record<string, unknown>) {
  const params = paramsOf(cls, widgets)
  const out = VIDEO_EFFECTS[cls]!.shape(params, [])
  const op = cls === 'AnimatedNoise' ? videoCores.nclip.frame : videoCores.wave.frame
  const snd = cls === 'AudioWaveform' ? await monoOf(String(widgets.audio_file)) : null
  const spf = snd ? waveSamplesPerFrame(snd.rate, params.fps as number) : 0
  const f32: Uint8Array[] = []
  const round8: Uint8Array[] = []
  const trunc8: Uint8Array[] = []
  const bands: Float32Array[] = []
  let state: ArrayBuffer | undefined
  for (let j = 0; j < out.count; j++) {
    const win = snd && j * spf < snd.mono.length ? snd.mono.slice(j * spf, (j + 1) * spf) : null
    const r = op([], win ? { ...params, _window: win } : params, state, j, out.count)
    state = r.state
    if (cls === 'AudioWaveform') bands.push(new Float32Array(state!.slice(0)))
    f32.push(bytesOf(hwc(r.out)).slice())
    round8.push(videoCores.vx.toRgb(r.out, 'round'))
    trunc8.push(videoCores.vx.toRgb(r.out, 'trunc'))
  }
  return { count: out.count, w: out.w, h: out.h, f32: concat(f32), round8: concat(round8), trunc8: concat(trunc8), bands }
}

/** A harness whose input folder holds the waveform's standard sounds. */
function drawHarness(o: { hosted?: boolean } = {}): VfxHarness {
  const h = vfxHarness(scratch, o)
  for (const s of FX.waveSounds) if (s !== 'nothing_here.wav') copyFileSync(clipPath(s), join(h.root, 'input', s))
  return h
}

/** The share of pixels (any channel) that differ between two rgb24 batches, and the most any byte differs. */
function pixelDiff(a: Uint8Array, b: Uint8Array): { share: number; max: number } {
  let px = 0
  let max = 0
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(Math.abs(a[i]! - b[i]!), Math.abs(a[i + 1]! - b[i + 1]!), Math.abs(a[i + 2]! - b[i + 2]!))
    if (d) px++
    max = Math.max(max, d)
  }
  return { share: px / (a.length / 3), max }
}

/**
 * The waveform's look bounds (VISUAL), measured over every fixture case (the
 * test prints each case's figures): the bands' largest difference from
 * Python's (measured at most 2.4e-7), and the share of pixels that differ
 * from Python's drawing, of the mix for a stereo file (measured 0 in every
 * case but dots at bar_count 4, 0.097%: the fitted ellipse's rim).
 */
const WAVE_BAND_EPS = 1e-6
const WAVE_PIXEL_SHARE = 0.002

// ── The fixture, and Pillow's drawing on its own ─────────────────────────────

describe('the fixture', () => {
  it('was made from the real nodes: each motion at speed 0, 2 and 20; each style over each sound and a missing file; stereo files also mixed', () => {
    expect(FX.threads.torch).toBeGreaterThan(1)
    expect(RUNS.filter(r => r.error)).toEqual([])
    for (const m of ['pan_x', 'pan_y', 'diagonal', 'breathe', 'swirl']) {
      for (const s of [0, 2, 20]) expect(NOISE.some(r => r.widgets.motion === m && r.widgets.speed === s), `${m} ${s}`).toBe(true)
    }
    for (const s of FX.waveSounds) {
      for (const st of ['bars', 'wave', 'dots', 'radial', 'mirrored_bars']) expect(WAVES.some(r => r.widgets.audio_file === s && r.widgets.style === st), `${s} ${st}`).toBe(true)
    }
    for (const s of ['a_s16.wav', 'a_s32.wav', 'a_24.flac']) expect(WAVES.filter(r => r.widgets.audio_file === s).every(r => !!r.mixed), s).toBe(true)
    // Every case is an output node's: a preview of frame T // 2 and its ui.
    for (const r of RUNS) expect(r.ui, r.name).toEqual({ images: [{ filename: 'live_preview_7.png', subfolder: '', type: 'temp' }], animated: [false] })
  })
})

describe('Pillow’s drawing on its own', () => {
  const figures: string[] = []
  afterAll(() => figuresOut(`[draw] ellipse pixels off Pillow's: ${figures.join(', ')}`))
  for (const p of FX.primitives) {
    it(`${p.kind} ${JSON.stringify(p.xy)}`, () => {
      const dr = videoCores.dr
      const c = dr.canvas(p.w, p.h, [0, 0, 0])
      const ink = [255, 255, 255]
      const xy = p.xy as number[] & [number, number][]
      if (p.kind === 'rectangle') dr.rectangle(c, xy[0]!, xy[1]!, xy[2]!, xy[3]!, ink)
      else if (p.kind === 'line') dr.line(c, xy as unknown as [number, number][], 3, ink)
      else dr.ellipse(c, xy[0]!, xy[1]!, xy[2]!, xy[3]!, ink)
      const py = unz(p.u8z)
      if (p.kind !== 'ellipse') { expect(sha256(c.rgb)).toBe(sha256(py)); return }
      // The ellipse is fitted: a few rim pixels at most.
      let off = 0
      for (let i = 0; i < py.length; i += 3) if (py[i] !== c.rgb[i]) off++
      figures.push(`${JSON.stringify(xy)} ${off}`)
      expect(off).toBeLessThanOrEqual(8)
    })
  }
})

// ── Animated noise: exact ────────────────────────────────────────────────────

describe('Animated noise on this thread: every frame bit for bit, and each window Python’s', () => {
  for (const c of NOISE) {
    it(c.name, async () => {
      const params = paramsOf('AnimatedNoise', c.widgets)
      const L = videoCores.nclip.layout(params)
      for (let t = 0; t < L.T; t++) expect(videoCores.nclip.offsets(params, t, L), `frame ${t}`).toEqual(c.offsets![t])
      const got = await genBatch('AnimatedNoise', c.widgets)
      expect({ count: got.count, w: got.w, h: got.h }).toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h })
      expect(sha256(got.f32), 'float32').toBe(c.out!.f32_sha256)
      expect(sha256(got.round8), 'round-8').toBe(c.out!.round8_sha256)
      expect(sha256(got.trunc8), 'trunc-8').toBe(c.out!.trunc8_sha256)
    })
  }
})

describe('Animated noise through its plan: the kept batch and the preview are Python’s', () => {
  for (const c of NOISE) {
    it(c.name, LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const id = c.node_id
      const before = PROCS.pids.length
      // Read by Trim: kept round-8. Read by Save video frames only: kept trunc-8 (rule 4).
      for (const [reader, want] of [[trimOf(id), c.out!.round8_sha256], [saveFrames(id), c.out!.trunc8_sha256]] as const) {
        const got = await runVfxNode(h, { [id]: made('AnimatedNoise', c.widgets), r: reader }, id, {}, { runId, families: ON })
        const v = got.values[0] as Extract<RunnerValue, { kind: 'frames' }>
        expect({ count: v.count, w: v.w, h: v.h }).toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h })
        expect(sha256(await batchBytes(h, runId, v))).toBe(want)
        expect(got.ui).toEqual(localUi(c))
        const pv = await previewPixels(h, (got.ui as { images: OutputFile[] }).images[0]!)
        expect(sha256(pv.px), 'preview').toBe(c.preview!.sha256)
      }
      for (const pid of PROCS.pids.slice(before)) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    })
  }
})

describe('Animated noise → Create video → Save video saves Python’s frames (Python’s own pipeline on libopenh264)', () => {
  for (const c of FX.saved) {
    it(JSON.stringify(c.widgets), LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const values: Record<string, Record<number, RunnerValue>> = {}
      const prompt: ApiPrompt = { e: made('AnimatedNoise', c.widgets), c: createVideo('e'), s: saveVideo('c') }
      values.e = (await runVfxNode(h, prompt, 'e', values, { runId, families: ON })).values
      values.c = (await runVfxNode(h, prompt, 'c', values, { runId, families: ON })).values
      const saved = await runVfxNode(h, prompt, 's', values, { runId, families: ON })
      expect(saved.ui).toEqual(c.x264.ui)
      const path = h.results.pathOf!((saved.ui as { images: OutputFile[] }).images[0]!)
      const p = await probeMedia(path, { userId: null, roots: [join(path, '..')] })
      expect(await pyFrameCount(p, p.path, { userId: null })).toBe(c.openh264.frameCount)
      expect(pyFrameRate(p)).toEqual(c.openh264.frameRate)
      const frames: string[] = []
      await decodeFrames(path, { userId: null, maxFrames: 1e6, roots: [join(path, '..')], onFrame: async (f) => { frames.push(sha256(f)) } })
      expect(frames).toEqual(c.openh264.frames)
    })
  }
})

// ── Audio waveform: looks the same ───────────────────────────────────────────

/** Python's drawing a case is judged against: of the channels mixed for a stereo file (the fix), else its own. */
const pyLook = (c: DrawRun) => (c.mixed ? { u8: unz(c.mixed.u8z), bands: f32Of(c.mixed.bands) } : { u8: unz(c.u8z!), bands: f32Of(c.bands!) })

describe('Audio waveform on this thread: bands near Python’s, frames that look the same', () => {
  const figures: string[] = []
  afterAll(() => figuresOut(`[wave] band difference | pixels off Python's (share, most) | vs Python's squeezed stereo:\n${figures.join('\n')}`))
  for (const c of WAVES) {
    it(c.name, LONG, async () => {
      await requireMediaTools()
      const got = await genBatch('AudioWaveform', c.widgets)
      const py = pyLook(c)
      expect({ count: got.count, w: got.w, h: got.h }).toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h })
      // The bands (before the clip to 1.5), frame by frame.
      const K = got.bands[0]!.length
      expect(py.bands.length).toBe(K * got.count)
      let band = 0
      for (let j = 0; j < got.count; j++) for (let k = 0; k < K; k++) band = Math.max(band, Math.abs(got.bands[j]![k]! - py.bands[j * K + k]!))
      const d = pixelDiff(got.trunc8, py.u8)
      let squeezed = ''
      if (c.mixed) {
        const sq = pixelDiff(got.trunc8, unz(c.u8z!))
        squeezed = ` | ${(100 * sq.share).toFixed(2)}%`
        // Far from Python's squeezed drawing: the fix is visible.
        if (c.widgets.style !== 'radial' || sq.share > 0) expect(sq.share, 'differs from the squeezed stereo').toBeGreaterThan(d.share)
      }
      figures.push(`  ${c.name}: ${band.toExponential(1)} | ${(100 * d.share).toFixed(3)}%, ${d.max}${squeezed}`)
      expect(band, 'bands').toBeLessThanOrEqual(WAVE_BAND_EPS)
      expect(d.share, 'pixels off').toBeLessThanOrEqual(WAVE_PIXEL_SHARE)
      // Silence (no file, a missing one): nothing drawn but the background, as Python.
      if (c.widgets.audio_file === 'nothing_here.wav' || c.widgets.audio_file === '(no audio found)') expect(sha256(got.trunc8)).toBe(c.out!.trunc8_sha256)
    })
  }
})

describe('Audio waveform through its plan: the sound streamed under the lease gives the core’s frames; the preview and ui', () => {
  for (const c of WAVES) {
    it(c.name, LONG, async () => {
      await requireMediaTools()
      const h = drawHarness()
      const runId = vfxRunId(++runs)
      const id = c.node_id
      const before = PROCS.pids.length
      const got = await runVfxNode(h, { [id]: made('AudioWaveform', c.widgets), r: trimOf(id) }, id, {}, { runId, families: ON })
      const v = got.values[0] as Extract<RunnerValue, { kind: 'frames' }>
      const core = await genBatch('AudioWaveform', c.widgets)
      expect({ count: v.count, w: v.w, h: v.h }).toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h })
      expect(sha256(await batchBytes(h, runId, v)), 'the plan’s frames are the core’s').toBe(sha256(core.round8))
      expect(got.ui).toEqual(localUi(c))
      const pv = await previewPixels(h, (got.ui as { images: OutputFile[] }).images[0]!)
      const per = v.w * v.h * 3
      const mid = Math.floor(v.count / 2)
      expect(sha256(pv.px), 'preview: frame T // 2').toBe(sha256(core.trunc8.subarray(mid * per, (mid + 1) * per)))
      for (const pid of PROCS.pids.slice(before)) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
      expect(readdirSync(join(h.root, 'kept', runId))).toEqual([v.file.filename])
    })
  }
})

// ── The family, rule 12, the limits ──────────────────────────────────────────

describe('the family', () => {
  it('rows: a local render with no frames in, its widgets as ComfyUI validates them; an output node', () => {
    const rows = mediaEffectRows()
    for (const cls of ['AnimatedNoise', 'AudioWaveform']) {
      expect(MEDIA_EFFECTS_PORTED).toContain(cls)
      expect(MEDIA_EFFECT_OUTPUT_NODES).toContain(cls)
      expect(mediaEffectSwitchedClasses()[cls]).toBe('video-draw')
      expect(FRAMES_OUTPUTS.map(x => x.join(':'))).toContain(`${cls}:0`)
      expect(rows[cls]).toMatchObject({ family: 'video-draw', local: 'render', inputCheck: ['effect-preview-name'] })
      expect(rows[cls]!.mustLink).toBeUndefined()
      expect(VIDEO_EFFECTS[cls]!.reads).toBe('generator')
    }
    expect(rows.AudioWaveform!.widgets!.audio_file).toEqual({ type: 'STRING', required: true })
  })

  it('with video-draw off, a workflow with either is left to the engine and the node named', () => {
    for (const c of [NOISE[0]!, WAVES[0]!]) {
      const p: ApiPrompt = { e: made(c.class_type, c.widgets), c: createVideo('e'), s: saveVideo('c') }
      expect(runnerTakesWorkflow(p, ON), c.class_type).toBe(true)
      for (const fam of [OFF, new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['video-draw', 'media-video'])]) {
        expect(runnerTakesWorkflow(p, fam)).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id })).toContain('e')
      }
      // Its frames into Preview image: saved one file per frame, as Python saves a batch (R11.9a, row 15, ruling (q)).
      expect(runnerTakesWorkflow({ e: made(c.class_type, c.widgets), p: { class_type: 'PreviewImage', inputs: { images: ['e', 0] } } }, ON)).toBe(true)
    }
  })

  it('rule 12 over the synthetic graphs: with the family off, or on with the tools missing or its media family off, every answer is the pinned one', () => {
    const pin = rule12Pin()
    for (const cls of ['AnimatedNoise', 'AudioWaveform']) {
      const g = pin.graphs[`synthetic ${cls}`]!
      expect(g).toBeDefined()
      for (const [set, fam] of Object.entries(pin.sets)) expect(hash16(invariantAnswers(g.prompt, new Set(fam as RunnerFamily[]))), `${cls} ${set}`).toBe(g.answers[set])
      const on = new Set<RunnerFamily>([...pin.sets['every family before R6']! as RunnerFamily[], 'video-draw'])
      expect(hash16(invariantAnswers(g.prompt, on))).not.toBe(g.answers['every family before R6'])
      expect(Object.hasOwn(PICTURE_OUTPUTS, cls)).toBe(false)
    }
    expect(PICTURE_OUTPUTS).toEqual(pin.pictureOutputs)
  })

  it('the limits come from the widgets alone: the batch caps, what each holds and its work', async () => {
    const at = (cls: string, w: Record<string, unknown>, hosted: boolean) => mediaEffectStartProblems({ e: made(cls, w), c: createVideo('e'), s: saveVideo('c') }, ON, { hosted, shapes: new Map() })
    const noiseMax = { ...NOISE[0]!.widgets, width: 2048, height: 2048, frame_count: 600, speed: 20.0, noise_scale: 4.0 }
    // Python's texture here is 14,049² floats (790 MB); the runner holds torch's grid only (49 MB).
    expect(VIDEO_EFFECTS.AnimatedNoise!.heldBytes(paramsOf('AnimatedNoise', noiseMax), [])).toBeLessThan(MEDIA_CAPS.hosted.heldFrameBytes)
    expect(await at('AnimatedNoise', noiseMax, false)).toBeNull()
    expect(await at('AnimatedNoise', noiseMax, true)).toMatchObject({ nodeId: 'e', engine: true })
    expect(await at('AnimatedNoise', { ...noiseMax, width: 512, height: 288 }, true)).toBeNull()
    const w = WAVES[0]!.widgets
    expect(await at('AudioWaveform', { ...w, width: 1280, height: 720, frame_count: 180 }, true)).toBeNull()
    expect(await at('AudioWaveform', { ...w, width: 1280, height: 720, frame_count: 10_000 }, true)).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_WORDS.tooManyFrames })
    expect(await at('AudioWaveform', { ...w, width: 4096, height: 4096, frame_count: 100 }, true)).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_WORDS.tooManyFrames })
    // The work at fps 1 (the largest FFT, at the highest rate drawn) stays inside the hosted budget for 600 frames of 720p.
    const p = paramsOf('AudioWaveform', { ...w, width: 1280, height: 720, frame_count: 600, fps: 1 })
    const spec = VIDEO_EFFECTS.AudioWaveform!
    expect(spec.work(p, [], spec.shape(p, []))).toBeLessThan(MEDIA_CAPS.hosted.effectWork)
  })
})

// ── The sound's file ─────────────────────────────────────────────────────────

describe('the sound’s file: judged by name and owner, left to the engine where it can’t be drawn', () => {
  const take = (name: string): ApiPrompt => ({ e: made('AudioWaveform', { ...WAVES[0]!.widgets, audio_file: name }), c: createVideo('e'), s: saveVideo('c') })

  it('listed for the ownership check only with video-draw on; a name outside the folders is unsafe by its name alone', () => {
    expect(collectInputFiles(take('a_mono.mp3'), ON)).toContainEqual({ filename: 'a_mono.mp3', subfolder: '', type: 'input' })
    expect(collectInputFiles(take('a_mono.mp3'), OFF).some(f => f.filename === 'a_mono.mp3')).toBe(false)
    expect(collectInputFiles(take('(no audio found)'), ON).some(f => f.filename === '(no audio found)')).toBe(false)
    for (const bad of ['../x.wav', '/etc/x.wav', 'sub/../../x.wav']) {
      expect(unsafeWaveformNames(take(bad), ON), bad).toEqual([bad])
      expect(collectInputFiles(take(bad), ON).some(f => f.filename === 'x.wav'), bad).toBe(false)
    }
    expect(unsafeWaveformNames(take('sub/x.wav'), ON)).toEqual([])
    expect(unsafeWaveformNames(take('../x.wav'), OFF)).toEqual([])
  })

  it('another person’s sound is refused (403) before the run', async () => {
    const files = collectInputFiles(take('theirs.wav'), ON)
    await expect(assertFilesOwned(files, 'user_1', true, { ownsInput: async (_u, f) => f.filename !== 'theirs.wav', ownsOutput: async () => true }))
      .rejects.toMatchObject({ message: NOT_YOURS, statusCode: 403 })
  })

  it('the start pass: missing or unreadable is Python’s silence (runs); outside the folders (local) or a rate past the bound goes to the engine', LONG, async () => {
    await requireMediaTools()
    const h = drawHarness()
    writeFileSync(join(h.root, 'input', 'junk.wav'), 'not a sound at all')
    // A float WAV whose header says 400 kHz (a rate past WAVE_MAX_RATE).
    const rate = 400_000
    const data = Buffer.alloc(4 * 64)
    const fmt = Buffer.alloc(16)
    fmt.writeUInt16LE(3, 0); fmt.writeUInt16LE(1, 2); fmt.writeUInt32LE(rate, 4); fmt.writeUInt32LE(rate * 4, 8); fmt.writeUInt16LE(4, 12); fmt.writeUInt16LE(32, 14)
    writeFileSync(join(h.root, 'input', 'fast.wav'), Buffer.concat([Buffer.from('RIFF'), Buffer.from(Uint32Array.of(4 + 24 + 8 + data.length).buffer), Buffer.from('WAVEfmt '), Buffer.from(Uint32Array.of(16).buffer), fmt, Buffer.from('data'), Buffer.from(Uint32Array.of(data.length).buffer), data]))
    expect(rate).toBeGreaterThan(WAVE_MAX_RATE)
    const io = mediaIo(h, vfxRunId(++runs))
    for (const name of ['a_mono.mp3', 'a_s16.wav', 'gone.wav', 'junk.wav', '(no audio found)']) expect(await waveformStartProblems(take(name), ON, io), name).toBeNull()
    // R11.9a (row 21): refused plainly at the start, saying what to change.
    expect(await waveformStartProblems(take('fast.wav'), ON, io)).toEqual({ message: withAdvice(MEDIA_EFFECT_WORDS.waveSoundTooBig, SOUND_RATE_ADVICE), nodeId: 'e', classType: 'AudioWaveform', engine: true, code: 'sound-rate' })
    expect(await waveformStartProblems(take('../x.wav'), ON, io)).toMatchObject({ nodeId: 'e', engine: true })
    expect(await waveformStartProblems(take('fast.wav'), OFF, io)).toBeNull()
    // A file that won't read draws silence at the node's turn, as Python's does.
    const runId = vfxRunId(++runs)
    const got = await runVfxNode(h, { e: made('AudioWaveform', { ...WAVES[0]!.widgets, audio_file: 'junk.wav' }), r: trimOf('e') }, 'e', {}, { runId, families: ON })
    const silent = WAVES.find(r => r.widgets.audio_file === 'nothing_here.wav' && r.widgets.style === WAVES[0]!.widgets.style)!
    expect(sha256(await batchBytes(h, runId, got.values[0] as Extract<RunnerValue, { kind: 'frames' }>))).toBe(silent.out!.round8_sha256)
  })

  it('in the engine, hosted: `../x.wav` is refused by its name alone before any hold; locally refused plainly too (R11.9a, row 21)', LONG, async () => {
    await requireMediaTools()
    const asked: string[] = []
    const k = makeKit({ hosted: true, dir: mkdtempSync(join(scratch, 'runs-')), deps: { families: () => ON, ownership: { ownsInput: async (_u, f) => { asked.push(f.filename); return true }, ownsOutput: async () => true } } })
    const held = k.ledger.hold.mock.calls.length
    const err = await k.engine.startRun({ userId: k.userId, takes: [take('../x.wav')], ...START }).then(() => null, e => e as Error & { statusCode?: number; data?: { file?: string } })
    expect(err?.message).toBe(NOT_YOURS)
    expect(err?.statusCode).toBe(403)
    expect(err?.data?.file).toBe('../x.wav')
    expect(asked.filter(n => n.includes('x.wav'))).toEqual([])
    expect(k.ledger.hold.mock.calls.length).toBe(held)
    const local = makeKit({ dir: mkdtempSync(join(scratch, 'runs-')), deps: { families: () => ON } })
    const localErr = await local.engine.startRun({ userId: null, takes: [take('../x.wav')], ...START }).catch(e => e)
    expect(localErr).toMatchObject({ message: WAVE_SOUND_OUTSIDE_WORDS, data: { code: 'sound-rate', nodeId: 'e' } })
    expect(localErr.data.reason).toBeUndefined()
  })
})

// ── Stop, and an early leave ─────────────────────────────────────────────────

describe('Stop mid-run, and an early leave', () => {
  let h: VfxHarness
  beforeAll(() => { h = drawHarness() })
  const long = { ...WAVES[0]!.widgets, audio_file: 'a_long_8k.wav', frame_count: 300 }

  it('stopped mid-run: no tool process left within a second, nothing kept', LONG, async () => {
    await requireMediaTools()
    const runId = vfxRunId(++runs)
    mkdirSync(join(h.root, 'kept', runId), { recursive: true })
    const before = PROCS.pids.length
    const ctl = new AbortController()
    Object.assign(HOOK, { puts: 0, at: 40, mode: 'stop', ctl })
    try {
      await expect(runVfxNode(h, { e: made('AudioWaveform', long), r: trimOf('e') }, 'e', {}, { runId, families: ON, signal: ctl.signal }))
        .rejects.toThrow(MEDIA_WORDS.stopped)
      expect(Date.now() - HOOK.firedAt).toBeLessThan(1000)
    }
    finally { Object.assign(HOOK, { at: 0, ctl: null }) }
    const pids = PROCS.pids.slice(before)
    // The probe, the sound's decode and the writer.
    expect(pids.length).toBeGreaterThanOrEqual(3)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    expect(readdirSync(join(h.root, 'kept', runId))).toEqual([])
  })

  it('a 75-second sound drawn for 12 frames (the decode left early), a writer failing mid-run, Animated noise stopped: no ffmpeg left', LONG, async () => {
    await requireMediaTools()
    const runId = vfxRunId(++runs)
    const before = PROCS.pids.length
    for (let k = 0; k < 5; k++) {
      const got = await runVfxNode(h, { e: made('AudioWaveform', { ...long, frame_count: 12 }), r: trimOf('e') }, 'e', {}, { runId, families: ON })
      expect((got.values[0] as Extract<RunnerValue, { kind: 'frames' }>).count).toBe(12)
    }
    Object.assign(HOOK, { puts: 0, at: 5, mode: 'fail', ctl: null })
    try {
      await expect(runVfxNode(h, { e: made('AudioWaveform', long), r: trimOf('e') }, 'e', {}, { runId, families: ON })).rejects.toThrow('the writer failed (test)')
    }
    finally { Object.assign(HOOK, { at: 0 }) }
    const ctl = new AbortController()
    Object.assign(HOOK, { puts: 0, at: 3, mode: 'stop', ctl })
    try {
      await expect(runVfxNode(h, { e: made('AnimatedNoise', NOISE[0]!.widgets), r: trimOf('e') }, 'e', {}, { runId, families: ON, signal: ctl.signal })).rejects.toThrow(MEDIA_WORDS.stopped)
    }
    finally { Object.assign(HOOK, { at: 0, ctl: null }) }
    const pids = PROCS.pids.slice(before)
    expect(pids.length).toBeGreaterThanOrEqual(5 * 3 + 3 + 1)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
  })
})

// ── The cores in the worker (es2019, from their source text) ─────────────────

describe('the worker builds the new cores from their source text', () => {
  it('nclip, draw and wave compose into the worker script, in order after their arguments', () => {
    const script = workerScript(compositorCore)
    const at = (name: string) => script.indexOf(`built[${JSON.stringify(name)}] =`)
    for (const n of ['nclip', 'dr', 'wave']) expect(at(n), n).toBeGreaterThan(0)
    expect(at('look')).toBeLessThan(at('nclip'))
    // R2's Add noise keeps its own name.
    expect(script.split('built["noise"] =').length).toBe(2)
    expect(at('ft')).toBeLessThan(at('wave'))
    expect(at('dr')).toBeLessThan(at('wave'))
  })
})

// ── The work figure, measured ────────────────────────────────────────────────

describe('the work figure', () => {
  it('48 frames of 1280 × 720 of each through the real plan: the figure a second, against the slowest pilot’s 2.2 × 10⁷', LONG, async () => {
    await requireMediaTools()
    const h = drawHarness()
    const runId = vfxRunId(++runs)
    const lines: string[] = []
    for (const [cls, w] of [
      ['AnimatedNoise', { ...NOISE[0]!.widgets, width: 1280, height: 720, frame_count: 48, speed: 20.0, noise_scale: 4.0 }],
      ['AudioWaveform', { ...WAVES[0]!.widgets, width: 1280, height: 720, frame_count: 48, audio_file: 'a_long_8k.wav', style: 'radial', fps: 1 }],
    ] as const) {
      const p = paramsOf(cls, w)
      const spec = VIDEO_EFFECTS[cls]!
      const work = spec.work(p, [], spec.shape(p, []))
      const t0 = Date.now()
      await runVfxNode(h, { e: made(cls, w), r: trimOf('e') }, 'e', {}, { runId, families: ON })
      const s = (Date.now() - t0) / 1000
      lines.push(`${cls}: ${s.toFixed(2)} s, ${(work / s).toExponential(2)} work units a second`)
      expect(work / s, cls).toBeGreaterThan(2.2e7)
    }
    figuresOut(`[work] 48 frames of 1280 × 720: ${lines.join('; ')}`)
  })
})

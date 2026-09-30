/**
 * The time effects, family `video-time` (server/runner/video/): R6.1's
 * pilots Trim (read one frame at a time), Reverse / ping-pong (every frame
 * held) and Frame trail (a state carried from frame to frame), and R6.2's
 * Motion blur (time) (Python raises on every clip longer than one frame),
 * Slit scan and Time displacement (every frame held, each output frame
 * gathered from many) and Speed ramp (a sliding window), against the real
 * Python (scripts/runner_media_fixtures.py --group vfx-time: each case the
 * node's own execute with its hidden unique_id set, its live preview and its
 * output).
 *
 * R6 rule 14, for every fixture case:
 *   - the core, called on this thread, gives Python's float32 bit for bit
 *     (all three are EXACT);
 *   - through the node's plan with the real stores and tools, the kept batch
 *     decodes to Python's round-8 frames (another effect reads it) and to its
 *     trunc-8 frames (only an encoder reads it, rule 4); the preview to
 *     Python's; the ui is Python's.
 * Plus: the effect → Create video → Save video saves Python's frames (R5
 * rule 3: equal to Python's own pipeline switched to libopenh264); with the
 * family off the workflow is left to the engine; rule 12 over the synthetic
 * graphs; Stop mid-effect leaves no process and no kept file; and the core
 * survives Nitro's build.
 *
 * The plan parts need the real tools (R5 rule 10): they fail, never skip.
 */
import { createRequire } from 'node:module'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

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

/** A hook in the worker's video frames: Stop the node on the Nth frame. */
const HOOK = vi.hoisted(() => ({ frames: 0, abortAt: 0, ctl: null as AbortController | null, abortedAt: 0 }))
vi.mock('~~/server/runner/compositor/worker', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/compositor/worker')>()
  return {
    ...real,
    pixelsInWorker: ((signal, job, timeout) => real.pixelsInWorker(signal, w => job(new Proxy(w, {
      get(t, k) {
        const v = Reflect.get(t, k)
        if (k !== 'videoFrame') return typeof v === 'function' ? v.bind(t) : v
        return (...a: Parameters<typeof t.videoFrame>) => {
          const running = t.videoFrame(...a)
          if (++HOOK.frames === HOOK.abortAt && HOOK.ctl) { HOOK.abortedAt = Date.now(); HOOK.ctl.abort() }
          return running
        }
      },
    })), timeout)) as typeof real.pixelsInWorker,
  }
})

/** Every heldFrames / heldFramesShared call (a spy): which, the batch it held and the most it was allowed to. */
const HELD = vi.hoisted(() => ({ calls: [] as { fn: string; count: number; w: number; h: number; maxBytes: number; shared?: boolean }[] }))
vi.mock('~~/server/media/values', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/values')>()
  return {
    ...real,
    heldFrames: ((v, io, lease, maxBytes) => {
      HELD.calls.push({ fn: 'heldFrames', count: v.count, w: v.w, h: v.h, maxBytes })
      return real.heldFrames(v, io, lease, maxBytes)
    }) as typeof real.heldFrames,
    heldFramesShared: (async (v, io, lease, maxBytes) => {
      const buf = await real.heldFramesShared(v, io, lease, maxBytes)
      HELD.calls.push({ fn: 'heldFramesShared', count: v.count, w: v.w, h: v.h, maxBytes, shared: buf instanceof SharedArrayBuffer })
      return buf
    }) as typeof real.heldFramesShared,
  }
})

import type { ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, MEDIA_EFFECT_TOOL_FAMILIES, MEDIA_TOOL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { MEDIA_EFFECTS_PORTED, MEDIA_EFFECT_FAMILY_OF, MEDIA_EFFECT_WORDS } from '#shared/runner/mediaEffects'
import { PICTURE_OUTPUTS } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { decodeFrames } from '~~/server/media/decode'
import { probeMedia, pyFrameCount, pyFrameRate } from '~~/server/media/probe'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { LOCAL_LIVE_PREVIEW_SUBFOLDER } from '~~/server/runner/results'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { workerScript } from '~~/server/runner/compositor/worker'
import { videoCores } from '~~/server/runner/video/cores'
import { VIDEO_EFFECTS, effectHeldBytes, windowSchedule } from '~~/server/runner/video/table'
import { mediaEffectRefusals, needsExactCount } from '~~/server/runner/video/start'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'
import { makeKit } from './__runner__/kit'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import {
  b64, batchBytes, clipFrames, coreBatch, hash16, invariantAnswers, rule12Pin, keptBatch, previewPixels, runVfxNode, sha256, vfxFixture, vfxHarness, vfxRunId,
  type VfxRun,
} from './__runner__/mediaEffectsParity'

const FX = vfxFixture('vfx-time')
/** The ported classes this group covers (R6.3 on: other families' classes are ported too). */
const TIME_PORTED = MEDIA_EFFECTS_PORTED.filter(c => MEDIA_EFFECT_FAMILY_OF[c] === 'video-time')
const LONG = { timeout: 120_000 }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-time'])
const OFF_VIDEO_TIME: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video'])

const scratch = mkdtempSync(join(tmpdir(), 'media-vfx-time-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let runs = 0

type Link = [string, number]
const getComp = () => ({ class_type: 'GetVideoComponents', inputs: { video: ['l', 0] as Link } })
const loadVideo = () => ({ class_type: 'LoadVideo', inputs: { file: 'a.mp4' } })
const effect = (c: VfxRun | { class_type: string; widgets: Record<string, unknown> }) => ({ class_type: c.class_type, inputs: { frames: ['g', 0] as Link, ...c.widgets } })
const trimOf = (from: string) => ({ class_type: 'VideoTrim', inputs: { frames: [from, 0] as Link, start: 0, end: -1 } })
const saveFrames = (from: string) => ({ class_type: 'SaveVideoFrames', inputs: { frames: [from, 0] as Link, fps: 24, filename_prefix: 'video', audio_file: '(none)', preset: 'veryfast', crf: 20 } })
const createVideo = (from: string) => ({ class_type: 'CreateVideo', inputs: { images: [from, 0] as Link, fps: 24 } })
const saveVideo = (from: string) => ({ class_type: 'SaveVideo', inputs: { video: [from, 0] as Link, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })

describe('the fixture', () => {
  it('was made from the real nodes at torch’s own thread count, over rule 13’s case set', () => {
    expect(FX.threads.torch).toBeGreaterThan(1)
    expect(FX.threads.opencv).toBeGreaterThan(0)
    const classes = new Set(FX.runs.map(r => r.class_type))
    expect([...classes].sort()).toEqual([...TIME_PORTED].sort())
    // Python raises only in Motion blur (time), on every clip longer than one frame (its replicate pad of a 4-D tensor).
    expect(FX.runs.filter(r => r.error).map(r => r.class_type)).toEqual(expect.arrayContaining(['TemporalMotionBlur']))
    for (const r of FX.runs) {
      const raises = r.class_type === 'TemporalMotionBlur' && FX.clips[r.input]!.frames > 1
      expect(!!r.error, r.name).toBe(raises)
      if (r.error) expect(r.error, r.name).toMatch(/^NotImplementedError: Padding size 2 is not supported for 4D input tensor\./)
    }
    for (const cls of classes) {
      for (const clip of ['clip8', 'clip8-odd', 'clip2', 'clip1', 'clip8-big']) {
        expect(FX.runs.some(r => r.class_type === cls && r.input === clip), `${cls} over ${clip}`).toBe(true)
      }
    }
    // Trim with end ≤ start and past the end; ping-pong with 1, 2 and 8 frames.
    const trim = FX.runs.filter(r => r.class_type === 'VideoTrim').map(r => r.widgets)
    expect(trim).toContainEqual({ start: 5, end: 2 })
    expect(trim).toContainEqual({ start: 2, end: 50 })
    const pp = FX.runs.filter(r => r.class_type === 'VideoReverse' && r.widgets.mode === 'ping_pong').map(r => FX.clips[r.input]!.frames)
    expect(pp).toEqual(expect.arrayContaining([1, 2, 8]))
    // R6.2's own cases: Speed ramp at every mode with speed 0.05 / 1 / 10 and start_speed 0.05 / 10; Slit scan with
    // delay 0 and 4, both axes, wrap on and off; Time displacement at noise_scale 8 and 400 and seeds 0 and 2³¹ − 1.
    const of = (cls: string) => FX.runs.filter(r => r.class_type === cls).map(r => r.widgets)
    for (const mode of ['constant', 'ramp_in', 'ramp_out', 'ramp_in_out']) {
      for (const speed of [0.05, 1, 10]) for (const start of [0.05, 10]) expect(of('SpeedRamp'), `${mode} ${speed} ${start}`).toContainEqual(expect.objectContaining({ mode, speed, start_speed: start }))
      expect(of('SpeedRamp').some(w => w.mode === mode && w.interpolation === 'nearest'), mode).toBe(true)
    }
    for (const delay of [0, 4]) {
      for (const axis of ['horizontal', 'vertical']) for (const wrap of [false, true]) expect(of('SlitScan')).toContainEqual({ delay, axis, wrap })
    }
    for (const noise_scale of [8, 400]) for (const seed of [0, 2 ** 31 - 1]) expect(of('TimeDisplacement')).toContainEqual(expect.objectContaining({ noise_scale, seed }))
    expect(of('TimeDisplacement')).toContainEqual(expect.objectContaining({ strength: 0 }))
  })
})

/**
 * Speed ramp's ramp_in_out running sum against Python's, relative: measured
 * worst 8.5 × 10⁻⁷ over the fixture (a few ulps of the sum, from cos values
 * one ulp apart); the bound is about twice that.
 */
const CUM_EPS = 2 ** -19

describe('Speed ramp: the count and every source frame are Python’s', () => {
  const ramps = FX.runs.filter(r => r.class_type === 'SpeedRamp' && r.ramp)
  it('covers every case with more than one frame', () => {
    expect(ramps.length).toBe(FX.runs.filter(r => r.class_type === 'SpeedRamp' && FX.clips[r.input]!.frames > 1).length)
    expect(ramps.length).toBeGreaterThan(40)
  })
  for (const c of ramps) {
    it(c.name, () => {
      const T = FX.clips[c.input]!.frames
      const params = { mode: c.widgets.mode, speed: c.widgets.speed, start_speed: c.widgets.start_speed, interpolation: c.widgets.interpolation }
      const got = videoCores.time.rampSources(params, T)
      const want = c.ramp!
      expect(got.N, 'N').toBe(want.N)
      expect(VIDEO_EFFECTS.SpeedRamp!.shape(params, [{ count: T, w: 1, h: 1, exact: true }]).count, 'the shape').toBe(want.N)
      expect([...got.lo], 'idx_lo').toEqual(want.lo)
      expect([...got.hi], 'idx_hi').toEqual(want.hi)
      expect([...got.nearest], 'the nearest frame').toEqual(want.nearest)
      expect(sha256(new Uint8Array(got.src.buffer)), 'src_idx (float32)').toBe(sha256(b64(want.src)))
      expect(sha256(new Uint8Array(got.frac.buffer)), 'frac (float32)').toBe(sha256(b64(want.frac)))
      if (want.meanRate !== undefined) {
        expect(got.meanRate, 'rate.mean()').toBe(want.meanRate)
        if (!want.cum) expect(sha256(new Uint8Array(got.cum!.buffer)), 'cumsum (float32)').toBe(want.cum_sha256)
        else {
          // ramp_in_out: torch's float cos is SLEEF's (about 1 value in 20 one ulp off the correctly rounded one), so
          // the rate and its running sum are LIBRARY: within CUM_EPS of Python's, relative. N and the frames above are exact.
          const py = new Float32Array(b64(want.cum).buffer)
          let worst = 0
          for (let i = 0; i < py.length; i++) worst = Math.max(worst, Math.abs(got.cum![i]! - py[i]!) / Math.abs(py[i]!))
          expect(worst, 'cumsum, relative').toBeLessThanOrEqual(CUM_EPS)
        }
      }
    })
  }

  it('holds at most four frames at once, over the fixture and a sweep of counts and settings', () => {
    let most = 0
    for (const mode of ['constant', 'ramp_in', 'ramp_out', 'ramp_in_out']) {
      for (const speed of [0.05, 0.1, 0.35, 0.5, 0.95, 1, 1.05, 2, 3.3, 7, 10]) {
        for (const start of [0.05, 0.3, 1, 2.5, 10]) {
          for (const T of [2, 3, 5, 8, 13, 24, 61, 120, 301]) {
            for (const interpolation of ['nearest', 'blend']) {
              const w = { mode, speed, start_speed: start, interpolation }
              const ins = [{ count: T, w: 1, h: 1, exact: true }]
              const n = VIDEO_EFFECTS.SpeedRamp!.shape(w, ins).count
              most = Math.max(most, windowSchedule(VIDEO_EFFECTS.SpeedRamp!.windowOf!(w, ins), n, T).maxHeld)
            }
          }
        }
      }
    }
    expect(most).toBeLessThanOrEqual(4)
  })
})

describe('the core on this thread gives Python’s float32, bit for bit (exact)', () => {
  for (const c of FX.runs) {
    it(`${c.class_type}: ${c.name}`, () => {
      if (c.error) {
        expect(() => coreBatch(c.class_type, c.widgets, clipFrames(FX, c.input))).toThrow(MEDIA_EFFECT_WORDS.motionBlurFails)
        return
      }
      const got = coreBatch(c.class_type, c.widgets, clipFrames(FX, c.input))
      const want = c.out!
      expect({ count: got.count, w: got.w, h: got.h }).toEqual({ count: want.count, w: want.w, h: want.h })
      if (want.f32) expect(sha256(got.f32) === sha256(b64(want.f32)) ? 'equal' : 'differs', 'the float32 bytes').toBe('equal')
      expect(sha256(got.f32), 'float32').toBe(want.f32_sha256)
      expect(sha256(got.round8), 'round-8').toBe(want.round8_sha256)
      expect(sha256(got.trunc8), 'trunc-8').toBe(want.trunc8_sha256)
    })
  }
})

describe('through the node’s plan: the kept batch, the preview and the ui are Python’s', () => {
  for (const c of FX.runs) {
    it(`${c.class_type}: ${c.name}`, LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const input = await keptBatch(h, runId, clipFrames(FX, c.input))
      const values: Record<string, Record<number, RunnerValue>> = { g: { 0: input } }
      const id = c.node_id
      if (c.error) {
        // Python's raise, in plain words, before any tool process starts; nothing kept but the input.
        const before = PROCS.pids.length
        await expect(runVfxNode(h, { l: loadVideo(), g: getComp(), [id]: effect(c), r: trimOf(id) }, id, values, { runId, families: ON })).rejects.toThrow(MEDIA_EFFECT_WORDS.motionBlurFails)
        expect(PROCS.pids.length).toBe(before)
        expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input.file.filename])
        return
      }
      for (const [quant, reader, want] of [['round', trimOf(id), c.out!.round8_sha256], ['trunc', saveFrames(id), c.out!.trunc8_sha256]] as const) {
        const prompt: ApiPrompt = { l: loadVideo(), g: getComp(), [id]: effect(c), r: reader }
        const made = await runVfxNode(h, prompt, id, values, { runId, families: ON })
        const v = made.values[0]!
        expect(v.kind, quant).toBe('frames')
        const batch = v as Extract<RunnerValue, { kind: 'frames' }>
        expect({ count: batch.count, w: batch.w, h: batch.h }, quant).toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h })
        expect(sha256(await batchBytes(h, runId, batch)), `${quant}-8 frames`).toBe(want)
        // Python's ui, with the runner's own preview folder (R2's: results.ts LOCAL_LIVE_PREVIEW_SUBFOLDER).
        expect(made.ui, 'ui').toEqual({ ...c.ui, images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: LOCAL_LIVE_PREVIEW_SUBFOLDER, type: im.type })) })
        const p = await previewPixels(h, (made.ui as { images: OutputFile[] }).images[0]!)
        expect({ w: p.w, h: p.h, channels: p.channels }, 'preview').toEqual({ w: c.preview!.w, h: c.preview!.h, channels: 3 })
        expect(sha256(p.px), 'preview pixels').toBe(c.preview!.sha256)
      }
    })
  }

  it('an effect whose result is its input unchanged hands the input on: the same kept file, no work', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    for (const [cls, widgets, clip] of [
      ['FrameTrail', { decay: 0.85, blend_mode: 'screen', intensity: 1, threshold: 0 }, 'clip1'], ['VideoTrim', { start: 0, end: -1 }, 'clip8'], ['VideoReverse', { mode: 'reverse' }, 'clip1'],
      ['TemporalMotionBlur', { radius: 2, falloff: 'gaussian' }, 'clip1'], ['SlitScan', { delay: 1, axis: 'horizontal', wrap: false }, 'clip1'],
      ['TimeDisplacement', { strength: 0, noise_scale: 120, wrap: true, seed: 0 }, 'clip8'], ['TimeDisplacement', { strength: 4, noise_scale: 120, wrap: true, seed: 0 }, 'clip1'],
      ['SpeedRamp', { mode: 'constant', speed: 2, start_speed: 1, interpolation: 'blend' }, 'clip1'],
    ] as const) {
      const input = await keptBatch(h, runId, clipFrames(FX, clip))
      const made = await runVfxNode(h, { l: loadVideo(), g: getComp(), e: effect({ class_type: cls, widgets }) }, 'e', { g: { 0: input } }, { runId, families: ON })
      expect(made.values[0], cls).toEqual(input)
      expect(made.ui, cls).toEqual({ images: [{ filename: 'live_preview_e.png', subfolder: LOCAL_LIVE_PREVIEW_SUBFOLDER, type: 'temp' }], animated: [false] })
    }
  })
})

describe('effect → Create video → Save video saves Python’s frames (R5 rule 3: Python’s own pipeline on libopenh264)', () => {
  for (const c of FX.saved) {
    it(`${c.class_type} ${JSON.stringify(c.widgets)}`, LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const input = await keptBatch(h, runId, clipFrames(FX, c.input))
      const prompt: ApiPrompt = { l: loadVideo(), g: getComp(), e: effect(c), c: createVideo('e'), s: saveVideo('c') }
      const values: Record<string, Record<number, RunnerValue>> = { g: { 0: input } }
      values.e = (await runVfxNode(h, prompt, 'e', values, { runId, families: ON })).values
      values.c = (await runVfxNode(h, prompt, 'c', values, { runId, families: ON })).values
      const saved = await runVfxNode(h, prompt, 's', values, { runId, families: ON })
      expect(saved.ui).toEqual(c.x264.ui)
      const path = h.results.pathOf!((saved.ui as { images: OutputFile[] }).images[0]!)
      const p = await probeMedia(path, { userId: null, roots: [join(path, '..')] })
      expect(p.video.map(v => ({ w: v.w, h: v.h, codec: v.codec, pixFmt: v.pixFmt, frames: v.frames })))
        .toEqual(c.openh264.header.video.map(v => ({ w: v.w, h: v.h, codec: v.codec, pixFmt: v.pixFmt, frames: v.frames })))
      expect(await pyFrameCount(p, p.path, { userId: null })).toBe(c.openh264.frameCount)
      expect(c.openh264.frameCount).toBe(c.x264.frameCount)
      expect(pyFrameRate(p)).toEqual(c.openh264.frameRate)
      const frames: string[] = []
      await decodeFrames(path, { userId: null, maxFrames: 1e6, roots: [join(path, '..')], onFrame: async (f) => { frames.push(sha256(f)) } })
      expect(frames, 'frames equal to Python’s pipeline on libopenh264').toEqual(c.openh264.frames)
    })
  }
})

describe('the acceptance: Load video → Get video components → Reverse → Create video → Save video in the engine', () => {
  it('runs with no engine and no provider, and saves Python’s frames', LONG, async () => {
    await requireMediaTools()
    const a = FX.acceptance!
    const dir = mkdtempSync(join(scratch, 'engine-'))
    const k = makeKit({ dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    copyFileSync(clipPath(a.clip), join(k.root, 'input', a.clip))
    const p: ApiPrompt = {
      l: { class_type: 'LoadVideo', inputs: { file: a.clip } }, g: getComp(), r: { class_type: 'VideoReverse', inputs: { frames: ['g', 0], mode: 'reverse' } },
      c: { class_type: 'CreateVideo', inputs: { images: ['r', 0], fps: ['g', 2] } }, s: saveVideo('c'),
    }
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...{ workflow: null, canvasId: null, projectUuid: null, projectName: null } })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 'g', 'r', 'c', 's']) expect(t.nodes[id]!.status, `${id}: ${t.nodes[id]!.error ?? ''}`).toBe('done')
    expect(t.nodes.s!.outputs).toEqual(a.x264.ui.images)
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()
    const path = join(k.root, 'output', 'video', 'ComfyUI_00001_.mp4')
    const frames: string[] = []
    await decodeFrames(path, { userId: null, maxFrames: 1e6, roots: [join(path, '..')], onFrame: async (f) => { frames.push(sha256(f)) } })
    expect(frames, 'frames equal to Python’s pipeline on libopenh264').toEqual(a.openh264.frames)
    const pr = await probeMedia(path, { userId: null, roots: [join(path, '..')] })
    expect(pyFrameRate(pr)).toEqual(a.openh264.frameRate)
    expect(await pyFrameCount(pr, pr.path, { userId: null })).toBe(a.openh264.frameCount)
    // Reverse's live preview was written, and its batch let go once Create video and Save video had read it.
    expect(existsSync(join(k.root, 'temp', LOCAL_LIVE_PREVIEW_SUBFOLDER, 'live_preview_r.png'))).toBe(true)
    expect(t.nodes.r!.released).toHaveLength(1)
  })
})

describe('Motion blur (time) on a clip known to be longer than one frame is refused before the hold', () => {
  const blurFrom = (count: number, o: { counted?: boolean; exact?: boolean }) => {
    const p: ApiPrompt = { l: loadVideo(), g: getComp(), m: { class_type: 'TemporalMotionBlur', inputs: { frames: ['g', 0], radius: 2, falloff: 'gaussian' } }, c: createVideo('m'), s: saveVideo('c') }
    const shapes = new Map([['g:0', { count, w: 24, h: 16, exact: !!o.exact, ...(o.counted ? { counted: true as const } : {}) }]])
    return { p, shapes }
  }

  it('only on a count known exactly (counted, or exact) above one; on a header bound the node’s own check stays, and the engine counts first', () => {
    for (const o of [{ counted: true }, { exact: true }]) {
      const { p, shapes } = blurFrom(2, o)
      expect(mediaEffectRefusals(p, ON, shapes), JSON.stringify(o)).toEqual({ message: MEDIA_EFFECT_WORDS.motionBlurFails, nodeId: 'm', classType: 'TemporalMotionBlur' })
      expect(needsExactCount(p, ON, shapes)).toBe(false)
      expect(mediaEffectRefusals(blurFrom(1, o).p, ON, blurFrom(1, o).shapes)).toBeNull()
    }
    const bound = blurFrom(48, {})
    expect(mediaEffectRefusals(bound.p, ON, bound.shapes)).toBeNull()
    expect(needsExactCount(bound.p, ON, bound.shapes)).toBe(true)
    const one = blurFrom(1, {})
    expect(needsExactCount(one.p, ON, one.shapes)).toBe(false)
    // Its family off: not the runner's, nothing refused.
    expect(mediaEffectRefusals(bound.p, OFF_VIDEO_TIME, new Map([['g:0', { count: 48, w: 24, h: 16, exact: true }]]))).toBeNull()
  })

  it('in the engine, hosted: refused in plain words; the paid node in the other branch is neither run nor held', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'refuse-'))
    const k = makeKit({ hosted: true, dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    const clip = 'v_stereo_aac.mp4'
    copyFileSync(clipPath(clip), join(k.root, 'input', clip))
    const paid = {
      i: { class_type: 'GenerateImageNode', inputs: { model: 'flux-schnell', prompt: 'a red fox', aspect_ratio: '1:1', seed: 0, model_options: '{}' } },
      ic: { class_type: 'Image', inputs: { image: '', export: false, images: ['i', 0], batch_index: -1 } },
    }
    const video = (effect: Record<string, unknown>): ApiPrompt => ({
      ...paid, l: { class_type: 'LoadVideo', inputs: { file: clip } }, g: getComp(), m: { class_type: String(effect.class_type), inputs: { frames: ['g', 0], ...(effect.inputs as object) } },
      c: { class_type: 'CreateVideo', inputs: { images: ['m', 0], fps: ['g', 2] } }, s: saveVideo('c'),
    })
    const blurred = video({ class_type: 'TemporalMotionBlur', inputs: { radius: 2, falloff: 'gaussian' } })
    expect(runnerTakesWorkflow(blurred, ON)).toBe(true)
    const before = PROCS.pids.length
    const err = await k.engine.startRun({ userId: k.userId, takes: [blurred], workflow: null, canvasId: null, projectUuid: null, projectName: null }).catch(e => e)
    expect(err).toMatchObject({ statusCode: 400, message: MEDIA_EFFECT_WORDS.motionBlurFails, data: { nodeId: 'm', classType: 'TemporalMotionBlur' } })
    expect(err.data.reason).toBeUndefined()
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()
    expect(k.ledger.settle).not.toHaveBeenCalled()
    // Only the header and the packet count were read (ffprobe): no decode or encode.
    expect(PROCS.pids.length - before).toBeGreaterThan(0)
    // Teeth: the same workflow with Trim in its place starts, and holds the paid node.
    const trimmed = video({ class_type: 'VideoTrim', inputs: { start: 0, end: -1 } })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [trimmed], workflow: null, canvasId: null, projectUuid: null, projectName: null })
    await k.engine.settled(runId)
    expect(k.ledger.hold).toHaveBeenCalled()
  })
})

describe('the family', () => {
  it('with video-time off, a workflow with a pilot is left to the engine and the pilot named', () => {
    for (const cls of TIME_PORTED) {
      const c = FX.runs.find(r => r.class_type === cls)!
      const p: ApiPrompt = { l: loadVideo(), g: getComp(), e: effect(c), c: createVideo('e'), s: saveVideo('c') }
      expect(runnerTakesWorkflow(p, ON), cls).toBe(true)
      for (const fam of [OFF_VIDEO_TIME, new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['video-time', 'media-video'])]) {
        expect(runnerTakesWorkflow(p, fam), cls).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }), cls).toContain('e')
      }
    }
  })

  it('rule 12 over the synthetic and hand-made graphs: with every R6 family off, or on with the tools missing or their media families off, every answer is the pinned one from before R6.1', () => {
    const pin = rule12Pin()
    expect(pin.commit).toBe('f0d1f7da1')
    expect(Object.keys(pin.graphs).filter(k => k.startsWith('synthetic '))).toHaveLength(34)
    for (const [name, g] of Object.entries(pin.graphs)) {
      for (const [set, fam] of Object.entries(pin.sets)) {
        expect(hash16(invariantAnswers(g.prompt, new Set(fam as RunnerFamily[]))), `${name}, ${set}`).toBe(g.answers[set])
      }
    }
    // The server's own set with the tools missing drops every media and R6 family: one of the pinned sets.
    const toolsMissing = ALL_RUNNER_FAMILIES.filter(f => !MEDIA_TOOL_FAMILIES.includes(f) && !MEDIA_EFFECT_TOOL_FAMILIES.includes(f))
    expect(toolsMissing.sort()).toEqual([...pin.sets['every family before R6, tools missing']!].sort())
    expect(PICTURE_OUTPUTS).toEqual(pin.pictureOutputs)
    for (const cls of MEDIA_EFFECTS_PORTED) expect(Object.hasOwn(PICTURE_OUTPUTS, cls), cls).toBe(false)
    // Teeth: with video-time on, a pilot's graph answers otherwise.
    const on = new Set<RunnerFamily>([...pin.sets['every family before R6']! as RunnerFamily[], 'video-time'])
    const g = pin.graphs['synthetic VideoReverse']!
    expect(hash16(invariantAnswers(g.prompt, on))).not.toBe(g.answers['every family before R6'])
  })
})

describe('Stop mid-effect', () => {
  it('ends the node: no tool process left, no kept file but its input', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const W = 320
    const H = 240
    const input = await keptBatch(h, runId, { frames: Array.from({ length: 40 }, (_, i) => new Uint8Array(W * H * 3).fill(i * 5)), w: W, h: H })
    const before = PROCS.pids.length
    const ctl = new AbortController()
    HOOK.frames = 0
    HOOK.abortAt = 3
    HOOK.ctl = ctl
    try {
      const c = { class_type: 'FrameTrail', widgets: { decay: 0.85, blend_mode: 'screen', intensity: 1, threshold: 0 } }
      await expect(runVfxNode(h, { l: loadVideo(), g: getComp(), e: effect(c), r: trimOf('e') }, 'e', { g: { 0: input } }, { runId, families: ON, signal: ctl.signal }))
        .rejects.toThrow(MEDIA_WORDS.stopped)
      // Every process gone within a second of Stop (rule 7).
      expect(Date.now() - HOOK.abortedAt).toBeLessThan(1000)
    }
    finally { HOOK.abortAt = 0; HOOK.ctl = null }
    const pids = PROCS.pids.slice(before)
    // Its decode and its encode ran, and neither is left.
    expect(pids.length).toBeGreaterThanOrEqual(2)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    const kept = readdirSync(join(h.root, 'kept', runId))
    expect(kept).toEqual([input.file.filename])
  })
})

describe('Slit scan and Time displacement hold every frame, under the held-bytes limit', () => {
  for (const [cls, widgets] of [['SlitScan', { delay: 2.5, axis: 'vertical', wrap: true }], ['TimeDisplacement', { strength: 4, noise_scale: 8, wrap: true, seed: 0 }]] as const) {
    for (const hosted of [false, true]) {
      it(`${cls}, ${hosted ? 'hosted' : 'local'}: the whole batch held once, in one shared buffer the worker reads, within MEDIA_CAPS.heldFrameBytes`, LONG, async () => {
        await requireMediaTools()
        const h = vfxHarness(scratch, { hosted })
        const runId = vfxRunId(++runs)
        const clip = clipFrames(FX, 'clip8-big')
        const input = await keptBatch(h, runId, clip)
        HELD.calls.length = 0
        await runVfxNode(h, { l: loadVideo(), g: getComp(), e: effect({ class_type: cls, widgets }), r: trimOf('e') }, 'e', { g: { 0: input } }, { runId, families: ON })
        const limit = (hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local).heldFrameBytes
        expect(HELD.calls).toEqual([{ fn: 'heldFramesShared', count: 8, w: clip.w, h: clip.h, maxBytes: limit, shared: true }])
        for (const c of HELD.calls) expect(c.count * c.w * c.h * 3).toBeLessThanOrEqual(c.maxBytes)
        // The start pass's figure covers every frame, the sources, and (Slit scan) the whole source table.
        const ins = [{ count: 8, w: clip.w, h: clip.h, exact: true }]
        const table = cls === 'SlitScan' ? 4 * 8 * clip.h : 0
        expect(VIDEO_EFFECTS[cls]!.heldBytes(widgets, ins)).toBeGreaterThanOrEqual(9 * clip.w * clip.h * 3 + 4 * clip.w * clip.h * 3 + table)
      })
    }
  }

  it('Slit scan’s figure counts its whole source table (4 bytes a frame and step), through the shared helper', () => {
    const flat = [{ count: 600, w: 4096, h: 2, exact: true }]
    const base = effectHeldBytes(flat[0]!, { reads: 1, held8: 601, state32: 1 })
    expect(VIDEO_EFFECTS.SlitScan!.heldBytes({ delay: 1, axis: 'horizontal', wrap: false }, flat)).toBe(base + 4 * 600 * 4096)
    expect(VIDEO_EFFECTS.SlitScan!.heldBytes({ delay: 1, axis: 'vertical', wrap: false }, flat)).toBe(base + 4 * 600 * 2)
  })

  it('a batch over the hosted limit is left to the engine by the start pass (the same figure)', () => {
    const big = [{ count: 90, w: 1920, h: 1080, exact: true }]
    for (const cls of ['SlitScan', 'TimeDisplacement']) {
      const spec = VIDEO_EFFECTS[cls]!
      const w = cls === 'SlitScan' ? { delay: 1, axis: 'horizontal', wrap: false } : { strength: 4, noise_scale: 120, wrap: true, seed: 0 }
      expect(spec.heldBytes(w, big), cls).toBeGreaterThan(MEDIA_CAPS.hosted.heldFrameBytes)
      expect(spec.heldBytes(w, [{ count: 20, w: 1920, h: 1080, exact: true }]), cls).toBeLessThanOrEqual(MEDIA_CAPS.hosted.heldFrameBytes)
    }
  })
})

describe('Stop mid-effect, held and windowed', () => {
  for (const [cls, widgets, abortAt] of [
    ['SlitScan', { delay: 1, axis: 'horizontal', wrap: false }, 3],
    ['TimeDisplacement', { strength: 4, noise_scale: 120, wrap: true, seed: 0 }, 3],
    ['SpeedRamp', { mode: 'ramp_in_out', speed: 0.5, start_speed: 2, interpolation: 'blend' }, 5],
  ] as const) {
    it(`${cls}: no tool process left, no kept file but its input`, LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const W = 320
      const H = 240
      const input = await keptBatch(h, runId, { frames: Array.from({ length: 30 }, (_, i) => new Uint8Array(W * H * 3).fill(i * 7)), w: W, h: H })
      const before = PROCS.pids.length
      const ctl = new AbortController()
      HOOK.frames = 0
      HOOK.abortAt = abortAt
      HOOK.ctl = ctl
      try {
        await expect(runVfxNode(h, { l: loadVideo(), g: getComp(), e: effect({ class_type: cls, widgets }), r: trimOf('e') }, 'e', { g: { 0: input } }, { runId, families: ON, signal: ctl.signal }))
          .rejects.toThrow(MEDIA_WORDS.stopped)
        expect(Date.now() - HOOK.abortedAt).toBeLessThan(1000)
      }
      finally { HOOK.abortAt = 0; HOOK.ctl = null }
      const pids = PROCS.pids.slice(before)
      expect(pids.length).toBeGreaterThanOrEqual(2)
      for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
      expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input.file.filename])
    })
  }
})

// ── The esbuild guard: the video cores built as Nitro builds server code ─────

describe('esbuild guard: the video cores survive Nitro’s build', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = existsSync(pnpm) ? readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild')) : []
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(scratch, 'esbuild-'))
  const clip = clipFrames(FX, 'clip8')
  const params = { decay: 0.85, blend_mode: 'screen', intensity: 1, threshold: 0.37 }
  // Frame 1 of Frame trail on this thread: the reference.
  const reference = (() => {
    const f0 = videoCores.time.trail([videoCores.vx.fromRgb(clip.frames[0]!, clip.w, clip.h)], params, undefined, 0, 8)
    const f1 = videoCores.time.trail([videoCores.vx.fromRgb(clip.frames[1]!, clip.w, clip.h)], params, f0.state, 1, 8)
    return [...videoCores.vx.toRgb(f1.out, 'round')]
  })()

  it('finds an esbuild to build with', () => {
    expect(builds.length).toBeGreaterThan(0)
  })

  for (const esbuildDir of builds) {
    for (const minify of [false, true]) {
      it(`${esbuildDir.split('/').at(-3)} target es2019, minify ${minify}: the source-text cores run in a Worker`, async () => {
        const esb = require(esbuildDir) as typeof import('esbuild')
        const build = async (rel: string, name: string) => {
          let code = (await esb.transform(src(rel), { loader: 'ts', target: 'es2019', format: 'esm' })).code
          if (minify) code = (await esb.transform(code, { loader: 'js', target: 'es2019', minify: true })).code
          const file = join(dir, `${name}-${minify}.mjs`)
          writeFileSync(file, code)
          return await import(`${pathToFileURL(file).href}?${Math.random()}`) as Record<string, (...a: unknown[]) => unknown>
        }
        const px = await build('pixels/core.ts', 'pixels')
        const tk = await build('effects/core/tensor.ts', 'tensor')
        const kn = await build('effects/core/kernels.ts', 'kernels')
        const rng = await build('effects/core/rng.ts', 'rng')
        const time = await build('video/core/time.ts', 'time')
        const cores = [
          { name: 'tk', fn: tk.tensorCore as never, args: ['px'] },
          { name: 'kn', fn: kn.kernelsCore as never, args: ['tk', 'px'] },
          { name: 'rng', fn: rng.rngCore as never, args: [] },
          { name: 'vx', fn: time.framesCore as never, args: ['tk'] },
          { name: 'time', fn: time.timeCore as never, args: ['tk', 'kn', 'rng'] },
        ]
        const w = new Worker(workerScript(compositorCore, px.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          const r0 = await reply({ id: 1, op: 'vfx.frame', fn: 'time.trail', params, index: 0, count: 8, inputs: [{ rgb: clip.frames[0]!.slice(), w: clip.w, h: clip.h }], quant: 'round', preview: false })
          expect(r0.error).toBeUndefined()
          const r1 = await reply({ id: 2, op: 'vfx.frame', fn: 'time.trail', params, index: 1, count: 8, inputs: [{ rgb: clip.frames[1]!.slice(), w: clip.w, h: clip.h }], state: r0.value.state, quant: 'round', preview: true })
          expect(r1.error).toBeUndefined()
          expect([...r1.value.rgb]).toEqual(reference)
          expect(r1.value.preview.length).toBe(clip.w * clip.h * 3)
          // Speed ramp's blend (R6.2) in the built worker: this thread's frame.
          const rp = { interpolation: 'blend', _frac: Math.fround(0.3719) }
          const want = videoCores.vx.toRgb(videoCores.time.ramp([videoCores.vx.fromRgb(clip.frames[2]!, clip.w, clip.h), videoCores.vx.fromRgb(clip.frames[3]!, clip.w, clip.h)], rp).out, 'trunc')
          const r2 = await reply({ id: 3, op: 'vfx.frame', fn: 'time.ramp', params: rp, index: 0, count: 1, inputs: [{ rgb: clip.frames[2]!.slice(), w: clip.w, h: clip.h }, { rgb: clip.frames[3]!.slice(), w: clip.w, h: clip.h }], quant: 'trunc', preview: false })
          expect(r2.error).toBeUndefined()
          expect([...r2.value.rgb]).toEqual([...want])
          // Time displacement in the built worker, reading every frame from one shared buffer: this thread's frame.
          const fb = clip.w * clip.h * 3
          const sab = new SharedArrayBuffer(clip.frames.length * fb)
          clip.frames.forEach((fr, i) => new Uint8Array(sab, i * fb, fb).set(fr))
          const dw = { strength: 4, noise_scale: 8, wrap: true, seed: 2 ** 31 - 1 }
          const dwant = videoCores.vx.toRgb(videoCores.time.displace([], dw, undefined, 3, 8, undefined, { frames: clip.frames, w: clip.w, h: clip.h }).out, 'round')
          const r3 = await reply({ id: 4, op: 'vfx.frame', fn: 'time.displace', params: dw, index: 3, count: 8, inputs: [], held: { buf: sab, count: 8, w: clip.w, h: clip.h }, quant: 'round', preview: false })
          expect(r3.error).toBeUndefined()
          expect([...r3.value.rgb]).toEqual([...dwant])
          expect(r3.value.state.byteLength).toBe(clip.w * clip.h * 4)
          // And the built core's own sources and ramp.
          const pxc = px.pixelsCore!()
          const tkc = tk.tensorCore!(pxc)
          const built = time.timeCore!(tkc, kn.kernelsCore!(tkc, pxc), rng.rngCore!()) as typeof videoCores.time
          const dp = { strength: 4, noise_scale: 8, wrap: true, seed: 2 ** 31 - 1 }
          expect([...built.displaceSources(built.displaceOffsets(dp, 24, 16), 3, 8, true)]).toEqual([...videoCores.time.displaceSources(videoCores.time.displaceOffsets(dp, 24, 16), 3, 8, true)])
          const ramp = { mode: 'ramp_in_out', speed: 0.3, start_speed: 3, interpolation: 'blend' }
          expect([...built.rampSources(ramp, 90).frac]).toEqual([...videoCores.time.rampSources(ramp, 90).frac])
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})

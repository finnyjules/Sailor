/**
 * Task R6.1's pilots, family `video-time` (server/runner/video/): Trim
 * (read one frame at a time), Reverse / ping-pong (every frame held) and
 * Frame trail (a state carried from frame to frame), against the real
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

import type { ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, MEDIA_EFFECT_TOOL_FAMILIES, MEDIA_TOOL_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import { MEDIA_EFFECTS_PORTED } from '#shared/runner/mediaEffects'
import { PICTURE_OUTPUTS } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_WORDS } from '#shared/runner/media'
import { decodeFrames } from '~~/server/media/decode'
import { probeMedia, pyFrameCount, pyFrameRate } from '~~/server/media/probe'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { LOCAL_LIVE_PREVIEW_SUBFOLDER } from '~~/server/runner/results'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { workerScript } from '~~/server/runner/compositor/worker'
import { videoCores } from '~~/server/runner/video/cores'
import { clipPath, requireMediaTools } from './__runner__/mediaParity'
import { makeKit } from './__runner__/kit'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import {
  b64, batchBytes, beforeR61, clipFrames, coreBatch, invariantAnswers, keptBatch, previewPixels, runVfxNode, sha256, vfxFixture, vfxHarness, vfxRunId,
  type VfxRun,
} from './__runner__/mediaEffectsParity'

const FX = vfxFixture('vfx-time')
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
    expect([...classes].sort()).toEqual([...MEDIA_EFFECTS_PORTED].sort())
    expect(FX.runs.filter(r => r.error)).toEqual([])
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
  })
})

describe('the core on this thread gives Python’s float32, bit for bit (exact)', () => {
  for (const c of FX.runs) {
    it(`${c.class_type}: ${c.name}`, () => {
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
    for (const [cls, widgets, clip] of [['FrameTrail', { decay: 0.85, blend_mode: 'screen', intensity: 1, threshold: 0 }, 'clip1'], ['VideoTrim', { start: 0, end: -1 }, 'clip8'], ['VideoReverse', { mode: 'reverse' }, 'clip1']] as const) {
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

describe('the family', () => {
  it('with video-time off, a workflow with a pilot is left to the engine and the pilot named', () => {
    for (const cls of MEDIA_EFFECTS_PORTED) {
      const c = FX.runs.find(r => r.class_type === cls)!
      const p: ApiPrompt = { l: loadVideo(), g: getComp(), e: effect(c), c: createVideo('e'), s: saveVideo('c') }
      expect(runnerTakesWorkflow(p, ON), cls).toBe(true)
      for (const fam of [OFF_VIDEO_TIME, new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['video-time', 'media-video'])]) {
        expect(runnerTakesWorkflow(p, fam), cls).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }), cls).toContain('e')
      }
    }
  })

  it('rule 12 over the synthetic graphs: with every R6 family off, or on with the tools missing, every answer is as before R6.1', () => {
    const R6: RunnerFamily[] = ['video-time', 'video-join', 'video-look', 'video-stabilize', 'video-flow', 'video-draw', 'video-text', 'sound-effects', 'sound-denoise']
    const allButR6 = ALL_RUNNER_FAMILIES.filter(f => !R6.includes(f))
    // The server's own answer with the tools missing: every media family dropped (config.ts runnerFamilies).
    const toolsMissing = ALL_RUNNER_FAMILIES.filter(f => !MEDIA_TOOL_FAMILIES.includes(f) && !MEDIA_EFFECT_TOOL_FAMILIES.includes(f))
    const sets: [string, RunnerFamily[]][] = [['none', []], ['cards', ['cards']], ['cards, media-video, media-sound', ['cards', 'media-video', 'media-sound']], ['every family but R6', allButR6], ['every family, tools missing', toolsMissing]]
    expect(Object.keys(FX.graphs)).toHaveLength(34)
    for (const [cls, p] of Object.entries(FX.graphs)) {
      for (const [name, fam] of sets) {
        const families = new Set(fam)
        expect(invariantAnswers(p, families), `${cls}, ${name}`).toEqual(beforeR61(() => invariantAnswers(p, families)))
      }
    }
    for (const cls of MEDIA_EFFECTS_PORTED) expect(Object.hasOwn(PICTURE_OUTPUTS, cls), cls).toBe(false)
    // Teeth: with video-time on, a pilot's graph answers otherwise.
    const on = new Set<RunnerFamily>([...allButR6, 'video-time'])
    expect(invariantAnswers(FX.graphs.VideoReverse!, on)).not.toEqual(beforeR61(() => invariantAnswers(FX.graphs.VideoReverse!, on)))
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
        const time = await build('video/core/time.ts', 'time')
        const cores = [
          { name: 'tk', fn: tk.tensorCore as never, args: ['px'] },
          { name: 'vx', fn: time.framesCore as never, args: ['tk'] },
          { name: 'time', fn: time.timeCore as never, args: ['tk'] },
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
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})

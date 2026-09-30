/**
 * Slow motion by optical flow, family `video-flow` (server/runner/video/,
 * R6.6), against the real Python (scripts/runner_media_fixtures.py --group
 * vfx-flow: each case the node's own execute, run in a child process).
 *
 * The user's matching rule, applied to R6.6 by the controller: no port of
 * OpenCV's Farneback. ffmpeg's own `minterpolate` makes the in-between
 * frames (media/run.ts slowMotionGraph, the one pinned graph that may use
 * it). What must match Python:
 *   - the count and the places: (T − 1)·m + 1 frames, the original frames
 *     at every m-th place, bit for bit (by sha256, every case);
 *   - under two frames, the input handed on as it is.
 * The in-betweens only need to look the same (VISUAL). They are judged on
 * the moving patterns (a textured pattern shifted by whole and half pixels,
 * turned, zoomed) by PSNR, away from an 8-pixel border where content enters
 * the frame:
 *   - against the true in-between (the same pattern drawn at t = j / m):
 *     at least TRUTH_DB, and never worse than Python's own frame;
 *   - against Python's frame: at least PYTHON_DB, a loose bound. Python
 *     warps both frames the wrong way along its flow (a double image at
 *     twice the motion; measured below), and that is not copied (the
 *     matching rule's point 3), so fast motion sits far from Python's.
 *
 * Plus: the graph allow-list; effect → Create video → Save video; the family
 * off leaves the workflow to the engine; rule 12; the limits (minterpolate's
 * largest frame, and what it holds); Stop mid-run and an early leave leave
 * no process and no kept file. The plan parts need the real tools (R5 rule
 * 10): they fail, never skip.
 */
import { readdirSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { FRAMES_OUTPUTS, MEDIA_EFFECTS_PORTED, MEDIA_EFFECT_OUTPUT_NODES, MEDIA_EFFECT_WORDS, mediaEffectSwitchedClasses } from '#shared/runner/mediaEffects'
import { PICTURE_OUTPUTS } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import { decodeFrames } from '~~/server/media/decode'
import { probeMedia, pyFrameCount } from '~~/server/media/probe'
import { SLOW_MOTION_MAX_PIXELS, checkArgs, checkFilterGraph, slowMotionGraph, slowMotionGraphAllowed } from '~~/server/media/run'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { VIDEO_EFFECTS, mediaEffectParams } from '~~/server/runner/video/table'
import { mediaEffectStartProblems } from '~~/server/runner/video/start'
import { requireMediaTools } from './__runner__/mediaParity'
import {
  b64, batchBytes, clipFrames, hash16, invariantAnswers, keptBatch, rule12Pin, runVfxNode, sha256, vfxFixture, vfxHarness, vfxRunId,
  type VfxRun,
} from './__runner__/mediaEffectsParity'

type FlowRun = VfxRun & { frames?: string[]; inbetweens?: string }
interface FlowFixture { flowCell: number; flowClips: Record<string, { motion: string; frames: number; w: number; h: number; sha256: string }> }
const FX = vfxFixture('vfx-flow') as ReturnType<typeof vfxFixture> & FlowFixture
const RUNS = FX.runs as FlowRun[]
const LONG = { timeout: 120_000 }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-flow'])
const OFF: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-time', 'video-join', 'video-look', 'video-stabilize'])

const scratch = mkdtempSync(join(tmpdir(), 'media-vfx-flow-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let runs = 0

type Link = [string, number]
type Clip = { frames: Uint8Array[]; w: number; h: number }

// ── The moving patterns: the fixture script's exact formula (vfx_flow_frame) ──

/** The turn's cos and sin at whole frames, written out as the script writes them. */
const TURN: Readonly<Record<number, [number, number]>> = {
  1: [0.9993908270190958, 0.03489949670250097], 2: [0.9975640502598242, 0.0697564737441253], 3: [0.9945218953682733, 0.10452846326765347],
}

function flowHash(ix: number, iy: number, k: number): number {
  let h = (Math.imul(ix + 4096, 73856093) ^ Math.imul(iy + 4096, 19349663) ^ Math.imul(k + 1, 83492791)) >>> 0
  h = (h ^ (h << 13)) >>> 0
  h = (h ^ (h >>> 17)) >>> 0
  h = (h ^ (h << 5)) >>> 0
  return h & 255
}

/** Where pixel (x, y) of the frame at time t reads the texture (t may be a fraction: the true in-between). */
function flowSource(motion: string, t: number, x: number, y: number, cx: number, cy: number): [number, number] {
  if (motion === 'shift') return [x - 3.0 * t, y - 2.0 * t]
  if (motion === 'half') return [x - 1.5 * t, y - 0.5 * t]
  if (motion === 'turn') {
    if (t === 0) return [x, y]
    const [c, s] = Number.isInteger(t) ? TURN[t]! : [Math.cos(2 * t * Math.PI / 180), Math.sin(2 * t * Math.PI / 180)]
    return [cx + c * (x - cx) + s * (y - cy), cy - s * (x - cx) + c * (y - cy)]
  }
  const z = 1.0 + 0.03 * t
  return [cx + (x - cx) / z, cy + (y - cy) / z]
}

function flowFrame(motion: string, t: number, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 3)
  const cell = FX.flowCell
  const cx = w / 2.0
  const cy = h / 2.0
  let at = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [u, v] = flowSource(motion, t, x, y, cx, cy)
      const gx = u / cell
      const gy = v / cell
      const x0 = Math.floor(gx)
      const y0 = Math.floor(gy)
      const fx = gx - x0
      const fy = gy - y0
      for (let k = 0; k < 3; k++) {
        const a = flowHash(x0, y0, k)
        const b = flowHash(x0 + 1, y0, k)
        const c = flowHash(x0, y0 + 1, k)
        const d = flowHash(x0 + 1, y0 + 1, k)
        const val = (1.0 - fx) * (1.0 - fy) * a + fx * (1.0 - fy) * b + (1.0 - fx) * fy * c + fx * fy * d
        out[at++] = Math.min(255, Math.max(0, Math.floor(val + 0.5)))
      }
    }
  }
  return out
}

const made = new Map<string, Clip>()
function flowClip(name: string): Clip {
  const p = FX.flowClips[name]
  if (!p) return clipFrames(FX, name)
  const had = made.get(name)
  if (had) return had
  const clip = { frames: Array.from({ length: p.frames }, (_, t) => flowFrame(p.motion, t, p.w, p.h)), w: p.w, h: p.h }
  made.set(name, clip)
  return clip
}

const concat = (list: Uint8Array[]) => {
  const out = new Uint8Array(list.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const f of list) { out.set(f, at); at += f.length }
  return out
}

/** PSNR (dB) of two rgb24 frames of w × h, away from a border of `edge` pixels. */
function psnr(a: Uint8Array, b: Uint8Array, w: number, h: number, edge = 8): number {
  let sum = 0
  let n = 0
  for (let y = edge; y < h - edge; y++) {
    for (let x = edge; x < w - edge; x++) {
      for (let k = 0; k < 3; k++) {
        const i = (y * w + x) * 3 + k
        const d = a[i]! - b[i]!
        sum += d * d
        n++
      }
    }
  }
  return sum === 0 ? 99 : 10 * Math.log10((255 * 255) / (sum / n))
}

/**
 * The in-betweens' bounds (VISUAL), measured on every pattern case (the
 * test prints each case's worst in-between). Against the true in-between,
 * the runner's worst per case is 30.0–51.3 dB and Python's 18.8–43.3 dB;
 * the runner against Python's frames, 19.2–44.5 dB (the lowest where the
 * motion is fastest: a whole-pixel shift of 3 pixels a frame, where
 * Python's own frames are 19 dB from the truth, its double image).
 */
const TRUTH_DB = 28
const PYTHON_DB = 18
/** Where Python's frame is closer to the truth than the runner's, by at most this (a slow, soft motion both get right). */
const TRUTH_SLACK_DB = 1

// ── The graph ────────────────────────────────────────────────────────────────

const getComp = () => ({ class_type: 'GetVideoComponents', inputs: { video: ['l', 0] as Link } })
const sources = () => ({ l: { class_type: 'LoadVideo', inputs: { file: 'a.mp4' } }, g: getComp() })
const slowed = (widgets: Record<string, unknown>, from = 'g') => ({ class_type: 'FrameInterpolate', inputs: { frames: [from, 0] as Link, ...widgets } })
const trimOf = (from: string) => ({ class_type: 'VideoTrim', inputs: { frames: [from, 0] as Link, start: 0, end: -1 } })
const createVideo = (from: string) => ({ class_type: 'CreateVideo', inputs: { images: [from, 0] as Link, fps: 24 } })
const saveVideo = (from: string) => ({ class_type: 'SaveVideo', inputs: { video: [from, 0] as Link, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })
const paramsOf = (w: Record<string, unknown>) => mediaEffectParams(MEDIA_EFFECT_SCHEMAS.FrameInterpolate, w)
const shapeOf = (x: Clip) => ({ count: x.frames.length, w: x.w, h: x.h, exact: true })

describe('the fixture', () => {
  it('was made from the real node over rule 13’s case set and the moving patterns, multiplier 2, 3 and 8', () => {
    expect(FX.threads.torch).toBeGreaterThan(1)
    expect(RUNS.filter(r => r.error)).toEqual([])
    for (const clip of ['clip8', 'clip8-odd', 'clip2', 'clip1', 'clip8-big']) expect(RUNS.some(r => r.input === clip), clip).toBe(true)
    for (const m of [2, 3, 8]) expect(RUNS.some(r => r.widgets.multiplier === m && !!FX.flowClips[r.input]), `m ${m}`).toBe(true)
    for (const motion of ['shift', 'half', 'turn', 'zoom']) {
      for (const size of ['64x48', '160x120']) expect(RUNS.some(r => r.input === `${motion}-${size}`), `${motion} ${size}`).toBe(true)
    }
    // Not an output node: no preview, no ui.
    for (const r of RUNS) expect([r.ui, r.preview], r.name).toEqual([null, null])
  })

  it('the moving patterns made here are Python’s, byte for byte', () => {
    for (const [name, p] of Object.entries(FX.flowClips)) expect(sha256(concat(flowClip(name).frames)), name).toBe(p.sha256)
  })

  it('the output shapes are Python’s: (T − 1)·m + 1 frames, the input as it is under two', () => {
    for (const c of RUNS) {
      const x = flowClip(c.input)
      expect(VIDEO_EFFECTS.FrameInterpolate!.shape(paramsOf(c.widgets), [shapeOf(x)]), c.name).toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h, exact: true })
      expect(c.frames!.length).toBe(c.out!.count)
    }
  })

  it('Python’s in-betweens are the pattern warped the wrong way: at a whole-pixel shift, frame t is closer to the blend of t − 1 and t + 1 than to t', () => {
    const c = RUNS.find(r => r.input === 'shift-64x48' && r.widgets.multiplier === 2)!
    const p = FX.flowClips['shift-64x48']!
    const per = p.w * p.h * 3
    const py = b64(c.inbetweens!)
    const first = py.subarray(0, per)
    const wrong = new Uint8Array(per)
    const a = flowFrame('shift', -0.5, p.w, p.h)
    const b = flowFrame('shift', 1.5, p.w, p.h)
    for (let i = 0; i < per; i++) wrong[i] = Math.floor((a[i]! + b[i]!) / 2)
    const toWrong = psnr(first, wrong, p.w, p.h)
    const toTruth = psnr(first, flowFrame('shift', 0.5, p.w, p.h), p.w, p.h)
    console.info(`[flow] Python's frame at t = 0.5: ${toTruth.toFixed(1)} dB from the truth, ${toWrong.toFixed(1)} dB from the blend of t = −0.5 and t = 1.5`)
    expect(toWrong).toBeGreaterThan(toTruth + 10)
  })
})

describe('the graph allow-list: slow motion’s one graph, pinned whole', () => {
  it('admits exactly the graphs slowMotionGraph builds', () => {
    for (const [w, h, m] of [[64, 48, 2], [160, 120, 8], [24, 16, 3], [23, 15, 8], [1, 1, 2], [1, 200, 5], [1920, 1080, 4]] as const) {
      const g = slowMotionGraph(w, h, m)
      expect(checkFilterGraph(g), g).toBe(true)
      expect(slowMotionGraphAllowed(g)).toBe(true)
      expect(() => checkArgs('ffmpeg', ['-filter_complex', g, '-map', '[f]', '-frames:v', '9', '-f', 'rawvideo', 'pipe:1'])).not.toThrow()
    }
    // A side under 32 is enlarged by a whole factor and shrunk back; 32 and over work as they are.
    expect(slowMotionGraph(23, 15, 2)).toContain(',scale=w=46:h=45:flags=neighbor,format=yuv444p,tpad=')
    expect(slowMotionGraph(23, 15, 2)).toContain(',scale=w=23:h=15:flags=neighbor,format=yuv444p,extractplanes=y+u+v')
    expect(slowMotionGraph(32, 32, 2)).toBe(slowMotionGraph(640, 360, 2))
  })

  it('refuses any change: another option, multiplier or size, a filter added, the size not matching, the filters used elsewhere', () => {
    const g = slowMotionGraph(23, 15, 2)
    const bad = [
      g.replace('fps=2', 'fps=9'), g.replace('fps=2', 'fps=1'), g.replace('scd=none', 'scd=fdiff'), g.replace('mb_size=16', 'mb_size=4'),
      g.replace('scale=w=23:h=15', 'scale=w=24:h=15'), g.replace('scale=w=46:h=45', 'scale=w=4600:h=4500'),
      `${g};[f]null`, g.replace('format=rgb24[f]', 'format=rgb24,split[f]'), g.replace('tpad=stop=1', 'tpad=stop=100000'),
      slowMotionGraph(64, 48, 2).replace(',tpad=', ',scale=w=9999:h=9999:flags=neighbor,format=yuv444p,tpad='),
      'minterpolate=fps=2', 'tpad=stop=1:stop_mode=clone', 'extractplanes=r+g+b[r][g][b]', 'format=yuv444p,mergeplanes=map0s=0:format=gbrp',
    ]
    for (const b of bad) expect(checkFilterGraph(b), b).toBe(false)
    for (const [w, h, m] of [[0, 4, 2], [4, 4, 1], [4, 4, 9], [2.5, 4, 2], [65_536, 4, 2], [2049, 2048, 2]] as const) {
      expect(() => slowMotionGraph(w, h, m), `${w} × ${h} m ${m}`).toThrow()
    }
    expect(SLOW_MOTION_MAX_PIXELS).toBe(2048 * 2048)
  })
})

// ── Through the node's plan, with the real stores and tools ──────────────────

const frameAt = (b: Uint8Array, j: number, per: number) => b.subarray(j * per, (j + 1) * per)

describe('through the node’s plan: Python’s count, its originals bit for bit, in-betweens that look the same', () => {
  const figures: string[] = []
  afterAll(() => { if (figures.length) console.info(`[flow] PSNR, runner and Python against the truth, runner against Python (dB, worst in-between):\n${figures.join('\n')}`) })
  for (const c of RUNS) {
    it(c.name, LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const x = flowClip(c.input)
      const input = await keptBatch(h, runId, x)
      const values: Record<string, Record<number, RunnerValue>> = { g: { 0: input } }
      const id = c.node_id
      const want = c.out!
      const m = c.widgets.multiplier as number
      const per = want.w * want.h * 3
      const before = PROCS.pids.length
      const got = await runVfxNode(h, { ...sources(), [id]: slowed(c.widgets), r: trimOf(id) }, id, values, { runId, families: ON })
      const v = got.values[0]! as Extract<RunnerValue, { kind: 'frames' }>
      expect(got.ui).toBeNull()
      expect({ count: v.count, w: v.w, h: v.h }).toEqual({ count: want.count, w: want.w, h: want.h })
      const bytes = await batchBytes(h, runId, v)
      if (x.frames.length < 2) {
        // Handed on: the input value itself, no process.
        expect(v.file.filename).toBe(input.file.filename)
        expect(sha256(bytes)).toBe(want.trunc8_sha256)
        return
      }
      // The originals, at every m-th place, are Python's bit for bit.
      for (let j = 0; j < want.count; j += m) expect(sha256(frameAt(bytes, j, per)), `original at ${j}`).toBe(c.frames![j])
      // The in-betweens (the patterns): near the truth, never much worse than Python's, and near Python's.
      const p = FX.flowClips[c.input]
      if (p) {
        const py = b64(c.inbetweens!)
        let k = 0
        let worst = { truth: 99, pyTruth: 99, py: 99 }
        for (let j = 0; j < want.count; j++) {
          if (j % m === 0) continue
          const ours = frameAt(bytes, j, per)
          const theirs = frameAt(py, k++, per)
          const truth = flowFrame(p.motion, j / m, p.w, p.h)
          const f = { truth: psnr(ours, truth, p.w, p.h), pyTruth: psnr(theirs, truth, p.w, p.h), py: psnr(ours, theirs, p.w, p.h) }
          expect(f.truth, `frame ${j} against the truth`).toBeGreaterThanOrEqual(TRUTH_DB)
          expect(f.truth, `frame ${j}: not worse than Python's`).toBeGreaterThanOrEqual(f.pyTruth - TRUTH_SLACK_DB)
          expect(f.py, `frame ${j} against Python's`).toBeGreaterThanOrEqual(PYTHON_DB)
          worst = { truth: Math.min(worst.truth, f.truth), pyTruth: Math.min(worst.pyTruth, f.pyTruth), py: Math.min(worst.py, f.py) }
        }
        expect(k * per).toBe(py.length)
        figures.push(`  ${c.name}: ${worst.truth.toFixed(1)} | ${worst.pyTruth.toFixed(1)} | ${worst.py.toFixed(1)}`)
      }
      // One decode (with minterpolate) and one encode, both gone; the node's own kept batch and its input only.
      expect(PROCS.pids.length - before).toBeGreaterThanOrEqual(2)
      for (const pid of PROCS.pids.slice(before)) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
      const keptNow = readdirSync(join(h.root, 'kept', runId)).sort()
      expect(keptNow).toEqual([input.file.filename, v.file.filename].sort())
    })
  }
})

describe('effect → Create video → Save video', () => {
  it('saves (T − 1)·m + 1 frames, the originals in their places', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const x = flowClip('shift-64x48')
    const values: Record<string, Record<number, RunnerValue>> = { g: { 0: await keptBatch(h, runId, x) } }
    const prompt: ApiPrompt = { ...sources(), e: slowed({ multiplier: 3 }), c: createVideo('e'), s: saveVideo('c') }
    values.e = (await runVfxNode(h, prompt, 'e', values, { runId, families: ON })).values
    values.c = (await runVfxNode(h, prompt, 'c', values, { runId, families: ON })).values
    const saved = await runVfxNode(h, prompt, 's', values, { runId, families: ON })
    const path = h.results.pathOf!((saved.ui as { images: OutputFile[] }).images[0]!)
    const p = await probeMedia(path, { userId: null, roots: [join(path, '..')] })
    expect(await pyFrameCount(p, p.path, { userId: null })).toBe(3 * 3 + 1)
    const frames: Uint8Array[] = []
    await decodeFrames(path, { userId: null, maxFrames: 1e6, roots: [join(path, '..')], onFrame: async (f) => { frames.push(f) } })
    expect(frames.length).toBe(10)
    // Through h264 (lossy, 4:2:0 on a fine colour texture): each original still looks like itself, not its neighbour.
    for (let t = 0; t < 4; t++) {
      const own = psnr(frames[3 * t]!, x.frames[t]!, x.w, x.h, 0)
      expect(own, `original ${t}`).toBeGreaterThan(20)
      expect(own, `original ${t} against its neighbour`).toBeGreaterThan(psnr(frames[3 * t]!, x.frames[t === 3 ? 2 : t + 1]!, x.w, x.h, 0) + 3)
    }
  })
})

// ── The family, rule 12, the limits ──────────────────────────────────────────

describe('the family', () => {
  it('with video-flow off, a workflow with Slow motion is left to the engine and the node named', () => {
    expect(MEDIA_EFFECTS_PORTED).toContain('FrameInterpolate')
    expect(MEDIA_EFFECT_OUTPUT_NODES).not.toContain('FrameInterpolate')
    expect(mediaEffectSwitchedClasses().FrameInterpolate).toBe('video-flow')
    expect(FRAMES_OUTPUTS.map(x => x.join(':'))).toContain('FrameInterpolate:0')
    const p: ApiPrompt = { ...sources(), e: slowed({ multiplier: 2 }), c: createVideo('e'), s: saveVideo('c') }
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    for (const fam of [OFF, new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['video-flow', 'media-video'])]) {
      expect(runnerTakesWorkflow(p, fam)).toBe(false)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id })).toContain('e')
    }
    // A still picture wired in leaves the workflow to the engine (ruling (k)).
    const still: ApiPrompt = { ...p, i: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, e: slowed({ multiplier: 2 }, 'i') }
    expect(runnerTakesWorkflow(still, ON)).toBe(false)
  })

  it('rule 12 over the synthetic graph: with the family off, or on with the tools missing or its media family off, every answer is the pinned one', () => {
    const pin = rule12Pin()
    const g = pin.graphs['synthetic FrameInterpolate']!
    expect(g).toBeDefined()
    for (const [set, fam] of Object.entries(pin.sets)) expect(hash16(invariantAnswers(g.prompt, new Set(fam as RunnerFamily[]))), set).toBe(g.answers[set])
    const on = new Set<RunnerFamily>([...pin.sets['every family before R6']! as RunnerFamily[], 'video-flow'])
    expect(hash16(invariantAnswers(g.prompt, on))).not.toBe(g.answers['every family before R6'])
    expect(PICTURE_OUTPUTS).toEqual(pin.pictureOutputs)
    expect(Object.hasOwn(PICTURE_OUTPUTS, 'FrameInterpolate')).toBe(false)
  })

  it('the limits: a frame over minterpolate’s largest leaves the workflow to the engine (local too); hosted, what it holds sends 1080p to the engine, 720p runs', async () => {
    const p: ApiPrompt = { ...sources(), e: slowed({ multiplier: 2 }), c: createVideo('e'), s: saveVideo('c') }
    const at = (w: number, h: number, count = 24) => new Map([['g:0', { count, w, h, exact: true }]])
    expect(await mediaEffectStartProblems(p, ON, { hosted: false, shapes: at(3840, 2160) })).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_EFFECT_WORDS.flowTooBig })
    expect(await mediaEffectStartProblems(p, ON, { hosted: false, shapes: at(2048, 2048) })).toBeNull()
    expect(await mediaEffectStartProblems(p, ON, { hosted: true, shapes: at(1920, 1080) })).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_EFFECT_WORDS.heldTooMuch })
    expect(await mediaEffectStartProblems(p, ON, { hosted: true, shapes: at(1280, 720) })).toBeNull()
    // Hosted, 600 frames at × 8 is 4,793 frames: over the batch cap, to the engine.
    expect(await mediaEffectStartProblems({ ...p, e: slowed({ multiplier: 8 }) }, ON, { hosted: true, shapes: at(640, 360, 600) })).toMatchObject({ nodeId: 'e', engine: true, message: MEDIA_WORDS.tooManyFrames })
    expect(VIDEO_EFFECTS.FrameInterpolate!.heldBytes(paramsOf({ multiplier: 2 }), [{ count: 24, w: 1920, h: 1080, exact: true }])).toBeGreaterThan(775_536_640)
    expect(VIDEO_EFFECTS.FrameInterpolate!.heldBytes(paramsOf({ multiplier: 2 }), [{ count: 24, w: 1280, h: 720, exact: true }])).toBeLessThan(MEDIA_CAPS.hosted.heldFrameBytes)
  })
})

// ── Stop, and an early leave ─────────────────────────────────────────────────

describe('Stop mid-run, and an early leave', () => {
  const W = 96
  const H = 64
  const T = 12
  const moving = (): Clip => ({ w: W, h: H, frames: Array.from({ length: T }, (_, t) => flowFrame('half', t, W, H)) })

  it('stopped mid-run: no tool process left within a second, no kept file but its input', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const input = await keptBatch(h, runId, moving())
    const before = PROCS.pids.length
    const ctl = new AbortController()
    Object.assign(HOOK, { puts: 0, at: 20, mode: 'stop', ctl })
    try {
      await expect(runVfxNode(h, { ...sources(), e: slowed({ multiplier: 8 }), r: trimOf('e') }, 'e', { g: { 0: input } }, { runId, families: ON, signal: ctl.signal }))
        .rejects.toThrow(MEDIA_WORDS.stopped)
      expect(Date.now() - HOOK.firedAt).toBeLessThan(1000)
    }
    finally { Object.assign(HOOK, { at: 0, ctl: null }) }
    const pids = PROCS.pids.slice(before)
    expect(pids.length).toBe(2)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input.file.filename])
  })

  it('a writer failing mid-run (an early leave from the decode), then a whole run and a one-frame clip handed on ten times: no ffmpeg left', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const input = await keptBatch(h, runId, moving())
    const one = await keptBatch(h, runId, clipFrames(FX, 'clip1'))
    const before = PROCS.pids.length
    Object.assign(HOOK, { puts: 0, at: 7, mode: 'fail', ctl: null })
    try {
      await expect(runVfxNode(h, { ...sources(), e: slowed({ multiplier: 4 }), r: trimOf('e') }, 'e', { g: { 0: input } }, { runId, families: ON }))
        .rejects.toThrow('the writer failed (test)')
    }
    finally { Object.assign(HOOK, { at: 0 }) }
    expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual([input.file.filename, one.file.filename].sort())
    const got = await runVfxNode(h, { ...sources(), e: slowed({ multiplier: 4 }), r: trimOf('e') }, 'e', { g: { 0: input } }, { runId, families: ON })
    expect((got.values[0] as Extract<RunnerValue, { kind: 'frames' }>).count).toBe((T - 1) * 4 + 1)
    for (let k = 0; k < 10; k++) {
      const m = await runVfxNode(h, { ...sources(), e: slowed({ multiplier: 4 }), r: trimOf('e') }, 'e', { g: { 0: one } }, { runId, families: ON })
      expect((m.values[0] as Extract<RunnerValue, { kind: 'frames' }>).file.filename).toBe(one.file.filename)
    }
    // Two for the failed run, two for the whole one; none for the one-frame clip (no preview to write).
    const pids = PROCS.pids.slice(before)
    expect(pids.length).toBe(4)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
  })
})

// ── The work figure, measured ────────────────────────────────────────────────

describe('the work figure', () => {
  it('24 frames of 1280 × 720 at × 2 through the real plan: the figure a second, against the slowest pilot’s 2.2 × 10⁷', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const W = 1280
    const H = 720
    const base = flowFrame('half', 0, W + 48, H + 32)
    const frames = Array.from({ length: 24 }, (_, t) => {
      const f = new Uint8Array(W * H * 3)
      for (let y = 0; y < H; y++) f.set(base.subarray(((y + (t % 8)) * (W + 48) + 2 * (t % 8)) * 3, ((y + (t % 8)) * (W + 48) + 2 * (t % 8) + W) * 3), y * W * 3)
      return f
    })
    const input = await keptBatch(h, runId, { frames, w: W, h: H })
    const params = paramsOf({ multiplier: 2 })
    const ins = [{ count: 24, w: W, h: H, exact: true }]
    const work = VIDEO_EFFECTS.FrameInterpolate!.work(params, ins, VIDEO_EFFECTS.FrameInterpolate!.shape(params, ins))
    const t0 = Date.now()
    await runVfxNode(h, { ...sources(), e: slowed({ multiplier: 2 }), r: trimOf('e') }, 'e', { g: { 0: input } }, { runId, families: ON })
    const s = (Date.now() - t0) / 1000
    console.info(`[flow] 24 frames of 1280 × 720 at × 2: ${s.toFixed(2)} s, ${(work / s).toExponential(2)} work units a second`)
    expect(work).toBeLessThan(MEDIA_CAPS.hosted.effectWork)
  })
})

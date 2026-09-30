/**
 * Joining two clips, family `video-join` (server/runner/video/, R6.3):
 * Crossfade (each clip trimmed, then a blend over the overlap) and
 * Transition (dissolve, whip pan, zoom, glitch, light leak), against the real
 * Python (scripts/runner_media_fixtures.py --group vfx-join: each case the
 * node's own execute with its hidden unique_id set, the glitch after
 * torch.manual_seed(seed)).
 *
 * R6 rule 14, for every fixture case:
 *   - the core, called on this thread, gives Python's float32 by its parity
 *     class: EXACT (Crossfade and dissolve on linear / ease_in / ease_out;
 *     the glitch under Python's seed) bit for bit; LIBRARY (ease_in_out's
 *     cos, whip pan's affine_grid and conv2d, zoom's affine_grid, light
 *     leak's exp) within JOIN_EPS, with the 8-bit forms equal but where
 *     Python's value sat on rule 5's band, and there one step at most;
 *   - through the node's plan with the real stores and tools, the kept batch
 *     decodes to Python's round-8 frames (another effect reads it) and to its
 *     trunc-8 frames (only an encoder reads it, rule 4), by the same class;
 *     the preview is Python's; the ui is Python's.
 * Plus: the glitch's decisions equal Python's under every fixture seed; with
 * glitchSeed the output is the same on a rerun and changes with a widget;
 * effect → Create video → Save video saves Python's frames; the family off
 * leaves the workflow to the engine; rule 12; Stop mid-join leaves no
 * process and no kept file; nothing is held beyond heldBytes; the core
 * survives Nitro's build.
 *
 * The plan parts need the real tools (R5 rule 10): they fail, never skip.
 */
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/** A hook in the worker's video frames: Stop the node on the Nth frame; the most frames handed to one call. */
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

/** The glitch's seed, set by a test to the one the fixture gave torch (null: glitchSeed's own). */
const SEED = vi.hoisted(() => ({ override: null as bigint | null, seen: [] as bigint[] }))
vi.mock('~~/server/runner/video/table', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/video/table')>()
  return {
    ...real,
    glitchSeed: ((...a: Parameters<typeof real.glitchSeed>) => {
      const s = SEED.override ?? real.glitchSeed(...a)
      SEED.seen.push(s)
      return s
    }) as typeof real.glitchSeed,
  }
})

/** Every frames value handed out by a decode (a spy on framesOf): how many frames each reader held at once. */
const DECODES = vi.hoisted(() => ({ open: 0, most: 0 }))
vi.mock('~~/server/media/values', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/values')>()
  return {
    ...real,
    heldFrames: (() => { throw new Error('A join holds no frames') }) as typeof real.heldFrames,
    heldFramesShared: (() => { throw new Error('A join holds no frames') }) as typeof real.heldFramesShared,
    framesOf: ((...a: Parameters<typeof real.framesOf>) => {
      const inner = real.framesOf(...a)
      return {
        [Symbol.asyncIterator]() {
          const it = inner[Symbol.asyncIterator]()
          DECODES.open++
          DECODES.most = Math.max(DECODES.most, DECODES.open)
          let closed = false
          const close = () => { if (!closed) { closed = true; DECODES.open-- } }
          return {
            async next() { const g = await it.next(); if (g.done) close(); return g },
            async return(v?: unknown) { close(); return (await it.return?.(v)) ?? { done: true, value: undefined } },
          } as AsyncIterator<Uint8Array>
        },
      }
    }) as typeof real.framesOf,
  }
})

import type { ApiPrompt } from '#shared/runner/graph'
import type { RunnerFamily } from '#shared/runner/families'
import { MEDIA_EFFECTS_PORTED, FRAMES_OUTPUTS, MEDIA_EFFECT_OUTPUT_NODES, mediaEffectSwitchedClasses } from '#shared/runner/mediaEffects'
import { PICTURE_OUTPUTS } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import { decodeFrames } from '~~/server/media/decode'
import { framesOf } from '~~/server/media/values'
import { mediaLease } from '~~/server/media/run'
import { probeMedia, pyFrameCount, pyFrameRate } from '~~/server/media/probe'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { LOCAL_LIVE_PREVIEW_SUBFOLDER } from '~~/server/runner/results'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { workerScript } from '~~/server/runner/compositor/worker'
import { videoCores } from '~~/server/runner/video/cores'
import { VIDEO_EFFECTS, effectHeldBytes, glitchSeed, joinReads, mediaEffectParams } from '~~/server/runner/video/table'
import { mediaEffectStartProblems } from '~~/server/runner/video/start'
import { requireMediaTools } from './__runner__/mediaParity'
import {
  b64, batchBytes, clipFrames, coreJoinBatch, hash16, invariantAnswers, keptBatch, mediaIo, previewPixels, rule12Pin, runVfxNode, sha256, vfxFixture, vfxHarness, vfxRunId,
  type VfxBand, type VfxRun,
} from './__runner__/mediaEffectsParity'

const FX = vfxFixture('vfx-join')
const LONG = { timeout: 120_000 }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-join'])
const OFF_VIDEO_JOIN: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-time'])

const scratch = mkdtempSync(join(tmpdir(), 'media-vfx-join-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let runs = 0

type Link = [string, number]
const getComp = (from = 'l') => ({ class_type: 'GetVideoComponents', inputs: { video: [from, 0] as Link } })
const loadVideo = (file = 'a.mp4') => ({ class_type: 'LoadVideo', inputs: { file } })
const joined = (c: { class_type: string; widgets: Record<string, unknown> }) => ({ class_type: c.class_type, inputs: { clip_a: ['g', 0] as Link, clip_b: ['h', 0] as Link, ...c.widgets } })
const trimOf = (from: string) => ({ class_type: 'VideoTrim', inputs: { frames: [from, 0] as Link, start: 0, end: -1 } })
const saveFrames = (from: string) => ({ class_type: 'SaveVideoFrames', inputs: { frames: [from, 0] as Link, fps: 24, filename_prefix: 'video', audio_file: '(none)', preset: 'veryfast', crf: 20 } })
const createVideo = (from: string) => ({ class_type: 'CreateVideo', inputs: { images: [from, 0] as Link, fps: 24 } })
const saveVideo = (from: string) => ({ class_type: 'SaveVideo', inputs: { video: [from, 0] as Link, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })
/** Two sources: Load video → Get video components, twice (g is clip A, h clip B). */
const sources = () => ({ l: loadVideo('a.mp4'), g: getComp('l'), m: loadVideo('b.mp4'), h: getComp('m') })

const LIBRARY_STYLES = ['whip_pan_left', 'whip_pan_right', 'zoom_in', 'zoom_out', 'light_leak']
/** A case's parity class (the brief's): LIBRARY where a transition frame goes through cos, affine_grid, conv2d or exp. */
const isLibrary = (c: { widgets: Record<string, unknown> }) => LIBRARY_STYLES.includes(String(c.widgets.style)) || (c.widgets.style !== 'glitch' && c.widgets.curve === 'ease_in_out')

/**
 * LIBRARY's ε (rule 5), on Python's float32 values: measured worst over the
 * fixture 1.19 × 10⁻⁷ (one ulp below 1: light leak's exp; whip pan's box blur,
 * a sum in another order than torch's, and ease_in_out's cos are one ulp at
 * most too); bound 2⁻²¹ (in 255-scale 1.2 × 10⁻⁴, well under rule 5's 2⁻⁸).
 */
const JOIN_EPS = 2 ** -21

const joinInputs = (c: VfxRun) => [clipFrames(FX, c.input), clipFrames(FX, c.input_b!)] as const

/** The frames of a batch's transition (the only frames a LIBRARY kernel makes), as a range of flat indices. */
function transRange(c: VfxRun): [number, number] {
  const per = c.out!.w * c.out!.h * 3
  return [c.layout!.head * per, (c.layout!.head + c.layout!.d) * per]
}

/**
 * The output frames a whip pan blurs (kw > 1): a sum in another order than
 * torch's, which can land an ulp off an 8-bit level Python lands on.
 */
function blurredFrames(c: VfxRun): Set<number> {
  if (c.widgets.style !== 'whip_pan_left' && c.widgets.style !== 'whip_pan_right') return new Set()
  const L = c.layout!
  const alphas = videoCores.join.alphaOf(L.d, c.widgets.curve)
  const out = new Set<number>()
  for (let i = 0; i < L.d; i++) if (Math.max(1, Math.trunc(15 * Math.fround(alphas[i]! * Math.fround(1 - alphas[i]!)) * 4 + 1)) > 1) out.add(L.head + i)
  return out
}

/**
 * Rule 5's band from Python's own float32 (whole cases), as the fixture
 * script's vfx_band: where round-8 or trunc-8 of Python's value sits within
 * `band` of its edge; an 8-bit level left out but in a blurred frame.
 */
function bandOf(py: Float32Array, lo: number, hi: number, band: number, per: number, sums: Set<number>): { round: Set<number>; trunc: Set<number> } {
  const levels = new Set(Array.from({ length: 256 }, (_, k) => Math.fround(k / 255)))
  const round = new Set<number>()
  const trunc = new Set<number>()
  for (let i = lo; i < hi; i++) {
    const v = py[i]!
    if (levels.has(v) && !sums.has(Math.floor(i / per))) continue
    const r = Math.fround(Math.min(1, Math.max(0, v)) * 255)
    if (Math.abs(r - Math.floor(r) - 0.5) < band) round.add(i)
    const t = Math.fround(255 * v)
    if (Math.abs(t - Math.round(t)) < band && t > 0 && t < 255) trunc.add(i)
  }
  return { round, trunc }
}

/** The 8-bit form with the band's places zeroed (the fixture's masked sha256). */
function masked(b: Uint8Array, at: readonly number[]): Uint8Array {
  const out = b.slice()
  for (const i of at) out[i] = 0
  return out
}

/**
 * Rule 5 for an 8-bit form of a LIBRARY case: equal to Python's everywhere
 * but the band, and there at most one step from Python's. `py8` is Python's
 * whole form when the case is small; else the fixture's masked sha256 and
 * Python's values at the band.
 */
function expect8(got: Uint8Array, c: VfxRun, form: 'round' | 'trunc', py8: Uint8Array | null, band: VfxBand | { round: Set<number>; trunc: Set<number> }) {
  if (py8) {
    const allowed = (band as { round: Set<number>; trunc: Set<number> })[form]
    const off: number[] = []
    for (let i = 0; i < got.length; i++) {
      if (got[i] === py8[i]) continue
      if (!allowed.has(i) || Math.abs(got[i]! - py8[i]!) > 1) off.push(i)
    }
    expect(off.slice(0, 8), `${form}-8 off the band (${off.length} places)`).toEqual([])
    return
  }
  const b = band as VfxBand
  const at = b[form]
  expect(sha256(masked(got, at)), `${form}-8 off the band`).toBe(b[`${form}8_masked_sha256`])
  const py = b[`${form}_py`]!
  for (let k = 0; k < at.length; k++) expect(Math.abs(got[at[k]!]! - py[k]!), `${form}-8 on the band at ${at[k]}`).toBeLessThanOrEqual(1)
}

/** Python's round-8 and trunc-8 of a whole case, from its float32 (as the fixture script computes them). */
function py8Of(py: Float32Array): { round: Uint8Array; trunc: Uint8Array } {
  const round = new Uint8Array(py.length)
  const trunc = new Uint8Array(py.length)
  for (let i = 0; i < py.length; i++) {
    const r = Math.fround(Math.min(1, Math.max(0, py[i]!)) * 255)
    const fl = Math.floor(r)
    round[i] = r - fl === 0.5 ? (fl % 2 === 0 ? fl : fl + 1) : Math.round(r)
    const t = Math.fround(255 * py[i]!)
    trunc[i] = Math.min(255, Math.max(0, Math.trunc(t)))
  }
  return { round, trunc }
}

describe('the fixture', () => {
  it('was made from the real nodes at torch’s own thread count, over rule 13’s case set and the brief’s', () => {
    expect(FX.threads.torch).toBeGreaterThan(1)
    const classes = new Set(FX.runs.map(r => r.class_type))
    expect([...classes].sort()).toEqual(['Transition', 'VideoCrossfade'])
    // Python raises nowhere over these inputs (a kept batch always has a frame).
    expect(FX.runs.filter(r => r.error)).toEqual([])
    for (const cls of classes) {
      for (const clip of ['clip8', 'clip8-odd', 'clip2', 'clip1', 'clip8-big']) expect(FX.runs.some(r => r.class_type === cls && r.input === clip), `${cls} over ${clip}`).toBe(true)
      // clip8 and clip6-small in both orders: B resized down and up.
      for (const [a, b] of [['clip8', 'clip6-small'], ['clip6-small', 'clip8']]) expect(FX.runs.some(r => r.class_type === cls && r.input === a && r.input_b === b), `${cls} ${a} + ${b}`).toBe(true)
      const of = FX.runs.filter(r => r.class_type === cls)
      for (const curve of ['linear', 'ease_in_out', 'ease_in', 'ease_out']) expect(of.some(r => r.widgets.curve === curve), `${cls} ${curve}`).toBe(true)
      // duration 1, 3 and past both lengths.
      for (const d of [1, 3]) expect(of.some(r => r.widgets.duration === d), `${cls} duration ${d}`).toBe(true)
      expect(of.some(r => (r.widgets.duration as number) > Math.max(FX.clips[r.input]!.frames, FX.clips[r.input_b!]!.frames)), `${cls} past both`).toBe(true)
    }
    for (const style of ['dissolve', 'whip_pan_left', 'whip_pan_right', 'zoom_in', 'zoom_out', 'glitch', 'light_leak']) {
      for (const curve of ['linear', 'ease_in_out', 'ease_in', 'ease_out']) expect(FX.runs.some(r => r.widgets.style === style && r.widgets.curve === curve), `${style} ${curve}`).toBe(true)
    }
    // Crossfade's trims at their edges: a trim in at the last frame and past it, a trim out at 0, before its trim in, at the end.
    const xf = FX.runs.filter(r => r.class_type === 'VideoCrossfade').map(r => r.widgets)
    expect(xf).toContainEqual(expect.objectContaining({ trim_in_a: 7, trim_out_a: -1 }))
    expect(xf).toContainEqual(expect.objectContaining({ trim_in_a: 8 }))
    expect(xf).toContainEqual(expect.objectContaining({ trim_out_a: 0 }))
    expect(xf).toContainEqual(expect.objectContaining({ trim_in_a: 5, trim_out_a: 2 }))
    expect(xf).toContainEqual(expect.objectContaining({ trim_in_b: 4, trim_out_b: 1 }))
    expect(xf).toContainEqual(expect.objectContaining({ trim_out_a: 100000 }))
    // The glitch under three seeds, one past 2³².
    const seeds = new Set(FX.runs.filter(r => r.widgets.style === 'glitch').map(r => r.seed))
    expect([...seeds].sort()).toEqual(['0', '12345', String(2n ** 64n - 1n)])
  })

  it('the layout is Python’s: every output count is head + d + tail', () => {
    for (const c of FX.runs) {
      const [a, b] = joinInputs(c)
      const params = mediaEffectParams(MEDIA_EFFECT_SCHEMAS[c.class_type], c.widgets)
      const L = VIDEO_EFFECTS[c.class_type]!.joinOf!(params, [{ count: a.frames.length, w: a.w, h: a.h, exact: true }, { count: b.frames.length, w: b.w, h: b.h, exact: true }])
      expect({ a: L.a, b: L.b, d: L.d, head: L.head, tail: L.tail }, c.name).toEqual(c.layout)
      expect(L.trans, c.name).toBe(L.d)
      expect(VIDEO_EFFECTS[c.class_type]!.shape(params, [{ count: a.frames.length, w: a.w, h: a.h, exact: true }, { count: b.frames.length, w: b.w, h: b.h, exact: true }]), c.name)
        .toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h, exact: true })
    }
  })
})

describe('the glitch’s decisions are Python’s under every fixture seed (ruling (e))', () => {
  const glitches = FX.runs.filter(r => r.glitch)
  it('covers every glitch case', () => {
    expect(glitches.length).toBe(FX.runs.filter(r => r.widgets.style === 'glitch').length)
    expect(glitches.length).toBeGreaterThan(15)
  })
  for (const c of glitches) {
    it(c.name, () => {
      const g = c.glitch!
      const alphas = videoCores.join.alphaOf(g.d, c.widgets.curve)
      for (let i = 0; i < g.d; i++) {
        const want = g.frames[i]!
        expect(alphas[i], `alpha ${i}`).toBe(want.t)
        const got = videoCores.join.glitchShifts(alphas, i, BigInt(c.seed!))
        expect([...got], `frame ${i}'s shifts`).toEqual(want.dx)
        expect(got.length, `frame ${i}'s bands`).toBe(want.slices)
      }
    })
  }
})

describe('the core on this thread gives Python’s float32 by its class', () => {
  for (const c of FX.runs) {
    it(`${c.class_type}: ${c.name}`, () => {
      const [a, b] = joinInputs(c)
      const got = coreJoinBatch(c.class_type, c.widgets, a, b, c.seed)
      const want = c.out!
      expect({ count: got.count, w: got.w, h: got.h }).toEqual({ count: want.count, w: want.w, h: want.h })
      if (!isLibrary(c)) {
        expect(sha256(got.f32), 'float32').toBe(want.f32_sha256)
        expect(sha256(got.round8), 'round-8').toBe(want.round8_sha256)
        expect(sha256(got.trunc8), 'trunc-8').toBe(want.trunc8_sha256)
        return
      }
      const f = new Float32Array(got.f32.buffer, got.f32.byteOffset, got.f32.byteLength / 4)
      const [lo, hi] = transRange(c)
      if (want.f32) {
        const py = new Float32Array(b64(want.f32).buffer)
        let worst = 0
        for (let i = 0; i < py.length; i++) {
          const dd = Math.abs(f[i]! - py[i]!)
          // Outside the transition every frame is EXACT (selection, the exact resize).
          if (i < lo || i >= hi) expect(dd, `outside the transition, at ${i}`).toBe(0)
          worst = Math.max(worst, dd)
        }
        expect(worst, 'LIBRARY: the worst difference').toBeLessThanOrEqual(JOIN_EPS)
        const band = bandOf(py, lo, hi, FX.band!, want.w * want.h * 3, blurredFrames(c))
        const p8 = py8Of(py)
        expect8(got.round8, c, 'round', p8.round, band)
        expect8(got.trunc8, c, 'trunc', p8.trunc, band)
      }
      else {
        expect8(got.round8, c, 'round', null, c.band!)
        expect8(got.trunc8, c, 'trunc', null, c.band!)
      }
    })
  }
})

// ── Through the node's plan, with the real stores and tools ──────────────────

/** Both clips kept as FFV1 batches of one run (as Get video components keeps them), and the values the join reads. */
async function keptPair(h: ReturnType<typeof vfxHarness>, runId: string, a: { frames: Uint8Array[]; w: number; h: number }, b: { frames: Uint8Array[]; w: number; h: number }) {
  const va = await keptBatch(h, runId, a)
  const vb = await keptBatch(h, runId, b)
  return { va, vb, values: { g: { 0: va }, h: { 0: vb } } as Record<string, Record<number, RunnerValue>> }
}

/** One frame of an 8-bit batch. */
const frameOf = (b: Uint8Array, j: number, per: number) => b.subarray(j * per, (j + 1) * per)

describe('through the node’s plan: the kept batch, the preview and the ui are Python’s', () => {
  for (const c of FX.runs) {
    it(`${c.class_type}: ${c.name}`, LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const [a, b] = joinInputs(c)
      const { va, vb, values } = await keptPair(h, runId, a, b)
      const id = c.node_id
      const want = c.out!
      const per = want.w * want.h * 3
      const py = want.f32 ? py8Of(new Float32Array(b64(want.f32).buffer)) : null
      const band = want.f32 && isLibrary(c) ? bandOf(new Float32Array(b64(want.f32).buffer), ...transRange(c), FX.band!, per, blurredFrames(c)) : c.band
      SEED.override = c.seed !== undefined ? BigInt(c.seed) : null
      SEED.seen.length = 0
      const before = PROCS.pids.length
      DECODES.most = 0
      let trunc8: Uint8Array | null = null
      const made8: string[] = []
      try {
        for (const [quant, reader, sha] of [['trunc', saveFrames(id), want.trunc8_sha256], ['round', trimOf(id), want.round8_sha256]] as const) {
          const prompt: ApiPrompt = { ...sources(), [id]: joined(c), r: reader }
          const made = await runVfxNode(h, prompt, id, values, { runId, families: ON })
          const v = made.values[0]!
          expect(v.kind, quant).toBe('frames')
          const batch = v as Extract<RunnerValue, { kind: 'frames' }>
          made8.push(batch.file.filename)
          expect({ count: batch.count, w: batch.w, h: batch.h }, quant).toEqual({ count: want.count, w: want.w, h: want.h })
          const bytes = await batchBytes(h, runId, batch)
          if (!isLibrary(c)) expect(sha256(bytes), `${quant}-8 frames`).toBe(sha)
          else expect8(bytes, c, quant, py ? py[quant] : null, band!)
          if (quant === 'trunc') trunc8 = bytes
          // Python's ui, with the runner's own preview folder (R2's: results.ts LOCAL_LIVE_PREVIEW_SUBFOLDER).
          expect(made.ui, 'ui').toEqual({ ...c.ui, images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: LOCAL_LIVE_PREVIEW_SUBFOLDER, type: im.type })) })
          const p = await previewPixels(h, (made.ui as { images: OutputFile[] }).images[0]!)
          expect({ w: p.w, h: p.h, channels: p.channels }, 'preview').toEqual({ w: c.preview!.w, h: c.preview!.h, channels: 3 })
          // The preview is trunc-8 of frame T // 2 (rule 9): Python's, by the batch's class (the trunc-8 frame checked above).
          if (!isLibrary(c)) expect(sha256(p.px), 'preview pixels').toBe(c.preview!.sha256)
          else expect(sha256(p.px), 'preview pixels: the checked trunc-8 frame T // 2').toBe(sha256(frameOf(trunc8!, Math.floor(want.count / 2), per)))
        }
      }
      finally { SEED.override = null }
      // One lease's processes: two decodes at most at once, the encode; the glitch seeded (only the glitch).
      expect(DECODES.most, 'decodes open at once').toBeLessThanOrEqual(2)
      expect(PROCS.pids.length - before).toBeGreaterThanOrEqual(4)
      expect(SEED.seen.length, 'seeded').toBe(c.widgets.style === 'glitch' ? 2 : 0)
      // Nothing kept but the inputs and the two outputs (equal bytes are one file: a join of one frame each is A's).
      expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual([...new Set([va.file.filename, vb.file.filename, ...made8])].sort())
    })
  }
})

describe('the glitch’s own seed (ruling (e)): its settings and its two clips', () => {
  const glitchCase = { class_type: 'Transition', widgets: { style: 'glitch', duration: 6, curve: 'linear' } }
  it('glitchSeed: the first 8 bytes of the sha256 of the widget values and the clips’ kept sha256, in order', () => {
    const schema = MEDIA_EFFECT_SCHEMAS.Transition
    const a = { filename: `${'a'.repeat(64)}.mkv` }
    const b = { filename: `${'b'.repeat(64)}.mkv` }
    const s = glitchSeed(schema, glitchCase.widgets, [a, b])
    expect(typeof s).toBe('bigint')
    expect(s).toBeLessThan(2n ** 64n)
    expect(glitchSeed(schema, glitchCase.widgets, [a, b])).toBe(s)
    expect(glitchSeed(schema, { ...glitchCase.widgets, duration: 7 }, [a, b])).not.toBe(s)
    expect(glitchSeed(schema, glitchCase.widgets, [b, a])).not.toBe(s)
    expect(() => glitchSeed(schema, glitchCase.widgets, [{ filename: 'x.mkv' }, b])).toThrow()
  })

  it('the same on a rerun, and different when a widget changes', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const { values } = await keptPair(h, runId, clipFrames(FX, 'clip8'), clipFrames(FX, 'clip8-odd'))
    const run = async (widgets: Record<string, unknown>) => {
      SEED.seen.length = 0
      const made = await runVfxNode(h, { ...sources(), e: joined({ class_type: 'Transition', widgets }), r: trimOf('e') }, 'e', values, { runId, families: ON })
      return { seed: SEED.seen[0]!, v: made.values[0] as Extract<RunnerValue, { kind: 'frames' }> }
    }
    const first = await run(glitchCase.widgets)
    const again = await run(glitchCase.widgets)
    expect(again.seed).toBe(first.seed)
    expect(again.v.file.filename, 'the same frames').toBe(first.v.file.filename)
    // Its frames are the core's under that seed (the core is Python's under Python's seed, above).
    const core = coreJoinBatch('Transition', glitchCase.widgets, clipFrames(FX, 'clip8'), clipFrames(FX, 'clip8-odd'), first.seed)
    expect(sha256(await batchBytes(h, runId, first.v))).toBe(sha256(core.round8))
    const other = await run({ ...glitchCase.widgets, curve: 'ease_in' })
    expect(other.seed).not.toBe(first.seed)
    expect(other.v.file.filename).not.toBe(first.v.file.filename)
    // Only the glitch is seeded.
    SEED.seen.length = 0
    await runVfxNode(h, { ...sources(), e: joined({ class_type: 'Transition', widgets: { ...glitchCase.widgets, style: 'dissolve' } }), r: trimOf('e') }, 'e', values, { runId, families: ON })
    expect(SEED.seen).toEqual([])
  })
})

describe('effect → Create video → Save video saves Python’s frames (R5 rule 3: Python’s own pipeline on libopenh264)', () => {
  for (const c of FX.saved) {
    it(`${c.class_type} ${JSON.stringify(c.widgets)}`, LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const { values } = await keptPair(h, runId, clipFrames(FX, c.input), clipFrames(FX, c.input_b!))
      const prompt: ApiPrompt = { ...sources(), e: joined(c), c: createVideo('e'), s: saveVideo('c') }
      SEED.override = c.seed !== undefined ? BigInt(c.seed) : null
      try { values.e = (await runVfxNode(h, prompt, 'e', values, { runId, families: ON })).values }
      finally { SEED.override = null }
      values.c = (await runVfxNode(h, prompt, 'c', values, { runId, families: ON })).values
      const saved = await runVfxNode(h, prompt, 's', values, { runId, families: ON })
      expect(saved.ui).toEqual(c.x264.ui)
      const path = h.results.pathOf!((saved.ui as { images: OutputFile[] }).images[0]!)
      const p = await probeMedia(path, { userId: null, roots: [join(path, '..')] })
      expect(p.video.map(v => ({ w: v.w, h: v.h, codec: v.codec, pixFmt: v.pixFmt, frames: v.frames })))
        .toEqual(c.openh264.header.video.map(v => ({ w: v.w, h: v.h, codec: v.codec, pixFmt: v.pixFmt, frames: v.frames })))
      expect(await pyFrameCount(p, p.path, { userId: null })).toBe(c.openh264.frameCount)
      expect(pyFrameRate(p)).toEqual(c.openh264.frameRate)
      const frames: string[] = []
      await decodeFrames(path, { userId: null, maxFrames: 1e6, roots: [join(path, '..')], onFrame: async (f) => { frames.push(sha256(f)) } })
      expect(frames, 'frames equal to Python’s pipeline on libopenh264').toEqual(c.openh264.frames)
    })
  }
})

describe('the family', () => {
  it('with video-join off, a workflow with a join is left to the engine and the join named', () => {
    for (const cls of ['VideoCrossfade', 'Transition']) {
      expect(MEDIA_EFFECTS_PORTED).toContain(cls)
      expect(MEDIA_EFFECT_OUTPUT_NODES).toContain(cls)
      expect(mediaEffectSwitchedClasses()[cls]).toBe('video-join')
      expect(FRAMES_OUTPUTS.map(x => x.join(':'))).toContain(`${cls}:0`)
      const c = FX.runs.find(r => r.class_type === cls)!
      const p: ApiPrompt = { ...sources(), e: joined(c), c: createVideo('e'), s: saveVideo('c') }
      expect(runnerTakesWorkflow(p, ON), cls).toBe(true)
      for (const fam of [OFF_VIDEO_JOIN, new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['video-join', 'media-video'])]) {
        expect(runnerTakesWorkflow(p, fam), cls).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }), cls).toContain('e')
      }
      // A still picture wired into a clip leaves the workflow to the engine (ruling (k)).
      const still: ApiPrompt = { ...p, i: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, e: { ...p.e!, inputs: { ...p.e!.inputs, clip_b: ['i', 0] } } }
      expect(runnerTakesWorkflow(still, ON), `${cls}, a still picture`).toBe(false)
    }
  })

  it('rule 12 over the synthetic graphs: with every R6 family off, or on with the tools missing or their media families off, every answer is the pinned one from before R6.1', () => {
    const pin = rule12Pin()
    for (const name of ['synthetic VideoCrossfade', 'synthetic Transition']) {
      const g = pin.graphs[name]!
      for (const [set, fam] of Object.entries(pin.sets)) expect(hash16(invariantAnswers(g.prompt, new Set(fam as RunnerFamily[]))), `${name}, ${set}`).toBe(g.answers[set])
      // Teeth: with video-join on, the graph answers otherwise.
      const on = new Set<RunnerFamily>([...pin.sets['every family before R6']! as RunnerFamily[], 'video-join'])
      expect(hash16(invariantAnswers(g.prompt, on)), name).not.toBe(g.answers['every family before R6'])
    }
    expect(PICTURE_OUTPUTS).toEqual(pin.pictureOutputs)
    for (const cls of ['VideoCrossfade', 'Transition']) expect(Object.hasOwn(PICTURE_OUTPUTS, cls), cls).toBe(false)
  })
})

describe('nothing is held: the two clips are read side by side', () => {
  it('heldBytes counts two frames in hand and the worker’s planes, not the overlap; well under the hosted limit at 1080p', () => {
    const hd = { count: 600, w: 1920, h: 1080, exact: true }
    for (const cls of ['VideoCrossfade', 'Transition']) {
      const spec = VIDEO_EFFECTS[cls]!
      const w = cls === 'VideoCrossfade'
        ? { duration: 2400, curve: 'linear', trim_in_a: 0, trim_out_a: -1, trim_in_b: 0, trim_out_b: -1 }
        : { style: 'whip_pan_left', duration: 240, curve: 'linear' }
      const fig = spec.heldBytes(w, [hd, hd])
      expect(fig).toBe(effectHeldBytes({ count: 1, w: 1, h: 1920 * 1080, exact: true }, { reads: 2, state32: 3 }))
      expect(fig).toBeLessThan(MEDIA_CAPS.hosted.heldFrameBytes)
      // The larger clip sizes the figure (B at 4K into a 1080p A).
      expect(spec.heldBytes(w, [hd, { count: 10, w: 3840, h: 2160, exact: true }])).toBeGreaterThan(fig)
    }
  })

  it('the output count only grows with either clip (a bound in gives a bound out)', () => {
    for (const cls of ['VideoCrossfade', 'Transition']) {
      const spec = VIDEO_EFFECTS[cls]!
      for (const w of cls === 'VideoCrossfade'
        ? [{ duration: 3, curve: 'linear', trim_in_a: 2, trim_out_a: 6, trim_in_b: 5, trim_out_b: 2 }, { duration: 12, curve: 'linear', trim_in_a: 0, trim_out_a: -1, trim_in_b: 4, trim_out_b: -1 }]
        : [{ style: 'dissolve', duration: 5, curve: 'linear' }, { style: 'glitch', duration: 240, curve: 'linear' }]) {
        for (let ta = 1; ta < 14; ta++) {
          for (let tb = 1; tb < 14; tb++) {
            const n = (x: number, y: number) => spec.shape(w, [{ count: x, w: 4, h: 4, exact: false }, { count: y, w: 4, h: 4, exact: false }]).count
            expect(n(ta + 1, tb), `${cls} ${ta} ${tb}`).toBeGreaterThanOrEqual(n(ta, tb))
            expect(n(ta, tb + 1), `${cls} ${ta} ${tb}`).toBeGreaterThanOrEqual(n(ta, tb))
          }
        }
      }
    }
  })

  it('the start pass leaves a join over the hosted work budget to the engine', async () => {
    const p: ApiPrompt = { ...sources(), e: joined({ class_type: 'Transition', widgets: { style: 'whip_pan_left', duration: 240, curve: 'linear' } }), c: createVideo('e'), s: saveVideo('c') }
    const shapes = (count: number) => new Map([['g:0', { count, w: 1920, h: 1080, exact: true }], ['h:0', { count, w: 1920, h: 1080, exact: true }]])
    expect(await mediaEffectStartProblems(p, ON, { hosted: true, shapes: shapes(1200) })).toMatchObject({ nodeId: 'e', engine: true })
    expect(await mediaEffectStartProblems(p, ON, { hosted: false, shapes: shapes(1200) })).toBeNull()
    expect(await mediaEffectStartProblems(p, ON, { hosted: true, shapes: shapes(24) })).toBeNull()
  })

  it('reads each output frame’s A and B frames in order, each clip only forward', () => {
    const L = videoCores.join.layout({ duration: 3, curve: 'linear', trim_in_a: 2, trim_out_a: 7, trim_in_b: 1, trim_out_b: 5 }, 8, 6)
    const reads = joinReads(L, 24, 16)
    expect(reads.map(r => [r.a, r.b, r.own._part])).toEqual([
      [2, null, 'a'], [3, null, 'a'], [4, 1, 'mix'], [5, 2, 'mix'], [6, 3, 'mix'], [null, 4, 'b'],
    ])
  })
})

/** Rejects when `p` takes longer than `ms` (a hang shows as a quick failure, not a stuck run). */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} hung for ${ms} ms`)), ms) })]).finally(() => clearTimeout(t))
}

describe('a decode left early never hangs the node, its lease or its writer (R6.3 fix)', () => {
  // The hang: a reader let go of a decode whose tool had already written every frame and exited; the frame in
  // hand was dropped by the channel's failure, so its callback ended cleanly, and the tool's output stayed
  // paused with bytes in it. 'close' never came: the decode, the lease and the node's FFV1 writer waited forever.
  it('framesOf, left after the first frame once the decoder has exited: settles at once, twenty times over, no ffmpeg left', async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const v = await keptBatch(h, runId, { frames: Array.from({ length: 8 }, (_, i) => new Uint8Array(24 * 16 * 3).fill(i * 9)), w: 24, h: 16 })
    const io = mediaIo(h, runId)
    const before = PROCS.pids.length
    for (let k = 0; k < 20; k++) {
      await within(mediaLease({ userId: null }, async (lease) => {
        const it = framesOf(v, io, lease)[Symbol.asyncIterator]()
        await it.next()
        // Long enough for the tool to write all eight frames and exit.
        await new Promise(r => setTimeout(r, 150))
        await it.return!(undefined)
      }), 3000, `leaving the decode (${k})`)
    }
    const pids = PROCS.pids.slice(before)
    expect(pids.length).toBe(20)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
  }, 30_000)

  it('a join reading one frame of A (trim_out_a 0), twenty times: every run ends, no ffmpeg left, only the inputs and its output kept', async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const { va, vb, values } = await keptPair(h, runId, clipFrames(FX, 'clip8'), clipFrames(FX, 'clip6-small'))
    const c = { class_type: 'VideoCrossfade', widgets: { duration: 12, curve: 'linear', trim_in_a: 0, trim_out_a: 0, trim_in_b: 0, trim_out_b: -1 } }
    const before = PROCS.pids.length
    const made = new Set<string>()
    for (let k = 0; k < 20; k++) {
      const r = await within(runVfxNode(h, { ...sources(), e: joined(c), r: trimOf('e') }, 'e', values, { runId, families: ON }), 5000, `the join (${k})`)
      made.add((r.values[0] as Extract<RunnerValue, { kind: 'frames' }>).file.filename)
    }
    expect(made.size).toBe(1)
    const pids = PROCS.pids.slice(before)
    expect(pids.length).toBeGreaterThanOrEqual(60)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual([...new Set([va.file.filename, vb.file.filename, ...made])].sort())
  }, 60_000)
})

describe('Stop mid-join', () => {
  for (const [cls, widgets] of [
    ['VideoCrossfade', { duration: 12, curve: 'linear', trim_in_a: 0, trim_out_a: -1, trim_in_b: 0, trim_out_b: -1 }],
    ['Transition', { style: 'whip_pan_right', duration: 12, curve: 'ease_in_out' }],
  ] as const) {
    it(`${cls}: stopped in the overlap (both decodes and the encode running): no tool process left, no kept file but its inputs`, LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const W = 320
      const H = 240
      const { va, vb, values } = await keptPair(h, runId,
        { frames: Array.from({ length: 30 }, (_, i) => new Uint8Array(W * H * 3).fill(i * 7)), w: W, h: H },
        { frames: Array.from({ length: 30 }, (_, i) => new Uint8Array(160 * 120 * 3).fill(250 - i * 7)), w: 160, h: 120 })
      const before = PROCS.pids.length
      const ctl = new AbortController()
      HOOK.frames = 0
      HOOK.abortAt = 22
      HOOK.ctl = ctl
      try {
        await expect(runVfxNode(h, { ...sources(), e: joined({ class_type: cls, widgets }), r: trimOf('e') }, 'e', values, { runId, families: ON, signal: ctl.signal }))
          .rejects.toThrow(MEDIA_WORDS.stopped)
        expect(Date.now() - HOOK.abortedAt).toBeLessThan(1000)
      }
      finally { HOOK.abortAt = 0; HOOK.ctl = null }
      const pids = PROCS.pids.slice(before)
      // A's decode, B's decode and the encode.
      expect(pids.length).toBeGreaterThanOrEqual(3)
      for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
      expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual([va.file.filename, vb.file.filename].sort())
    })
  }
})

// ── The esbuild guard: the join core built as Nitro builds server code ───────

describe('esbuild guard: the join core survives Nitro’s build', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = existsSync(pnpm) ? readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild')) : []
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(scratch, 'esbuild-'))
  const A = clipFrames(FX, 'clip8')
  const B = clipFrames(FX, 'clip6-small')
  const here = (p: Record<string, unknown>) => {
    const r = videoCores.join.frame([videoCores.vx.fromRgb(A.frames[5]!, A.w, A.h), videoCores.vx.fromRgb(B.frames[1]!, B.w, B.h)], p)
    return [...videoCores.vx.toRgb(r.out, 'round')]
  }
  const cases = [
    { style: 'whip_pan_left', duration: 6, curve: 'ease_in_out', _part: 'mix', _i: 2, _d: 6 },
    { style: 'zoom_out', duration: 6, curve: 'ease_out', _part: 'mix', _i: 3, _d: 6 },
    { style: 'glitch', duration: 6, curve: 'linear', _part: 'mix', _i: 3, _d: 6, _seed: String(2n ** 64n - 1n) },
    { style: 'light_leak', duration: 6, curve: 'linear', _part: 'mix', _i: 2, _d: 6 },
  ]

  it('finds an esbuild to build with', () => {
    expect(builds.length).toBeGreaterThan(0)
  })

  for (const esbuildDir of builds) {
    for (const minify of [false, true]) {
      it(`${esbuildDir.split('/').at(-3)} target es2019, minify ${minify}: the source-text core runs in a Worker`, async () => {
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
        const jn = await build('video/core/join.ts', 'join')
        const cores = [
          { name: 'tk', fn: tk.tensorCore as never, args: ['px'] },
          { name: 'kn', fn: kn.kernelsCore as never, args: ['tk', 'px'] },
          { name: 'rng', fn: rng.rngCore as never, args: [] },
          { name: 'vx', fn: time.framesCore as never, args: ['tk'] },
          { name: 'join', fn: jn.joinCore as never, args: ['tk', 'kn', 'rng'] },
        ]
        const w = new Worker(workerScript(compositorCore, px.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m) })
          let id = 0
          for (const p of cases) {
            const r = await reply({ id: ++id, op: 'vfx.frame', fn: 'join.frame', params: p, index: 0, count: 1, inputs: [{ rgb: A.frames[5]!.slice(), w: A.w, h: A.h }, { rgb: B.frames[1]!.slice(), w: B.w, h: B.h }], quant: 'round', preview: false })
            expect(r.error, p.style).toBeUndefined()
            expect([...r.value.rgb], p.style).toEqual(here(p))
          }
          // B's tail at A's size.
          const rb = await reply({ id: ++id, op: 'vfx.frame', fn: 'join.frame', params: { style: 'dissolve', duration: 6, curve: 'linear', _part: 'b', _w: A.w, _h: A.h }, index: 0, count: 1, inputs: [{ rgb: B.frames[4]!.slice(), w: B.w, h: B.h }], quant: 'trunc', preview: true })
          expect(rb.error).toBeUndefined()
          expect([rb.value.w, rb.value.h]).toEqual([A.w, A.h])
          // The built core's own glitch shifts and layout.
          const pxc = px.pixelsCore!()
          const tkc = tk.tensorCore!(pxc)
          const built = jn.joinCore!(tkc, kn.kernelsCore!(tkc, pxc), rng.rngCore!()) as typeof videoCores.join
          const al = videoCores.join.alphaOf(8, 'ease_in_out')
          expect([...built.glitchShifts(built.alphaOf(8, 'ease_in_out'), 5, 12345n)]).toEqual([...videoCores.join.glitchShifts(al, 5, 12345n)])
          expect(built.layout({ duration: 3, curve: 'linear', trim_in_a: 2, trim_out_a: 7, trim_in_b: 1, trim_out_b: 5 }, 8, 6)).toEqual(videoCores.join.layout({ duration: 3, curve: 'linear', trim_in_a: 2, trim_out_a: 7, trim_in_b: 1, trim_out_b: 5 }, 8, 6))
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})

/**
 * The frame looks, family `video-look` (server/runner/video/, R6.4): Ken
 * Burns, Aspect convert, Chroma key, LUT and 3-way color, against the real
 * Python (scripts/runner_media_fixtures.py --group vfx-look: each case the
 * node's own execute with its hidden unique_id set).
 *
 * R6 rule 14, for every fixture case:
 *   - the core, called on this thread, gives Python's float32 by its parity
 *     class: EXACT (Aspect convert's pad and crop_center, Chroma key, the LUT,
 *     3-way color at gamma 1) bit for bit; BAND (auto_pan's edge: Python's,
 *     but where two of Python's own scores sit within LOOK_TIE); LIBRARY (Ken
 *     Burns' affine_grid and cos, 3-way color's pow) within LOOK_EPS, the
 *     8-bit forms equal but on rule 5's band, and there one step at most;
 *   - through the node's plan with the real stores and tools, the kept batch
 *     decodes to Python's round-8 frames (another effect reads it) and
 *     trunc-8 frames (only an encoder reads it), by the same class; the
 *     preview and the ui are Python's.
 * Plus: the LUT's parse equals Python's; a broken LUT is refused plainly
 * before the hold (the matching rule: Python hands the frames on silently);
 * hosted, a `../grade.cube` name is refused by the name alone and another
 * person's LUT before the run; Chroma key with its mask wired, and a still
 * picture into 3-way color, leave the workflow to the engine; effect →
 * Create video → Save video saves Python's frames; the family off leaves the
 * workflow to the engine; rule 12; Stop mid-effect and an early leave leave
 * no process; the core survives Nitro's build.
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
import type { RunnerFamily } from '#shared/runner/families'
import { FRAMES_OUTPUTS, MEDIA_EFFECTS_PORTED, MEDIA_EFFECT_OUTPUT_NODES, MEDIA_EFFECT_WORDS, mediaEffectRows, mediaEffectSwitchedClasses } from '#shared/runner/mediaEffects'
import { PICTURE_OUTPUTS } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
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
import { LUT_WORDS, parseCubeLut } from '~~/server/runner/video/core/look'
import { LUT_HOSTED_MAX_SIZE, VIDEO_EFFECTS, mediaEffectParams } from '~~/server/runner/video/table'
import { lutStartProblems, mediaEffectStartProblems } from '~~/server/runner/video/start'
import { NOT_YOURS, assertFilesOwned, collectInputFiles, unsafeLutNames } from '~~/server/runner/inputs'
import { requireMediaTools, clipPath } from './__runner__/mediaParity'
import { makeKit } from './__runner__/kit'
import { createFileKeptBytes } from '~~/server/runner/keptBytes'
import {
  b64, batchBytes, clipFrames, coreBatch, hash16, invariantAnswers, keptBatch, mediaIo, previewPixels, rule12Pin, runVfxNode, sha256, vfxFixture, vfxHarness, vfxRunId,
  type VfxBand, type VfxRun,
} from './__runner__/mediaEffectsParity'

const FX = vfxFixture('vfx-look')
const LONG = { timeout: 120_000 }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-look'])
const OFF_VIDEO_LOOK: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-time', 'video-join'])
const LOOKS = ['KenBurns', 'AspectConvert', 'ChromaKey', 'LUT', 'ThreeWayCC'] as const
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const scratch = mkdtempSync(join(tmpdir(), 'media-vfx-look-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let runs = 0

type Link = [string, number]
type Clip = { frames: Uint8Array[]; w: number; h: number }

/** A case's input: a standard clip, or one of the group's own (recorded whole). */
function lookClip(name: string): Clip {
  const x = FX.extraClips?.[name]
  if (!x) return clipFrames(FX, name)
  const all = b64(x.u8)
  const per = x.w * x.h * 3
  return { frames: Array.from({ length: x.frames }, (_, i) => all.slice(i * per, (i + 1) * per)), w: x.w, h: x.h }
}

/** The input a class reads its frames on (3-way color's is `image`). */
const inputOf = (cls: string) => MEDIA_EFFECT_SCHEMAS[cls]!.frames[0]!.name

const getComp = (from = 'l') => ({ class_type: 'GetVideoComponents', inputs: { video: [from, 0] as Link } })
const loadVideo = (file = 'a.mp4') => ({ class_type: 'LoadVideo', inputs: { file } })
const looked = (c: { class_type: string; widgets: Record<string, unknown> }, from = 'g') => ({ class_type: c.class_type, inputs: { [inputOf(c.class_type)]: [from, 0] as Link, ...c.widgets } })
const trimOf = (from: string) => ({ class_type: 'VideoTrim', inputs: { frames: [from, 0] as Link, start: 0, end: -1 } })
const saveFrames = (from: string) => ({ class_type: 'SaveVideoFrames', inputs: { frames: [from, 0] as Link, fps: 24, filename_prefix: 'video', audio_file: '(none)', preset: 'veryfast', crf: 20 } })
const createVideo = (from: string) => ({ class_type: 'CreateVideo', inputs: { images: [from, 0] as Link, fps: 24 } })
const saveVideo = (from: string) => ({ class_type: 'SaveVideo', inputs: { video: [from, 0] as Link, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })
const sources = () => ({ l: loadVideo('a.mp4'), g: getComp('l') })

/** The LUT file a case names, or null ('(none)', empty). */
const lutOf = (c: { class_type: string; widgets: Record<string, unknown> }) => {
  const f = c.class_type === 'LUT' ? String(c.widgets.lut_file) : ''
  return f && f !== '(none)' ? f : null
}
/** A case the runner refuses before the hold where Python hands the frames on silently (the broken LUT). */
const refused = (c: VfxRun) => lutOf(c) === 'broken.cube'
/** The table a LUT case carries, as the plan reads it. */
function tableOf(c: VfxRun): ArrayBuffer | undefined {
  const f = lutOf(c)
  if (!f) return undefined
  const r = parseCubeLut(new TextEncoder().encode(FX.cubes![f]!))
  if ('error' in r) throw new Error(r.error)
  return r.table.buffer as ArrayBuffer
}

/** A case's parity class (the brief's). */
const isLibrary = (c: { class_type: string; widgets: Record<string, unknown> }) =>
  (c.class_type === 'KenBurns' && c.widgets.easing === 'ease_in_out') || (c.class_type === 'ThreeWayCC' && ['gamma_r', 'gamma_g', 'gamma_b'].some(k => Number(c.widgets[k]) !== 1))

/**
 * LIBRARY's ε (rule 5), on Python's float32 values: measured worst over the
 * fixture 5.96 × 10⁻⁸, one ulp (Ken Burns' ease_in_out: torch's cos; 3-way
 * color: pow); bound 2⁻²¹ (255-scale 1.2 × 10⁻⁴, far under rule 5's 2⁻⁸).
 */
const LOOK_EPS = 2 ** -21
/** BAND for auto_pan (rule 5): another edge only where Python's own scores there and at its edge are this close, relatively. */
const LOOK_TIE = 2 ** -20

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

/** Rule 5's band from Python's own float32 (whole cases), as the fixture script's vfx_band (an 8-bit level left out). */
function bandOf(py: Float32Array, band: number): { round: Set<number>; trunc: Set<number> } {
  const levels = new Set(Array.from({ length: 256 }, (_, k) => Math.fround(k / 255)))
  const round = new Set<number>()
  const trunc = new Set<number>()
  for (let i = 0; i < py.length; i++) {
    const v = py[i]!
    if (levels.has(v)) continue
    const r = Math.fround(Math.min(1, Math.max(0, v)) * 255)
    if (Math.abs(r - Math.floor(r) - 0.5) < band) round.add(i)
    const t = Math.fround(255 * v)
    if (Math.abs(t - Math.round(t)) < band && t > 0 && t < 255) trunc.add(i)
  }
  return { round, trunc }
}

const masked = (b: Uint8Array, at: readonly number[]) => {
  const out = b.slice()
  for (const i of at) out[i] = 0
  return out
}

/** Rule 5 for an 8-bit form of a LIBRARY case: Python's everywhere but the band, and there one step at most. */
function expect8(got: Uint8Array, form: 'round' | 'trunc', py8: Uint8Array | null, band: VfxBand | { round: Set<number>; trunc: Set<number> }) {
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

const f32Of = (s: string) => new Float32Array(b64(s).buffer)

/** auto_pan's edges on this thread against Python's: equal, or Python's own two scores within LOOK_TIE. Whether every edge is Python's. */
function checkAutoPan(c: VfxRun, input: Clip): boolean {
  const L = videoCores.look.aspectLayout(mediaEffectParams(MEDIA_EFFECT_SCHEMAS.AspectConvert, c.widgets), input.w, input.h)
  let same = true
  for (let i = 0; i < input.frames.length; i++) {
    const py = c.autopan![i]!
    const got = videoCores.look.autoPanScores(videoCores.vx.fromRgb(input.frames[i]!, input.w, input.h), L)
    const scores = f32Of(py.scores)
    const variance = f32Of(py.var)
    // The variances (torch's Welford in double, rounded once) and the scores (a conv1d sum) within an ulp or two.
    for (let k = 0; k < variance.length; k++) expect(Math.abs(got.variance[k]! - variance[k]!), `frame ${i} variance ${k}`).toBeLessThanOrEqual(Math.abs(variance[k]!) * 2 ** -22)
    for (let k = 0; k < scores.length; k++) expect(Math.abs(got.scores[k]! - scores[k]!), `frame ${i} score ${k}`).toBeLessThanOrEqual(Math.abs(scores[k]!) * 2 ** -21)
    if (got.edge === py.edge) continue
    same = false
    expect(Math.abs(scores[got.edge]! - scores[py.edge]!), `frame ${i}: edge ${got.edge} against Python's ${py.edge}`).toBeLessThanOrEqual(Math.abs(scores[py.edge]!) * LOOK_TIE)
  }
  return same
}

// ── The fixture ──────────────────────────────────────────────────────────────

describe('the fixture', () => {
  it('was made from the real nodes at torch’s own thread count, over rule 13’s case set and the brief’s', () => {
    expect(FX.threads.torch).toBeGreaterThan(1)
    expect([...new Set(FX.runs.map(r => r.class_type))].sort()).toEqual([...LOOKS].sort())
    // Python raises nowhere over these inputs (a broken LUT is printed and passed over).
    expect(FX.runs.filter(r => r.error)).toEqual([])
    for (const cls of LOOKS) {
      for (const clip of ['clip8', 'clip8-odd', 'clip2', 'clip1', 'clip8-big']) expect(FX.runs.some(r => r.class_type === cls && r.input === clip), `${cls} over ${clip}`).toBe(true)
    }
    // Every target and method of Aspect convert on clip8 and on clip8 turned upright.
    for (const clip of ['clip8', 'clip8-tall']) {
      for (const t of MEDIA_EFFECT_SCHEMAS.AspectConvert!.widgets.target!.options!) {
        for (const m of MEDIA_EFFECT_SCHEMAS.AspectConvert!.widgets.method!.options!) expect(FX.runs.some(r => r.class_type === 'AspectConvert' && r.input === clip && r.widgets.target === t && r.widgets.method === m), `${t} ${m} ${clip}`).toBe(true)
      }
    }
    // Chroma key on a green screen at the tolerance and smoothness edges.
    const keyed = FX.runs.filter(r => r.class_type === 'ChromaKey' && r.input === 'clip-green').map(r => r.widgets)
    for (const [t, s] of [[0, 0], [1, 0.5], [0.25, 0], [0.1, 0.5]]) expect(keyed).toContainEqual(expect.objectContaining({ tolerance: t, smoothness: s }))
    // Each LUT file at strength 0, 0.5 and 1.
    for (const f of ['identity.cube', 'warm.cube', 'broken.cube']) {
      for (const s of [0, 0.5, 1]) expect(FX.runs.some(r => r.class_type === 'LUT' && r.widgets.lut_file === f && r.widgets.strength === s && r.input === 'clip8'), `${f} ${s}`).toBe(true)
    }
    expect(FX.cubes!['warm.cube']).toContain('DOMAIN_MIN')
    expect(FX.cubes!['warm.cube']).toContain('#')
    // Chroma key's mask: one per frame (the runner doesn't make it).
    for (const r of FX.runs.filter(r => r.class_type === 'ChromaKey')) expect(r.mask!.count).toBe(r.out!.count)
  })

  it('the output shapes are Python’s', () => {
    for (const c of FX.runs) {
      const x = lookClip(c.input)
      const params = mediaEffectParams(MEDIA_EFFECT_SCHEMAS[c.class_type], c.widgets)
      expect(VIDEO_EFFECTS[c.class_type]!.shape(params, [{ count: x.frames.length, w: x.w, h: x.h, exact: true }]), c.name).toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h, exact: true })
    }
  })
})

describe('the LUT’s .cube parse is Python’s', () => {
  it('each fixture file: its size and table (Python’s [b, g, r, c] float32), or the failure', () => {
    for (const [name, want] of Object.entries(FX.cubeParse!)) {
      const r = parseCubeLut(new TextEncoder().encode(FX.cubes![name]!))
      if (want.error) {
        expect('error' in r, name).toBe(true)
        continue
      }
      if ('error' in r) throw new Error(`${name}: ${r.error}`)
      expect(r.size, name).toBe(want.size)
      const cube = r.size ** 3
      const hwc = new Float32Array(cube * 3)
      for (let i = 0; i < cube; i++) for (let ch = 0; ch < 3; ch++) hwc[i * 3 + ch] = r.table[ch * cube + i]!
      expect(sha256(new Uint8Array(hwc.buffer)), name).toBe(want.f32_sha256)
    }
  })

  it('reads what Python reads, and fails where it fails (in plain words)', () => {
    const enc = (s: string) => new TextEncoder().encode(s)
    const rows = (n: number) => Array.from({ length: n }, (_, i) => `${i % 2} 0.5 1e-1`).join('\n')
    // Comments, blanks, TITLE, LUT_1D_SIZE, a row that isn't three floats (skipped), underscores and a lower-case key.
    const ok = parseCubeLut(enc(`# c\n\nTITLE "x"\nlut_3d_size 2\nLUT_1D_SIZE 9\nDOMAIN_MIN 0 0 0\nnot a row\n${rows(7)}\n  1_0 0 inf  \n`))
    if ('error' in ok) throw new Error(ok.error)
    expect(ok.size).toBe(2)
    expect(ok.table[0]).toBe(0)
    // The last row, R fastest: red 10 (float('1_0')), blue inf.
    expect([ok.table[7], ok.table[8 + 7], ok.table[16 + 7]]).toEqual([10, 0, Infinity])
    expect(parseCubeLut(enc(`LUT_3D_SIZE 2\n${rows(7)}\n`))).toEqual({ error: LUT_WORDS.countWrong })
    expect(parseCubeLut(enc(`${rows(8)}\n`))).toEqual({ error: LUT_WORDS.noSize })
    expect(parseCubeLut(enc('LUT_3D_SIZE 2\n'))).toEqual({ error: LUT_WORDS.noSize })
    expect(parseCubeLut(enc(`LUT_3D_SIZE two\n${rows(8)}\n`))).toEqual({ error: LUT_WORDS.badSize })
    expect(parseCubeLut(enc(`LUT_3D_SIZE\n${rows(8)}\n`))).toEqual({ error: LUT_WORDS.badSize })
    expect(parseCubeLut(enc(`LUT_3D_SIZE 2\nDOMAIN_MAX 1 x 1\n${rows(8)}\n`))).toEqual({ error: LUT_WORDS.badDomain })
    expect(parseCubeLut(new Uint8Array([0xff, 0xfe, 0x00]))).toEqual({ error: LUT_WORDS.notText })
    // \r alone ends a line, as Python's text mode reads it.
    expect('error' in parseCubeLut(enc(`LUT_3D_SIZE 2\r${rows(8).replace(/\n/g, '\r')}`))).toBe(false)
  })
})

// ── The core on this thread ──────────────────────────────────────────────────

describe('the core on this thread gives Python’s float32 by its class', () => {
  for (const c of FX.runs.filter(r => !refused(r))) {
    it(`${c.class_type}: ${c.name}`, () => {
      const x = lookClip(c.input)
      const want = c.out!
      if (c.autopan && !checkAutoPan(c, x)) return
      const got = coreBatch(c.class_type, c.widgets, x, tableOf(c))
      expect({ count: got.count, w: got.w, h: got.h }).toEqual({ count: want.count, w: want.w, h: want.h })
      if (!isLibrary(c)) {
        expect(sha256(got.f32), 'float32').toBe(want.f32_sha256)
        expect(sha256(got.round8), 'round-8').toBe(want.round8_sha256)
        expect(sha256(got.trunc8), 'trunc-8').toBe(want.trunc8_sha256)
        return
      }
      const f = new Float32Array(got.f32.buffer, got.f32.byteOffset, got.f32.byteLength / 4)
      if (want.f32) {
        const py = f32Of(want.f32)
        let worst = 0
        for (let i = 0; i < py.length; i++) worst = Math.max(worst, Math.abs(f[i]! - py[i]!))
        expect(worst, 'LIBRARY: the worst difference').toBeLessThanOrEqual(LOOK_EPS)
        const band = bandOf(py, FX.band!)
        const p8 = py8Of(py)
        expect8(got.round8, 'round', p8.round, band)
        expect8(got.trunc8, 'trunc', p8.trunc, band)
      }
      else {
        expect8(got.round8, 'round', null, c.band!)
        expect8(got.trunc8, 'trunc', null, c.band!)
      }
    })
  }
})

// ── Through the node's plan, with the real stores and tools ──────────────────

const frameOf = (b: Uint8Array, j: number, per: number) => b.subarray(j * per, (j + 1) * per)

/** A harness with the fixture's .cube files in its input folder. */
function lookHarness(o: { hosted?: boolean } = {}) {
  const h = vfxHarness(scratch, o)
  for (const [name, text] of Object.entries(FX.cubes!)) writeFileSync(join(h.root, 'input', name), text)
  return h
}

describe('through the node’s plan: the kept batch, the preview and the ui are Python’s', () => {
  for (const c of FX.runs.filter(r => !refused(r))) {
    it(`${c.class_type}: ${c.name}`, LONG, async () => {
      await requireMediaTools()
      const h = lookHarness()
      const runId = vfxRunId(++runs)
      const x = lookClip(c.input)
      const input = await keptBatch(h, runId, x)
      const values: Record<string, Record<number, RunnerValue>> = { g: { 0: input } }
      const id = c.node_id
      const want = c.out!
      const per = want.w * want.h * 3
      const py = want.f32 ? py8Of(f32Of(want.f32)) : null
      const band = want.f32 && isLibrary(c) ? bandOf(f32Of(want.f32), FX.band!) : c.band
      // Where auto_pan picks another edge on a tie (BAND), the batch is judged against the core's own frames.
      const tie = c.autopan ? !checkAutoPan(c, x) : false
      const core = tie ? coreBatch(c.class_type, c.widgets, x) : null
      const through = !!VIDEO_EFFECTS[c.class_type]!.passThrough?.(mediaEffectParams(MEDIA_EFFECT_SCHEMAS[c.class_type], c.widgets), [{ count: x.frames.length, w: x.w, h: x.h, exact: true }])
      const before = PROCS.pids.length
      let trunc8: Uint8Array | null = null
      const made8: string[] = []
      for (const [quant, reader, sha] of [['trunc', saveFrames(id), want.trunc8_sha256], ['round', trimOf(id), want.round8_sha256]] as const) {
        const prompt: ApiPrompt = { ...sources(), [id]: looked(c), r: reader }
        const made = await runVfxNode(h, prompt, id, values, { runId, families: ON })
        const v = made.values[0]! as Extract<RunnerValue, { kind: 'frames' }>
        expect(v.kind, quant).toBe('frames')
        made8.push(v.file.filename)
        expect({ count: v.count, w: v.w, h: v.h }, quant).toEqual({ count: want.count, w: want.w, h: want.h })
        const bytes = await batchBytes(h, runId, v)
        // A pass-through hands its input on as it was kept (round-8 of k / 255 is k): Python's either way.
        if (core) expect(sha256(bytes), `${quant}-8 frames (the core's, on a tie)`).toBe(sha256(core[quant === 'trunc' ? 'trunc8' : 'round8']))
        else if (!isLibrary(c)) expect(sha256(bytes), `${quant}-8 frames`).toBe(sha)
        else expect8(bytes, quant, py ? py[quant] : null, band!)
        if (quant === 'trunc') trunc8 = bytes
        expect(made.ui, 'ui').toEqual({ ...c.ui, images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: LOCAL_LIVE_PREVIEW_SUBFOLDER, type: im.type })) })
        const p = await previewPixels(h, (made.ui as { images: OutputFile[] }).images[0]!)
        expect({ w: p.w, h: p.h, channels: p.channels }, 'preview').toEqual({ w: c.preview!.w, h: c.preview!.h, channels: 3 })
        if (!isLibrary(c) && !core) expect(sha256(p.px), 'preview pixels').toBe(c.preview!.sha256)
        else expect(sha256(p.px), 'preview pixels: the checked trunc-8 frame T // 2').toBe(sha256(frameOf(trunc8!, Math.floor(want.count / 2), per)))
      }
      // One decode and one encode a run (a pass-through only decodes for its preview).
      expect(PROCS.pids.length - before).toBeGreaterThanOrEqual(through ? 2 : 4)
      for (const pid of PROCS.pids.slice(before)) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
      // Nothing kept but the input and the outputs.
      expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual([...new Set([input.file.filename, ...made8])].sort())
    })
  }
})

describe('effect → Create video → Save video saves Python’s frames (R5 rule 3: Python’s own pipeline on libopenh264)', () => {
  for (const c of FX.saved) {
    it(`${c.class_type} ${JSON.stringify(c.widgets)}`, LONG, async () => {
      await requireMediaTools()
      const h = lookHarness()
      const runId = vfxRunId(++runs)
      const values: Record<string, Record<number, RunnerValue>> = { g: { 0: await keptBatch(h, runId, lookClip(c.input)) } }
      const prompt: ApiPrompt = { ...sources(), e: looked(c), c: createVideo('e'), s: saveVideo('c') }
      values.e = (await runVfxNode(h, prompt, 'e', values, { runId, families: ON })).values
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
      if (c.class_type === 'KenBurns') {
        // LIBRARY: the saved frames follow the batch; where a level differs on the band the encoder's frames may too.
        expect(frames.length).toBe(c.openh264.frames.length)
      }
      else expect(frames, 'frames equal to Python’s pipeline on libopenh264').toEqual(c.openh264.frames)
    })
  }
})

// ── The LUT's file ───────────────────────────────────────────────────────────

describe('the LUT’s file (rule 8, ruling (p), the matching rule)', () => {
  const lutTake = (name: string): ApiPrompt => ({ l: loadVideo('v_stereo_aac.mp4'), g: getComp('l'), e: looked({ class_type: 'LUT', widgets: { lut_file: name, strength: 1 } }), c: createVideo('e'), s: saveVideo('c') })

  it('the file is listed for the ownership check only with video-look on; a name outside the folders is unsafe by its name alone', () => {
    expect(collectInputFiles(lutTake('warm.cube'), ON)).toContainEqual({ filename: 'warm.cube', subfolder: '', type: 'input' })
    expect(collectInputFiles(lutTake('warm.cube'), OFF_VIDEO_LOOK).some(f => f.filename === 'warm.cube')).toBe(false)
    expect(collectInputFiles(lutTake('(none)'), ON).some(f => f.filename.endsWith('.cube'))).toBe(false)
    for (const bad of ['../grade.cube', '/etc/grade.cube', 'sub/../../grade.cube']) {
      expect(unsafeLutNames(lutTake(bad), ON), bad).toEqual([bad])
      expect(collectInputFiles(lutTake(bad), ON).some(f => f.filename === 'grade.cube'), bad).toBe(false)
    }
    expect(unsafeLutNames(lutTake('sub/grade.cube'), ON)).toEqual([])
    expect(unsafeLutNames(lutTake('../grade.cube'), OFF_VIDEO_LOOK)).toEqual([])
  })

  it('another person’s LUT is refused before the run (the ownership check)', async () => {
    const files = collectInputFiles(lutTake('theirs.cube'), ON)
    await expect(assertFilesOwned(files, 'user_1', true, { ownsInput: async (_u, f) => f.filename !== 'theirs.cube', ownsOutput: async () => true }))
      .rejects.toMatchObject({ message: NOT_YOURS, statusCode: 403 })
  })

  it('the start pass: a missing or broken file refused plainly; locally a name outside the folders goes to the engine; hosted, one past 65 points or 16 MiB too', async () => {
    const texts: Record<string, string> = { ...FX.cubes!, 'big.cube': `LUT_3D_SIZE ${LUT_HOSTED_MAX_SIZE + 1}\n${'0 0 0\n'.repeat((LUT_HOSTED_MAX_SIZE + 1) ** 3)}` }
    const access = (sizes: Record<string, number> = {}) => ({
      exists: vi.fn(async (f: OutputFile) => f.filename in texts),
      size: vi.fn(async (f: OutputFile) => sizes[f.filename] ?? texts[f.filename]!.length),
      read: vi.fn(async (f: OutputFile) => new TextEncoder().encode(texts[f.filename]!)),
    })
    for (const hosted of [false, true]) {
      expect(await lutStartProblems(lutTake('warm.cube'), ON, { hosted, ...access() }), `warm, hosted ${hosted}`).toBeNull()
      expect(await lutStartProblems(lutTake('gone.cube'), ON, { hosted, ...access() })).toEqual({ message: MEDIA_EFFECT_WORDS.lutMissing, nodeId: 'e', classType: 'LUT' })
      expect(await lutStartProblems(lutTake('broken.cube'), ON, { hosted, ...access() })).toEqual({ message: LUT_WORDS.countWrong, nodeId: 'e', classType: 'LUT' })
      // With the family off the LUT isn't the runner's: nothing is read.
      const a = access()
      expect(await lutStartProblems(lutTake('broken.cube'), OFF_VIDEO_LOOK, { hosted, ...a })).toBeNull()
      expect(a.read).not.toHaveBeenCalled()
    }
    expect(await lutStartProblems(lutTake('big.cube'), ON, { hosted: false, ...access() })).toBeNull()
    expect(await lutStartProblems(lutTake('big.cube'), ON, { hosted: true, ...access() })).toEqual({ message: MEDIA_EFFECT_WORDS.lutTooBig, nodeId: 'e', classType: 'LUT', engine: true })
    const huge = access({ 'warm.cube': 16 * 1024 * 1024 + 1 })
    expect(await lutStartProblems(lutTake('warm.cube'), ON, { hosted: true, ...huge })).toEqual({ message: MEDIA_EFFECT_WORDS.lutTooBig, nodeId: 'e', classType: 'LUT', engine: true })
    expect(huge.read).not.toHaveBeenCalled()
    const out = access()
    expect(await lutStartProblems(lutTake('../grade.cube'), ON, { hosted: false, ...out })).toEqual({ message: MEDIA_EFFECT_WORDS.lutMissing, nodeId: 'e', classType: 'LUT', engine: true })
    expect(out.exists).not.toHaveBeenCalled()
  })

  it('in the engine, hosted: `../grade.cube` is refused by its name alone (no disk access), before any hold', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const asked: string[] = []
    const k = makeKit({ hosted: true, dir, deps: { families: () => ON, ownership: { ownsInput: async (_u, f) => { asked.push(f.filename); return true }, ownsOutput: async () => true } } })
    copyFileSync(clipPath('v_stereo_aac.mp4'), join(k.root, 'input', 'v_stereo_aac.mp4'))
    const results = k.deps.results as unknown as Record<string, (...a: unknown[]) => unknown>
    const touched: string[] = []
    const spies = ['exists', 'read', 'size'].map((m) => {
      const real = results[m]!.bind(results)
      return vi.spyOn(results, m).mockImplementation(async (...a: unknown[]) => { touched.push(`${m}:${(a[0] as OutputFile).filename}`); return real(...a) })
    })
    const held = k.ledger.hold.mock.calls.length
    const err = await k.engine.startRun({ userId: k.userId, takes: [lutTake('../grade.cube')], ...START }).then(() => null, e => e as Error & { statusCode?: number; data?: { file?: string } })
    expect(err?.message).toBe(NOT_YOURS)
    expect(err?.statusCode).toBe(403)
    expect(err?.data?.file).toBe('../grade.cube')
    expect(touched.filter(t => t.includes('grade.cube'))).toEqual([])
    expect(asked.filter(n => n.includes('grade'))).toEqual([])
    expect(k.ledger.hold.mock.calls.length).toBe(held)
    for (const s of spies) s.mockRestore()
  })

  it('in the engine: a broken LUT is refused plainly before the run (Python hands the frames on silently); a good one runs', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const k = makeKit({ dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    copyFileSync(clipPath('v_stereo_aac.mp4'), join(k.root, 'input', 'v_stereo_aac.mp4'))
    for (const [name, text] of Object.entries(FX.cubes!)) writeFileSync(join(k.root, 'input', name), text)
    const before = PROCS.pids.length
    await expect(k.engine.startRun({ userId: null, takes: [lutTake('broken.cube')], ...START })).rejects.toMatchObject({ message: LUT_WORDS.countWrong, statusCode: 400 })
    await expect(k.engine.startRun({ userId: null, takes: [lutTake('gone.cube')], ...START })).rejects.toMatchObject({ message: MEDIA_EFFECT_WORDS.lutMissing })
    // Nothing ran for either: no run was made, and no tool is left (the source's header probes are all that start).
    expect(readdirSync(dir).filter(n => n.endsWith('.json'))).toEqual([])
    for (const pid of PROCS.pids.slice(before)) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    // Locally, a name outside the folders goes to the engine (Python opens it there).
    await expect(k.engine.startRun({ userId: null, takes: [lutTake('../grade.cube')], ...START })).rejects.toMatchObject({ data: { reason: RUNNER_NOT_ELIGIBLE } })
    const { runId } = await k.engine.startRun({ userId: null, takes: [lutTake('warm.cube')], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    expect(t.nodes.e!.status, t.nodes.e!.error ?? '').toBe('done')
    expect(t.nodes.s!.status, t.nodes.s!.error ?? '').toBe('done')
  })

  it('the node’s own turn says the same plain words when the file went bad after the start (nothing left running)', LONG, async () => {
    await requireMediaTools()
    const h = lookHarness()
    const runId = vfxRunId(++runs)
    const values: Record<string, Record<number, RunnerValue>> = { g: { 0: await keptBatch(h, runId, lookClip('clip8')) } }
    const before = PROCS.pids.length
    for (const [name, words] of [['broken.cube', LUT_WORDS.countWrong], ['gone.cube', MEDIA_EFFECT_WORDS.lutMissing]] as const) {
      await expect(runVfxNode(h, { ...sources(), e: looked({ class_type: 'LUT', widgets: { lut_file: name, strength: 1 } }), r: trimOf('e') }, 'e', values, { runId, families: ON })).rejects.toThrow(words)
    }
    expect(PROCS.pids.length - before).toBe(0)
  })
})

// ── The family, ruling (k) and (l), rule 12 ──────────────────────────────────

describe('the family', () => {
  it('with video-look off, a workflow with a look is left to the engine and the look named', () => {
    for (const cls of LOOKS) {
      expect(MEDIA_EFFECTS_PORTED).toContain(cls)
      expect(MEDIA_EFFECT_OUTPUT_NODES).toContain(cls)
      expect(mediaEffectSwitchedClasses()[cls]).toBe('video-look')
      expect(FRAMES_OUTPUTS.map(x => x.join(':'))).toContain(`${cls}:0`)
      const c = FX.runs.find(r => r.class_type === cls && !refused(r) && lutOf(r) === null)!
      const p: ApiPrompt = { ...sources(), e: looked(c), c: createVideo('e'), s: saveVideo('c') }
      expect(runnerTakesWorkflow(p, ON), cls).toBe(true)
      for (const fam of [OFF_VIDEO_LOOK, new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['video-look', 'media-video'])]) {
        expect(runnerTakesWorkflow(p, fam), cls).toBe(false)
        expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }), cls).toContain('e')
      }
      // A still picture wired in leaves the workflow to the engine (ruling (k)): 3-way color's `image` too.
      const still: ApiPrompt = { ...p, i: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, e: { ...p.e!, inputs: { ...p.e!.inputs, [inputOf(cls)]: ['i', 0] } } }
      expect(runnerTakesWorkflow(still, ON), `${cls}, a still picture`).toBe(false)
    }
    expect(inputOf('ThreeWayCC')).toBe('image')
  })

  it('Chroma key with its mask wired leaves the workflow to the engine (ruling (l)); its picture alone is taken', () => {
    const c = FX.runs.find(r => r.class_type === 'ChromaKey')!
    const p: ApiPrompt = { ...sources(), e: looked(c), c: createVideo('e'), s: saveVideo('c') }
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    expect(mediaEffectRows().ChromaKey!.outputsNotLinked).toEqual([1])
    const masked: ApiPrompt = { ...p, m: { class_type: 'MaskToImage', inputs: { mask: ['e', 1] } }, pv: { class_type: 'PreviewImage', inputs: { images: ['m', 0] } } }
    expect(runnerTakesWorkflow(masked, ON)).toBe(false)
    expect(nodesNeedingEngine(masked, { runnerOn: true, families: ON, titleOf: id => id })).toContain('e')
    for (const cls of ['KenBurns', 'AspectConvert', 'LUT', 'ThreeWayCC']) expect(mediaEffectRows()[cls]!.outputsNotLinked, cls).toBeUndefined()
  })

  it('rule 12 over the synthetic graphs: with every R6 family off, or on with the tools missing or their media families off, every answer is the pinned one from before R6.1', () => {
    const pin = rule12Pin()
    for (const cls of LOOKS) {
      const name = `synthetic ${cls}`
      const g = pin.graphs[name]!
      expect(g, name).toBeDefined()
      for (const [set, fam] of Object.entries(pin.sets)) expect(hash16(invariantAnswers(g.prompt, new Set(fam as RunnerFamily[]))), `${name}, ${set}`).toBe(g.answers[set])
      // Teeth: with video-look on, the graph answers otherwise.
      const on = new Set<RunnerFamily>([...pin.sets['every family before R6']! as RunnerFamily[], 'video-look'])
      expect(hash16(invariantAnswers(g.prompt, on)), name).not.toBe(g.answers['every family before R6'])
    }
    expect(PICTURE_OUTPUTS).toEqual(pin.pictureOutputs)
    for (const cls of LOOKS) expect(Object.hasOwn(PICTURE_OUTPUTS, cls), cls).toBe(false)
  })

  it('what each look holds and works stays under the hosted limits at 1080p, and the start pass bounds a long clip', async () => {
    const hd = { count: 600, w: 1920, h: 1080, exact: true }
    for (const cls of LOOKS) {
      const c = FX.runs.find(r => r.class_type === cls)!
      const params = mediaEffectParams(MEDIA_EFFECT_SCHEMAS[cls], c.widgets)
      expect(VIDEO_EFFECTS[cls]!.heldBytes(params, [hd]), cls).toBeLessThan(MEDIA_CAPS.hosted.heldFrameBytes)
    }
    const p = (count: number): [ApiPrompt, Map<string, { count: number; w: number; h: number; exact: boolean }>] => [
      { ...sources(), e: looked({ class_type: 'KenBurns', widgets: FX.runs.find(r => r.class_type === 'KenBurns')!.widgets }), c: createVideo('e'), s: saveVideo('c') },
      new Map([['g:0', { count, w: 1920, h: 1080, exact: true }]]),
    ]
    const [long, longShapes] = p(3000)
    expect(await mediaEffectStartProblems(long, ON, { hosted: true, shapes: longShapes })).toMatchObject({ nodeId: 'e', engine: true })
    const [short, shortShapes] = p(24)
    expect(await mediaEffectStartProblems(short, ON, { hosted: true, shapes: shortShapes })).toBeNull()
  })
})

// ── Stop, and an early leave ─────────────────────────────────────────────────

describe('Stop mid-look, and a decode left early', () => {
  for (const cls of ['KenBurns', 'LUT'] as const) {
    it(`${cls}: stopped mid-batch: no tool process left, no kept file but its input`, LONG, async () => {
      await requireMediaTools()
      const h = lookHarness()
      const runId = vfxRunId(++runs)
      const W = 320
      const H = 240
      const input = await keptBatch(h, runId, { frames: Array.from({ length: 30 }, (_, i) => new Uint8Array(W * H * 3).fill(i * 7)), w: W, h: H })
      const widgets = cls === 'LUT' ? { lut_file: 'warm.cube', strength: 0.5 } : FX.runs.find(r => r.class_type === 'KenBurns')!.widgets
      const before = PROCS.pids.length
      const ctl = new AbortController()
      HOOK.frames = 0
      HOOK.abortAt = 12
      HOOK.ctl = ctl
      try {
        await expect(runVfxNode(h, { ...sources(), e: looked({ class_type: cls, widgets }), r: trimOf('e') }, 'e', { g: { 0: input } }, { runId, families: ON, signal: ctl.signal }))
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

  it('a pass-through look (LUT (none), Aspect convert to its own ratio) leaves its decode after the preview frame, ten times: no ffmpeg left', LONG, async () => {
    await requireMediaTools()
    const h = lookHarness()
    const runId = vfxRunId(++runs)
    const square = { frames: Array.from({ length: 8 }, (_, i) => new Uint8Array(16 * 16 * 3).fill(i * 20)), w: 16, h: 16 }
    const input = await keptBatch(h, runId, square)
    const before = PROCS.pids.length
    for (let k = 0; k < 10; k++) {
      for (const c of [{ class_type: 'LUT', widgets: { lut_file: '(none)', strength: 1 } }, { class_type: 'AspectConvert', widgets: { target: '1:1', method: 'auto_pan', pad_color: '#000' } }]) {
        const made = await runVfxNode(h, { ...sources(), e: looked(c), r: trimOf('e') }, 'e', { g: { 0: input } }, { runId, families: ON })
        expect((made.values[0] as Extract<RunnerValue, { kind: 'frames' }>).file.filename, c.class_type).toBe(input.file.filename)
      }
    }
    const pids = PROCS.pids.slice(before)
    expect(pids.length).toBe(20)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
    expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input.file.filename])
  })

  it('framesOf left after its first frame under a lease: settles at once, no ffmpeg left', LONG, async () => {
    await requireMediaTools()
    const h = lookHarness()
    const runId = vfxRunId(++runs)
    const v = await keptBatch(h, runId, lookClip('clip8'))
    const before = PROCS.pids.length
    for (let k = 0; k < 5; k++) {
      await mediaLease({ userId: null }, async (lease) => {
        const it = framesOf(v, mediaIo(h, runId), lease)[Symbol.asyncIterator]()
        await it.next()
        await it.return!(undefined)
      })
    }
    const pids = PROCS.pids.slice(before)
    expect(pids.length).toBe(5)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
  })
})

// ── The esbuild guard: the look core built as Nitro builds server code ───────

describe('esbuild guard: the look core survives Nitro’s build', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = existsSync(pnpm) ? readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild')) : []
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(scratch, 'esbuild-'))
  const A = lookClip('clip-green')
  const warm = tableOf({ class_type: 'LUT', widgets: { lut_file: 'warm.cube' } } as unknown as VfxRun)!
  const cases: { fn: string; p: Record<string, unknown>; state?: ArrayBuffer }[] = [
    { fn: 'look.kenBurns', p: { start_zoom: 1.2, end_zoom: 2.4, start_x: -0.2, start_y: 0.1, end_x: 0.3, end_y: -0.2, easing: 'ease_in_out' } },
    { fn: 'look.aspect', p: { target: '9:16', method: 'auto_pan', pad_color: '#000' } },
    { fn: 'look.aspect', p: { target: '1:1', method: 'pad', pad_color: ' ##3a7' } },
    { fn: 'look.chroma', p: { key_color: '#0f0', tolerance: 0.3, smoothness: 0.1, spill_suppression: 0.7, bg_color: '#123456' } },
    { fn: 'look.lut', p: { lut_file: 'warm.cube', strength: 0.5 }, state: warm },
    { fn: 'look.threeWay', p: { lift_r: 0.1, lift_g: 0, lift_b: -0.1, gamma_r: 1.4, gamma_g: 1, gamma_b: 0.7, gain_r: 1.2, gain_g: 1, gain_b: 0.9 } },
  ]
  const here = (c: typeof cases[number]) => {
    const [core, fn] = c.fn.split('.') as [string, string]
    const op = (videoCores as unknown as Record<string, Record<string, (...a: unknown[]) => { out: import('~~/server/runner/effects/core/tensor').Tensor }>>)[core]![fn]!
    const r = op([videoCores.vx.fromRgb(A.frames[1]!, A.w, A.h)], c.p, c.state?.slice(0), 1, 4)
    return [...videoCores.vx.toRgb(r.out, 'round')]
  }

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
        const time = await build('video/core/time.ts', 'time')
        const look = await build('video/core/look.ts', 'look')
        const cores = [
          { name: 'tk', fn: tk.tensorCore as never, args: ['px'] },
          { name: 'kn', fn: kn.kernelsCore as never, args: ['tk', 'px'] },
          { name: 'vx', fn: time.framesCore as never, args: ['tk'] },
          { name: 'look', fn: look.lookCore as never, args: ['tk', 'kn'] },
        ]
        const w = new Worker(workerScript(compositorCore, px.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>, transfer: ArrayBuffer[] = []) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m, transfer) })
          let id = 0
          for (const c of cases) {
            const state = c.state?.slice(0)
            const r = await reply({ id: ++id, op: 'vfx.frame', fn: c.fn, params: c.p, index: 1, count: 4, inputs: [{ rgb: A.frames[1]!.slice(), w: A.w, h: A.h }], ...(state ? { state } : {}), quant: 'round', preview: false }, state ? [state] : [])
            expect(r.error, c.fn).toBeUndefined()
            expect([...r.value.rgb], c.fn).toEqual(here(c))
            // The LUT's table comes back as the state for the next frame.
            if (c.state) expect(r.value.state.byteLength, c.fn).toBe(c.state.byteLength)
          }
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})

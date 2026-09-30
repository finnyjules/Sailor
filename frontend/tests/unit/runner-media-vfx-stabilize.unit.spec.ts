/**
 * Stabilize and the shared FFT, family `video-stabilize` (server/runner/video/,
 * R6.5), against the real Python (scripts/runner_media_fixtures.py --group
 * vfx-stabilize: each case the node's own execute with its hidden unique_id
 * set; the FFT cases numpy's and torch's own).
 *
 * The matching rule (USER, 2026-09-30) applied: the FFT runs in float64 and
 * is judged against numpy within 1e-12 of each case's largest term (float32
 * callers round once: numpy's float32 rfft and torch's complex64 fft2 are
 * judged within FFT32_EPS). Stabilize's shifts must equal Python's in every
 * case but a tie the fixture flags (its two highest correlation values
 * within `shiftTie`); with Python's shifts, the frames are its frames: the
 * float32 bit for bit where the fixture holds it whole, and every case's
 * round-8 and trunc-8 by sha256.
 *
 * R6 rule 14, for every fixture case: the core on this thread; through the
 * node's plan with the real stores and tools, the kept batch (round-8 when
 * another effect reads it, trunc-8 when only an encoder does), the preview
 * and the ui. Plus: effect → Create video → Save video; the family off
 * leaves the workflow to the engine; rule 12; the hosted held and work
 * figures; Stop in either pass and a one-frame clip's early leave leave no
 * process and no kept file; the cores survive Nitro's build.
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

/** A hook in the worker's video frames: Stop the node on the Nth call (pass 1's calls count too). */
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
import { FRAMES_OUTPUTS, MEDIA_EFFECTS_PORTED, MEDIA_EFFECT_OUTPUT_NODES, mediaEffectSwitchedClasses } from '#shared/runner/mediaEffects'
import { PICTURE_OUTPUTS } from '#shared/runner/eligibility'
import { runnerTakesWorkflow } from '#shared/runner/validate'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { MEDIA_EFFECT_SCHEMAS } from '#shared/runner/mediaEffectSchemas.generated'
import { decodeFrames } from '~~/server/media/decode'
import { probeMedia, pyFrameCount, pyFrameRate } from '~~/server/media/probe'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { LOCAL_LIVE_PREVIEW_SUBFOLDER } from '~~/server/runner/results'
import { compositorCore } from '~~/server/runner/compositor/plane'
import { workerScript } from '~~/server/runner/compositor/worker'
import { videoCores } from '~~/server/runner/video/cores'
import { shiftOf } from '~~/server/runner/video/core/stabilize'
import { VIDEO_EFFECTS, mediaEffectParams } from '~~/server/runner/video/table'
import { mediaEffectStartProblems } from '~~/server/runner/video/start'
import { requireMediaTools } from './__runner__/mediaParity'
import { synth } from './__runner__/effectsParity'
import {
  b64, batchBytes, clipFrames, coreBatch, hash16, invariantAnswers, keptBatch, previewPixels, rule12Pin, runVfxNode, sha256, vfxFixture, vfxHarness, vfxRunId,
  type VfxRun,
} from './__runner__/mediaEffectsParity'

const FX = vfxFixture('vfx-stabilize')
const LONG = { timeout: 120_000 }
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-stabilize'])
const OFF: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'video-time', 'video-join', 'video-look'])

const scratch = mkdtempSync(join(tmpdir(), 'media-vfx-stabilize-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
let runs = 0

type Link = [string, number]
type Clip = { frames: Uint8Array[]; w: number; h: number }

/** A case's input: a standard clip, or a shaking pattern made again from its recorded path. */
const made = new Map<string, Clip>()
function stabClip(name: string): Clip {
  const s = FX.shakes?.[name]
  if (!s) return clipFrames(FX, name)
  const had = made.get(name)
  if (had) return had
  const bw = s.w + 2 * s.margin
  const base = synth(bw, s.h + 2 * s.margin, 3, s.seed)
  const frames = s.path.map(([dy, dx]) => {
    const f = new Uint8Array(s.w * s.h * 3)
    for (let y = 0; y < s.h; y++) {
      const from = ((s.margin + dy + y) * bw + s.margin + dx) * 3
      f.set(base.subarray(from, from + s.w * 3), y * s.w * 3)
    }
    return f
  })
  const clip = { frames, w: s.w, h: s.h }
  made.set(name, clip)
  return clip
}

const getComp = () => ({ class_type: 'GetVideoComponents', inputs: { video: ['l', 0] as Link } })
const sources = () => ({ l: { class_type: 'LoadVideo', inputs: { file: 'a.mp4' } }, g: getComp() })
const stabilized = (widgets: Record<string, unknown>, from = 'g') => ({ class_type: 'Stabilize', inputs: { frames: [from, 0] as Link, ...widgets } })
const trimOf = (from: string) => ({ class_type: 'VideoTrim', inputs: { frames: [from, 0] as Link, start: 0, end: -1 } })
const saveFrames = (from: string) => ({ class_type: 'SaveVideoFrames', inputs: { frames: [from, 0] as Link, fps: 24, filename_prefix: 'video', audio_file: '(none)', preset: 'veryfast', crf: 20 } })
const createVideo = (from: string) => ({ class_type: 'CreateVideo', inputs: { images: [from, 0] as Link, fps: 24 } })
const saveVideo = (from: string) => ({ class_type: 'SaveVideo', inputs: { video: [from, 0] as Link, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })

const paramsOf = (w: Record<string, unknown>) => mediaEffectParams(MEDIA_EFFECT_SCHEMAS.Stabilize, w)
const f64Of = (s: string) => new Float64Array(b64(s).buffer)
const f32Of = (s: string) => new Float32Array(b64(s).buffer)

/** The shifts pass 1 finds on this thread (the op the worker runs, in order, its state carried). */
function shiftsHere(c: Clip): [number, number][] {
  const out: [number, number][] = []
  let st: ArrayBuffer | undefined
  for (let i = 0; i < c.frames.length; i++) {
    st = videoCores.stab.track([videoCores.vx.fromRgb(c.frames[i]!, c.w, c.h)], {}, st, i, c.frames.length).state
    out.push(shiftOf(st))
  }
  return out
}

/** Whether every shift is Python's (a tie the fixture flags may differ). */
function shiftsArePythons(c: VfxRun): boolean {
  if (!c.shifts) return true
  const got = shiftsHere(stabClip(c.input))
  let same = true
  c.shifts.forEach((s, i) => {
    const g = got[i]!
    if (g[0] === s.dy && g[1] === s.dx) return
    same = false
    expect(s.tie, `${c.name}: frame ${i} (${g}) against Python's (${s.dy}, ${s.dx}), not a tie`).toBe(true)
  })
  return same
}

// ── The FFT ──────────────────────────────────────────────────────────────────

/** The fixture script's exact formula: part k of n values. */
function fftInput(n: number, k: number): Float64Array {
  const out = new Float64Array(n)
  for (let j = 0; j < n; j++) out[j] = k === 0 ? ((j * 7919 + 13) % 1000) / 1000 - 0.5 : ((j * 104729 + 7) % 997) / 997 - 0.5
  return out
}

/** The worst difference from `want` (interleaved re, im), relative to its largest term. */
function relErr(re: ArrayLike<number>, im: ArrayLike<number>, want: Float64Array | Float32Array): number {
  let big = 0
  for (let i = 0; i < want.length; i++) big = Math.max(big, Math.abs(want[i]!))
  let worst = 0
  for (let k = 0; k < re.length; k++) worst = Math.max(worst, Math.abs(re[k]! - want[2 * k]!), Math.abs(im[k]! - want[2 * k + 1]!))
  expect(want.length).toBe(2 * re.length)
  return worst / Math.max(big, 1e-300)
}

/** float64 against numpy (pocketfft): within this of each case's largest term. */
const FFT64_REL = 1e-12
/**
 * float32 callers (numpy's float32 rfft, torch's complex64 fft2), the float64
 * result rounded once, relative to the largest term. Measured: torch's
 * complex64 fft2 1.14e-7 (it computes in float32); numpy 2.4.3's float32
 * rfft is bit for bit at every power of two (it computes in double and
 * rounds once) and at n = 1000 all but 2 of 501 terms (1.9e-17). Bound
 * 2⁻²⁰ ≈ 9.5e-7.
 */
const FFT32_REL = 2 ** -20

describe('the shared FFT against numpy and torch', () => {
  const ft = videoCores.ft
  it(`covers lengths 1–64, 256, 1000, 1024, 4096 and 9 × 16, 144 × 256 (numpy ${FX.fft!.numpy})`, () => {
    expect(FX.fft!.one.map(c => c.n)).toEqual([...Array.from({ length: 64 }, (_, i) => i + 1), 256, 1000, 1024, 4096])
    expect(FX.fft!.two.map(c => [c.h, c.w])).toEqual([[9, 16], [144, 256]])
  })

  it('fft, ifft and rfft of every length: within 1e-12 of numpy (float64)', () => {
    let worst = 0
    for (const c of FX.fft!.one) {
      const re = fftInput(c.n, 0)
      const im = fftInput(c.n, 1)
      const [a, b] = [re.slice(), im.slice()]
      ft.fft(a, b)
      const e1 = relErr(a, b, f64Of(c.fft))
      const [x, y] = [re.slice(), im.slice()]
      ft.ifft(x, y)
      const e2 = relErr(x, y, f64Of(c.ifft))
      const r = ft.rfft(re)
      const e3 = relErr(r.re, r.im, f64Of(c.rfft))
      for (const e of [e1, e2, e3]) expect(e, `n = ${c.n}`).toBeLessThanOrEqual(FFT64_REL)
      worst = Math.max(worst, e1, e2, e3)
      // And back: irfft of the rfft gives the samples.
      const back = ft.irfft(r.re, r.im, c.n)
      for (let j = 0; j < c.n; j++) expect(Math.abs(back[j]! - re[j]!), `irfft n = ${c.n}`).toBeLessThan(1e-12)
    }
    console.info(`[fft] float64 1-D worst relative difference from numpy: ${worst.toExponential(2)}`)
  })

  it('fft2 and ifft2: within 1e-12 of numpy; torch’s complex64 fft2 within FFT32_REL', () => {
    for (const c of FX.fft!.two) {
      const n = c.h * c.w
      const re = fftInput(n, 0)
      const im = fftInput(n, 1)
      const [a, b] = [re.slice(), im.slice()]
      videoCores.ft.fft2(a, b, c.h, c.w)
      expect(relErr(a, b, f64Of(c.fft2)), `${c.h} × ${c.w}`).toBeLessThanOrEqual(FFT64_REL)
      const e32 = relErr(Float32Array.from(a), Float32Array.from(b), f32Of(c.torch_fft2_c64))
      expect(e32, `${c.h} × ${c.w} complex64`).toBeLessThanOrEqual(FFT32_REL)
      console.info(`[fft] torch complex64 fft2 ${c.h} × ${c.w}: worst relative ${e32.toExponential(2)}`)
      const [x, y] = [re.slice(), im.slice()]
      videoCores.ft.ifft2(x, y, c.h, c.w)
      expect(relErr(x, y, f64Of(c.ifft2)), `${c.h} × ${c.w} inverse`).toBeLessThanOrEqual(FFT64_REL)
    }
  })

  it('numpy’s float32 rfft: the float64 result rounded once is within FFT32_REL (and whether it is bit for bit is reported)', () => {
    for (const c of FX.fft!.rfft32) {
      const x = Float32Array.from(fftInput(c.n, 0))
      const r = ft.rfft(x)
      const re = Float32Array.from(r.re)
      const im = Float32Array.from(r.im)
      const want = f32Of(c.rfft_c64)
      const e = relErr(re, im, want)
      let same = 0
      for (let k = 0; k < re.length; k++) if (re[k] === want[2 * k] && im[k] === want[2 * k + 1]) same++
      console.info(`[fft] numpy float32 rfft n = ${c.n}: worst relative ${e.toExponential(2)}, ${same} of ${re.length} terms bit for bit`)
      expect(e, `n = ${c.n}`).toBeLessThanOrEqual(FFT32_REL)
    }
  })
})

// ── The fixture, and the core on this thread ─────────────────────────────────

describe('the fixture', () => {
  it('was made from the real node over rule 13’s case set and the shaking patterns', () => {
    expect(FX.threads.torch).toBeGreaterThan(1)
    expect(FX.runs.filter(r => r.error)).toEqual([])
    for (const clip of ['clip8', 'clip8-odd', 'clip2', 'clip1', 'clip8-big']) expect(FX.runs.some(r => r.input === clip), clip).toBe(true)
    for (const s of Object.keys(FX.shakes!)) {
      for (const e of ['crop', 'border']) {
        for (const sm of [0, 0.85, 0.99]) expect(FX.runs.some(r => r.input === s && r.widgets.edge_mode === e && r.widgets.smoothing === sm), `${s} ${e} ${sm}`).toBe(true)
      }
      for (const p of [0, 0.3]) expect(FX.runs.some(r => r.input === s && r.widgets.crop_pad === p), `${s} pad ${p}`).toBe(true)
    }
    // 600 × 338 works at half size.
    expect(videoCores.stab.trackSize(338, 600)).toEqual({ scale: 2, th: 169, tw: 300 })
    // The shaking patterns do shake: Python finds the path's steps (negated) at 96 × 64.
    const s = FX.shakes!['shake-96x64']!
    const py = FX.runs.find(r => r.input === 'shake-96x64')!.shifts!
    for (let i = 1; i < s.frames; i++) expect([py[i]!.dy, py[i]!.dx]).toEqual([s.path[i - 1]![0] - s.path[i]![0], s.path[i - 1]![1] - s.path[i]![1]])
  })

  it('the output shapes are Python’s', () => {
    for (const c of FX.runs) {
      const x = stabClip(c.input)
      expect(VIDEO_EFFECTS.Stabilize!.shape(paramsOf(c.widgets), [{ count: x.frames.length, w: x.w, h: x.h, exact: true }]), c.name).toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h, exact: true })
    }
  })
})

describe('the core on this thread: Python’s shifts, and with them Python’s frames', () => {
  for (const c of FX.runs) {
    it(c.name, () => {
      const x = stabClip(c.input)
      if (!shiftsArePythons(c)) return
      const got = coreBatch('Stabilize', c.widgets, x)
      expect({ count: got.count, w: got.w, h: got.h }).toEqual({ count: c.out!.count, w: c.out!.w, h: c.out!.h })
      expect(sha256(got.f32), 'float32').toBe(c.out!.f32_sha256)
      expect(sha256(got.round8), 'round-8').toBe(c.out!.round8_sha256)
      expect(sha256(got.trunc8), 'trunc-8').toBe(c.out!.trunc8_sha256)
    })
  }
})

// ── Through the node's plan, with the real stores and tools ──────────────────

const frameOf = (b: Uint8Array, j: number, per: number) => b.subarray(j * per, (j + 1) * per)

describe('through the node’s plan: the kept batch, the preview and the ui are Python’s', () => {
  for (const c of FX.runs) {
    it(c.name, LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const x = stabClip(c.input)
      const input = await keptBatch(h, runId, x)
      const values: Record<string, Record<number, RunnerValue>> = { g: { 0: input } }
      const id = c.node_id
      const want = c.out!
      const per = want.w * want.h * 3
      const tie = !shiftsArePythons(c)
      const core = tie ? coreBatch('Stabilize', c.widgets, x) : null
      const through = x.frames.length <= 1
      const before = PROCS.pids.length
      const kept: string[] = []
      for (const [quant, reader, sha] of [['trunc', saveFrames(id), want.trunc8_sha256], ['round', trimOf(id), want.round8_sha256]] as const) {
        const prompt: ApiPrompt = { ...sources(), [id]: stabilized(c.widgets), r: reader }
        const got = await runVfxNode(h, prompt, id, values, { runId, families: ON })
        const v = got.values[0]! as Extract<RunnerValue, { kind: 'frames' }>
        expect(v.kind, quant).toBe('frames')
        kept.push(v.file.filename)
        expect({ count: v.count, w: v.w, h: v.h }, quant).toEqual({ count: want.count, w: want.w, h: want.h })
        const bytes = await batchBytes(h, runId, v)
        expect(sha256(bytes), `${quant}-8 frames`).toBe(core ? sha256(core[quant === 'trunc' ? 'trunc8' : 'round8']) : sha)
        expect(got.ui, 'ui').toEqual({ ...c.ui, images: c.ui!.images.map(im => ({ filename: im.filename, subfolder: LOCAL_LIVE_PREVIEW_SUBFOLDER, type: im.type })) })
        const p = await previewPixels(h, (got.ui as { images: OutputFile[] }).images[0]!)
        expect({ w: p.w, h: p.h, channels: p.channels }, 'preview').toEqual({ w: c.preview!.w, h: c.preview!.h, channels: 3 })
        if (!core) expect(sha256(p.px), 'preview pixels').toBe(c.preview!.sha256)
        else if (quant === 'trunc') expect(sha256(p.px), 'preview: the trunc-8 frame T // 2').toBe(sha256(frameOf(bytes, Math.floor(want.count / 2), per)))
      }
      // Two decodes and one encode a run (a one-frame clip only decodes for its preview).
      expect(PROCS.pids.length - before).toBeGreaterThanOrEqual(through ? 2 : 6)
      for (const pid of PROCS.pids.slice(before)) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
      expect(readdirSync(join(h.root, 'kept', runId)).sort()).toEqual([...new Set([input.file.filename, ...kept])].sort())
    })
  }
})

describe('effect → Create video → Save video saves Python’s frames (R5 rule 3: Python’s own pipeline on libopenh264)', () => {
  for (const c of FX.saved) {
    it(`${c.class_type} ${JSON.stringify(c.widgets)}`, LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const values: Record<string, Record<number, RunnerValue>> = { g: { 0: await keptBatch(h, runId, stabClip(c.input)) } }
      const prompt: ApiPrompt = { ...sources(), e: stabilized(c.widgets), c: createVideo('e'), s: saveVideo('c') }
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
      expect(frames, 'frames equal to Python’s pipeline on libopenh264').toEqual(c.openh264.frames)
    })
  }
})

// ── The family, rule 12, the limits ──────────────────────────────────────────

describe('the family', () => {
  it('with video-stabilize off, a workflow with Stabilize is left to the engine and the node named', () => {
    expect(MEDIA_EFFECTS_PORTED).toContain('Stabilize')
    expect(MEDIA_EFFECT_OUTPUT_NODES).toContain('Stabilize')
    expect(mediaEffectSwitchedClasses().Stabilize).toBe('video-stabilize')
    expect(FRAMES_OUTPUTS.map(x => x.join(':'))).toContain('Stabilize:0')
    const p: ApiPrompt = { ...sources(), e: stabilized(FX.runs[0]!.widgets), c: createVideo('e'), s: saveVideo('c') }
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    for (const fam of [OFF, new Set<RunnerFamily>(['cards']), new Set<RunnerFamily>(['video-stabilize', 'media-video'])]) {
      expect(runnerTakesWorkflow(p, fam)).toBe(false)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id })).toContain('e')
    }
    // A still picture wired in leaves the workflow to the engine (ruling (k)).
    const still: ApiPrompt = { ...p, i: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, e: stabilized(FX.runs[0]!.widgets, 'i') }
    expect(runnerTakesWorkflow(still, ON)).toBe(false)
  })

  it('rule 12 over the synthetic graph: with the family off, or on with the tools missing or its media family off, every answer is the pinned one', () => {
    const pin = rule12Pin()
    const g = pin.graphs['synthetic Stabilize']!
    expect(g).toBeDefined()
    for (const [set, fam] of Object.entries(pin.sets)) expect(hash16(invariantAnswers(g.prompt, new Set(fam as RunnerFamily[]))), set).toBe(g.answers[set])
    const on = new Set<RunnerFamily>([...pin.sets['every family before R6']! as RunnerFamily[], 'video-stabilize'])
    expect(hash16(invariantAnswers(g.prompt, on))).not.toBe(g.answers['every family before R6'])
    expect(PICTURE_OUTPUTS).toEqual(pin.pictureOutputs)
    expect(Object.hasOwn(PICTURE_OUTPUTS, 'Stabilize')).toBe(false)
  })

  it('what it holds stays under the hosted limit at 1080p, and the start pass sends a long 1080p clip to the engine', async () => {
    const params = paramsOf(FX.runs[0]!.widgets)
    const hd = { count: 600, w: 1920, h: 1080, exact: true }
    expect(VIDEO_EFFECTS.Stabilize!.heldBytes(params, [hd])).toBeLessThan(MEDIA_CAPS.hosted.heldFrameBytes)
    const p: ApiPrompt = { ...sources(), e: stabilized(FX.runs[0]!.widgets), c: createVideo('e'), s: saveVideo('c') }
    expect(await mediaEffectStartProblems(p, ON, { hosted: true, shapes: new Map([['g:0', { count: 3000, w: 1920, h: 1080, exact: true }]]) })).toMatchObject({ nodeId: 'e', engine: true })
    expect(await mediaEffectStartProblems(p, ON, { hosted: true, shapes: new Map([['g:0', { count: 24, w: 1920, h: 1080, exact: true }]]) })).toBeNull()
  })
})

// ── Stop, and an early leave ─────────────────────────────────────────────────

describe('Stop in either pass, and a one-frame clip’s early leave', () => {
  const W = 200
  const H = 120
  const T = 16
  const shaking = (): Clip => {
    const base = synth(W + 16, H + 16, 3, 99)
    return {
      w: W, h: H,
      frames: Array.from({ length: T }, (_, i) => {
        const f = new Uint8Array(W * H * 3)
        const d = (i * 5) % 9
        for (let y = 0; y < H; y++) f.set(base.subarray(((y + d) * (W + 16) + (8 - d)) * 3, ((y + d) * (W + 16) + (8 - d) + W) * 3), y * W * 3)
        return f
      }),
    }
  }
  for (const [pass, at] of [['pass 1', 5], ['pass 2', T + 5]] as const) {
    it(`stopped in ${pass}: no tool process left within a second, no kept file but its input`, LONG, async () => {
      await requireMediaTools()
      const h = vfxHarness(scratch)
      const runId = vfxRunId(++runs)
      const input = await keptBatch(h, runId, shaking())
      const before = PROCS.pids.length
      const ctl = new AbortController()
      HOOK.frames = 0
      HOOK.abortAt = at
      HOOK.ctl = ctl
      try {
        await expect(runVfxNode(h, { ...sources(), e: stabilized(FX.runs[0]!.widgets), r: trimOf('e') }, 'e', { g: { 0: input } }, { runId, families: ON, signal: ctl.signal }))
          .rejects.toThrow(MEDIA_WORDS.stopped)
        expect(Date.now() - HOOK.abortedAt).toBeLessThan(1000)
      }
      finally { HOOK.abortAt = 0; HOOK.ctl = null }
      const pids = PROCS.pids.slice(before)
      // The encoder and pass 1's decode (and pass 2's, when stopped there).
      expect(pids.length).toBeGreaterThanOrEqual(pass === 'pass 1' ? 2 : 3)
      for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
      expect(readdirSync(join(h.root, 'kept', runId))).toEqual([input.file.filename])
    })
  }

  it('the whole clip through both passes finishes with every process gone; a one-frame clip hands its input on after the preview frame, ten times: no ffmpeg left', LONG, async () => {
    await requireMediaTools()
    const h = vfxHarness(scratch)
    const runId = vfxRunId(++runs)
    const whole = await keptBatch(h, runId, shaking())
    const one = await keptBatch(h, runId, clipFrames(FX, 'clip1'))
    const before = PROCS.pids.length
    const got = await runVfxNode(h, { ...sources(), e: stabilized(FX.runs[0]!.widgets), r: trimOf('e') }, 'e', { g: { 0: whole } }, { runId, families: ON })
    expect((got.values[0] as Extract<RunnerValue, { kind: 'frames' }>).count).toBe(T)
    for (let k = 0; k < 10; k++) {
      const m = await runVfxNode(h, { ...sources(), e: stabilized(FX.runs[0]!.widgets), r: trimOf('e') }, 'e', { g: { 0: one } }, { runId, families: ON })
      expect((m.values[0] as Extract<RunnerValue, { kind: 'frames' }>).file.filename).toBe(one.file.filename)
    }
    const pids = PROCS.pids.slice(before)
    expect(pids.length).toBe(3 + 10)
    for (const pid of pids) expect(() => process.kill(pid, 0), `pid ${pid}`).toThrow()
  })
})

// ── The esbuild guard: the cores built as Nitro builds server code ───────────

describe('esbuild guard: the FFT and Stabilize cores survive Nitro’s build', () => {
  const require = createRequire(import.meta.url)
  const pnpm = fileURLToPath(new URL('../../node_modules/.pnpm/', import.meta.url))
  const builds = existsSync(pnpm) ? readdirSync(pnpm).filter(d => /^esbuild@\d/.test(d)).map(d => join(pnpm, d, 'node_modules', 'esbuild')) : []
  const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../server/runner/${rel}`, import.meta.url)), 'utf8')
  const dir = mkdtempSync(join(scratch, 'esbuild-'))
  const A = stabClip('shake-96x64')

  it('finds an esbuild to build with', () => {
    expect(builds.length).toBeGreaterThan(0)
  })

  for (const esbuildDir of builds) {
    for (const minify of [false, true]) {
      it(`${esbuildDir.split('/').at(-3)} target es2019, minify ${minify}: track and warp run in a Worker as on this thread`, async () => {
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
        const ft = await build('video/core/fft.ts', 'fft')
        const stab = await build('video/core/stabilize.ts', 'stabilize')
        const cores = [
          { name: 'tk', fn: tk.tensorCore as never, args: ['px'] },
          { name: 'kn', fn: kn.kernelsCore as never, args: ['tk', 'px'] },
          { name: 'vx', fn: time.framesCore as never, args: ['tk'] },
          { name: 'ft', fn: ft.fftCore as never, args: [] },
          { name: 'stab', fn: stab.stabilizeCore as never, args: ['tk', 'kn', 'ft'] },
        ]
        const w = new Worker(workerScript(compositorCore, px.pixelsCore as never, cores), { eval: true, workerData: { stop: new SharedArrayBuffer(4) } })
        try {
          const reply = (m: Record<string, unknown>, transfer: ArrayBuffer[] = []) => new Promise<any>((res) => { w.once('message', res); w.postMessage(m, transfer) })
          let id = 0
          let state: ArrayBuffer | undefined
          const here = shiftsHere({ frames: A.frames.slice(0, 4), w: A.w, h: A.h })
          for (let i = 0; i < 4; i++) {
            const r = await reply({ id: ++id, op: 'vfx.frame', fn: 'stab.track', params: {}, index: i, count: 4, inputs: [{ rgb: A.frames[i]!.slice(), w: A.w, h: A.h }], ...(state ? { state } : {}), quant: 'round', preview: false }, state ? [state] : [])
            expect(r.error).toBeUndefined()
            state = r.value.state
            expect(shiftOf(state), `frame ${i}`).toEqual(here[i])
          }
          for (const p of [{ edge_mode: 'crop', crop_pad: 0.05 }, { edge_mode: 'border', crop_pad: 0 }]) {
            const params = { ...p, _ty: 1.75, _tx: -2.5 }
            const r = await reply({ id: ++id, op: 'vfx.frame', fn: 'stab.warp', params, index: 1, count: 4, inputs: [{ rgb: A.frames[1]!.slice(), w: A.w, h: A.h }], quant: 'round', preview: false })
            expect(r.error).toBeUndefined()
            const mine = videoCores.stab.warp([videoCores.vx.fromRgb(A.frames[1]!, A.w, A.h)], params, undefined, 1, 4)
            expect([...r.value.rgb], p.edge_mode).toEqual([...videoCores.vx.toRgb(mine.out, 'round')])
          }
        }
        finally { await w.terminate() }
      }, 30_000)
    }
  }
})

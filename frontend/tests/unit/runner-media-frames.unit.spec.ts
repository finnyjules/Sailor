/**
 * Task R5.5: frame batches from and to files, family `media-video`
 * (server/runner/media/frameNodes.ts): LoadVideoFrames and SaveVideoFrames
 * (comfy_extras/nodes_video_effects.py), and Pillow's resize(BILINEAR) in the
 * pixel core (pixels/core.ts pilResize, filter 'bilinear').
 *
 * Parity is against scripts/runner_media_fixtures.py --group frames: each
 * class's own execute as the real Python (PyAV 17, Pillow 12) runs it. Loaded
 * frames are byte-equal to Python's (the frame choice, the resize, the 64 × 64
 * black fallback) and the rate equal; a saved H.264 file is judged by ruling
 * (c) as R5.4's are (the numbers exact, the frames equal to Python's own
 * pipeline switched to libopenh264, no further from the source than libx264
 * within 0.5 dB); its sound, the file's first stream cut after the first frame
 * past the video's length, decodes exactly as Python's does. Names and ui are
 * Python's, with ruling (h)'s counter only on a clash.
 *
 * The parity parts need the real tools (R5.1a): they fail, never skip, when
 * the tools are missing.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

/** Fix round 1 (Minor 6): a hook in the worker's resize, to stop a run while frames flow and a resize runs. */
const HOOK = vi.hoisted(() => ({ calls: 0, abortAt: 0, ctl: null as AbortController | null }))
vi.mock('~~/server/runner/compositor/worker', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/runner/compositor/worker')>()
  return {
    ...real,
    pixelsInWorker: ((signal, job, timeout) => real.pixelsInWorker(signal, w => job(new Proxy(w, {
      get(t, k) {
        const v = Reflect.get(t, k)
        if (k !== 'resizeRgb') return typeof v === 'function' ? v.bind(t) : v
        return (...a: Parameters<typeof t.resizeRgb>) => {
          const running = t.resizeRgb(...a)
          if (++HOOK.calls === HOOK.abortAt) HOOK.ctl?.abort()
          return running
        }
      },
    })), timeout)) as typeof real.pixelsInWorker,
  }
})
import { makeKit } from './__runner__/kit'
import { synth } from './__runner__/effectsParity'
import { clipPath, requireMediaTools, sha256Hex, unz, type PySound, type PyRational } from './__runner__/mediaParity'
import type { ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, type RunnerFamily } from '#shared/runner/families'
import {
  LOCAL_RENDER_TYPES, RUNNER_NODE_RULES, SWITCHED_CLASSES,
  isRunnerEligible, outputKindsFor, runnerTakesNode, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { OUTPUT_KINDS } from '#shared/runner/values'
import { RUNNER_OUTPUT_CLASSES, pruneInvalidOutputs, runnerTakesWorkflow } from '#shared/runner/validate'
import { stopGapRefusal } from '#shared/runner/stopGaps'
import { VIDEO_FORMAT_ADVICE, withAdvice } from '#shared/runner/messages'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { pixelsCore } from '~~/server/runner/pixels/core'
import { planNode, type DeriveIO, type Derived, type NodePlan } from '~~/server/runner/executors'
import { createEngineResultStore, type ResultStore } from '~~/server/runner/results'
import { createFileKeptBytes, type KeptBytes } from '~~/server/runner/keptBytes'
import { createFileAccess, type FileAccess } from '~~/server/runner/fileAccess'
import { collectInputFiles } from '~~/server/runner/inputs'
import { filesOf } from '~~/server/runner/values'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { decodeAudio, decodeFrames } from '~~/server/media/decode'
import { probeMedia, pyFrameCount, pyFrameRate, pyRawDuration } from '~~/server/media/probe'
import { readFrames } from '~~/server/media/values'
import { NO_FRAMES_WIRED, frameStartProblems, framesPrefixOutside, framesStreamRate, loadFramesPick, saveFramesName } from '~~/server/runner/media/frameNodes'
import { pyStreamRate } from '~~/server/media/encode'
import { KEPT_TOO_MUCH } from '~~/server/runner/keptBytes'
import { SAVE_OUTSIDE } from '~~/server/runner/results'
import { VIDEO_FILE_MISSING } from '~~/server/runner/media/videoNodes'

// ── The fixture ──────────────────────────────────────────────────────────────

interface PyEntry { filename: string; subfolder: string; type: string }
interface PyUi { images: PyEntry[]; animated?: boolean[] }
interface PyHeader {
  formatName: string; containerDuration: number | null; bytes: number
  video: { w: number; h: number; codec: string; pixFmt: string; averageRate: PyRational | null; frames: number; duration: number | null; timeBase: PyRational }[]
  sound: { rate: number; channels: number; layout: string; codec: string; duration: number | null; timeBase: PyRational }[]
}
interface PySaved {
  header: PyHeader; frameCount: number; frameRate: PyRational; duration: number
  frames: string[]; rgbz?: string; rgbzKey?: string; psnr?: number | null
  sound: PySound | null
}
interface PyRun { ui: PyUi; saved: PySaved; written: string[]; result: unknown[] }
interface LoadSettings { max_size: number; stride: number; start_frame: number; max_seconds: number; max_frames: number }
type LoadCase = LoadSettings & { clip: string } & ({ error: string } | { w: number; h: number; frames: number[]; fps: number })
interface SaveCase {
  source: 'even' | 'odd'; fps: number; crf: number; audio: string
  kept?: { kept: number; rate: number; frameSizes: number[]; lastFrame: number; broken?: string } | { error: string } | null
  x264: PyRun; openh264: PyRun
}
interface FramesCases {
  groupClips: Record<string, string>
  stamp: string; pastEnd: number
  loads: LoadCase[]
  tables: Record<string, string[]>
  black64: string
  validate: { missing: string; present: boolean }
  pilBilinear: { w: number; h: number; seed: number; ow: number; oh: number; sha256: string; rgb?: string }[]
  sources: Record<'even' | 'odd', { clip: string; max_size: number; max_seconds: number; w: number; h: number; count: number }>
  saves: SaveCase[]
  names: { prefix: string; ui: PyUi; written: string[] }[]
  rgbz: Record<string, string>
}

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const FIX = JSON.parse(readFileSync(join(FIXTURES, 'runner-media-frames.json'), 'utf8')) as { cases: FramesCases; clips: Record<string, string> }
const C = FIX.cases
const LONG = { timeout: 120_000 }
const BIG = Number.MAX_SAFE_INTEGER
/** Ruling (c)'s sanity bound on the mean difference from libx264's frames, in levels (2/255 of full scale). */
const MEAN_DIFF_BOUND = 2

const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video'])
const ON_BOTH: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'media-sound'])
const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

/** Python's stamp as the runner reads the clock: the same local second. */
function stampDate(): Date {
  const m = /^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(C.stamp)!
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

const scratch = mkdtempSync(join(tmpdir(), 'media-frames-spec-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

const rid = (n: number) => `run_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
let runs = 0

// ── A node run with the real stores ──────────────────────────────────────────

interface Harness { root: string; results: ResultStore; kept: KeptBytes; access: FileAccess; hosted: boolean; userId: string | null }

function harness(o: { hosted?: boolean; clips?: string[] } = {}): Harness {
  const root = mkdtempSync(join(scratch, 'h-'))
  for (const t of ['input', 'output', 'temp']) mkdirSync(join(root, t), { recursive: true })
  for (const c of o.clips ?? []) copyFileSync(clipPath(c), join(root, 'input', c))
  const hosted = !!o.hosted
  const results = createEngineResultStore({ dirForType: t => join(root, t), hosted: () => hosted })
  const kept = createFileKeptBytes(join(root, 'kept'))
  return { root, results, kept, access: createFileAccess(results, kept), hosted, userId: hosted ? 'user_1' : null }
}

function ioFor(h: Harness, nodeId: string, runId: string, assets: OutputFile[], signal = new AbortController().signal, kept: KeptBytes = h.kept): DeriveIO {
  type SaveOpts = Parameters<NonNullable<DeriveIO['saveAssetFromPath']>>[1]
  const opts = (a: SaveOpts) => ({
    userId: h.userId, prefix: a.prefix, ext: a.ext,
    ...(a.subfolder !== undefined ? { subfolder: a.subfolder } : {}),
    ...(a.folder ? { folder: a.folder } : {}),
    ...(a.counter ? { counter: a.counter } : {}),
    ...(a.exact ? { exact: true as const } : {}),
  })
  return {
    read: f => h.access.read(f),
    keep: (b, ext) => kept.put(runId, b, ext),
    saveAsset: async () => { throw new Error('not here') },
    saveAssetFromPath: async (path, a) => {
      const f = await h.results.saveFromPath!(path, opts(a))
      if ((a.folder ?? 'output') === 'output') assets.push(f)
      return f
    },
    savePreview: async () => { throw new Error('no live previews') },
    savePreviewAs: async () => { throw new Error('no previews') },
    hosted: h.hosted, signal, nodeId,
    runWorkflow: null, runPrompt: {},
    media: { access: h.access, kept, runId, userId: h.userId, hosted: h.hosted, signal },
  }
}

async function runNode(h: Harness, prompt: ApiPrompt, id: string, values: Record<string, Record<number, RunnerValue>> = {}, o: { runId?: string; signal?: AbortSignal; kept?: KeptBytes } = {}): Promise<Derived & { assets: OutputFile[] }> {
  const plan: NodePlan = await planNode({
    prompt, nodeId: id, families: ON, gateOpen: false,
    filesFrom: l => filesOf(values[l[0]]?.[l[1]]),
    valueFrom: l => values[l[0]]?.[l[1]],
    toUrl: async () => '',
  })
  expect(plan.kind, `${prompt[id]!.class_type} plans a derive`).toBe('derive')
  const assets: OutputFile[] = []
  const made = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive(ioFor(h, id, o.runId ?? rid(++runs), assets, o.signal, o.kept))
  return { ...made, assets }
}

const inputFile = (name: string): OutputFile => ({ filename: name, subfolder: '', type: 'input' })

// ── Prompts ──────────────────────────────────────────────────────────────────

type Link = [string, number]
const DEFAULTS: LoadSettings = { max_seconds: 10, max_frames: 600, max_size: 720, start_frame: 0, stride: 1 }
const loadFrames = (file: string | Link, s: Partial<LoadSettings> = {}) => ({ class_type: 'LoadVideoFrames', inputs: { file, ...DEFAULTS, ...s } })
const saveFrames = (frames: Link, o: { fps?: number | Link; prefix?: string; audio?: string | Link; crf?: number; preset?: string } = {}) => ({
  class_type: 'SaveVideoFrames',
  inputs: { frames, fps: o.fps ?? 30, filename_prefix: o.prefix ?? 'video', audio_file: o.audio ?? '(none)', preset: o.preset ?? 'veryfast', crf: o.crf ?? 20 },
})
const loadVideo = (file: string) => ({ class_type: 'LoadVideo', inputs: { file } })
const getComp = (from: string) => ({ class_type: 'GetVideoComponents', inputs: { video: [from, 0] as Link } })
const createVideo = (images: Link, fps: number | Link) => ({ class_type: 'CreateVideo', inputs: { images, fps } })
const saveVideo = (from: string) => ({ class_type: 'SaveVideo', inputs: { video: [from, 0] as Link, filename_prefix: 'video/ComfyUI', format: 'auto', codec: 'auto' } })
const saveImage = (from: Link) => ({
  class_type: 'SaveImage',
  inputs: { images: from, filename_prefix: 'ComfyUI', format: 'png', quality: 90, lossless_webp: true, png_compression: 6, scale: 1, max_dimension: 0, embed_metadata: true },
})

// ── Reading files back ───────────────────────────────────────────────────────

function concat(list: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(list.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const f of list) { out.set(f, at); at += f.length }
  return out
}

function psnr(a: Uint8Array, b: Uint8Array): number {
  let se = 0
  for (let i = 0; i < a.length; i++) { const d = a[i]! - b[i]!; se += d * d }
  const mse = se / a.length
  return mse ? 10 * Math.log10((255 * 255) / mse) : Number.POSITIVE_INFINITY
}

function meanDiff(a: Uint8Array, b: Uint8Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!)
  return s / a.length
}

function soundBytes(channels: Float32Array[]): Uint8Array {
  return concat(channels.map(ch => new Uint8Array(ch.buffer.slice(ch.byteOffset, ch.byteOffset + ch.byteLength))))
}

const rootsOf = (path: string) => [join(path, '..')]

async function decodeAll(path: string): Promise<Uint8Array[]> {
  const frames: Uint8Array[] = []
  await decodeFrames(path, { userId: null, maxFrames: BIG, roots: rootsOf(path), onFrame: async (f) => { frames.push(f) } })
  return frames
}

/** A kept batch's frames, rgb24, in order. */
async function batchFrames(h: Harness, v: RunnerValue): Promise<Uint8Array[]> {
  const out: Uint8Array[] = []
  await readFrames(v as Extract<RunnerValue, { kind: 'frames' }>, { access: h.access, kept: h.kept, runId: rid(runs), userId: null, hosted: false }, async (rgb) => { out.push(rgb) })
  return out
}

/** SaveVideoFrames' padding: black at the right and bottom, to even sizes. */
function padded(frames: Uint8Array[], w: number, h: number): Uint8Array[] {
  const ew = w + (w % 2)
  const eh = h + (h % 2)
  return frames.map((f) => {
    const out = new Uint8Array(ew * eh * 3)
    for (let y = 0; y < h; y++) out.set(f.subarray(y * w * 3, (y + 1) * w * 3), y * ew * 3)
    return out
  })
}

/** Ruling (c), as R5.4 judges a saved H.264 file (runner-media-video's expectH264File). */
async function expectH264File(path: string, openh264: PySaved, x264: PySaved, source: Uint8Array, label: string): Promise<Record<string, number | null>> {
  const p = await probeMedia(path, { userId: null, roots: rootsOf(path) })
  const want = openh264.header
  expect(p.formatName, label).toBe(want.formatName)
  expect(p.containerDuration, `${label}: length`).toBe(want.containerDuration)
  expect(p.video.map(v => ({ w: v.w, h: v.h, codec: v.codec, pixFmt: v.pixFmt, averageRate: v.averageRate, frames: v.frames, duration: v.duration, timeBase: v.timeBase })), label)
    .toEqual(want.video.map(v => ({ w: v.w, h: v.h, codec: v.codec, pixFmt: v.pixFmt, averageRate: v.averageRate, frames: v.frames, duration: v.duration, timeBase: v.timeBase })))
  expect(p.sound.map(s => ({ rate: s.rate, channels: s.channels, layout: s.layout, codec: s.codec, duration: s.duration, timeBase: s.timeBase })), label)
    .toEqual(want.sound.map(s => ({ rate: s.rate, channels: s.channels, layout: s.layout, codec: s.codec, duration: s.duration, timeBase: s.timeBase })))
  expect(await pyFrameCount(p, p.path, { userId: null }), label).toBe(openh264.frameCount)
  expect(pyFrameRate(p), label).toEqual(openh264.frameRate)
  expect(pyRawDuration(p), label).toBe(openh264.duration)
  expect(openh264.frameCount, label).toBe(x264.frameCount)
  expect(openh264.frameRate, label).toEqual(x264.frameRate)
  const frames = await decodeAll(path)
  expect(frames.map(sha256Hex), `${label}: equal to Python's pipeline on libopenh264`).toEqual(openh264.frames)
  const all = concat(frames)
  const py = unz(x264.rgbz ?? C.rgbz[x264.rgbzKey!]!)
  expect(all.length, label).toBe(py.length)
  const mean = meanDiff(all, py)
  const ours = psnr(source, all)
  expect(Math.abs(openh264.psnr! - ours), `${label}: the same distance from the source as Python's libopenh264 run`).toBeLessThan(1e-9)
  expect(ours, `${label}: no further from the source than libx264`).toBeGreaterThanOrEqual(x264.psnr! - 0.5)
  if (ours < x264.psnr!) expect(mean, `${label}: mean difference from libx264`).toBeLessThanOrEqual(MEAN_DIFF_BOUND)
  return { mean: Math.round(mean * 1000) / 1000, psnrOurs: Math.round(ours * 100) / 100, psnrPython: x264.psnr ?? null }
}

/** Every file under a folder, relative, sorted. */
function written(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name))
      else out.push(relative(dir, join(d, e.name)))
    }
  }
  walk(dir)
  return out.sort()
}

const settingsOf = (c: LoadSettings): LoadSettings => ({ max_size: c.max_size, stride: c.stride, start_frame: c.start_frame, max_seconds: c.max_seconds, max_frames: c.max_frames })
const labelOf = (c: LoadCase) => `${c.clip} size ${c.max_size} stride ${c.stride} start ${c.start_frame} seconds ${c.max_seconds} frames ${c.max_frames}`

// ── Pillow's resize(BILINEAR) ────────────────────────────────────────────────

describe('Pillow’s resize(BILINEAR) in the pixel core', () => {
  const px = pixelsCore()
  for (const c of C.pilBilinear) {
    it(`${c.w}×${c.h} → ${c.ow}×${c.oh} is byte-equal to Pillow`, () => {
      const got = px.pilResize(synth(c.w, c.h, 3, c.seed), c.w, c.h, 3, c.ow, c.oh, undefined, 'bilinear')
      expect(got.length).toBe(c.ow * c.oh * 3)
      if (c.rgb) expect(Buffer.from(got).toString('base64')).toBe(c.rgb)
      expect(sha256Hex(got)).toBe(c.sha256)
    })
  }

  it('Lanczos stays the default: no filter named is exactly Lanczos, and it differs from bilinear', () => {
    const src = synth(64, 48, 3, 5)
    const plain = px.pilResize(src, 64, 48, 3, 17, 13)
    expect(sha256Hex(px.pilResize(src, 64, 48, 3, 17, 13, undefined, 'lanczos'))).toBe(sha256Hex(plain))
    expect(sha256Hex(px.pilResize(src, 64, 48, 3, 17, 13, undefined, 'bilinear'))).not.toBe(sha256Hex(plain))
  })
})

// ── LoadVideoFrames ──────────────────────────────────────────────────────────

describe('LoadVideoFrames equals Python’s execute', () => {
  it('covers every standard clip, and this group’s own clips at every max_size', () => {
    const clips = new Set(C.loads.map(c => c.clip))
    for (const n of Object.keys(FIX.clips)) expect(clips.has(n), n).toBe(true)
    for (const [n, sha] of Object.entries(C.groupClips)) expect(sha256Hex(readFileSync(clipPath(n))), n).toBe(sha)
    const sizes = new Set(C.loads.filter(c => c.clip === 'g_frames_big.mp4' && c.start_frame !== C.pastEnd && !('error' in c)).map(c => `${(c as { w: number }).w}×${(c as { h: number }).h}`))
    expect([...sizes].sort()).toEqual(['160×90', '64×36', '96×54'])
  })

  const byClip = new Map<string, LoadCase[]>()
  for (const c of C.loads) byClip.set(c.clip, [...(byClip.get(c.clip) ?? []), c])
  for (const [clip, cases] of byClip) {
    it(`${clip}: frames, size and fps in ${cases.length} settings`, { timeout: 300_000 }, async () => {
      await requireMediaTools()
      const h = harness({ clips: [clip] })
      const table = C.tables[clip] ?? []
      for (const c of cases) {
        const label = labelOf(c)
        const prompt = { l: loadFrames(clip, settingsOf(c)) }
        if ('error' in c) {
          // Python: IndexError on a sound file's missing picture, or torch.stack of frames of two sizes.
          const words = c.error.startsWith('IndexError') ? MEDIA_WORDS.noVideo : MEDIA_WORDS.sizeChanged
          await expect(runNode(h, prompt, 'l'), label).rejects.toThrow(words)
          continue
        }
        const made = await runNode(h, prompt, 'l')
        expect(made.values[0], label).toMatchObject({ kind: 'frames', count: c.frames.length, w: c.w, h: c.h })
        expect(filesOf(made.values[0])[0]!.type).toBe('kept')
        const shas = (await batchFrames(h, made.values[0]!)).map(sha256Hex)
        expect(shas, `${label}: frames`).toEqual(c.frames.map(i => table[i]))
        expect(made.values[1], `${label}: fps`).toEqual({ kind: 'number', value: c.fps, int: false })
        expect(made.ui, label).toBeNull()
      }
      expect(written(join(h.root, 'output'))).toEqual([])
    })
  }

  it('nothing kept gives one 64 × 64 black frame (a start past the end)', LONG, async () => {
    await requireMediaTools()
    const past = C.loads.filter(c => c.start_frame === C.pastEnd && !('error' in c)) as Extract<LoadCase, { w: number }>[]
    expect(past.length).toBeGreaterThan(10)
    for (const c of past) {
      expect({ w: c.w, h: c.h, frames: c.frames.map(i => C.tables[c.clip]![i]) }, labelOf(c)).toEqual({ w: 64, h: 64, frames: [C.black64] })
    }
    const h = harness({ clips: ['g_frames_big.mp4'] })
    const made = await runNode(h, { l: loadFrames('g_frames_big.mp4', { start_frame: C.pastEnd, max_size: 64 }) }, 'l')
    expect(made.values[0]).toMatchObject({ kind: 'frames', count: 1, w: 64, h: 64 })
    const [frame] = await batchFrames(h, made.values[0]!)
    expect(sha256Hex(frame!)).toBe(C.black64)
    expect(frame!.every(b => b === 0)).toBe(true)
  })

  it('the frame choice: Python’s round, rate, time cap and frame cap', () => {
    // 128 × 73 at 64: 36.5 rounds half to even (36); 160 × 90 at 96: 54.
    expect(loadFramesPick({ w: 128, h: 73, rate: { num: 25, den: 1 } }, { ...DEFAULTS, max_size: 64 })).toMatchObject({ tw: 64, th: 36, fps: 25 })
    expect(loadFramesPick({ w: 160, h: 90, rate: { num: 24, den: 1 } }, { ...DEFAULTS, max_size: 96 })).toMatchObject({ tw: 96, th: 54 })
    // No rate: 30. int(0.5 · 24 / 3) = 4; a cap of 0 still keeps one frame.
    expect(loadFramesPick({ w: 32, h: 24, rate: null }, DEFAULTS)).toMatchObject({ fps: 30, tw: 32, th: 24 })
    expect(loadFramesPick({ w: 32, h: 24, rate: { num: 24, den: 1 } }, { ...DEFAULTS, max_seconds: 0.5, stride: 3 })).toMatchObject({ count: 4, start: 0, stride: 3 })
    expect(loadFramesPick({ w: 32, h: 24, rate: { num: 24, den: 1 } }, { ...DEFAULTS, max_seconds: 0.01 })).toMatchObject({ count: 1 })
    expect(loadFramesPick({ w: 32, h: 24, rate: { num: 24, den: 1 } }, { ...DEFAULTS, max_seconds: 0, max_frames: 7 })).toMatchObject({ count: 7 })
    expect(loadFramesPick({ w: 32, h: 24, rate: { num: 400, den: 17 } }, { ...DEFAULTS, stride: 2 }).outFps).toBe(400 / 17 / 2)
  })
})

// ── SaveVideoFrames ──────────────────────────────────────────────────────────

describe('SaveVideoFrames equals Python’s execute (ruling c for the pictures; the sound exact)', () => {
  afterEach(() => { vi.useRealTimers() })
  const measured: Record<string, unknown> = {}
  afterAll(() => { console.info('[media-frames] saved videos measured', JSON.stringify(measured)) })

  for (const c of C.saves) {
    const label = `${c.source} ${c.fps} fps CRF ${c.crf}, sound ${c.audio}`
    it(label, LONG, async () => {
      await requireMediaTools()
      const s = C.sources[c.source]
      const soundClips = c.audio !== '(none)' && existsSync(clipPath(c.audio)) ? [c.audio] : []
      const h = harness({ clips: [s.clip, ...soundClips] })
      const load = await runNode(h, { l: loadFrames(s.clip, { max_size: s.max_size, max_seconds: s.max_seconds }) }, 'l')
      expect(load.values[0]).toMatchObject({ kind: 'frames', count: s.count, w: s.w, h: s.h })
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(stampDate())
      const prompt = { l: loadFrames(s.clip), s: saveFrames(['l', 0], { fps: c.fps, crf: c.crf, audio: c.audio }) }
      const saved = await runNode(h, prompt, 's', { l: load.values })
      vi.useRealTimers()
      expect(saved.ui).toEqual(c.x264.ui)
      expect(saved.values).toEqual({})
      expect(c.x264.result).toEqual([])
      expect(saved.assets).toEqual(c.x264.ui.images)
      expect(written(join(h.root, 'output'))).toEqual(c.x264.written)
      const path = h.results.pathOf!(saved.assets[0]!)
      const source = concat(padded(await batchFrames(h, load.values[0]!), s.w, s.h))
      measured[label] = await expectH264File(path, c.openh264.saved, c.x264.saved, source, label)
      // The sound: none where Python has none (no file, a missing one, one that won't open); else exactly Python's.
      const want = c.openh264.saved.sound
      expect(c.x264.saved.sound, `${label}: the sound doesn't depend on the video encoder`).toEqual(want)
      const p = await probeMedia(path, { userId: null, roots: rootsOf(path) })
      if (!want) {
        expect(p.sound, `${label}: no sound`).toEqual([])
        return
      }
      const got = await decodeAudio(path, { decoder: 'fltp', userId: null, maxSamples: BIG, roots: rootsOf(path) })
      expect({ rate: got.rate, rows: got.channels.length, samples: got.channels[0]!.length }, label).toEqual({ rate: want.rate, rows: want.rows, samples: want.samples })
      expect(sha256Hex(soundBytes(got.channels)), `${label}: the sound decodes exactly as Python's`).toBe(want.sha256)
    })
  }

  it('the sound runs past the video by at most one of its own frames, as Python’s loop keeps it', () => {
    const withSound = C.saves.filter(c => c.kept && !('error' in c.kept) && !c.kept.broken)
    expect(withSound.length).toBeGreaterThanOrEqual(10)
    let over = 0
    for (const c of withSound) {
      const k = c.kept as { kept: number; rate: number; lastFrame: number }
      const s = C.sources[c.source]
      const video = (s.count / c.fps) * k.rate
      // At most the frame that starts at or before the video's end (a frame's time, not its samples, is
      // what Python's loop reads: an MP3's first frame is short, so it can end a little early too).
      expect(k.kept, c.audio).toBeLessThan(video + k.lastFrame + 1)
      if (k.kept > video) over++
      // Python's AAC then holds the kept samples plus the encoder's 1024 of priming, in whole frames of 1024:
      // what the parity cases above decode, exactly, from the runner's files.
      const want = c.openh264.saved.sound!
      expect(want.samples, c.audio).toBe(Math.ceil((k.kept + 1024) / 1024) * 1024)
    }
    // Teeth: most files do run past the video.
    expect(over).toBeGreaterThanOrEqual(8)
  })

  it('names: (prefix or “video”).rstrip(“_”) and the second, in output’s top folder', LONG, async () => {
    await requireMediaTools()
    for (const n of C.names) {
      expect(saveFramesName(n.prefix, stampDate()), n.prefix).toEqual({ subfolder: '', name: n.ui.images[0]!.filename.replace(/\.mp4$/, '') })
      const h = harness({ clips: ['g_frames_big.mp4'] })
      const load = await runNode(h, { l: loadFrames('g_frames_big.mp4', { max_size: 96, max_frames: 1 }) }, 'l')
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(stampDate())
      const saved = await runNode(h, { l: loadFrames('g_frames_big.mp4'), s: saveFrames(['l', 0], { prefix: n.prefix, fps: 24 }) }, 's', { l: load.values })
      vi.useRealTimers()
      expect(saved.ui, n.prefix).toEqual(n.ui)
      expect(written(join(h.root, 'output')), n.prefix).toEqual(n.written)
    }
    // A prefix naming a folder saves into it (Python writes the joined path only if the folder exists).
    expect(saveFramesName('clips/take_', stampDate())).toEqual({ subfolder: 'clips', name: `take_${C.stamp}` })
  })

  it('ruling (h): two saves in the same second both land, the second with a counter; nothing is overwritten', LONG, async () => {
    await requireMediaTools()
    const h = harness({ clips: ['g_frames_big.mp4'] })
    const load = await runNode(h, { l: loadFrames('g_frames_big.mp4', { max_size: 64, max_frames: 2 }) }, 'l')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(stampDate())
    const prompt = { l: loadFrames('g_frames_big.mp4'), s: saveFrames(['l', 0], { fps: 24 }) }
    const a = await runNode(h, prompt, 's', { l: load.values })
    const first = readFileSync(h.results.pathOf!(a.assets[0]!))
    const b = await runNode(h, { ...prompt, s: saveFrames(['l', 0], { fps: 12 }) }, 's', { l: load.values })
    vi.useRealTimers()
    expect(a.assets[0]!.filename).toBe(`video_${C.stamp}.mp4`)
    expect(b.assets[0]!.filename).toBe(`video_${C.stamp}_2.mp4`)
    expect(written(join(h.root, 'output'))).toEqual([`video_${C.stamp}.mp4`, `video_${C.stamp}_2.mp4`])
    expect(sha256Hex(readFileSync(h.results.pathOf!(a.assets[0]!)))).toBe(sha256Hex(first))
  })

  it('the padding is black: the odd batch’s padded column and row decode as Python’s black padding does', LONG, async () => {
    await requireMediaTools()
    const c = C.saves.find(x => x.source === 'odd' && x.crf === 10 && x.audio === '(none)')!
    const s = C.sources.odd
    expect(s.w % 2 && s.h % 2).toBeTruthy()
    expect(c.openh264.saved.header.video[0]).toMatchObject({ w: s.w + 1, h: s.h + 1 })
    const h = harness({ clips: [s.clip] })
    const load = await runNode(h, { l: loadFrames(s.clip, { max_size: s.max_size, max_seconds: s.max_seconds }) }, 'l')
    const saved = await runNode(h, { l: loadFrames(s.clip), s: saveFrames(['l', 0], { fps: c.fps, crf: c.crf }) }, 's', { l: load.values })
    const frames = await decodeAll(h.results.pathOf!(saved.assets[0]!))
    expect(frames.map(sha256Hex)).toEqual(c.openh264.saved.frames)
    // The pad itself: dark (H.264 blurs the picture's edge into it, so it is judged on average).
    const W = s.w + 1
    let sum = 0
    let n = 0
    for (const f of frames) {
      for (let y = 0; y <= s.h; y++) for (let k = 0; k < 3; k++) { sum += f[(y * W + s.w) * 3 + k]!; n++ }
      for (let x = 0; x < s.w; x++) for (let k = 0; k < 3; k++) { sum += f[(s.h * W + x) * 3 + k]!; n++ }
    }
    console.info(`[media-frames] odd batch: the padded column and row average ${(sum / n).toFixed(2)} levels`)
    expect(sum / n).toBeLessThan(24)
  })
})

// ── Stop, caps and guards ────────────────────────────────────────────────────

describe('Stop and the caps', () => {
  /** A kept store that aborts the run the `nth` time a work folder is made. */
  function abortingKept(kept: KeptBytes, ctl: AbortController, nth: number): KeptBytes {
    let n = 0
    return new Proxy(kept, {
      get(t, k) {
        const v = Reflect.get(t, k)
        if (k !== 'workDir') return typeof v === 'function' ? v.bind(t) : v
        return async (runId: string) => {
          const dir = await t.workDir(runId)
          if (++n === nth) ctl.abort()
          return dir
        }
      },
    })
  }

  for (const [how, size, nth] of [['resized, stopped as it decodes', 64, 1], ['resized, stopped as it keeps', 64, 2], ['not resized, stopped as it decodes', 720, 1]] as const) {
    it(`Stop mid-decode leaves no kept file (${how})`, LONG, async () => {
      await requireMediaTools()
      const h = harness({ clips: ['g_frames_big.mp4'] })
      const ctl = new AbortController()
      const runId = rid(++runs)
      await expect(runNode(h, { l: loadFrames('g_frames_big.mp4', { max_size: size }) }, 'l', {}, { runId, signal: ctl.signal, kept: abortingKept(h.kept, ctl, nth) }))
        .rejects.toThrow(MEDIA_WORDS.stopped)
      expect(ctl.signal.aborted).toBe(true)
      expect(await h.kept.runBytes(runId)).toBe(0)
      expect(await h.kept.workBytes(runId)).toBe(0)
      expect(written(join(h.root, 'kept'))).toEqual([])
    })
  }

  it('hosted: a batch over the frame cap is refused from the header before any decode, and as it streams where the count isn’t known', LONG, async () => {
    await requireMediaTools()
    const caps = MEDIA_CAPS.hosted as { batchFrames: number }
    const saved = caps.batchFrames
    const h = harness({ hosted: true, clips: ['g_frames_big.mp4', 'v_vp9_live.webm'] })
    try {
      caps.batchFrames = 5
      // Known from the header (30 frames, 10 kept): before any decode.
      await expect(runNode(h, { l: loadFrames('g_frames_big.mp4', { max_size: 64, max_seconds: 0, max_frames: 10 }) }, 'l')).rejects.toThrow(MEDIA_WORDS.tooManyFrames)
      // Six kept of a live WebM (no count in its header): as the frames arrive.
      await expect(runNode(h, { l: loadFrames('v_vp9_live.webm', { max_seconds: 0, max_frames: 6 }) }, 'l')).rejects.toThrow(MEDIA_WORDS.tooManyFrames)
      // Within the cap, it runs.
      const ok = await runNode(h, { l: loadFrames('g_frames_big.mp4', { max_size: 64, max_seconds: 0, max_frames: 5 }) }, 'l')
      expect(ok.values[0]).toMatchObject({ count: 5, w: 64, h: 36 })
    }
    finally { caps.batchFrames = saved }
    expect(written(join(h.root, 'kept')).filter(f => f.endsWith('.raw'))).toEqual([])
  })

  it('a node with no media IO (a live preview) fails plainly', async () => {
    const plan = await planNode({ prompt: { l: loadFrames('a.mp4') }, nodeId: 'l', families: ON, gateOpen: false, filesFrom: () => [], toUrl: async () => '' })
    const io = { ...ioFor(harness(), 'l', rid(++runs), []), media: undefined }
    await expect((plan as Extract<NodePlan, { kind: 'derive' }>).derive(io)).rejects.toThrow()
  })

  it('SaveVideoFrames with no frame batch wired fails plainly', async () => {
    const plan = await planNode({ prompt: { i: { class_type: 'LoadImage', inputs: { image: 'a.png' } }, s: saveFrames(['i', 0]) }, nodeId: 's', families: ON, gateOpen: false, filesFrom: () => [inputFile('a.png')], valueFrom: () => ({ kind: 'files', files: [inputFile('a.png')] }), toUrl: async () => '' })
    await expect((plan as Extract<NodePlan, { kind: 'derive' }>).derive(ioFor(harness(), 's', rid(++runs), []))).rejects.toThrow(NO_FRAMES_WIRED)
    expect(NO_FRAMES_WIRED).toMatch(/^[A-Z][^_]*$/)
  })
})

// ── The family's rows ────────────────────────────────────────────────────────

describe('the rows', () => {
  it('LoadVideoFrames and SaveVideoFrames render (both decode or encode), switched by media-video', () => {
    for (const cls of ['LoadVideoFrames', 'SaveVideoFrames']) {
      expect(RUNNER_NODE_RULES[cls], cls).toMatchObject({ family: 'media-video', local: 'render' })
      expect(LOCAL_RENDER_TYPES.has(cls), cls).toBe(true)
      expect(SWITCHED_CLASSES[cls], cls).toBe('media-video')
    }
    expect(RUNNER_OUTPUT_CLASSES.has('SaveVideoFrames')).toBe(true)
    expect(RUNNER_OUTPUT_CLASSES.has('LoadVideoFrames')).toBe(false)
    expect(OUTPUT_KINDS.LoadVideoFrames).toEqual({ 0: 'frames', 1: 'number' })
    for (const off of [new Set<RunnerFamily>(), CARDS, new Set<RunnerFamily>(['cards', 'media-sound'])]) expect(outputKindsFor(off).LoadVideoFrames).toBeUndefined()
    expect(outputKindsFor(ON).LoadVideoFrames).toEqual({ 0: 'frames', 1: 'number' })
    expect(RUNNER_NODE_RULES.SaveVideoFrames!.valueInputs).toEqual({ frames: ['frames'], fps: ['number'] })
  })

  it('takes the frame workflows with media-video and `cards` on, and leaves them to the engine otherwise', () => {
    const graphs: Record<string, ApiPrompt> = {
      'load → save, the rate wired': { l: loadFrames('a.mp4'), s: saveFrames(['l', 0], { fps: ['l', 1] }) },
      'load → save with a sound': { l: loadFrames('a.mp4', { max_size: 64, stride: 2 }), s: saveFrames(['l', 0], { fps: 24, audio: 'a.wav', crf: 32, preset: 'slow' }) },
      'load → create → save video': { l: loadFrames('a.mp4'), v: createVideo(['l', 0], ['l', 1]), s: saveVideo('v') },
      'video parts → save frames': { l: loadVideo('a.mp4'), g: getComp('l'), s: saveFrames(['g', 0], { fps: ['g', 2] }) },
    }
    for (const [name, p] of Object.entries(graphs)) {
      expect(runnerTakesWorkflow(p, ON), name).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: ON, titleOf: id => id }), name).toEqual([])
      for (const off of [new Set<RunnerFamily>(), CARDS, new Set<RunnerFamily>(['media-video']), new Set<RunnerFamily>(ALL_RUNNER_FAMILIES.filter(f => f !== 'media-video'))]) {
        expect(runnerTakesWorkflow(p, off), `${name} with ${[...off].join(',') || 'none'}`).toBe(false)
      }
    }
  })

  it('never makes a working graph fail: what the runner can’t do leaves the whole workflow to the engine', () => {
    const left: Record<string, ApiPrompt> = {
      'an Image card into Save video frames': { i: { class_type: 'Image', inputs: { image: 'a.png', export: false, batch_index: -1 } }, s: saveFrames(['i', 0]) },
      'a wired file name': { t: { class_type: 'PrimitiveString', inputs: { value: 'x' } }, l: loadFrames(['t', 0]), s: saveFrames(['l', 0]) },
      'a wired size': { t: { class_type: 'PrimitiveInt', inputs: { value: 64 } }, l: { class_type: 'LoadVideoFrames', inputs: { ...loadFrames('a.mp4').inputs, max_size: ['t', 0] } }, s: saveFrames(['l', 0]) },
      'a wired sound name': { t: { class_type: 'PrimitiveString', inputs: { value: 'x' } }, l: loadFrames('a.mp4'), s: saveFrames(['l', 0], { audio: ['t', 0] }) },
    }
    const every = new Set<RunnerFamily>([...ALL_RUNNER_FAMILIES])
    for (const [name, p] of Object.entries(left)) {
      for (const fam of [ON, ON_BOTH, every]) {
        // R11.9a: either left to the engine and named, or (rows 15–19) sent to the runner to be refused plainly before the hold.
        if (runnerTakesWorkflow(p, fam)) expect(stopGapRefusal(p, fam)?.code, `${name} with ${fam.size} families: refused plainly`).toBeTruthy()
        else expect(nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }).length, `${name}: named`).toBeGreaterThan(0)
      }
    }
    // R11.9a (row 15, ruling (q)): a clip's frames into Save image are saved one file per frame, as Python saves a batch.
    const framesSaved: ApiPrompt = { l: loadFrames('a.mp4'), s: saveImage(['l', 0]) }
    for (const fam of [ON, ON_BOTH, every]) {
      expect(runnerTakesWorkflow(framesSaved, fam), `frames into Save image with ${fam.size} families`).toBe(true)
      expect(stopGapRefusal(framesSaved, fam), 'frames into Save image: not refused').toBeNull()
    }
    // Frames wired into a Frame's layer: the Frame is not taken (its picture inputs take pictures only).
    const frame: ApiPrompt = { l: loadFrames('a.mp4'), f: { class_type: 'Compositor', inputs: { layer1: ['l', 0] } } }
    for (const fam of [ON, every]) expect(runnerTakesNode(frame, 'f', fam), 'a Frame reading frames').toBe(false)
    // Widgets ComfyUI's validation refuses: the runner refuses the prompt with ComfyUI's own error, as ComfyUI would.
    const bad: ApiPrompt = { l: loadFrames('a.mp4', { max_size: 32 }), s: saveFrames(['l', 0], { crf: 40 }) }
    expect(runnerTakesWorkflow(bad, ON)).toBe(true)
    expect(pruneInvalidOutputs(bad, ON)).toMatchObject({ failed: true, nodeErrors: { s: { errors: [{ type: 'value_bigger_than_max' }] } } })
  })

  it('collects LoadVideoFrames’ file and SaveVideoFrames’ sound as the workflow’s own (hosted: must be the user’s)', () => {
    expect(collectInputFiles({ l: loadFrames('sub/a.mp4'), s: saveFrames(['l', 0], { audio: 'b.wav' }), n: saveFrames(['l', 0]) }))
      .toEqual([{ filename: 'a.mp4', subfolder: 'sub', type: 'input' }, { filename: 'b.wav', subfolder: '', type: 'input' }])
    expect(collectInputFiles({ l: loadFrames(['x', 0]), s: saveFrames(['l', 0], { audio: ['y', 0] }) })).toEqual([])
  })
})

// ── Rule 8: with media-video off, nothing changes ────────────────────────────

/** The rows R5.5 added, taken away: the tables as they were before it. */
function beforeR55<T>(fn: () => T): T {
  const rules = RUNNER_NODE_RULES as Record<string, unknown>
  const switched = SWITCHED_CLASSES as Record<string, unknown>
  const renders = LOCAL_RENDER_TYPES as Set<string>
  const kinds = OUTPUT_KINDS as Record<string, unknown>
  const outputs = RUNNER_OUTPUT_CLASSES as Set<string>
  const added = ['LoadVideoFrames', 'SaveVideoFrames']
  const saved = added.map(c => [c, rules[c], switched[c], renders.has(c), kinds[c], outputs.has(c)] as const)
  for (const c of added) { delete rules[c]; delete switched[c]; renders.delete(c); delete kinds[c]; outputs.delete(c) }
  try { return fn() }
  finally {
    for (const [c, r, s, isRender, k, isOut] of saved) {
      rules[c] = r; switched[c] = s; if (isRender) renders.add(c)
      if (k !== undefined) kinds[c] = k
      if (isOut) outputs.add(c)
    }
  }
}

function answers(p: ApiPrompt, families: ReadonlySet<RunnerFamily>) {
  const kinds = outputKindsFor(families)
  return {
    needs: nodesNeedingEngine(p, { runnerOn: true, families, titleOf: id => id }),
    workflow: runnerTakesWorkflow(p, families),
    eligible: isRunnerEligible(p, families),
    pruned: pruneInvalidOutputs(p, families),
    nodes: Object.keys(p).map(id => [runnerTakesNode(p, id, families), valueWiresAllowed(p, id, kinds, families)]),
    kinds,
  }
}

const OFF_SETS: [string, RunnerFamily[]][] = [
  ['none', []],
  ['cards', ['cards']],
  ['cards and media-sound', ['cards', 'media-sound']],
  ['every family but media-video', ALL_RUNNER_FAMILIES.filter(f => f !== 'media-video')],
]

const FRAME_GRAPHS: Record<string, ApiPrompt> = {
  'load → save': { l: loadFrames('a.mp4'), s: saveFrames(['l', 0], { fps: ['l', 1] }) },
  'load → create → save video': { l: loadFrames('a.mp4'), v: createVideo(['l', 0], ['l', 1]), s: saveVideo('v') },
  'frames into Save image': { l: loadFrames('a.mp4'), s: saveImage(['l', 0]) },
  'video parts → save frames': { l: loadVideo('a.mp4'), g: getComp('l'), s: saveFrames(['g', 0], { fps: ['g', 2] }) },
}

describe('rule 8: with media-video off, every answer is as before R5.5', () => {
  it('over these graphs, under every other family set', () => {
    for (const [name, p] of Object.entries(FRAME_GRAPHS)) {
      for (const [set, fam] of OFF_SETS) {
        const families = new Set(fam)
        expect(answers(p, families), `${name}, ${set}`).toEqual(beforeR55(() => answers(p, families)))
      }
    }
    // Teeth: with media-video on the answers differ.
    expect(answers(FRAME_GRAPHS['load → save']!, ON)).not.toEqual(beforeR55(() => answers(FRAME_GRAPHS['load → save']!, ON)))
  })

  const PROJECTS = fileURLToPath(new URL('../../../user/sailor/projects/', import.meta.url))
  const projectsIt = existsSync(PROJECTS) ? it : it.skip
  projectsIt('over every saved project graph (made into prompts as the app makes them)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(fileURLToPath(new URL('../../server/native/objectInfo.baseline.json.gz', import.meta.url)))).toString('utf8'))
    let graphs = 0
    let frames = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        if (Object.values(p).some(n => n.class_type === 'LoadVideoFrames' || n.class_type === 'SaveVideoFrames')) frames++
        for (const [name, fam] of OFF_SETS) {
          const families = new Set(fam)
          expect(answers(p, families), `${uuid}, ${name}`).toEqual(beforeR55(() => answers(p, families)))
        }
        graphs++
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`[media-frames] rule 8 held over ${graphs} saved graphs (${frames} with a frames node)`)
  }, 300_000)
})

// ── The engine, end to end ───────────────────────────────────────────────────

describe('the engine', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function framesKit(o: { hosted?: boolean; owns?: boolean } = {}) {
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const kept = createFileKeptBytes(join(dir, 'runner-kept'))
    const k = makeKit({
      hosted: o.hosted, dir,
      deps: {
        families: () => ON, kept,
        ...(o.owns === false ? { ownership: { ownsInput: async () => false, ownsOutput: async () => false } } : {}),
      },
    })
    for (const c of ['g_frames_big.mp4', 'a_s16.wav', 'g_frames_broken.wav']) copyFileSync(clipPath(c), join(k.root, 'input', c))
    writeFileSync(join(k.root, 'input', 'mystery.mp4'), new Uint8Array(4096).fill(7))
    writeFileSync(join(k.root, 'input', 'mystery.wav'), new Uint8Array(4096).fill(7))
    return k
  }

  it('runs LoadVideoFrames → SaveVideoFrames in the runner, with no engine and no provider, the output listed once', LONG, async () => {
    await requireMediaTools()
    const k = framesKit()
    const p: ApiPrompt = { l: loadFrames('g_frames_big.mp4', { max_size: 64, max_seconds: 0.25 }), s: saveFrames(['l', 0], { fps: ['l', 1], audio: 'a_s16.wav' }) }
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 's']) expect(t.nodes[id]!.status, `${id}: ${t.nodes[id]!.error ?? ''}`).toBe('done')
    const out = t.nodes.s!.outputs
    expect(out).toHaveLength(1)
    expect(out[0]!).toMatchObject({ subfolder: '', type: 'output' })
    expect(out[0]!.filename).toMatch(/^video_\d{8}_\d{6}\.mp4$/)
    const path = join(k.root, 'output', out[0]!.filename)
    const got = await probeMedia(path, { userId: null, roots: rootsOf(path) })
    expect(got.video[0]).toMatchObject({ codec: 'h264', w: 64, h: 36, frames: 6, averageRate: { num: 24, den: 1 } })
    expect(got.sound[0]).toMatchObject({ codec: 'aac', channels: 2, rate: 44100 })
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()
    const listed = k.records.write.mock.calls.flatMap(c => (c[0] as { outputs: OutputFile[] }).outputs)
    expect(listed).toEqual(out)
  })

  it('a sound that won’t open is skipped, as Python skips it: the video is saved without one', LONG, async () => {
    await requireMediaTools()
    const k = framesKit()
    const { runId } = await k.engine.startRun({ userId: null, takes: [{ l: loadFrames('g_frames_big.mp4', { max_size: 64, max_frames: 2 }), s: saveFrames(['l', 0], { audio: 'g_frames_broken.wav' }) }], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    expect(t.nodes.s!.status, t.nodes.s!.error ?? '').toBe('done')
    const path = join(k.root, 'output', t.nodes.s!.outputs[0]!.filename)
    expect((await probeMedia(path, { userId: null, roots: rootsOf(path) })).sound).toEqual([])
  })

  it('refuses a LoadVideoFrames file that isn’t there before the run, in plain words (Python: “Invalid video file”)', async () => {
    expect(C.validate).toEqual({ missing: 'Invalid video file: no_such_video.mp4', present: true })
    const k = framesKit()
    await expect(k.engine.startRun({ userId: null, takes: [{ l: loadFrames('no_such_video.mp4'), s: saveFrames(['l', 0]) }], ...START })).rejects.toThrow(VIDEO_FILE_MISSING)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('a file the build can’t read (a video, or the sound to add): R11.9a (row 20) refuses it plainly before the hold, saying what to change, never the engine', LONG, async () => {
    await requireMediaTools()
    const k = framesKit()
    for (const p of [
      { l: loadFrames('mystery.mp4'), s: saveFrames(['l', 0]) },
      { l: loadFrames('g_frames_big.mp4'), s: saveFrames(['l', 0], { audio: 'mystery.wav' }) },
    ] as ApiPrompt[]) {
      const err = await k.engine.startRun({ userId: null, takes: [p], ...START }).catch(e => e)
      expect(err, JSON.stringify(p)).toMatchObject({ statusCode: 400, data: { code: 'video-format' } })
      expect(err.data.reason, JSON.stringify(p)).toBeUndefined()
      // The node named by its display name, then the words (R11.9a fix round 1, m5).
      expect(err.message).toMatch(/^“(Load|Save) Video Frames”: /)
      expect(err.message.endsWith(withAdvice(MEDIA_WORDS.unreadable, VIDEO_FORMAT_ADVICE))).toBe(true)
    }
    expect(k.ledger.hold).not.toHaveBeenCalled()
    // The checks on their own: the unknown sound leaves to the engine; a missing one or a broken one is Python's skip.
    const exists = async (f: OutputFile) => existsSync(join(k.root, 'input', f.filename))
    const verdict = async () => null
    const sound = async (f: OutputFile) => (f.filename === 'mystery.wav' ? { message: MEDIA_WORDS.unreadable, engine: true } : null)
    expect(await frameStartProblems({ s: saveFrames(['l', 0], { audio: 'mystery.wav' }) }, exists, verdict, sound)).toMatchObject({ nodeId: 's', engine: true })
    expect(await frameStartProblems({ s: saveFrames(['l', 0], { audio: 'no_such.wav' }) }, exists, verdict, sound)).toBeNull()
    expect(await frameStartProblems({ s: saveFrames(['l', 0], { audio: 'g_frames_broken.wav' }) }, exists, verdict, sound)).toBeNull()
  })

  it('hosted: a sound or video file that isn’t the user’s is refused before the hold', async () => {
    const k = framesKit({ hosted: true, owns: false })
    await expect(k.engine.startRun({ userId: k.userId, takes: [{ l: loadFrames('g_frames_big.mp4'), s: saveFrames(['l', 0]) }], ...START })).rejects.toThrow('isn’t one of yours')
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('hosted: the saved video is in the user’s own folder and counted as the run’s output', LONG, async () => {
    await requireMediaTools()
    const k = framesKit({ hosted: true })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ l: loadFrames('g_frames_big.mp4', { max_size: 64, max_frames: 2 }), s: saveFrames(['l', 0]) }], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    expect(t.nodes.s!.status, t.nodes.s!.error ?? '').toBe('done')
    const out = t.nodes.s!.outputs[0]!
    expect(out.subfolder).toMatch(/^u_[0-9a-f]+$/)
    expect(out.filename).toMatch(/^video_\d{8}_\d{6}\.mp4$/)
    expect(existsSync(join(k.root, 'output', out.subfolder, out.filename))).toBe(true)
    const recorded = k.graphRuns.appendOutput.mock.calls.map(c => String(c[1]))
    expect(recorded.some(r => r.includes(out.filename))).toBe(true)
  })
})

// ── Fix round 1 ──────────────────────────────────────────────────────────────

describe('fix round 1', () => {
  afterEach(() => {
    vi.useRealTimers()
    HOOK.abortAt = 0
    HOOK.ctl = null
    HOOK.calls = 0
  })

  it('Important 1: the stream rate rounds the float fps · 1000, halves to even, as SaveVideoFrames does', () => {
    expect(framesStreamRate(23.9765)).toEqual({ num: 2997, den: 125 })
    expect(framesStreamRate(12.3455)).toEqual({ num: 6173, den: 500 })
    // R5.4's exact rounding (right for save_to's Fraction(fps)) lands elsewhere on these.
    expect(pyStreamRate(23.9765)).not.toEqual(framesStreamRate(23.9765))
    expect(pyStreamRate(12.3455)).not.toEqual(framesStreamRate(12.3455))
    for (const r of [24, 29.97, 30, 59.94, 1, 120]) expect(framesStreamRate(r), String(r)).toEqual(pyStreamRate(r))
    const cases = C.saves.filter(c => c.fps === 23.9765 || c.fps === 12.3455)
    expect(cases).toHaveLength(2)
    // Python's own files have these rates (the parity cases above save them and match every number).
    for (const c of cases) expect(c.openh264.saved.header.video[0]!.averageRate, String(c.fps)).toEqual(framesStreamRate(c.fps))
  })

  it('(1) a sound that fails partway: Python keeps the video, and the sound its unflushed encoder had made', () => {
    const broken = C.saves.filter(c => c.kept && !('error' in c.kept) && c.kept.broken)
    expect(broken.map(c => c.audio).sort()).toEqual(['g_frames_badmid.m4a', 'g_frames_badmid.mp3'])
    for (const c of broken) {
      const k = c.kept as { kept: number }
      // One AAC packet for each whole 1024-sample frame after the first; the parity cases decode ours exactly.
      expect(c.openh264.saved.sound!.samples, c.audio).toBe((Math.floor(k.kept / 1024) - 1) * 1024)
      expect(c.openh264.saved.header.video[0]!.frames, c.audio).toBe(C.sources.even.count)
    }
  })

  it('(3) frames that change size partway are each resized, as Python resizes them', () => {
    const cases = C.loads.filter(c => c.clip === 'g_frames_resize.webm')
    const resized = cases.filter(c => c.max_size === 64)
    expect(resized.every(c => !('error' in c) && c.w === 64 && c.h === 48)).toBe(true)
    expect(resized.map(c => ('frames' in c ? c.frames.length : 0))).toEqual([8, 3, 3, 1])
    // Not resized, Python's stack fails where the pick spans both sizes (the parity loop runs every case).
    expect(cases.filter(c => 'error' in c)).toHaveLength(2)
  })

  it('(2), fix round 2: hosted judges the sound by its name alone: another user’s is refused there or not, in the same words; the user’s own missing one is skipped', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'runs-'))
    // The upload records, as the hosted gate reads them (uploadOwner(name) === user): by name, never by the disk.
    const mine = new Set(['g_frames_big.mp4', 'gone.wav'])
    const k = makeKit({
      hosted: true, dir,
      deps: {
        families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')),
        ownership: { ownsInput: async (_u, f) => mine.has(f.filename), ownsOutput: async () => true },
      },
    })
    copyFileSync(clipPath('g_frames_big.mp4'), join(k.root, 'input', 'g_frames_big.mp4'))
    copyFileSync(clipPath('a_s16.wav'), join(k.root, 'input', 'someone.wav'))
    const take = (audio: string): ApiPrompt => ({ l: loadFrames('g_frames_big.mp4', { max_size: 64, max_frames: 2 }), s: saveFrames(['l', 0], { audio }) })
    // The user's own name, not on disk: skipped at its turn, as Python skips it.
    const gone = await k.engine.startRun({ userId: k.userId, takes: [take('gone.wav')], ...START })
    await k.engine.settled(gone.runId)
    const t = (await k.store.get(gone.runId))!.takes[0]!
    expect(t.nodes.s!.status, t.nodes.s!.error ?? '').toBe('done')
    const out = t.nodes.s!.outputs[0]!
    const path = join(k.root, 'output', out.subfolder, out.filename)
    expect((await probeMedia(path, { userId: null, roots: rootsOf(path) })).sound).toEqual([])
    // Another user's name: refused before the hold, there (someone.wav) or not (nobody.wav), and so is a name
    // outside the folders; every refusal has the same words and status, so none tells whether a file exists.
    const held = k.ledger.hold.mock.calls.length
    const refusals: { message: string; statusCode?: number; data?: unknown }[] = []
    for (const audio of ['someone.wav', 'nobody.wav', 'u_0123456789ab/x.wav', '../someone.wav', '/etc/someone.wav']) {
      const err = await k.engine.startRun({ userId: k.userId, takes: [take(audio)], ...START }).then(() => null, e => e as Error & { statusCode?: number; data?: { file?: string } })
      expect(err, audio).not.toBeNull()
      // The whole answer, with the name itself swapped out, must be the same for every name.
      expect(Object.keys(err!.data ?? {}), audio).toEqual(['file'])
      expect(audio.endsWith(err!.data!.file!), audio).toBe(true)
      refusals.push({ message: err!.message, statusCode: err!.statusCode, data: { ...err!.data, file: '<name>' } })
    }
    expect(new Set(refusals.map(r => JSON.stringify(r))).size, JSON.stringify(refusals)).toBe(1)
    expect(refusals[0]!.message).toBe('This workflow uses a file that isn’t one of yours')
    expect(refusals[0]!.statusCode).toBe(403)
    expect(k.ledger.hold.mock.calls.length).toBe(held)
  })

  it('(2), fix round 2: locally a missing sound, or a name outside the folders, is skipped as before', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const k = makeKit({ dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    copyFileSync(clipPath('g_frames_big.mp4'), join(k.root, 'input', 'g_frames_big.mp4'))
    for (const audio of ['nobody.wav', '../nobody.wav']) {
      const { runId } = await k.engine.startRun({ userId: null, takes: [{ l: loadFrames('g_frames_big.mp4', { max_size: 64, max_frames: 2 }), s: saveFrames(['l', 0], { audio }) }], ...START })
      await k.engine.settled(runId)
      const t = (await k.store.get(runId))!.takes[0]!
      expect(t.nodes.s!.status, `${audio}: ${t.nodes.s!.error ?? ''}`).toBe('done')
    }
  })

  it('Minor 2: a soundtrack longer than the length cap is read as far as the video; what is decoded is held to the sample cap', LONG, async () => {
    await requireMediaTools()
    const caps = MEDIA_CAPS.local as { soundSeconds: number; soundSamples: number }
    const saved = { soundSeconds: caps.soundSeconds, soundSamples: caps.soundSamples }
    const want = C.saves.find(c => c.audio === 'a_s16.wav')!.openh264.saved.sound!
    const h = harness({ clips: ['g_frames_big.mp4', 'a_s16.wav'] })
    const load = await runNode(h, { l: loadFrames('g_frames_big.mp4', { max_size: 96, max_seconds: 0.25 }) }, 'l')
    const prompt = { l: loadFrames('g_frames_big.mp4'), s: saveFrames(['l', 0], { fps: 24, audio: 'a_s16.wav' }) }
    let path = ''
    try {
      // The file is 1 s long, the cap 0.1 s: the 0.25 s video still gets Python's sound.
      caps.soundSeconds = 0.1
      expect(await frameStartProblems(prompt, async () => true, async () => null, f => framesSoundVerdictOf(h, f))).toBeNull()
      const ok = await runNode(h, prompt, 's', { l: load.values })
      path = h.results.pathOf!(ok.assets[0]!)
      // The samples it would decode (0.25 s, stereo) over the sample cap: refused plainly.
      caps.soundSamples = 1000
      await expect(runNode(h, prompt, 's', { l: load.values })).rejects.toThrow(MEDIA_WORDS.tooLong)
    }
    finally {
      caps.soundSeconds = saved.soundSeconds
      caps.soundSamples = saved.soundSamples
    }
    // Read back under the usual caps: exactly Python's sound for this file.
    const got = await decodeAudio(path, { decoder: 'fltp', userId: null, maxSamples: BIG, roots: rootsOf(path) })
    expect(sha256Hex(soundBytes(got.channels))).toBe(want.sha256)
  })

  it('Minor 3: a prefix that would save outside output is refused before any work, in plain words', LONG, async () => {
    for (const bad of ['../x', '/abs/x', 'a/../../x', '..//x']) expect(framesPrefixOutside(bad), bad).toBe(true)
    for (const ok of ['video', 'clips/take_', '..', 'a..b/c', '', 'x/..y']) expect(framesPrefixOutside(ok), ok).toBe(false)
    await expect(planNode({ prompt: { l: loadFrames('a.mp4'), s: saveFrames(['l', 0], { prefix: '../x' }) }, nodeId: 's', families: ON, gateOpen: false, filesFrom: () => [], toUrl: async () => '' }))
      .rejects.toThrow(SAVE_OUTSIDE)
    expect(SAVE_OUTSIDE).toMatch(/^[A-Z][^_]*$/)
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const k = makeKit({ dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    copyFileSync(clipPath('g_frames_big.mp4'), join(k.root, 'input', 'g_frames_big.mp4'))
    await expect(k.engine.startRun({ userId: null, takes: [{ l: loadFrames('g_frames_big.mp4'), s: saveFrames(['l', 0], { prefix: '/tmp/x' }) }], ...START })).rejects.toThrow(SAVE_OUTSIDE)
    expect(written(join(k.root, 'output'))).toEqual([])
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('Minor 4: the raw file is held to the run’s kept room as it grows: KEPT_TOO_MUCH plainly, nothing left', LONG, async () => {
    await requireMediaTools()
    const h = harness({ clips: ['g_frames_big.mp4'] })
    let checks = 0
    const tight = new Proxy(h.kept, {
      get(t, k) {
        const v = Reflect.get(t, k)
        if (k !== 'checkRoom') return typeof v === 'function' ? v.bind(t) : v
        return async (runId: string) => {
          // Room at the start; none once frames are being written.
          if (++checks > 1) throw new Error(KEPT_TOO_MUCH)
          return t.checkRoom(runId)
        }
      },
    })
    const runId = rid(++runs)
    await expect(runNode(h, { l: loadFrames('g_frames_big.mp4', { max_size: 64, max_seconds: 0 }) }, 'l', {}, { runId, kept: tight })).rejects.toThrow(KEPT_TOO_MUCH)
    // Checked while the raw file grew (30 frames: at frame 16), not only once the decode was done.
    expect(checks).toBe(2)
    expect(await h.kept.runBytes(runId)).toBe(0)
    expect(await h.kept.workBytes(runId)).toBe(0)
    expect(written(join(h.root, 'kept'))).toEqual([])
  })

  for (const [clip, at] of [['g_frames_big.mp4', 3], ['g_frames_resize.webm', 6]] as const) {
    it(`Minor 6: Stop while frames flow and a worker resize runs (${clip}, frame ${at}): the plain words, nothing kept or left`, LONG, async () => {
      await requireMediaTools()
      const h = harness({ clips: [clip] })
      const ctl = new AbortController()
      HOOK.ctl = ctl
      HOOK.abortAt = at
      HOOK.calls = 0
      const runId = rid(++runs)
      const err = await runNode(h, { l: loadFrames(clip, { max_size: 64, max_seconds: 0 }) }, 'l', {}, { runId, signal: ctl.signal }).then(() => null, e => e as Error)
      expect(ctl.signal.aborted).toBe(true)
      expect(HOOK.calls).toBe(at)
      expect(err?.message).toBe(MEDIA_WORDS.stopped)
      expect(await h.kept.runBytes(runId)).toBe(0)
      expect(await h.kept.workBytes(runId)).toBe(0)
      expect(written(join(h.root, 'kept'))).toEqual([])
    })
  }
})

/** framesSoundVerdict over a harness's files. */
async function framesSoundVerdictOf(h: Harness, f: OutputFile) {
  const { framesSoundVerdict } = await import('~~/server/runner/media/frameNodes')
  return framesSoundVerdict(h.access, f, { userId: null })
}

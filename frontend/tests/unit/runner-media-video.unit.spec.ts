/**
 * Task R5.4: the video nodes in the runner, family `media-video`
 * (server/runner/media/videoNodes.ts): LoadVideo, GetVideoComponents,
 * CreateVideo, SaveVideo and the Video card's export and made videos.
 *
 * Parity is against scripts/runner_media_fixtures.py --group video: each
 * class's own execute over the standard clips, as the real Python (PyAV 17)
 * runs it. Decoded pictures and sounds are byte-equal to Python's; a stream
 * copy keeps the source's packets; an H.264 file is judged by ruling (c):
 * the numbers exact, the frames equal to Python's own pipeline switched to
 * libopenh264, no further from the source than libx264 (within 0.5 dB).
 * Names, subfolders, counters and ui equal Python's; tags are JSON-value-equal.
 *
 * The parity parts need the real tools (R5.1a): they fail, never skip, when
 * the tools are missing.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { randomBytes, createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { makeKit } from './__runner__/kit'
import { clipPath, requireMediaTools, sha256Hex, unz, unzF32, type PySound, type PyRational } from './__runner__/mediaParity'
import { videoCardCaseKey, videoCardCases, videoCardPrompt } from './__runner__/videoCardCases'
import { GATE_CLASS, type ApiPrompt } from '#shared/runner/graph'
import { ALL_RUNNER_FAMILIES, FAMILY_REQUIRES, MEDIA_TOOL_FAMILIES, RUNNER_FAMILIES, parseFamilies, type RunnerFamily } from '#shared/runner/families'
import {
  LOCAL_RENDER_TYPES, RUNNER_NODE_RULES, SOUND_OUTPUTS, SWITCHED_CLASSES, VIDEO_CARD_MEDIA_RULE,
  isRunnerEligible, outputKindsFor, rendersLocally, runnerRuleFor, runnerTakesNode, valueInputsOf, valueWiresAllowed,
} from '#shared/runner/eligibility'
import { OUTPUT_KINDS } from '#shared/runner/values'
import { RUNNER_OUTPUT_CLASSES, pruneInvalidOutputs, runnerTakesWorkflow } from '#shared/runner/validate'
import { stopGapRefusal } from '#shared/runner/stopGaps'
import { CARD_EXPORT_ADVICE, withAdvice } from '#shared/runner/messages'
import { nodesNeedingEngine } from '#shared/runner/needsEngine'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import { planNode, type DeriveIO, type Derived, type NodePlan } from '~~/server/runner/executors'
import { createEngineResultStore, type ResultStore } from '~~/server/runner/results'
import { createFileKeptBytes, type KeptBytes } from '~~/server/runner/keptBytes'
import { createFileAccess, type FileAccess } from '~~/server/runner/fileAccess'
import { collectInputFiles } from '~~/server/runner/inputs'
import { filesOf } from '~~/server/runner/values'
import type { OutputFile, RunnerValue } from '~~/server/runner/types'
import { decodeAudio, decodeFrames, type DecodedSound } from '~~/server/media/decode'
import { probeMedia, pyFrameCount, pyFrameRate, pyRawDuration } from '~~/server/media/probe'
import { mediaLimiter, runMedia } from '~~/server/media/run'
import { keepFrames, keepSound, readFrames, readSound } from '~~/server/media/values'
import { VIDEO_FILE_MISSING, VIDEO_NOT_MP4, loadVideoStartProblems, videoSaveWords } from '~~/server/runner/media/videoNodes'
import { runnerFamilies } from '~~/server/runner/config'
import { RUNNER_NOT_ELIGIBLE } from '#shared/runner/messages'
import { mediaFormat } from '~~/server/runner/mediaInputs'
import { keepVideoFrames, probeVideoFile } from '~~/server/media/values'

/** The tools' remembered answer, as the server's eligibility reads it; null: the real one. */
const TOOLS = vi.hoisted(() => ({ ready: null as boolean | null }))
vi.mock('~~/server/media/tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('~~/server/media/tools')>()
  return { ...real, mediaToolsReady: () => TOOLS.ready ?? real.mediaToolsReady() }
})

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
  streams: { type: string; codec: string; timeBase: PyRational; duration: number | null; frames: number }[]
  tags: Record<string, string>
}
interface PyRun { ui: PyUi; saved: PySaved; written: string[] }
interface PyFailed { error: string; written: string[] }
interface VideoCases {
  prompt: ApiPrompt
  extraPnginfo: { workflow: unknown }
  components: ({ clip: string; error: string } | { clip: string; frames: { w: number; h: number; list: string[] }; fps: number; sound: PySound | null })[]
  made: { clip: string; sounds: Record<string, string | null>; cases: { fps: number; sound: 'none' | 'mono' | 'stereo'; x264: PyRun; openh264: PyRun }[]; rgbz: Record<string, string> }
  madeNoise: { clip: string; cases: { fps: number; sound: 'none'; x264: PyRun; openh264: PyRun }[] }
  channels: ({ channels: number; rate: number; input: string; written: string[] } & ({ error: string } | { ui: PyUi; saved: PySaved }))[]
  saves: { clips: string[]; cases: { clip: string; format: 'auto' | 'mp4'; codec: 'auto' | 'h264'; x264: PyRun | PyFailed; openh264: PyRun | PyFailed }[] }
  cards: {
    label: string; file: string; source: string | null; export: boolean
    x264: { ui: PyUi; shown: PySaved[]; handsOn: boolean; written: { output: string[]; temp: string[] } }
    openh264?: { ui: PyUi; shown: PySaved[]; handsOn: boolean; written: { output: string[]; temp: string[] } }
  }[]
  validate: { missing: string; present: boolean }
  containers: ({ clip: string; formatName: string; codecs: string[]; save: PyRun | PyFailed } & ({ error: string } | { frames: { w: number; h: number; list: string[] }; fps: number; sound: PySound | null }))[]
}

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))
const FIX = JSON.parse(readFileSync(join(FIXTURES, 'runner-media-video.json'), 'utf8')) as { cases: VideoCases; clips: Record<string, string>; groupClips?: Record<string, string> }
const C = FIX.cases
const LONG = { timeout: 120_000 }
const BIG = Number.MAX_SAFE_INTEGER
/** Ruling (c)'s sanity bound on the mean difference from libx264's frames, in levels (2/255 of full scale). */
const MEAN_DIFF_BOUND = 2

/** The media families on, as a local server runs them. */
const ON: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video'])
const ON_BOTH: ReadonlySet<RunnerFamily> = new Set(['cards', 'media-video', 'media-sound'])
const CARDS: ReadonlySet<RunnerFamily> = new Set(['cards'])
const START = { workflow: null, canvasId: null, projectUuid: null, projectName: null }

const scratch = mkdtempSync(join(tmpdir(), 'media-video-spec-'))
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

function ioFor(h: Harness, nodeId: string, runId: string, assets: OutputFile[]): DeriveIO {
  const signal = new AbortController().signal
  const opts = (a: { prefix: string; ext: string; subfolder?: string; folder?: 'output' | 'temp' | 'input'; counter?: { prefix: string; offset: number } }) => ({
    userId: h.userId, prefix: a.prefix, ext: a.ext,
    ...(a.subfolder !== undefined ? { subfolder: a.subfolder } : {}),
    ...(a.folder ? { folder: a.folder } : {}),
    ...(a.counter ? { counter: a.counter } : {}),
  })
  return {
    read: f => h.access.read(f),
    keep: (b, ext) => h.kept.put(runId, b, ext),
    saveAsset: async (bytes, a) => {
      const f = await h.results.save(bytes, opts(a))
      if ((a.folder ?? 'output') === 'output') assets.push(f)
      return f
    },
    saveAssetFromPath: async (path, a) => {
      const f = await h.results.saveFromPath!(path, opts(a))
      if ((a.folder ?? 'output') === 'output') assets.push(f)
      return f
    },
    savePreview: async () => { throw new Error('no live previews') },
    savePreviewAs: (bytes, a) => h.results.savePreviewAs(bytes, { filename: a.filename, userId: h.userId }),
    hosted: h.hosted, signal, nodeId,
    runWorkflow: C.extraPnginfo.workflow, runPrompt: C.prompt,
    media: { access: h.access, kept: h.kept, runId, userId: h.userId, hosted: h.hosted, signal },
  }
}

/** Plans and runs node `id` of `prompt`; `values[id]`: what each upstream node handed on, by slot. */
async function runNode(h: Harness, prompt: ApiPrompt, id: string, values: Record<string, Record<number, RunnerValue>> = {}, families = ON, runId = rid(++runs)): Promise<Derived & { assets: OutputFile[] }> {
  const plan: NodePlan = await planNode({
    prompt, nodeId: id, families, gateOpen: false,
    filesFrom: l => filesOf(values[l[0]]?.[l[1]]),
    valueFrom: l => values[l[0]]?.[l[1]],
    toUrl: async () => '',
  })
  expect(plan.kind, `${prompt[id]!.class_type} plans a derive`).toBe('derive')
  const assets: OutputFile[] = []
  const made = await (plan as Extract<NodePlan, { kind: 'derive' }>).derive(ioFor(h, id, runId, assets))
  return { ...made, assets }
}

const inputFile = (name: string): OutputFile => ({ filename: name, subfolder: '', type: 'input' })

// ── Prompts ──────────────────────────────────────────────────────────────────

type Link = [string, number]
const loadVideo = (file: string) => ({ class_type: 'LoadVideo', inputs: { file } })
const getComp = (from: string) => ({ class_type: 'GetVideoComponents', inputs: { video: [from, 0] as Link } })
const createVideo = (images: Link, fps: number | Link, audio?: Link) => ({ class_type: 'CreateVideo', inputs: { images, fps, ...(audio ? { audio } : {}) } })
const saveVideo = (from: string, format = 'auto', codec = 'auto', prefix = 'video/ComfyUI') => ({ class_type: 'SaveVideo', inputs: { video: [from, 0] as Link, filename_prefix: prefix, format, codec } })
const videoCard = (o: { file?: string; source?: Link; export?: boolean; prefix?: string } = {}) => ({
  class_type: 'Video',
  inputs: { file: o.file ?? '', export: o.export ?? false, filename_prefix: o.prefix ?? 'video/ComfyUI', ...(o.source ? { source: o.source } : {}) },
})
const loadAudio = (audio: string) => ({ class_type: 'LoadAudio', inputs: { audio } })
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

function snr(want: Float32Array[], got: Float32Array[]): number {
  let sig = 0
  let noise = 0
  for (let c = 0; c < want.length; c++) {
    for (let i = 0; i < want[c]!.length; i++) {
      sig += want[c]![i]! ** 2
      noise += (want[c]![i]! - (got[c]?.[i] ?? 0)) ** 2
    }
  }
  return noise ? 10 * Math.log10(sig / noise) : Number.POSITIVE_INFINITY
}

function channelsOf(f32z: string, rows: number): Float32Array[] {
  const all = unzF32(f32z)
  const n = all.length / rows
  return Array.from({ length: rows }, (_, c) => all.slice(c * n, (c + 1) * n))
}

function soundBytes(channels: Float32Array[]): Uint8Array {
  return concat(channels.map(ch => new Uint8Array(ch.buffer.slice(ch.byteOffset, ch.byteOffset + ch.byteLength))))
}

const rootsOf = (path: string) => [join(path, '..')]

/** Every frame get_components reads from a file, rgb24. */
async function decodeAll(path: string): Promise<Uint8Array[]> {
  const frames: Uint8Array[] = []
  await decodeFrames(path, { userId: null, maxFrames: BIG, roots: rootsOf(path), onFrame: async (f) => { frames.push(f) } })
  return frames
}

/** A saved file's streams and tags as ffprobe reads them, in the fixture's shape. */
async function streamsAndTags(path: string): Promise<{ streams: { type: string; codec: string; timeBase: PyRational; duration: number | null; frames: number }[]; tags: Record<string, string> }> {
  const { stdout } = await runMedia({
    tool: 'ffprobe',
    args: ['-protocol_whitelist', 'file,pipe', '-i', `file:${path}`, '-of', 'json', '-show_format', '-show_streams'],
    userId: null,
  })
  const j = JSON.parse(Buffer.from(stdout!).toString('utf8')) as {
    format?: { tags?: Record<string, string> }
    streams?: { index: number; codec_type: string; codec_name: string; time_base: string; duration_ts?: number; nb_frames?: string; tags?: Record<string, string> }[]
  }
  const tags: Record<string, string> = { ...(j.format?.tags ?? {}) }
  const streams = (j.streams ?? []).map((s) => {
    for (const [k, v] of Object.entries(s.tags ?? {})) tags[`stream${s.index}:${k}`] = v
    const [num, den] = s.time_base.split('/').map(Number)
    return { type: s.codec_type, codec: s.codec_name, timeBase: { num: num!, den: den! }, duration: s.duration_ts ?? null, frames: Number(s.nb_frames ?? 0) }
  })
  return { streams, tags }
}

/**
 * The tags against Python's: `prompt` and `workflow` JSON-value-equal (rule
 * 3), every other tag equal except `encoder`, which each muxer writes as its
 * own libavformat version (Lavf62.3.100 in PyAV, 62.3.103 here). A stream's
 * `vendor_id` of `[0][0][0][0]` is the reader's, not the file's: PyAV's
 * libavformat reports an MP4 track's zero vendor, the build's leaves it out
 * (read with both, Python's own file and ours carry the same zero vendor).
 */
function expectTags(ours: Record<string, string>, py: Record<string, string>, label: string): void {
  const rest = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([k, v]) => k !== 'prompt' && k !== 'workflow' && k !== 'encoder' && !(k.endsWith(':vendor_id') && v === '[0][0][0][0]')))
  expect(rest(ours), `${label}: tags`).toEqual(rest(py))
  for (const k of ['prompt', 'workflow']) {
    expect(k in ours, `${label}: ${k} tag`).toBe(k in py)
    if (k in py) expect(JSON.parse(ours[k]!), `${label}: ${k}`).toEqual(JSON.parse(py[k]!))
  }
  expect('encoder' in ours, `${label}: encoder tag`).toBe('encoder' in py)
}

/**
 * Ruling (c) for a saved H.264 file: the header and Python's own numbers equal
 * the libopenh264 run's exactly; the frames equal that run's byte for byte; no
 * further from the source than libx264 (within 0.5 dB), the mean difference
 * held to the bound only where ours is further.
 */
async function expectH264File(path: string, openh264: PySaved, x264: PySaved, source: Uint8Array | null, label: string, named?: NamedH264): Promise<Record<string, number | null>> {
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
  expect({ w: want.video[0]!.w, h: want.video[0]!.h }, label).toEqual({ w: x264.header.video[0]!.w, h: x264.header.video[0]!.h })
  const frames = await decodeAll(path)
  expect(frames.map(sha256Hex), `${label}: equal to Python's pipeline on libopenh264`).toEqual(openh264.frames)
  const all = concat(frames)
  const py = unz(x264.rgbz ?? C.made.rgbz[x264.rgbzKey!]!)
  expect(all.length, label).toBe(py.length)
  const mean = meanDiff(all, py)
  let ours: number | null = null
  if (source) {
    ours = psnr(source, all)
    if (named) {
      // The named case: held to its measured numbers (any change shows), not to ruling (c)'s bounds.
      expect(ours, `${label}: PSNR as measured`).toBeCloseTo(named.psnrOurs, 2)
      expect(x264.psnr!, `${label}: libx264's PSNR as measured`).toBeCloseTo(named.psnrPython, 2)
      expect(mean, `${label}: mean difference as measured`).toBeCloseTo(named.mean, 2)
    }
    else {
      expect(ours, `${label}: no further from the source than libx264`).toBeGreaterThanOrEqual(x264.psnr! - 0.5)
      if (ours < x264.psnr!) expect(mean, `${label}: mean difference from libx264`).toBeLessThanOrEqual(MEAN_DIFF_BOUND)
    }
  }
  return { mean: Math.round(mean * 1000) / 1000, psnrOurs: ours && Math.round(ours * 100) / 100, psnrPython: x264.psnr ?? null }
}

/**
 * A named H.264 case for the controller (rule 3): made from the standard
 * clips' `synth` noise at 32 × 24, where ruling (d)'s table (measured on
 * smooth pictures) leaves OpenH264 further from the source than libx264.
 * Our frames still equal Python's own pipeline on libopenh264 byte for byte
 * (the proof that the runner feeds the encoder the same frames with the same
 * settings); the distance from libx264 is recorded here as measured.
 */
interface NamedH264 { psnrOurs: number; psnrPython: number; mean: number }
const NOISE_NAMED: Record<number, NamedH264> = {
  24: { psnrOurs: 30.214, psnrPython: 31.091, mean: 5.277 },
  30: { psnrOurs: 30.214, psnrPython: 30.446, mean: 6.193 },
}

/** The sound Python's get_components reads from a saved file: exactly, or (not exact) at least 60 dB where kept whole. */
async function expectFileSound(path: string, want: PySound | null, label: string): Promise<number | 'exact' | null> {
  const p = await probeMedia(path, { userId: null, roots: rootsOf(path) })
  if (!want) {
    expect(p.sound, `${label}: no sound`).toEqual([])
    return null
  }
  const got = await decodeAudio(path, { decoder: 'fltp', userId: null, maxSamples: BIG, roots: rootsOf(path) })
  expect(got.rate, label).toBe(want.rate)
  expect(got.channels.length, label).toBe(want.rows)
  expect(got.channels[0]!.length, label).toBe(want.samples)
  if (sha256Hex(soundBytes(got.channels)) === want.sha256) return 'exact'
  expect(want.f32z, `${label}: the sound decodes exactly`).toBeDefined()
  const s = snr(channelsOf(want.f32z!, want.rows), got.channels)
  expect(s, `${label}: within 60 dB`).toBeGreaterThanOrEqual(60)
  return Math.round(s * 10) / 10
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

/** The source frames of a clip, as Python's get_components reads them. */
async function clipFrames(name: string): Promise<Uint8Array[]> {
  return decodeAll(clipPath(name))
}

// ── Parity: LoadVideo → GetVideoComponents ───────────────────────────────────

describe('LoadVideo → GetVideoComponents over every standard clip equals Python’s execute', () => {
  const clips = new Set(Object.keys(FIX.clips))
  it('covers every standard clip', () => {
    expect(C.components.map(c => c.clip).sort()).toEqual([...clips].sort())
  })

  for (const c of C.components) {
    it(`${c.clip}: frames, sound and fps`, LONG, async () => {
      await requireMediaTools()
      const h = harness({ clips: [c.clip] })
      const loaded = await runNode(h, { l: loadVideo(c.clip) }, 'l')
      expect(loaded.values[0]).toEqual({ kind: 'files', files: [inputFile(c.clip)] })
      expect(loaded.ui).toBeNull()
      const prompt = { l: loadVideo(c.clip), g: getComp('l') }
      if ('error' in c) {
        // Python: "No video stream found" (a sound file), or torch.stack of frames of two sizes.
        const words = c.error.includes('No video stream') ? MEDIA_WORDS.noVideo : MEDIA_WORDS.sizeChanged
        await expect(runNode(h, prompt, 'g', { l: loaded.values })).rejects.toThrow(words)
        return
      }
      const made = await runNode(h, prompt, 'g', { l: loaded.values })
      const frames = made.values[0]!
      expect(frames).toMatchObject({ kind: 'frames', count: c.frames.list.length, w: c.frames.w, h: c.frames.h })
      expect(filesOf(frames)[0]!.type).toBe('kept')
      const shas: string[] = []
      await readFrames(frames as Extract<RunnerValue, { kind: 'frames' }>, { access: h.access, kept: h.kept, runId: rid(runs), userId: null, hosted: false }, async (rgb) => { shas.push(sha256Hex(rgb)) })
      expect(shas, `${c.clip}: frames`).toEqual(c.frames.list)
      expect(made.values[2], `${c.clip}: fps`).toEqual({ kind: 'number', value: c.fps, int: false })
      if (!c.sound) expect(made.values[1], `${c.clip}: no sound`).toEqual({ kind: 'files', files: [] })
      else {
        expect(made.values[1]).toMatchObject({ kind: 'files', sound: { decode: 'exact' } })
        const s = await readSound(made.values[1]!, 'GetVideoComponents', { access: h.access, userId: null, hosted: false })
        expect(s.rate).toBe(c.sound.rate)
        expect(s.channels.length).toBe(c.sound.rows)
        expect(s.channels[0]!.length).toBe(c.sound.samples)
        expect(sha256Hex(soundBytes(s.channels)), `${c.clip}: sound`).toBe(c.sound.sha256)
      }
      expect(made.ui).toBeNull()
      expect(written(join(h.root, 'output'))).toEqual([])
    })
  }

  it('of a made video hands on its own parts and starts no tool', LONG, async () => {
    await requireMediaTools()
    const h = harness({ clips: ['v_h264_601.mp4', 'a_min.wav'] })
    const comp = await runNode(h, { l: loadVideo('v_h264_601.mp4'), g: getComp('l') }, 'g', { l: { 0: { kind: 'files', files: [inputFile('v_h264_601.mp4')] } } })
    const sound: RunnerValue = { kind: 'files', files: [inputFile('a_min.wav')], sound: { decode: 'load' } }
    const made = await runNode(h, { g: getComp('x'), a: loadAudio('a_min.wav'), v: createVideo(['g', 0], 29.97, ['a', 0]) }, 'v', { g: comp.values, a: { 0: sound } })
    const before = mediaLimiter().started()
    const parts = await runNode(h, { v: createVideo(['g', 0], 29.97), p: getComp('v') }, 'p', { v: made.values })
    expect(mediaLimiter().started(), 'no tool started').toBe(before)
    expect(parts.values[0]).toEqual(comp.values[0])
    expect(parts.values[1]).toEqual(sound)
    expect(parts.values[2]).toEqual({ kind: 'number', value: 29.97, int: false })
    // Without a sound: slot 1 is empty (Python's None).
    const silent = await runNode(h, { g: getComp('x'), v: createVideo(['g', 0], 24) }, 'v', { g: comp.values })
    const none = await runNode(h, { v: createVideo(['g', 0], 24), p: getComp('v') }, 'p', { v: silent.values })
    expect(none.values[1]).toEqual({ kind: 'files', files: [] })
  })
})

// ── Parity: CreateVideo → SaveVideo ──────────────────────────────────────────

describe('CreateVideo → SaveVideo equals VideoFromComponents.save_to (ruling c)', () => {
  const measured: Record<string, unknown> = {}
  afterAll(() => { console.info('[media-video] made videos measured', JSON.stringify(measured)) })

  for (const c of C.made.cases) {
    it(`${c.fps} fps, ${c.sound} sound: names, ui, numbers, frames, sound and tags`, LONG, async () => {
      await requireMediaTools()
      const soundClip = C.made.sounds[c.sound]
      const h = harness({ clips: [C.made.clip, ...(soundClip ? [soundClip] : [])] })
      const comp = await runNode(h, { l: loadVideo(C.made.clip), g: getComp('l') }, 'g', { l: { 0: { kind: 'files', files: [inputFile(C.made.clip)] } } })
      const values: Record<string, Record<number, RunnerValue>> = { g: comp.values }
      if (soundClip) values.a = { 0: { kind: 'files', files: [inputFile(soundClip)], sound: { decode: 'load' } } }
      const prompt: ApiPrompt = { g: getComp('l'), ...(soundClip ? { a: loadAudio(soundClip) } : {}), v: createVideo(['g', 0], c.fps, soundClip ? ['a', 0] : undefined), s: saveVideo('v') }
      const made = await runNode(h, prompt, 'v', values)
      const fr = comp.values[0] as Extract<RunnerValue, { kind: 'frames' }>
      expect(made.values[0]).toEqual({ kind: 'video', fps: c.fps, frames: { file: fr.file, count: fr.count, w: fr.w, h: fr.h }, sound: soundClip ? { file: inputFile(soundClip), note: { decode: 'load' } } : null })
      expect(made.ui).toBeNull()
      values.v = made.values
      const saved = await runNode(h, prompt, 's', values)
      expect(saved.ui).toEqual(c.x264.ui)
      expect(saved.assets).toEqual(c.x264.ui.images)
      expect(written(join(h.root, 'output'))).toEqual(c.x264.written)
      const path = h.results.pathOf!(saved.assets[0]!)
      const source = concat(await clipFrames(C.made.clip))
      measured[`${c.fps} ${c.sound}`] = {
        ...(await expectH264File(path, c.openh264.saved, c.x264.saved, source, `${c.fps} ${c.sound}`)),
        sound: await expectFileSound(path, c.x264.saved.sound, `${c.fps} ${c.sound}`),
      }
      expectTags((await streamsAndTags(path)).tags, c.x264.saved.tags, `${c.fps} ${c.sound}`)
    })
  }

  for (const c of C.madeNoise.cases) {
    it(`the named case: noise frames at ${c.fps} fps equal Python’s libopenh264 run; the distance from libx264 as measured`, LONG, async () => {
      await requireMediaTools()
      const h = harness({ clips: [C.madeNoise.clip] })
      const comp = await runNode(h, { l: loadVideo(C.madeNoise.clip), g: getComp('l') }, 'g', { l: { 0: { kind: 'files', files: [inputFile(C.madeNoise.clip)] } } })
      const prompt: ApiPrompt = { g: getComp('l'), v: createVideo(['g', 0], c.fps), s: saveVideo('v') }
      const made = await runNode(h, prompt, 'v', { g: comp.values })
      const saved = await runNode(h, prompt, 's', { v: made.values })
      expect(saved.ui).toEqual(c.x264.ui)
      const path = h.results.pathOf!(saved.assets[0]!)
      measured[`noise ${c.fps}`] = await expectH264File(path, c.openh264.saved, c.x264.saved, concat(await clipFrames(C.madeNoise.clip)), `noise ${c.fps}`, NOISE_NAMED[c.fps])
    })
  }

  for (const c of C.channels) {
    it(`a ${c.channels}-channel sound: ${'error' in c ? 'fails plainly, as PyAV raises' : 'saved as Python saves it'}`, LONG, async () => {
      await requireMediaTools()
      const h = harness({ clips: [C.made.clip] })
      const comp = await runNode(h, { l: loadVideo(C.made.clip), g: getComp('l') }, 'g', { l: { 0: { kind: 'files', files: [inputFile(C.made.clip)] } } })
      const snd = await keepSound(rid(++runs), { rate: c.rate, channels: channelsOf(c.input, c.channels) }, h.kept, { hosted: false })
      const prompt: ApiPrompt = { g: getComp('l'), a: loadAudio('x.wav'), v: createVideo(['g', 0], 24, ['a', 0]), s: saveVideo('v') }
      const made = await runNode(h, prompt, 'v', { g: comp.values, a: { 0: snd } })
      if ('error' in c) {
        await expect(runNode(h, prompt, 's', { v: made.values }), `${c.channels} channels`).rejects.toThrow(MEDIA_WORDS.failed)
        // Python leaves a broken file behind; the runner leaves nothing.
        expect(c.written).toEqual(['video/ComfyUI_00001_.mp4'])
        expect(written(join(h.root, 'output'))).toEqual([])
        return
      }
      const saved = await runNode(h, prompt, 's', { v: made.values })
      expect(saved.ui).toEqual(c.ui)
      const path = h.results.pathOf!(saved.assets[0]!)
      const p = await probeMedia(path, { userId: null, roots: rootsOf(path) })
      expect(p.sound.map(s => ({ channels: s.channels, layout: s.layout, rate: s.rate })), '5.1').toEqual(c.saved.header.sound.map(s => ({ channels: s.channels, layout: s.layout, rate: s.rate })))
      measured[`${c.channels} channels`] = await expectFileSound(path, c.saved.sound, `${c.channels} channels`)
    })
  }

  it('an odd width or height of a made video fails at save before any work', LONG, async () => {
    await requireMediaTools()
    const h = harness({ clips: ['v_vp9_odd.webm'] })
    const comp = await runNode(h, { l: loadVideo('v_vp9_odd.webm'), g: getComp('l') }, 'g', { l: { 0: { kind: 'files', files: [inputFile('v_vp9_odd.webm')] } } })
    const made = await runNode(h, { g: getComp('l'), v: createVideo(['g', 0], 24), s: saveVideo('v') }, 'v', { g: comp.values })
    const before = mediaLimiter().started()
    await expect(runNode(h, { v: createVideo(['g', 0], 24), s: saveVideo('v') }, 's', { v: made.values })).rejects.toThrow(MEDIA_WORDS.oddSize)
    expect(mediaLimiter().started()).toBe(before)
    expect(written(join(h.root, 'output'))).toEqual([])
  })

  it('CreateVideo reads Python’s float fps: a wired GetVideoComponents rate, and 1…120 typed', () => {
    const p: ApiPrompt = { l: loadVideo('a.mp4'), g: getComp('l'), v: createVideo(['g', 0], ['g', 2], ['g', 1]), s: saveVideo('v') }
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    for (const fps of [0.5, 121]) {
      const q: ApiPrompt = { ...p, v: createVideo(['g', 0], fps) }
      expect(runnerTakesNode(q, 'v', ON), String(fps)).toBe(false)
    }
  })
})

// ── Parity: SaveVideo of a file ──────────────────────────────────────────────

describe('SaveVideo of a file equals VideoFromFile.save_to', () => {
  const measured: Record<string, unknown> = {}
  afterAll(() => { console.info('[media-video] saved files measured', JSON.stringify(measured)) })

  for (const c of C.saves.cases) {
    const label = `${c.clip} format ${c.format} codec ${c.codec}`
    it(`${label}: ${'error' in c.x264 ? 'fails plainly where Python raises' : 'Python’s name, streams, frames, sound and tags'}`, LONG, async () => {
      await requireMediaTools()
      const h = harness({ clips: [c.clip] })
      const prompt: ApiPrompt = { l: loadVideo(c.clip), s: saveVideo('l', c.format, c.codec) }
      const values = { l: { 0: { kind: 'files', files: [inputFile(c.clip)] } as RunnerValue } }
      if ('error' in c.x264) {
        const words = c.x264.error.includes('does not support') ? VIDEO_NOT_MP4 : MEDIA_WORDS.oddSize
        await expect(runNode(h, prompt, 's', values), label).rejects.toThrow(words)
        expect(written(join(h.root, 'output'))).toEqual([])
        return
      }
      const saved = await runNode(h, prompt, 's', values)
      expect(saved.ui).toEqual(c.x264.ui)
      expect(saved.assets).toEqual(c.x264.ui.images)
      expect(written(join(h.root, 'output'))).toEqual(c.x264.written)
      const path = h.results.pathOf!(saved.assets[0]!)
      const { streams, tags } = await streamsAndTags(path)
      expectTags(tags, c.x264.saved.tags, label)
      const copied = c.x264.saved.header.video[0]!.codec !== 'h264' || !c.x264.saved.tags.encoder || c.x264.saved.streams.length > 1 || c.codec === 'auto' || c.clip.endsWith('.mp4')
      const reencoded = (c.x264 as PyRun).saved.frames.join() !== ((c.openh264 as PyRun).saved.frames.join())
      if (!reencoded) {
        // A stream copy: the same streams, codecs, time bases and lengths as Python's copy, and the source's pictures.
        expect(streams, `${label}: streams`).toEqual(c.x264.saved.streams)
        const frames = await decodeAll(path)
        expect(frames.map(sha256Hex), `${label}: the source's frames`).toEqual(c.x264.saved.frames)
        expect(frames.map(sha256Hex), `${label}: the source's frames`).toEqual((await clipFrames(c.clip)).map(sha256Hex))
        const p = await probeMedia(path, { userId: null, roots: rootsOf(path) })
        expect(await pyFrameCount(p, p.path, { userId: null }), label).toBe(c.x264.saved.frameCount)
        expect(pyFrameRate(p), label).toEqual(c.x264.saved.frameRate)
        expect(pyRawDuration(p), label).toBe(c.x264.saved.duration)
        measured[label] = { copy: true, sound: await expectFileSound(path, c.x264.saved.sound, label) }
      }
      else {
        const source = concat(await clipFrames(c.clip))
        measured[label] = { ...(await expectH264File(path, (c.openh264 as PyRun).saved, c.x264.saved, source, label)), sound: await expectFileSound(path, c.x264.saved.sound, label) }
      }
      expect(copied || reencoded).toBe(true)
    })
  }
})

// ── Parity: the Video card ───────────────────────────────────────────────────

describe('the Video card with media-video on', () => {
  for (const c of C.cards) {
    const label = `${c.label}, export ${c.export ? 'on' : 'off'}`
    it(`${label}`, LONG, async () => {
      await requireMediaTools()
      const clips = [C.made.clip, 'a_s16.wav', ...(c.file ? [c.file] : []), ...(c.source && c.source !== 'made' ? [c.source] : [])]
      const h = harness({ clips: [...new Set(clips)] })
      const values: Record<string, Record<number, RunnerValue>> = {}
      let source: Link | undefined
      if (c.source === 'made') {
        const comp = await runNode(h, { l: loadVideo(C.made.clip), g: getComp('l') }, 'g', { l: { 0: { kind: 'files', files: [inputFile(C.made.clip)] } } })
        const made = await runNode(h, { g: getComp('l'), a: loadAudio('a_s16.wav'), v: createVideo(['g', 0], 24, ['a', 0]) }, 'v', {
          g: comp.values, a: { 0: { kind: 'files', files: [inputFile('a_s16.wav')], sound: { decode: 'load' } } },
        })
        values.s = made.values
        source = ['s', 0]
      }
      else if (c.source) {
        values.s = { 0: { kind: 'files', files: [inputFile(c.source)] } }
        source = ['s', 0]
      }
      const prompt: ApiPrompt = { ...(source ? { s: c.source === 'made' ? createVideo(['g', 0], 24) : loadVideo(c.source!) } : {}), c: videoCard({ file: c.file, source, export: c.export }) }
      const shown = await runNode(h, prompt, 'c', values)
      const py = c.x264
      // The card hands on the video as it came in.
      if (!py.handsOn) expect(shown.values[0]).toEqual({ kind: 'files', files: [] })
      else if (source) expect(shown.values[0]).toEqual(values.s![0])
      else expect(shown.values[0]).toEqual({ kind: 'files', files: [inputFile(c.file)] })
      const fileVideo = !!py.handsOn && c.source !== 'made'
      if (fileVideo && !c.export) {
        // A file video is shown as the file itself, as the runner did before R5.4 (Python writes a stream-copied temp preview: the same pictures and sound).
        const file = source ? inputFile(c.source!) : inputFile(c.file)
        expect(py.ui.images.map(e => [e.filename, e.type])).toEqual([['preview_video_00001_.mp4', 'temp']])
        expect(shown.ui).toEqual({ images: [file], animated: [true] })
        expect(written(join(h.root, 'temp'))).toEqual([])
        expect(written(join(h.root, 'output'))).toEqual([])
        return
      }
      expect(shown.ui, label).toEqual(py.ui)
      expect(written(join(h.root, 'output')), label).toEqual(py.written.output)
      // With export on the card shows the output copy: the temp preview no one sees is not written (as R5.3's Audio card).
      expect(written(join(h.root, 'temp')), label).toEqual(c.export ? [] : py.written.temp)
      for (const [i, e] of (py.ui.images ?? []).entries()) {
        const path = h.results.pathOf!({ filename: e.filename, subfolder: e.subfolder, type: e.type as OutputFile['type'] })
        const want = py.shown[i]!
        if (c.source === 'made') await expectH264File(path, c.openh264!.shown[i]!, want, concat(await clipFrames(C.made.clip)), label)
        else {
          const { streams } = await streamsAndTags(path)
          expect(streams, `${label}: streams`).toEqual(want.streams)
          expect((await decodeAll(path)).map(sha256Hex), `${label}: frames`).toEqual(want.frames)
        }
        await expectFileSound(path, want.sound, label)
        expectTags((await streamsAndTags(path)).tags, want.tags, label)
      }
    })
  }
})

// ── Eligibility ──────────────────────────────────────────────────────────────

describe('the family', () => {
  it('is known, needs `cards`, and is dropped without it', () => {
    expect(ALL_RUNNER_FAMILIES).toContain('media-video')
    // R3.10's sound-in joined them (its WAV is made with the tools).
    expect(MEDIA_TOOL_FAMILIES).toEqual(['media-sound', 'media-video', 'sound-in'])
    expect(RUNNER_FAMILIES).not.toContain('media-video')
    expect(FAMILY_REQUIRES['media-video']).toBe('cards')
    expect([...parseFamilies('media-video')]).toEqual([])
    expect([...parseFamilies('cards,media-video')].sort()).toEqual(['cards', 'media-video'])
  })

  it('answers as off on the server while the video tools are missing or refused', () => {
    const env = { ...process.env }
    process.env.NUXT_RUNNER_ENABLED = 'true'
    process.env.NUXT_RUNNER_FAMILIES = 'cards,media-video,media-sound'
    try {
      TOOLS.ready = false
      expect([...runnerFamilies()]).toEqual(['cards'])
      TOOLS.ready = true
      expect([...runnerFamilies()].sort()).toEqual(['cards', 'media-sound', 'media-video'])
    }
    finally {
      TOOLS.ready = null
      process.env = env
    }
  })

  it('the rows: LoadVideo and CreateVideo are sources; GetVideoComponents, SaveVideo and the card render', () => {
    for (const cls of ['LoadVideo', 'CreateVideo']) expect(RUNNER_NODE_RULES[cls], cls).toMatchObject({ family: 'media-video', local: 'source' })
    for (const cls of ['GetVideoComponents', 'SaveVideo']) {
      expect(RUNNER_NODE_RULES[cls], cls).toMatchObject({ family: 'media-video', local: 'render' })
      expect(LOCAL_RENDER_TYPES.has(cls), cls).toBe(true)
    }
    for (const cls of ['LoadVideo', 'GetVideoComponents', 'CreateVideo', 'SaveVideo']) expect(SWITCHED_CLASSES[cls], cls).toBe('media-video')
    expect(RUNNER_OUTPUT_CLASSES.has('SaveVideo')).toBe(true)
    for (const cls of ['LoadVideo', 'GetVideoComponents', 'CreateVideo']) expect(RUNNER_OUTPUT_CLASSES.has(cls), cls).toBe(false)
    expect(RUNNER_NODE_RULES.CreateVideo!.valueInputs).toMatchObject({ images: ['frames'] })
    expect(RUNNER_NODE_RULES.CreateVideo!.linkSources).toMatchObject({ audio: SOUND_OUTPUTS })
    for (const cls of ['GetVideoComponents', 'SaveVideo']) expect(RUNNER_NODE_RULES[cls]!.valueInputs, cls).toEqual({ video: ['files', 'video'] })
    expect(RUNNER_NODE_RULES.SaveVideo!.widgets).toMatchObject({
      format: { type: 'COMBO', options: ['auto', 'mp4'] }, codec: { type: 'COMBO', options: ['auto', 'h264'] },
    })
    expect(VIDEO_CARD_MEDIA_RULE).toMatchObject({ family: 'media-video', local: 'render', valueInputs: { source: ['files', 'video'] } })
  })

  it('the frames and video kinds apply only while media-video is on', () => {
    expect(OUTPUT_KINDS.GetVideoComponents).toEqual({ 0: 'frames', 2: 'number' })
    expect(OUTPUT_KINDS.CreateVideo).toEqual({ 0: 'video' })
    for (const off of [new Set<RunnerFamily>(), CARDS, new Set<RunnerFamily>(['cards', 'media-sound'])]) {
      expect(outputKindsFor(off).GetVideoComponents, [...off].join(',')).toBeUndefined()
      expect(outputKindsFor(off).CreateVideo).toBeUndefined()
    }
    expect(outputKindsFor(ON).GetVideoComponents).toEqual({ 0: 'frames', 2: 'number' })
    expect(outputKindsFor(ON).CreateVideo).toEqual({ 0: 'video' })
    expect(valueInputsOf('Video', ON)).toEqual({ source: ['files', 'video'] })
    expect(valueInputsOf('Video', CARDS)).toEqual({})
  })

  it('the card’s row: the media row while media-video is on, none (the runner type as before) while off', () => {
    const inputs = { file: 'a.mp4', export: true, filename_prefix: 'video/ComfyUI' }
    expect(runnerRuleFor('Video', inputs, ON)).toBe(VIDEO_CARD_MEDIA_RULE)
    expect(runnerRuleFor('Video', inputs, CARDS)).toBeUndefined()
    expect(rendersLocally('Video', inputs, ON)).toBe(true)
    expect(rendersLocally('Video', inputs, CARDS)).toBe(false)
  })

  it('takes the video workflows with media-video and `cards` on, and leaves them to the engine otherwise', () => {
    const graphs: Record<string, ApiPrompt> = {
      'load → save': { l: loadVideo('a.mp4'), s: saveVideo('l') },
      'load → parts → create → save': { l: loadVideo('a.mp4'), g: getComp('l'), v: createVideo(['g', 0], ['g', 2], ['g', 1]), s: saveVideo('v') },
      'parts → create → card': { l: loadVideo('a.mp4'), g: getComp('l'), v: createVideo(['g', 0], 24), c: videoCard({ source: ['v', 0] }) },
      'a card exporting its file': { c: videoCard({ file: 'a.mp4', export: true }) },
      'a card showing a loaded video, saved': { l: loadVideo('a.mp4'), c: videoCard({ source: ['l', 0] }), s: saveVideo('c') },
    }
    for (const [name, p] of Object.entries(graphs)) {
      expect(runnerTakesWorkflow(p, ON), name).toBe(true)
      expect(nodesNeedingEngine(p, { runnerOn: true, families: ON, titleOf: id => id }), name).toEqual([])
      if (name === 'a card exporting its file') continue
      for (const off of [new Set<RunnerFamily>(), CARDS, new Set<RunnerFamily>(['media-video'])]) {
        expect(runnerTakesWorkflow(p, off), `${name} with ${[...off].join(',') || 'none'}`).toBe(false)
      }
    }
    // With media-sound too: a loaded sound into CreateVideo, and a video's sound saved.
    const sound: ApiPrompt = { l: loadVideo('a.mp4'), g: getComp('l'), a: loadAudio('a.wav'), v: createVideo(['g', 0], 24, ['a', 0]), s: saveVideo('v'), sa: { class_type: 'SaveAudio', inputs: { audio: ['g', 1], filename_prefix: 'audio/ComfyUI' } } }
    expect(runnerTakesWorkflow(sound, ON_BOTH)).toBe(true)
    expect(runnerTakesWorkflow(sound, ON)).toBe(false)
  })

  it('never makes a working graph fail: what the runner can’t do yet leaves the whole workflow to the engine', () => {
    const left: Record<string, ApiPrompt> = {
      'an Image card into CreateVideo': { i: { class_type: 'Image', inputs: { image: 'a.png', export: false, batch_index: -1 } }, v: createVideo(['i', 0], 24), s: saveVideo('v') },
      'a card with a made video read by a Gate': { l: loadVideo('a.mp4'), g: getComp('l'), v: createVideo(['g', 0], 24), c: videoCard({ source: ['v', 0] }), gt: { class_type: GATE_CLASS, inputs: { data_in: ['c', 0], bypass: true } }, c2: videoCard({ source: ['gt', 0] }) },
      'a wired file name': { t: { class_type: 'PrimitiveString', inputs: { value: 'x' } }, l: { class_type: 'LoadVideo', inputs: { file: ['t', 0] } }, s: saveVideo('l') },
      'Preview video, not ported': { l: loadVideo('a.mp4'), p: { class_type: 'PreviewVideo', inputs: { video: ['l', 0] } } },
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
    const framesSaved: ApiPrompt = { l: loadVideo('a.mp4'), g: getComp('l'), s: saveImage(['g', 0]) }
    for (const fam of [ON, ON_BOTH, every]) {
      expect(runnerTakesWorkflow(framesSaved, fam), `frames into Save image with ${fam.size} families`).toBe(true)
      expect(stopGapRefusal(framesSaved, fam), 'frames into Save image: not refused').toBeNull()
    }
    // R11.8 (ruling (k)): a music node into CreateVideo is taken once its own family is on (its maker bounds its
    // sound, #shared/runner/sourceBounds); with audio-gen off it stays with the engine, as before.
    const music: ApiPrompt = {
      l: loadVideo('a.mp4'), g: getComp('l'),
      m: { class_type: 'GenerateMusicNode', inputs: { model: 'MusicGen', prompt: 'calm piano', duration: 8, model_version: 'stereo-large', temperature: 1, top_p: 0, seed: 0 } },
      v: createVideo(['g', 0], 24, ['m', 0]), s: saveVideo('v'),
    }
    expect(runnerTakesWorkflow(music, every), 'a music node into CreateVideo, every family on').toBe(true)
    for (const fam of [ON, ON_BOTH]) expect(runnerTakesWorkflow(music, fam), `a music node into CreateVideo with ${fam.size} families`).toBe(false)
    // Frames wired into a Frame's layer: the Frame is not taken (its picture inputs take pictures only).
    const frame: ApiPrompt = { l: loadVideo('a.mp4'), g: getComp('l'), f: { class_type: 'Compositor', inputs: { layer1: ['g', 0] } } }
    for (const fam of [ON, every]) expect(runnerTakesNode(frame, 'f', fam), 'a Frame reading frames').toBe(false)
    // A codec ComfyUI's validation refuses: the runner refuses the prompt with ComfyUI's own error, as ComfyUI would.
    const badCodec: ApiPrompt = { l: loadVideo('a.mp4'), s: saveVideo('l', 'auto', 'vp9') }
    expect(runnerTakesWorkflow(badCodec, ON)).toBe(true)
    expect(pruneInvalidOutputs(badCodec, ON)).toMatchObject({ failed: true, dropped: ['s'], nodeErrors: { s: { errors: [{ type: 'value_not_in_list' }] } } })
    // A made video through a Gate into a card that is saved: every reader reads a video.
    const gated: ApiPrompt = { l: loadVideo('a.mp4'), g: getComp('l'), v: createVideo(['g', 0], 24), gt: { class_type: GATE_CLASS, inputs: { data_in: ['v', 0], bypass: true } }, c: videoCard({ source: ['gt', 0] }), s: saveVideo('c') }
    expect(runnerTakesWorkflow(gated, ON)).toBe(true)
    // A paid video into the card, with media-video on: the card shows and saves the provider's file.
    const paid: ApiPrompt = {
      g: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'a boat at dawn', aspect_ratio: '16:9', duration: '8', seed: 0 } },
      c: videoCard({ source: ['g', 0], export: true }), s: saveVideo('c'),
    }
    expect(runnerTakesWorkflow(paid, ON)).toBe(true)
    expect(runnerTakesWorkflow({ g: paid.g!, c: videoCard({ source: ['g', 0] }) }, ON)).toBe(true)
  })

  it('pruning knows the classes only while the family is on', () => {
    const p: ApiPrompt = { l: loadVideo('a.mp4'), s: saveVideo('l'), x: loadVideo('b.mp4') }
    expect(pruneInvalidOutputs(p, ON).unread).toEqual(['x'])
    expect(pruneInvalidOutputs(p, CARDS).prompt).toBe(p)
  })

  it('collects LoadVideo’s file as the workflow’s own (hosted: must be the user’s)', () => {
    expect(collectInputFiles({ l: loadVideo('sub/a.mp4'), w: { class_type: 'LoadVideo', inputs: { file: ['x', 0] } } }))
      .toEqual([{ filename: 'a.mp4', subfolder: 'sub', type: 'input' }])
  })
})

// ── Rule 8: with media-video off, nothing changes ────────────────────────────

/** The rows R5.4 added, taken away: the tables as they were before it. */
function beforeR54<T>(fn: () => T): T {
  const rules = RUNNER_NODE_RULES as Record<string, unknown>
  const switched = SWITCHED_CLASSES as Record<string, unknown>
  const renders = LOCAL_RENDER_TYPES as Set<string>
  const added = ['LoadVideo', 'GetVideoComponents', 'CreateVideo', 'SaveVideo']
  const saved = added.map(c => [c, rules[c], switched[c], renders.has(c)] as const)
  for (const c of added) { delete rules[c]; delete switched[c]; renders.delete(c) }
  try { return fn() }
  finally {
    for (const [c, r, s, isRender] of saved) { rules[c] = r; switched[c] = s; if (isRender) renders.add(c) }
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

const VIDEO_GRAPHS: Record<string, ApiPrompt> = {
  'video saved': { l: loadVideo('a.mp4'), s: saveVideo('l') },
  'parts remade': { l: loadVideo('a.mp4'), g: getComp('l'), v: createVideo(['g', 0], ['g', 2], ['g', 1]), s: saveVideo('v') },
  'a card exporting': { c: videoCard({ file: 'a.mp4', export: true }) },
  'a paid video in a card': { g: { class_type: 'GenerateVideoNode', inputs: { model: 'veo-3.1', prompt: 'a boat', aspect_ratio: '16:9', duration: '8', seed: 0 } }, c: videoCard({ source: ['g', 0] }) },
  'frames into Save image': { l: loadVideo('a.mp4'), g: getComp('l'), s: saveImage(['g', 0]) },
}

describe('rule 8: with media-video off, every answer is as before R5.4', () => {
  it('over the checked-in video graphs, under every other family set', () => {
    for (const [name, p] of Object.entries(VIDEO_GRAPHS)) {
      for (const [set, fam] of OFF_SETS) {
        const families = new Set(fam)
        expect(answers(p, families), `${name}, ${set}`).toEqual(beforeR54(() => answers(p, families)))
      }
    }
    // Teeth: with media-video on the answers differ.
    expect(answers(VIDEO_GRAPHS['video saved']!, ON)).not.toEqual(beforeR54(() => answers(VIDEO_GRAPHS['video saved']!, ON)))
  })

  const PIN = JSON.parse(readFileSync(join(FIXTURES, 'runner-media-video-card-rows.json'), 'utf8')) as {
    commit: string; rows: Record<string, { prompt: string; card: boolean; wires: boolean; eligible: boolean; workflow: boolean; needs: string[] }>
  }
  it('the Video card: every configuration and family set answers as fd2f13daa pinned it', () => {
    const cases = videoCardCases()
    expect(Object.keys(PIN.rows)).toHaveLength(cases.length)
    let taken = 0
    for (const k of cases) {
      const key = videoCardCaseKey(k)
      const want = PIN.rows[key]!
      const p = videoCardPrompt(k)
      const fam = new Set(k.families) as ReadonlySet<RunnerFamily>
      expect(createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 16), `${key}: the same prompt`).toBe(want.prompt)
      const got = {
        prompt: want.prompt,
        card: runnerTakesNode(p, 'c', fam),
        wires: valueWiresAllowed(p, 'c', outputKindsFor(fam), fam),
        eligible: isRunnerEligible(p, fam),
        workflow: runnerTakesWorkflow(p, fam),
        needs: nodesNeedingEngine(p, { runnerOn: true, families: fam, titleOf: id => id }),
      }
      expect(got, key).toEqual(want)
      if (got.workflow) taken++
    }
    // Teeth: the pinned answers take some of these workflows.
    expect(taken).toBeGreaterThan(0)
  })

  it('the card’s plan with media-video off is today’s: its file or its source handed on and shown, export ignored', async () => {
    const plan = await planNode({ prompt: { c: videoCard({ file: 'a.mp4', export: true }) }, nodeId: 'c', families: CARDS, gateOpen: false, filesFrom: () => [], toUrl: async () => '' })
    expect(plan).toEqual({ kind: 'pass', files: [inputFile('a.mp4')], ui: { images: [inputFile('a.mp4')], animated: [true] } })
    const src: OutputFile = { filename: 'v.mp4', subfolder: '', type: 'output' }
    const wired = await planNode({ prompt: { g: { class_type: 'GenerateVideoNode', inputs: {} }, c: videoCard({ source: ['g', 0] }) }, nodeId: 'c', families: CARDS, gateOpen: false, filesFrom: () => [src], toUrl: async () => '' })
    expect(wired).toEqual({ kind: 'pass', files: [src], ui: { images: [src], animated: [true] } })
    const empty = await planNode({ prompt: { c: videoCard() }, nodeId: 'c', families: CARDS, gateOpen: false, filesFrom: () => [], toUrl: async () => '' })
    expect(empty).toEqual({ kind: 'pass', files: [], ui: { images: [] } })
  })

  const PROJECTS = fileURLToPath(new URL('../../../user/sailor/projects/', import.meta.url))
  const projectsIt = existsSync(PROJECTS) ? it : it.skip
  projectsIt('over every saved project graph (made into prompts as the app makes them)', async () => {
    const { gunzipSync } = await import('node:zlib')
    const { graphToPrompt } = await import('~/lib/graph/graphToPrompt')
    const catalog = JSON.parse(gunzipSync(readFileSync(fileURLToPath(new URL('../../server/native/objectInfo.baseline.json.gz', import.meta.url)))).toString('utf8'))
    let graphs = 0
    let video = 0
    for (const uuid of readdirSync(PROJECTS).sort()) {
      let wf: { canvases?: { workflow: unknown }[] } | undefined
      try { wf = JSON.parse(readFileSync(join(PROJECTS, uuid, 'versions', 'current.json'), 'utf8')).workflow }
      catch { continue }
      for (const c of wf?.canvases ?? []) {
        let p: ApiPrompt
        try { p = graphToPrompt(c.workflow as never, catalog) }
        catch { continue }
        if (Object.values(p).some(n => ['LoadVideo', 'GetVideoComponents', 'CreateVideo', 'SaveVideo', 'Video'].includes(n.class_type))) video++
        for (const [name, fam] of OFF_SETS) {
          const families = new Set(fam)
          expect(answers(p, families), `${uuid}, ${name}`).toEqual(beforeR54(() => answers(p, families)))
        }
        graphs++
      }
    }
    expect(graphs).toBeGreaterThanOrEqual(800)
    console.info(`[media-video] rule 8 held over ${graphs} saved graphs (${video} with a video node)`)
  }, 300_000)
})

// ── The engine, end to end ───────────────────────────────────────────────────

describe('the engine', () => {
  afterEach(() => { vi.restoreAllMocks() })

  function videoKit(o: { hosted?: boolean; owns?: boolean; families?: ReadonlySet<RunnerFamily> } = {}) {
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const kept = createFileKeptBytes(join(dir, 'runner-kept'))
    const k = makeKit({
      hosted: o.hosted, dir,
      deps: {
        families: () => o.families ?? ON, kept,
        ...(o.owns === false ? { ownership: { ownsInput: async () => false, ownsOutput: async () => false } } : {}),
      },
    })
    for (const c of ['v_stereo_aac.mp4', 'a_min.wav']) copyFileSync(clipPath(c), join(k.root, 'input', c))
    return k
  }

  it('runs LoadVideo → GetVideoComponents → CreateVideo → SaveVideo in the runner, with no engine and no provider', LONG, async () => {
    await requireMediaTools()
    const k = videoKit()
    const p: ApiPrompt = { l: loadVideo('v_stereo_aac.mp4'), g: getComp('l'), v: createVideo(['g', 0], ['g', 2], ['g', 1]), s: saveVideo('v') }
    expect(runnerTakesWorkflow(p, ON)).toBe(true)
    const { runId } = await k.engine.startRun({ userId: null, takes: [p], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    for (const id of ['l', 'g', 'v', 's']) expect(t.nodes[id]!.status, `${id}: ${t.nodes[id]!.error ?? ''}`).toBe('done')
    expect(t.nodes.s!.outputs).toEqual([{ filename: 'ComfyUI_00001_.mp4', subfolder: 'video', type: 'output' }])
    const path = join(k.root, 'output', 'video', 'ComfyUI_00001_.mp4')
    const got = await probeMedia(path, { userId: null, roots: rootsOf(path) })
    expect(got.video[0]).toMatchObject({ codec: 'h264', w: 32, h: 24, frames: 24, averageRate: { num: 24, den: 1 } })
    expect(got.sound[0]).toMatchObject({ codec: 'aac', channels: 2, rate: 44100 })
    // No provider was asked for anything, and nothing was held.
    expect(k.fal.client.submit).not.toHaveBeenCalled()
    expect(k.replicate.client.submit).not.toHaveBeenCalled()
    expect(k.ledger.hold).not.toHaveBeenCalled()
    // The saved video is listed once in the stage's history, and the kept parts not at all.
    const written = k.records.write.mock.calls.flatMap(c => (c[0] as { outputs: OutputFile[] }).outputs)
    expect(written).toEqual([{ filename: 'ComfyUI_00001_.mp4', subfolder: 'video', type: 'output' }])
  })

  it('refuses a LoadVideo file that isn’t there before the run, in plain words (Python: “Invalid video file”)', async () => {
    expect(C.validate).toEqual({ missing: 'Invalid video file: no_such_video.mp4', present: true })
    const k = videoKit()
    await expect(k.engine.startRun({ userId: null, takes: [{ l: loadVideo('no_such_video.mp4'), s: saveVideo('l') }], ...START })).rejects.toThrow(VIDEO_FILE_MISSING)
    expect(await loadVideoStartProblems({ l: loadVideo('a.mp4'), s: saveVideo('l') }, async () => true)).toBeNull()
  })

  it('refuses a LoadVideo file with no video in it before anything is held', LONG, async () => {
    await requireMediaTools()
    const k = videoKit()
    const err = await k.engine.startRun({ userId: null, takes: [{ l: loadVideo('a_min.wav'), s: saveVideo('l') }], ...START }).then(() => null, e => e as Error)
    expect(err?.message).toContain(MEDIA_WORDS.noVideo)
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('hosted: a video file that isn’t the user’s is refused before the hold', async () => {
    const k = videoKit({ hosted: true, owns: false })
    await expect(k.engine.startRun({ userId: k.userId, takes: [{ l: loadVideo('v_stereo_aac.mp4'), s: saveVideo('l') }], ...START })).rejects.toThrow('isn’t one of yours')
    await expect(k.engine.startRun({ userId: k.userId, takes: [{ c: videoCard({ file: 'v_stereo_aac.mp4', export: true }) }], ...START })).rejects.toThrow('isn’t one of yours')
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('hosted: a saved video is in the user’s own folder and counted as the run’s output', LONG, async () => {
    await requireMediaTools()
    const k = videoKit({ hosted: true })
    const { runId } = await k.engine.startRun({ userId: k.userId, takes: [{ l: loadVideo('v_stereo_aac.mp4'), s: saveVideo('l') }], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    expect(t.nodes.s!.status, t.nodes.s!.error ?? '').toBe('done')
    const out = t.nodes.s!.outputs[0]!
    expect(out.subfolder).toMatch(/^u_[0-9a-f]+\/video$/)
    expect(existsSync(join(k.root, 'output', out.subfolder, out.filename))).toBe(true)
    const recorded = k.graphRuns.appendOutput.mock.calls.map(c => String(c[1]))
    expect(recorded.some(r => r.includes(out.filename))).toBe(true)
  })

  it('the card exporting a file saves a stream copy and lists it once; the file it hands on is not listed as made', LONG, async () => {
    await requireMediaTools()
    const k = videoKit()
    const { runId } = await k.engine.startRun({ userId: null, takes: [{ c: videoCard({ file: 'v_stereo_aac.mp4', export: true }) }], ...START })
    await k.engine.settled(runId)
    const t = (await k.store.get(runId))!.takes[0]!
    expect(t.nodes.c!.status, t.nodes.c!.error ?? '').toBe('done')
    const written = k.records.write.mock.calls.flatMap(c => (c[0] as { outputs: OutputFile[] }).outputs)
    expect(written).toEqual([{ filename: 'ComfyUI_00001_.mp4', subfolder: 'video', type: 'output' }])
  })
})

// ── Plain words and guards ───────────────────────────────────────────────────

describe('guards', () => {
  it('save failures in plain words by cause; the server’s folders are never named', () => {
    const coded = (code: string) => Object.assign(new Error(`${code}: /srv/secret/output/x`), { code })
    expect(videoSaveWords(coded('ENAMETOOLONG'))).toMatch(/name/)
    expect(videoSaveWords(coded('ENOSPC'))).toMatch(/no room/)
    expect(videoSaveWords(coded('EACCES'))).toBe('The video couldn’t be saved.')
    for (const w of [VIDEO_FILE_MISSING, VIDEO_NOT_MP4, videoSaveWords(coded('EACCES'))]) {
      expect(w, 'sentence case, no identifiers').toMatch(/^[A-Z][^_]*$/)
    }
  })

  it('a node with no media IO (a live preview) fails plainly', async () => {
    const plan = await planNode({ prompt: { l: loadVideo('a.mp4'), g: getComp('l') }, nodeId: 'g', families: ON, gateOpen: false, filesFrom: () => [inputFile('a.mp4')], valueFrom: () => ({ kind: 'files', files: [inputFile('a.mp4')] }), toUrl: async () => '' })
    const io = { ...ioFor(harness(), 'g', rid(++runs), []), media: undefined }
    await expect((plan as Extract<NodePlan, { kind: 'derive' }>).derive(io)).rejects.toThrow()
  })

  it('Stop during GetVideoComponents ends it and keeps nothing', LONG, async () => {
    await requireMediaTools()
    const h = harness({ clips: ['v_stereo_aac.mp4'] })
    const plan = await planNode({ prompt: { l: loadVideo('v_stereo_aac.mp4'), g: getComp('l') }, nodeId: 'g', families: ON, gateOpen: false, filesFrom: () => [], valueFrom: () => ({ kind: 'files', files: [inputFile('v_stereo_aac.mp4')] }), toUrl: async () => '' })
    const ctl = new AbortController()
    ctl.abort()
    const io = ioFor(h, 'g', rid(++runs), [])
    await expect((plan as Extract<NodePlan, { kind: 'derive' }>).derive({ ...io, signal: ctl.signal, media: { ...io.media!, signal: ctl.signal } })).rejects.toThrow(MEDIA_WORDS.stopped)
    expect(written(join(h.root, 'kept')).filter(f => !f.includes('.work'))).toEqual([])
  })

  it('hosted: a video over the length cap is refused from its header, and a batch over the frame cap as it streams; nothing is kept', LONG, async () => {
    await requireMediaTools()
    expect(MEDIA_CAPS.hosted).toMatchObject({ batchFrames: 600, batchPixels: 600 * 1920 * 1080, keptBytesPerRun: 4 * 1024 ** 3 })
    const caps = MEDIA_CAPS.hosted as { videoSeconds: number; batchFrames: number }
    const saved = { videoSeconds: caps.videoSeconds, batchFrames: caps.batchFrames }
    const h = harness({ hosted: true, clips: ['v_stereo_aac.mp4'] })
    const prompt: ApiPrompt = { l: loadVideo('v_stereo_aac.mp4'), g: getComp('l') }
    const values = { l: { 0: { kind: 'files', files: [inputFile('v_stereo_aac.mp4')] } as RunnerValue } }
    try {
      caps.videoSeconds = 0.5
      await expect(runNode(h, prompt, 'g', values)).rejects.toThrow(MEDIA_WORDS.tooLong)
      caps.videoSeconds = saved.videoSeconds
      caps.batchFrames = 10
      await expect(runNode(h, prompt, 'g', values)).rejects.toThrow(MEDIA_WORDS.tooManyFrames)
    }
    finally {
      caps.videoSeconds = saved.videoSeconds
      caps.batchFrames = saved.batchFrames
    }
    expect(written(join(h.root, 'kept')).filter(f => f.endsWith('.mkv') || f.endsWith('.wav'))).toEqual([])
  })

  it('the Audio card reads an empty sound (a silent video’s) as Python’s None: its own file, else silence', LONG, async () => {
    await requireMediaTools()
    const h = harness({ clips: ['a_min.wav'] })
    const card = (audio: string) => ({ class_type: 'Audio', inputs: { audio, export: false, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: ['g', 1] as Link } })
    const empty = { g: { 1: { kind: 'files', files: [] } as RunnerValue } }
    const own = await runNode(h, { g: getComp('l'), c: card('a_min.wav') }, 'c', empty, ON_BOTH)
    expect(own.values[0]).toEqual({ kind: 'files', files: [inputFile('a_min.wav')], sound: { decode: 'load' } })
    const silent = await runNode(h, { g: getComp('l'), c: card('') }, 'c', empty, ON_BOTH)
    expect(silent.ui).toEqual({ audio: [] })
    expect(silent.values[0]).toMatchObject({ kind: 'files', sound: { decode: 'exact' } })
  })
})

// ── The big-batch concern (R5.2 review) ──────────────────────────────────────

describe('a noisy 1080p batch kept as FFV1 (measured)', () => {
  it('measures the kept size per frame and extrapolates to a 600-frame batch against the 2 GiB and 4 GiB caps', LONG, async () => {
    await requireMediaTools()
    const h = harness()
    const W = 1920
    const H = 1080
    const N = 6
    async function* noise(): AsyncIterable<Uint8Array> {
      for (let i = 0; i < N; i++) yield new Uint8Array(randomBytes(W * H * 3))
    }
    const v = await keepFrames(rid(++runs), noise(), W, H, { access: h.access, kept: h.kept, runId: rid(runs), userId: null, hosted: false })
    const bytes = statSync(h.kept.pathOf(v.file)).size
    const perFrame = bytes / N
    const batch600 = perFrame * 600
    const GiB = 1024 ** 3
    console.info(`[media-video] big batch: ${N} frames of 1920×1080 noise kept as ${bytes} B (${(perFrame / 1e6).toFixed(2)} MB a frame, raw ${(W * H * 3 / 1e6).toFixed(2)} MB); 600 frames ≈ ${(batch600 / GiB).toFixed(2)} GiB against the 2 GiB video and 4 GiB kept caps`)
    // Pure noise can't compress: about the raw size, so a 600-frame batch passes 2 GiB and nearly fills the run's 4 GiB.
    expect(perFrame).toBeGreaterThan(W * H * 3 * 0.9)
    expect(batch600).toBeGreaterThan(2 * GiB)
    expect(batch600).toBeLessThan(4 * GiB)
  })
})

// ── Fix round 1 ──────────────────────────────────────────────────────────────

describe('fix round 1 (Critical): on their media rows the cards’ own files are the user’s, checked before the hold', () => {
  const OTHER = 'u_someone_else/clip.mp4'
  it('collectInputFiles lists a card’s file whenever it is set on its media row, wired source or not (off: as before)', () => {
    const p: ApiPrompt = { a: videoCard(), c: videoCard({ source: ['a', 0], file: OTHER, export: true }) }
    const own = { filename: 'clip.mp4', subfolder: 'u_someone_else', type: 'input' }
    expect(collectInputFiles(p, ON)).toContainEqual(own)
    expect(collectInputFiles(p, CARDS)).not.toContainEqual(own)
    const a: ApiPrompt = { g: getComp('l'), c: { class_type: 'Audio', inputs: { audio: 'u_someone_else/voice.wav', export: true, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: ['g', 1] } } }
    const voice = { filename: 'voice.wav', subfolder: 'u_someone_else', type: 'input' }
    expect(collectInputFiles(a, ON_BOTH)).toContainEqual(voice)
    expect(collectInputFiles(a, ON)).not.toContainEqual(voice)
  })

  function hostedKit(families: ReadonlySet<RunnerFamily>) {
    const dir = mkdtempSync(join(scratch, 'runs-'))
    return makeKit({
      hosted: true, dir,
      deps: {
        families: () => families, kept: createFileKeptBytes(join(dir, 'kept')),
        // The user owns their own folder's files only.
        ownership: { ownsInput: async (_u: string, f: OutputFile) => !f.subfolder.startsWith('u_someone_else'), ownsOutput: async () => true },
      },
    })
  }

  it('Video card: an empty video source, another user’s file, export on: refused before the hold', async () => {
    const k = hostedKit(ON)
    const take: ApiPrompt = { a: videoCard(), c: videoCard({ source: ['a', 0], file: OTHER, export: true }) }
    expect(runnerTakesWorkflow(take, ON)).toBe(true)
    await expect(k.engine.startRun({ userId: k.userId, takes: [take], ...START })).rejects.toThrow('isn’t one of yours')
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('Audio card: an empty sound source (a silent video’s), another user’s sound, export on: refused before the hold', async () => {
    const k = hostedKit(ON_BOTH)
    const take: ApiPrompt = {
      l: loadVideo('mine.mp4'), g: getComp('l'),
      c: { class_type: 'Audio', inputs: { audio: 'u_someone_else/voice.wav', export: true, filename_prefix: 'audio/ComfyUI', format: 'flac', quality: 'V0', source: ['g', 1] } },
    }
    expect(runnerTakesWorkflow(take, ON_BOTH)).toBe(true)
    await expect(k.engine.startRun({ userId: k.userId, takes: [take], ...START })).rejects.toThrow('isn’t one of yours')
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })
})

describe('fix round 1 (Important 1): a stream copy keeps no codec tag or stream tag of the source’s, as PyAV’s', () => {
  it('an hvc1-tagged HEVC with its own language and handler, not muxed by PyAV, saves as Python saves it', LONG, async () => {
    await requireMediaTools()
    const src = await streamsAndTags(clipPath('g_video_hvc1.mp4'))
    // The source really carries what a phone writes.
    expect(src.tags['stream0:language']).toBe('eng')
    expect(src.tags['stream0:handler_name']).toBe('Core Media Video')
    const c = C.saves.cases.find(x => x.clip === 'g_video_hvc1.mp4' && x.format === 'auto' && x.codec === 'auto')!.x264 as PyRun
    const h = harness({ clips: ['g_video_hvc1.mp4'] })
    const saved = await runNode(h, { l: loadVideo('g_video_hvc1.mp4'), s: saveVideo('l') }, 's', { l: { 0: { kind: 'files', files: [inputFile('g_video_hvc1.mp4')] } } })
    const path = h.results.pathOf!(saved.assets[0]!)
    const { stdout } = await runMedia({ tool: 'ffprobe', args: ['-protocol_whitelist', 'file,pipe', '-i', `file:${path}`, '-of', 'json', '-show_streams'], userId: null })
    const tagOf = (JSON.parse(Buffer.from(stdout!).toString('utf8')) as { streams: { codec_tag_string: string }[] }).streams[0]!.codec_tag_string
    // PyAV resets the codec tag: the MP4 muxer's own for HEVC.
    expect(tagOf).toBe('hev1')
    expectTags((await streamsAndTags(path)).tags, c.saved.tags, 'hvc1')
  })
})

describe('fix round 1 (Important 2): every container a person can upload that Python reads', () => {
  const FORMATS: Record<string, string> = {
    'g_video_ts.ts': 'mpegts', 'g_video_ps.mpg': 'mpegps', 'g_video_flv.flv': 'flv', 'g_video_asf.wmv': 'asf', 'g_video_noftyp.mov': 'mov',
  }
  it('is told apart from its first bytes', () => {
    for (const c of C.containers) expect(mediaFormat(readFileSync(clipPath(c.clip)).subarray(0, 1024)), c.clip).toBe(FORMATS[c.clip])
    // An M2TS (192-byte packets, a 4-byte time code before each) is MPEG-TS too.
    const m2ts = new Uint8Array(1024)
    for (let k = 0; k < 5; k++) m2ts[4 + 192 * k] = 0x47
    expect(mediaFormat(m2ts)).toBe('mpegts')
    // A lone 0x47 is not.
    expect(mediaFormat(Uint8Array.from([0x47, 1, 2, 3, 4, 5, 6, 7]))).toBeNull()
  })

  for (const c of C.containers) {
    it(`${c.clip} (${c.formatName}): LoadVideo → GetVideoComponents, and SaveVideo`, LONG, async () => {
      await requireMediaTools()
      const h = harness({ clips: [c.clip] })
      const values = { l: { 0: { kind: 'files', files: [inputFile(c.clip)] } as RunnerValue } }
      // The start check passes it.
      expect(await loadVideoStartProblems({ l: loadVideo(c.clip) }, f => h.access.exists(f), f => probeVideoFile(f, { access: h.access, userId: null, hosted: false }).then(() => null))).toBeNull()
      const made = await runNode(h, { l: loadVideo(c.clip), g: getComp('l') }, 'g', values)
      const shas: string[] = []
      await readFrames(made.values[0] as Extract<RunnerValue, { kind: 'frames' }>, { access: h.access, kept: h.kept, runId: rid(runs), userId: null, hosted: false }, async (rgb) => { shas.push(sha256Hex(rgb)) })
      if ('error' in c) {
        // Named: PyAV can't seek an FLV (get_components' seek to 0 raises); the runner, which doesn't seek, reads its 8 frames.
        expect(c.error).toContain('Operation not permitted')
        expect(made.values[0]).toMatchObject({ kind: 'frames', count: 8, w: 64, h: 48 })
      }
      else {
        expect(shas, `${c.clip}: frames`).toEqual(c.frames.list)
        expect(made.values[2]).toEqual({ kind: 'number', value: c.fps, int: false })
        const s = await readSound(made.values[1]!, 'GetVideoComponents', { access: h.access, userId: null, hosted: false })
        expect(sha256Hex(soundBytes(s.channels)), `${c.clip}: sound`).toBe(c.sound!.sha256)
      }
      const prompt: ApiPrompt = { l: loadVideo(c.clip), s: saveVideo('l') }
      if ('error' in c.save) {
        expect(c.save.error).toContain('does not support')
        await expect(runNode(h, prompt, 's', values)).rejects.toThrow(VIDEO_NOT_MP4)
        return
      }
      const saved = await runNode(h, prompt, 's', values)
      expect(saved.ui).toEqual(c.save.ui)
      const path = h.results.pathOf!(saved.assets[0]!)
      expect((await decodeAll(path)).map(sha256Hex)).toEqual(c.save.saved.frames)
      await expectFileSound(path, c.save.saved.sound, c.clip)
      expectTags((await streamsAndTags(path)).tags, c.save.saved.tags, c.clip)
    })
  }

  it('a file the build can’t read: R11.9a (row 20) refuses it plainly before the hold, saying what to change, never the engine', async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const k = makeKit({ dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(k.root, 'input', 'odd.mp4'), Buffer.from('not a container any tool here reads'.repeat(40)))
    for (const take of [
      { l: loadVideo('odd.mp4'), s: saveVideo('l') },
      { c: videoCard({ file: 'odd.mp4' }), g: getComp('c'), v: createVideo(['g', 0], 24), s: saveVideo('v') },
      { c: videoCard({ file: 'odd.mp4' }), s: saveVideo('c') },
    ] as ApiPrompt[]) {
      const err = await k.engine.startRun({ userId: null, takes: [take], ...START }).catch(e => e)
      expect(err, Object.keys(take).join(' ')).toMatchObject({ statusCode: 400, data: { code: 'video-format' } })
      expect(err.data.reason).toBeUndefined()
      expect(err.message).toMatch(/Convert it to an MP4/)
    }
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })

  it('a Video card export the runner can’t do (ProRes into MP4: the build has no ProRes encoder) is refused plainly (R11.9a, row 20); one it can do runs', LONG, async () => {
    await requireMediaTools()
    const dir = mkdtempSync(join(scratch, 'runs-'))
    const k = makeKit({ dir, deps: { families: () => ON, kept: createFileKeptBytes(join(dir, 'kept')) } })
    for (const c of ['v_prores.mov', 'v_stereo_aac.mp4']) copyFileSync(clipPath(c), join(k.root, 'input', c))
    for (const take of [
      { c: videoCard({ file: 'v_prores.mov', export: true }) },
      { l: loadVideo('v_prores.mov'), c: videoCard({ source: ['l', 0], export: true }) },
    ] as ApiPrompt[]) {
      const err = await k.engine.startRun({ userId: null, takes: [take], ...START }).catch(e => e)
      expect(err).toMatchObject({ statusCode: 400, data: { code: 'video-format', nodeId: 'c' } })
      expect(err.data.reason).toBeUndefined()
      expect(err.message).toBe(withAdvice(VIDEO_NOT_MP4, CARD_EXPORT_ADVICE))
    }
    // Shown only (export off), the ProRes file is handed on as before.
    const shown = await k.engine.startRun({ userId: null, takes: [{ c: videoCard({ file: 'v_prores.mov' }) }], ...START })
    await k.engine.settled(shown.runId)
    expect((await k.store.get(shown.runId))!.takes[0]!.nodes.c!.status).toBe('done')
    const ok = await k.engine.startRun({ userId: null, takes: [{ c: videoCard({ file: 'v_stereo_aac.mp4', export: true }) }], ...START })
    await k.engine.settled(ok.runId)
    expect((await k.store.get(ok.runId))!.takes[0]!.nodes.c!.status).toBe('done')
    expect(k.ledger.hold).not.toHaveBeenCalled()
  })
})

describe('fix round 1 (Minor): a failed or stopped sound step keeps no frames', () => {
  for (const how of ['fails', 'is stopped'] as const) {
    it(`when the sound step ${how}, the frames just written are gone and the run keeps nothing`, LONG, async () => {
      await requireMediaTools()
      const h = harness({ clips: ['v_stereo_aac.mp4'] })
      const runId = rid(++runs)
      const ctl = new AbortController()
      const io = { access: h.access, kept: h.kept, runId, userId: null, hosted: false, signal: ctl.signal }
      const p = await probeVideoFile(inputFile('v_stereo_aac.mp4'), io)
      const before = async () => {
        if (how === 'fails') throw new Error('the sound failed')
        ctl.abort()
      }
      await expect(keepVideoFrames(p, io, { before })).rejects.toThrow(how === 'fails' ? 'the sound failed' : MEDIA_WORDS.stopped)
      expect(await h.kept.runBytes(runId)).toBe(0)
      expect(await h.kept.workBytes(runId)).toBe(0)
      expect(written(join(h.root, 'kept')).filter(f => f.endsWith('.mkv'))).toEqual([])
    })
  }
})

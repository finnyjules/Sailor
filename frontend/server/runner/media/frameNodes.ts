/**
 * Frame batches from and to files, computed here (step 3, R5.5, family
 * `media-video`), exactly as comfy_extras/nodes_video_effects.py runs them.
 * R5.4's videoNodes.ts is the model: every probe, decode and encode goes
 * through the media module, a batch is kept as one FFV1 file (R5.2's `frames`
 * value), and a saved file goes into the store by path.
 *
 *   LoadVideoFrames — execute (:554-599). The first video stream; `scale =
 *                     min(1, max_size / max(w, h))`, `tw, th = max(1,
 *                     round(w·scale)), max(1, round(h·scale))` (Python's round,
 *                     half to even); `fps = float(average_rate) or 30`; every
 *                     frame the decoder hands over counted (no pts rule, unlike
 *                     get_components), `start_frame` skipped, then every
 *                     `stride`-th kept, `min(int(max_seconds · fps / stride),
 *                     max_frames)` at most (and at least one). A frame to
 *                     resize goes through Pillow's resize(BILINEAR) on the
 *                     Frame's worker (pixels/core.ts pilResize, its watchdog and
 *                     Stop), one at a time; nothing kept gives one 64 × 64 black
 *                     frame. Outputs: the batch, and `fps / stride`. Its
 *                     validate_inputs ("Invalid video file") is the start check
 *                     `frameStartProblems`, as Load video's is.
 *   SaveVideoFrames — execute (:661-740). `<(prefix or 'video').rstrip('_')>_
 *                     <YYYYmmdd_HHMMSS>.mp4` in output's top folder (the user's
 *                     own in hosted), a counter only where that name is taken
 *                     (ruling h). The frames as they are (an 8-bit batch:
 *                     `(clamp(0, 1)·255).astype(uint8)` gives them back
 *                     exactly), padded to even sizes with black at the right
 *                     and bottom; H.264 at Fraction(round(fps · 1000), 1000)
 *                     with `h264Args({ crf, preset })`. With an `audio_file`,
 *                     its first sound stream, decoded frames up to the first
 *                     past T / fps, as AAC stereo at the stream's rate. A sound
 *                     that won't open (or has no sound stream, or isn't there)
 *                     is skipped, as Python skips it; one whose kind the build
 *                     can't tell leaves the workflow to the engine before the
 *                     run. ui `{ images: [the file], animated: [true] }`; no
 *                     outputs.
 *
 * Why the resize goes through a file: the decode is one media job and the
 * FFV1 write another, and a person has one job at a time in hosted (rule 5).
 * The resized frames are written, one at a time, to a raw file in the run's
 * work folder (counted toward its kept total while it exists), then kept. A
 * file already at its size is kept in ONE job, straight from the decode.
 *
 * Free: no price, no hold, no charge. Both classes count as work.
 */
import { open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { pyFloatOf, pyIntOf } from '#shared/runner/pyText'
import { MEDIA_CAPS, MEDIA_WORDS } from '#shared/runner/media'
import type { DeriveIO, NodePlan, PlanContext } from '../executors'
import type { OutputFile, RunnerValue } from '../types'
import { parseInputFileRef } from '../inputs'
import { pixelsInWorker } from '../compositor/worker'
import type { FileAccess } from '../fileAccess'
import { VIDEO_FILE_MISSING, videoSaveWords } from './videoNodes'
import type { FramePick } from '../../media/decode'
import { decodeFramesAnySize } from '../../media/decode'
import { encodeVideo, pyStreamRateOf, type SoundLayout, type SoundSource } from '../../media/encode'
import { SAVE_OUTSIDE } from '../results'
import { probeMedia, sniffMediaFormat, type MediaProbe, type Rational } from '../../media/probe'
import { MediaError } from '../../media/run'
import { batchWord, keepFrames, keepPickedFrames, probeVideoFile, type MediaValueIO } from '../../media/values'

/** Save video frames with no frame batch wired in (a picture from anything but Load video frames or Get video components). */
export const NO_FRAMES_WIRED = 'There are no video frames wired in'
/** A frames node run where it can't reach the video tools' files (a live preview). */
export const FRAMES_NEED_RUN = 'Video frames can only be worked on when the workflow runs'

type FramesValue = Extract<RunnerValue, { kind: 'frames' }>

function mediaOf(io: DeriveIO): MediaValueIO {
  if (!io.media || !io.saveAssetFromPath) throw new Error(FRAMES_NEED_RUN)
  return io.media
}

/** What a link brings (its value, or its files). */
function wired(ctx: PlanContext, link: ApiLink): RunnerValue {
  return ctx.valueFrom?.(link) ?? { kind: 'files', files: ctx.filesFrom(link) }
}

/** Python's int() of a validated INT widget. */
function intOf(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? (Number.isFinite(v) ? Math.trunc(v) : null)
    : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? pyIntOf(v) : null
  return n ?? fallback
}

/** Python's float() of a validated FLOAT widget. */
function floatOf(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'boolean' ? Number(v) : typeof v === 'string' ? pyFloatOf(v) : null
  return n ?? fallback
}

/** Python's round() of a float: halves to the even neighbour. */
function pyRound(x: number): number {
  const r = Math.round(x)
  return r - x === 0.5 && r % 2 !== 0 ? r - 1 : r
}

// ── LoadVideoFrames ──────────────────────────────────────────────────────────

export interface LoadFramesSettings { max_seconds: number; max_frames: number; max_size: number; start_frame: number; stride: number }

/**
 * execute's numbers (:566-577), from the stream's size and average rate: the
 * size each frame is kept at, the rate, and which of the decoder's frames are
 * kept (`count` at least 1: Python's loop keeps a frame before it checks its
 * cap). `outFps` is the second output, `fps / stride`.
 */
export function loadFramesPick(v: { w: number; h: number; rate: Rational | null }, s: LoadFramesSettings): FramePick & { tw: number; th: number; fps: number; outFps: number } {
  const scale = Math.min(1, s.max_size / Math.max(v.w, v.h))
  const tw = Math.max(1, pyRound(v.w * scale))
  const th = Math.max(1, pyRound(v.h * scale))
  // float(average_rate) if average_rate else 30.0
  const fps = v.rate && v.rate.num && v.rate.den ? v.rate.num / v.rate.den : 30
  const stride = Math.max(1, Math.trunc(s.stride))
  const timeCap = s.max_seconds > 0 ? Math.trunc(s.max_seconds * fps / stride) : 1e9
  const hardCap = Math.max(1, Math.trunc(s.max_frames))
  const count = Math.max(1, Math.min(timeCap, hardCap))
  return { tw, th, fps, outFps: fps / stride, start: Math.max(0, Math.trunc(s.start_frame)), stride, count }
}

/** The file a loader's `file` widget names, as get_annotated_filepath opens it; null when it names none it can open. */
function loaderFile(inputs: Record<string, unknown>): OutputFile | null {
  return isLink(inputs.file) ? null : parseInputFileRef(inputs.file)
}

/** Load video frames' settings as its execute() receives them (R6.1: read by the start pass too, server/runner/video/shapes.ts). */
export function settingsOf(inputs: Record<string, unknown>): LoadFramesSettings {
  return {
    max_seconds: floatOf(inputs.max_seconds, 10),
    max_frames: intOf(inputs.max_frames, 600),
    max_size: intOf(inputs.max_size, 720),
    start_frame: intOf(inputs.start_frame, 0),
    stride: intOf(inputs.stride, 1),
  }
}

const capsOf = (hosted: boolean) => hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local

/** LoadVideoFrames: see the header. */
export function planLoadVideoFrames(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const file = loaderFile(inputs)
  if (!file) throw new Error(VIDEO_FILE_MISSING)
  const settings = settingsOf(inputs)
  return {
    kind: 'derive',
    async derive(io) {
      const media = mediaOf(io)
      if (!(await media.access.exists(file))) throw new Error(VIDEO_FILE_MISSING)
      const p = await probeVideoFile(file, media)
      const v = p.video[0]!
      const pick = loadFramesPick({ w: v.w, h: v.h, rate: v.averageRate }, settings)
      const { tw, th } = pick
      // The caps before any decode, where the header counts the frames (and the size alone otherwise).
      const known = v.frames && v.frames > 0 ? Math.min(pick.count, Math.max(0, Math.ceil((v.frames - pick.start) / pick.stride))) : 0
      const word = batchWord(known, tw, th, capsOf(media.hosted))
      if (word) throw new MediaError(word)
      const resize = tw !== v.w || th !== v.h
      const frames = resize ? await keepResized(p, file, media, pick, tw, th) : await keepPickedFrames(p, media, pick)
      return {
        values: {
          0: frames ?? await keepFrames(media.runId, blackFrame(), 64, 64, media),
          1: { kind: 'number', value: pick.outFps, int: false },
        },
        ui: null,
      }
    },
  }
}

/** Python's fallback when no frame is kept: torch.zeros(64, 64, 3). */
async function* blackFrame(): AsyncIterable<Uint8Array> {
  yield new Uint8Array(64 * 64 * 3)
}

/**
 * The picked frames, each through Pillow's resize(BILINEAR) on the Frame's
 * worker, written one at a time to a raw file in the run's work folder, then
 * kept as one FFV1 batch (see the header for why two jobs). The batch caps
 * hold as the frames arrive. Null when no frame is picked. A failure or Stop
 * leaves nothing: the raw file goes with its folder.
 */
async function keepResized(p: MediaProbe, file: OutputFile, media: MediaValueIO, pick: FramePick, tw: number, th: number): Promise<FramesValue | null> {
  const caps = capsOf(media.hosted)
  const bytes = tw * th * 3
  await media.kept.checkRoom(media.runId)
  const work = await media.kept.workDir(media.runId)
  try {
    const raw = join(work, 'frames.raw')
    let n = 0
    let sinceCheck = 0
    const out = await open(raw, 'wx')
    try {
      // Each frame at its own size (fix round 1): Python resizes whatever size a frame comes out at.
      await decodeFramesAnySize(p.path, {
        userId: media.userId, signal: media.signal, pick, framePixels: caps.framePixels,
        roots: [media.access.rootOf(file)], probe: p,
        onFrame: async (rgb, fw, fh) => {
          const word = batchWord(n + 1, tw, th, caps)
          if (word) throw new MediaError(word)
          let small: Uint8Array
          try { small = await pixelsInWorker(media.signal, w => w.resizeRgb(rgb, fw, fh, tw, th)) }
          // Stop reaches the worker as its own 'Stopped': the node says the plain words.
          catch (e) { throw media.signal?.aborted ? new MediaError('stopped') : e }
          if (small.byteLength !== bytes) throw new MediaError('failed')
          for (let at = 0; at < small.byteLength;) {
            const { bytesWritten } = await out.write(small, at, small.byteLength - at)
            at += bytesWritten
          }
          n++
          // The raw file is held to the run's kept room as it grows (fix round 1, Minor 4): KEPT_TOO_MUCH
          // as soon as it passes, not only once the decode is done.
          sinceCheck += bytes
          if (sinceCheck >= ROOM_CHECK_BYTES || n % ROOM_CHECK_FRAMES === 0) {
            sinceCheck = 0
            await media.kept.checkRoom(media.runId)
          }
        },
      })
    }
    finally { await out.close() }
    if (media.signal?.aborted) throw new MediaError('stopped')
    if (n === 0) return null
    return await keepFrames(media.runId, rawFrames(raw, bytes, n), tw, th, media)
  }
  finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** How many bytes of frames may be written between two checks of the run's kept room. */
export const ROOM_CHECK_BYTES = 64 * 1024 * 1024
/** …and at least every this many frames. */
export const ROOM_CHECK_FRAMES = 16

/** A raw rgb24 file's `n` frames of `bytes` each, read one at a time. */
async function* rawFrames(path: string, bytes: number, n: number): AsyncIterable<Uint8Array> {
  const f = await open(path, 'r')
  try {
    for (let i = 0; i < n; i++) {
      const frame = new Uint8Array(bytes)
      let at = 0
      while (at < bytes) {
        const { bytesRead } = await f.read(frame, at, bytes - at, i * bytes + at)
        if (!bytesRead) throw new MediaError('failed')
        at += bytesRead
      }
      yield frame
    }
  }
  finally { await f.close() }
}

// ── SaveVideoFrames ──────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * The saved file's name (:667-669): `(prefix or 'video').rstrip('_')`, `_`,
 * then time.strftime('%Y%m%d_%H%M%S') (local time), before `.mp4`. A prefix
 * naming a folder (`clips/take`) saves into that folder of output, as
 * Python's joined path does where the folder is there.
 */
export function saveFramesName(prefix: string, now: Date): { subfolder: string; name: string } {
  const base = (prefix || 'video').replace(/_+$/, '')
  const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`
  const full = `${base}_${stamp}`
  const cut = full.lastIndexOf('/')
  return cut < 0 ? { subfolder: '', name: full } : { subfolder: full.slice(0, cut), name: full.slice(cut + 1) }
}

/** Python's str() of a widget value. */
function pyStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  if (v === null || v === undefined) return 'None'
  return String(v)
}

/** The file `audio_file` names, when Python would open one: set, not '(none)'. */
function soundFileOf(v: unknown): OutputFile | null {
  if (typeof v !== 'string' || !v || v === '(none)') return null
  return parseInputFileRef(v)
}

/**
 * The sound SaveVideoFrames adds (:684-695): the named file's first sound
 * stream, cut after the first decoded frame whose time is past `seconds`,
 * stereo AAC at its rate (48 kHz where it has none). Null where Python skips
 * the sound: no file named, a file that isn't there, one that won't open, or
 * one with no sound stream in it.
 */
async function soundFor(v: unknown, media: MediaValueIO, seconds: number): Promise<{ sound: { source: SoundSource; layout: SoundLayout; rate: number }; root: string } | null> {
  const file = soundFileOf(v)
  if (!file || !(await media.access.exists(file))) return null
  const path = await media.access.verifiedPath(file)
  const root = media.access.rootOf(file)
  let p: MediaProbe
  // Only T / fps of it is read (fix round 1, Minor 2): its length isn't held to the caps, what is decoded is.
  try { p = await probeMedia(path, { userId: media.userId, signal: media.signal, roots: [root], kind: 'sound', anyLength: true }) }
  catch (e) {
    // PyAV can't open it either: "[SaveVideoFrames] audio open failed", and the video is saved without it.
    if (e instanceof MediaError && (e.word === 'unreadable' || e.word === 'failed')) {
      console.warn('[runner] Save video frames: the sound won’t open, saved without it')
      return null
    }
    throw e
  }
  const s = p.sound[0]
  if (!s) return null
  return { sound: { source: { path, stream: 'first', cutSeconds: seconds }, layout: 'stereo', rate: s.rate || 48000 }, root }
}

/**
 * The stream rate SaveVideoFrames sets (:678): Fraction(int(round(fps * 1000)),
 * 1000), `fps` a Python FLOAT, so the product is rounded as the double it is,
 * halves to even (R5.5 fix round 1, Important 1: 23.9765 · 1000 is the double
 * 23976.5, which rounds to 23976; the exact value, 23976.4999…, is what R5.4's
 * `pyStreamRate` rounds, right for save_to's Fraction(fps) but not here).
 */
export function framesStreamRate(fps: number): Rational {
  const q = pyRound(fps * 1000)
  if (!(q > 0) || !Number.isSafeInteger(q)) throw new MediaError('failed')
  return pyStreamRateOf(BigInt(q), 1000n)
}

/**
 * Whether a prefix would save outside the output folder (R5.5 fix round 1,
 * Minor 3): an absolute path, or a `..` part. Python's os.path.join really
 * writes there; Sailor never does, and refuses it before any work.
 */
export function framesPrefixOutside(prefix: string): boolean {
  const full = (prefix || 'video').replace(/_+$/, '')
  // The last part is the name itself (the stamp follows it), never a folder.
  return full.startsWith('/') || full.split('/').slice(0, -1).some(part => part === '..')
}

/** Python's float() of the fps (a typed widget, or the rate a wire brought, already in place). */
function fpsOf(v: unknown): number {
  const n = floatOf(v, Number.NaN)
  if (!Number.isFinite(n) || !(n > 0)) throw new MediaError('failed')
  return n
}

const entry = (f: OutputFile) => ({ filename: f.filename, subfolder: f.subfolder, type: f.type })

/** SaveVideoFrames: see the header. */
export function planSaveVideoFrames(ctx: PlanContext): NodePlan {
  const inputs = ctx.prompt[ctx.nodeId]!.inputs ?? {}
  const link = inputs.frames
  if (!isLink(link)) throw new Error(NO_FRAMES_WIRED)
  const fps = fpsOf(inputs.fps ?? 30)
  const prefix = pyStr(inputs.filename_prefix ?? 'video')
  if (framesPrefixOutside(prefix)) throw new Error(SAVE_OUTSIDE)
  const crf = intOf(inputs.crf, 20)
  const preset = String(inputs.preset ?? 'veryfast') as 'veryfast' | 'fast' | 'medium' | 'slow'
  return {
    kind: 'derive',
    async derive(io) {
      const media = mediaOf(io)
      const frames = wired(ctx, link)
      if (frames.kind !== 'frames') throw new Error(NO_FRAMES_WIRED)
      const word = batchWord(frames.count, frames.w, frames.h, capsOf(media.hosted))
      if (word) throw new MediaError(word)
      const { subfolder, name } = saveFramesName(prefix, new Date())
      const sound = await soundFor(inputs.audio_file, media, frames.count / fps)
      // Known gap (R5.2 review Minor 3, parked in the ledger): the bytes are verified, then the tool reopens the path.
      const framesPath = await media.access.verifiedPath(frames.file)
      await media.kept.checkRoom(media.runId)
      const work = await media.kept.workDir(media.runId)
      try {
        const out = join(work, 'video.mp4')
        await encodeVideo({
          input: { kind: 'ffv1', path: framesPath, w: frames.w, h: frames.h }, padToEven: true,
          out, fps: framesStreamRate(fps), quality: { crf, preset },
          sound: sound?.sound ?? null,
          userId: media.userId, signal: media.signal,
          roots: [media.access.rootOf(frames.file), ...(sound ? [sound.root] : [])], outRoots: [work],
        })
        let saved: OutputFile
        try { saved = await io.saveAssetFromPath!(out, { prefix: name, ext: 'mp4', subfolder, folder: 'output', exact: true }) }
        catch (e) { throw new Error(videoSaveWords(e)) }
        return { values: {}, ui: { images: [entry(saved)], animated: [true] } }
      }
      finally {
        await rm(work, { recursive: true, force: true })
      }
    },
  }
}

// ── Before the run ───────────────────────────────────────────────────────────

/**
 * What SaveVideoFrames' sound file is to the runner, before the run: null
 * when it can go ahead (it reads the file, or skips it as Python does: one
 * that won't open, with a kind the build knows, is Python's skip too); else
 * the plain words and whether the workflow is left to the engine (a kind the
 * build can't tell, which PyAV may read; the tools missing) instead of
 * refused (a sound over the caps).
 */
export async function framesSoundVerdict(access: FileAccess, file: OutputFile, o: { userId: string | null; signal?: AbortSignal }): Promise<{ message: string; engine: boolean } | null> {
  let path: string
  try { path = await access.verifiedPath(file) }
  catch { return null }
  const format = await sniffMediaFormat(path).catch(() => null)
  if (!format) return { message: MEDIA_WORDS.unreadable, engine: true }
  try { await probeMedia(path, { userId: o.userId, signal: o.signal, roots: [access.rootOf(file)], kind: 'sound', anyLength: true }) }
  catch (e) {
    const w = e instanceof MediaError ? e.word : 'failed'
    if (w === 'unreadable' || w === 'failed') return null
    return { message: e instanceof MediaError ? e.message : MEDIA_WORDS.failed, engine: w === 'toolsMissing' }
  }
  return null
}

/**
 * The frames nodes' checks before the run, the first found or null:
 *   - LoadVideoFrames' validate_inputs: a file that isn't there (or a name
 *     get_annotated_filepath can't open) is refused, as ComfyUI refuses the
 *     prompt; then its file's verdict (`verdictOf`: R5.4's videoFileVerdict,
 *     a file the build can't read leaves the workflow to the engine);
 *   - SaveVideoFrames' sound: one that isn't there is skipped at its turn, as
 *     Python skips it; otherwise its verdict (`soundOf`, framesSoundVerdict).
 * `engine: true`: once left the whole workflow to the engine; R11.9a (row 20) refuses it plainly
 * instead, saying what to change (engine.ts prepareStart, server/runner/stopGapWords.ts).
 */
export async function frameStartProblems(
  prompt: ApiPrompt, exists: (f: OutputFile) => Promise<boolean>,
  verdictOf: (f: OutputFile) => Promise<{ message: string; engine: boolean } | null>,
  soundOf: (f: OutputFile) => Promise<{ message: string; engine: boolean } | null>,
): Promise<{ message: string; nodeId: string; classType: string; file?: string; engine?: true } | null> {
  for (const [nodeId, n] of Object.entries(prompt)) {
    const inputs = n.inputs ?? {}
    if (n.class_type === 'LoadVideoFrames') {
      const file = loaderFile(inputs)
      if (!file) return { message: VIDEO_FILE_MISSING, nodeId, classType: n.class_type }
      if (!(await exists(file))) return { message: VIDEO_FILE_MISSING, nodeId, classType: n.class_type, file: file.filename }
      const v = await verdictOf(file)
      if (v) return { message: v.message, nodeId, classType: n.class_type, file: file.filename, ...(v.engine ? { engine: true as const } : {}) }
    }
    // A prefix that would save outside output (fix round 1, Minor 3): refused before anything runs.
    if (n.class_type === 'SaveVideoFrames' && typeof inputs.filename_prefix === 'string' && framesPrefixOutside(inputs.filename_prefix)) {
      return { message: SAVE_OUTSIDE, nodeId, classType: n.class_type }
    }
    if (n.class_type === 'SaveVideoFrames' && !isLink(inputs.audio_file)) {
      const file = soundFileOf(inputs.audio_file)
      if (!file || !(await exists(file))) continue
      const v = await soundOf(file)
      if (v) return { message: v.message, nodeId, classType: n.class_type, file: file.filename, ...(v.engine ? { engine: true as const } : {}) }
    }
  }
  return null
}

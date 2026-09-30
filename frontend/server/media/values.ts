/**
 * Video, frame batches and sound between runner nodes (step 3, R5.2). The
 * runner's values (server/runner/types.ts RunnerValue) name files; this module
 * turns them into what Python's nodes hold, and back, through the media
 * module only (decode.ts, encode.ts):
 *
 *   - a sound is a `files` value with a `sound` note (SoundNote) saying which
 *     of Python's readers makes its AUDIO: 'load' (nodes_audio.py load(),
 *     LoadAudio and the cards), 'download' (nodes_replicate.py
 *     _download_url_to_audio_dict, the paid sound nodes), or 'exact' (a float
 *     WAV the runner wrote: the samples as they are). A value kept before R5
 *     has no note and is read by its maker (`soundNoteOf`);
 *   - a `frames` value is an IMAGE batch from a video: one kept FFV1 file of
 *     exact 8-bit RGB frames (ruling e);
 *   - a `video` value is a video a node assembled (Python's
 *     VideoFromComponents): its frames, sound and rate, encoded only when saved
 *     or shown (`videoFileFor`). A video file stays `files`: Python's
 *     VideoFromFile is the file itself.
 *
 * Kept `.mkv` and `.wav` files are written by the tools (or floatWav) into
 * the run's `workDir`, then kept by `putPath`; they are read by path, never
 * whole into memory. The caps (MEDIA_CAPS: batchFrames, batchPixels,
 * framePixels, soundSamples) are checked before the work wherever the value
 * or the probe tells them, and as the frames stream otherwise.
 */
import { rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { MEDIA_CAPS, MEDIA_JOB_TIMEOUT_MS, type MediaCaps } from '#shared/runner/media'
import type { FileAccess } from '../runner/fileAccess'
import type { KeptBytes } from '../runner/keptBytes'
import type { OutputFile, RunnerValue, SoundNote } from '../runner/types'
import { decodeAudio, decodeFrames, framesFilter, framesScale, pickFilter, type DecodedSound, type FramePick, type SoundDecoder } from './decode'
import { FFV1_KEPT_RATE, PYAV_H264_DEFAULT, encodeVideo, floatWav, pyStreamRate, writeFfv1, type SoundLayout } from './encode'
import { ffprobeJson, mediaCapsWord, probeMedia, type MediaProbe, type Rational } from './probe'
import { MediaError, inputArgs, runMedia } from './run'

/** Classes whose sound Python decodes with _download_url_to_audio_dict (nodes_replicate.py:1735, :1834, :5463, and the two cards that run them). */
export const SOUND_DOWNLOAD_CLASSES: ReadonlySet<string> = new Set([
  'GenerateMusicNode', 'MusicGenRemoteNode', 'GenerateSpeechNode', 'MiniMaxSpeechRemoteNode', 'CloneSingingVoiceNode',
])

/** What media values need from the run: its files by path, its kept store, who runs it, and Stop. */
export interface MediaValueIO {
  access: FileAccess
  kept: KeptBytes
  runId: string
  userId: string | null
  hosted: boolean
  signal?: AbortSignal
}

/** What reading a sound needs (no kept store). */
export type SoundReadIO = Pick<MediaValueIO, 'access' | 'userId' | 'signal' | 'hosted'>

type FramesValue = Extract<RunnerValue, { kind: 'frames' }>
type VideoValue = Extract<RunnerValue, { kind: 'video' }>

const capsOf = (hosted: boolean): Readonly<MediaCaps> => hosted ? MEDIA_CAPS.hosted : MEDIA_CAPS.local

/** A frame batch's size against the caps, before any work: the MEDIA_WORDS key, or null. */
export function batchWord(count: number, w: number, h: number, caps: Readonly<MediaCaps>): 'tooBig' | 'tooManyFrames' | null {
  if (w * h > caps.framePixels) return 'tooBig'
  if (count > caps.batchFrames || count * w * h > caps.batchPixels) return 'tooManyFrames'
  return null
}

function checkBatch(count: number, w: number, h: number, hosted: boolean): void {
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && Number.isInteger(count) && count >= 0)) throw new MediaError('failed')
  const word = batchWord(count, w, h, capsOf(hosted))
  if (word) throw new MediaError(word)
}

/** Python's reader for a note: a float WAV the runner wrote is read by `load`, which hands float32 samples on as they are. */
function decoderOf(note: SoundNote): SoundDecoder {
  return note.decode === 'download' ? 'download' : 'load'
}

/**
 * The note a sound value carries, or, for a value kept before R5 (no note),
 * its maker's: the paid sound nodes 'download', a sound the runner kept
 * itself (a kept `.wav`) 'exact', anything else (LoadAudio, the Audio card)
 * 'load'.
 */
export function soundNoteOf(v: RunnerValue, makerClass: string): SoundNote {
  if (v.kind === 'files' && v.sound) return v.sound
  if (SOUND_DOWNLOAD_CLASSES.has(makerClass)) return { decode: 'download' }
  const f = v.kind === 'files' ? v.files[0] : undefined
  if (f?.type === 'kept' && f.filename.endsWith('.wav')) return { decode: 'exact' }
  return { decode: 'load' }
}

/** The sound file of a sound value (its first file, as Python's AUDIO comes from one). */
function soundFileOf(v: RunnerValue): OutputFile {
  const f = v.kind === 'files' ? v.files[0] : undefined
  if (!f) throw new MediaError('noSound')
  return f
}

/**
 * A sound value's samples, exactly as Python's AUDIO holds them: decoded the
 * way its note (or its maker, `soundNoteOf`) says. Past MEDIA_CAPS.soundSamples
 * it fails as it streams (and before, where the header says so).
 */
export async function readSound(v: RunnerValue, makerClass: string, io: SoundReadIO): Promise<DecodedSound> {
  const file = soundFileOf(v)
  // Known gap (R5.2 review Minor 3, parked in the ledger): the bytes are verified, then the tool reopens the path.
  const path = await io.access.verifiedPath(file)
  return decodeAudio(path, {
    decoder: decoderOf(soundNoteOf(v, makerClass)),
    userId: io.userId, signal: io.signal,
    maxSamples: capsOf(io.hosted).soundSamples,
    roots: [io.access.rootOf(file)],
    // The runner's own kept sound is read back under the cap it was kept under (soundSamples, above),
    // not the upload caps (soundBytes, the length): its float WAV is 4 bytes a sample (fix round 1).
    ...(file.type === 'kept' ? { kept: true as const } : {}),
  })
}

/**
 * Keeps a sound the runner made, as a float WAV of its samples (read back
 * 'exact', bit for bit). `o.hosted`: the run's own (MediaValueIO.hosted).
 */
export async function keepSound(runId: string, s: DecodedSound, kept: KeptBytes, o: { hosted: boolean }): Promise<RunnerValue> {
  const n = s.channels[0]?.length ?? 0
  if (s.channels.length * n > capsOf(o.hosted).soundSamples) throw new MediaError('tooLong')
  await kept.checkRoom(runId)
  const bytes = floatWav(s)
  const work = await kept.workDir(runId)
  try {
    const tmp = join(work, 'sound.wav')
    await writeFile(tmp, bytes, { flag: 'wx' })
    const file = await kept.putPath(runId, tmp, 'wav')
    return { kind: 'files', files: [file], sound: { decode: 'exact' } }
  }
  finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * Every frame of a kept batch, in order, as exact rgb24, handed to `onFrame`
 * one at a time. The batch is checked against the caps before any decode,
 * and must decode to exactly its own count and size.
 */
export async function readFrames(v: FramesValue, io: MediaValueIO, onFrame: (rgb: Uint8Array, i: number) => Promise<void>): Promise<void> {
  checkBatch(v.count, v.w, v.h, io.hosted)
  // Known gap (R5.2 review Minor 3, parked in the ledger): the bytes are verified, then the tool reopens the path.
  const path = await io.access.verifiedPath(v.file)
  const got = await decodeFrames(path, {
    userId: io.userId, signal: io.signal, maxFrames: v.count,
    roots: [io.access.rootOf(v.file)],
    // Judged above by the batch caps it was kept under, not the upload caps (videoBytes, the length).
    kept: true,
    onFrame: (rgb, i) => onFrame(rgb, i),
  })
  if (got.count !== v.count || got.w !== v.w || got.h !== v.h) throw new MediaError('failed')
}

/** Frames as they stream, the batch caps checked at each (a batch over them fails before its next frame is written). */
async function* cappedFrames(frames: AsyncIterable<Uint8Array>, w: number, h: number, hosted: boolean, counted: { n: number }): AsyncIterable<Uint8Array> {
  const caps = capsOf(hosted)
  for await (const f of frames) {
    const word = batchWord(counted.n + 1, w, h, caps)
    if (word) throw new MediaError(word)
    counted.n++
    yield f
  }
}

/** Keeps a frame batch (rgb24 frames of w × h) as one FFV1 file for the run. */
export async function keepFrames(runId: string, frames: AsyncIterable<Uint8Array>, w: number, h: number, io: MediaValueIO): Promise<FramesValue> {
  checkBatch(0, w, h, io.hosted)
  await io.kept.checkRoom(runId)
  const work = await io.kept.workDir(runId)
  try {
    const out = join(work, 'frames.mkv')
    const counted = { n: 0 }
    const { count } = await writeFfv1({ frames: cappedFrames(frames, w, h, io.hosted, counted), w, h, out, outRoots: [work], userId: io.userId, signal: io.signal })
    const file = await io.kept.putPath(runId, out, 'mkv')
    return { kind: 'frames', file, count, w, h }
  }
  finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * save_to's sound cut (video_types.py:437): math.ceil((rate / frame_rate) ·
 * frames), `frame_rate` the stream rate it has just set,
 * Fraction(round(fps · 1000), 1000) (`pyStreamRate`).
 */
export function madeVideoSoundCut(rate: number, fps: number, frames: number): number {
  return soundCutAt(rate, pyStreamRate(fps), frames)
}

/** The same cut at a stream rate already set (R5.4: a file's average_rate, rounded by `pyStreamRateOf`). */
export function soundCutAt(rate: number, r: Rational, frames: number): number {
  const top = BigInt(rate) * BigInt(frames) * BigInt(r.den)
  const n = BigInt(r.num)
  const q = top / n
  return Number(top % n === 0n ? q : q + 1n)
}

/** save_to's layout by channel count ({1: 'mono', 2: 'stereo', 6: '5.1'}, else 'stereo'). */
function layoutOf(channels: number): SoundLayout {
  return channels === 1 ? 'mono' : channels === 6 ? '5.1' : 'stereo'
}

/**
 * The file of a video value: a file video is returned as it is; a made video
 * is encoded as VideoFromComponents.save_to writes it (H.264 at save_to's
 * libx264 default, its sound as AAC cut to the frames) into a temporary file
 * in the run's kept folder (`temporary`: the caller lets it go with
 * `dropVideoFile`). `metadata`: the tags as Python writes them (JSON text).
 */
export async function videoFileFor(v: RunnerValue, io: MediaValueIO, o: { metadata?: Record<string, string> } = {}): Promise<{ path: string; temporary: boolean }> {
  if (v.kind === 'files') {
    const file = v.files[0]
    if (!file) throw new MediaError('noVideo')
    // Known gap (R5.2 review Minor 3, parked in the ledger): the bytes are verified, then the tool reopens the path.
    return { path: await io.access.verifiedPath(file), temporary: false }
  }
  if (v.kind !== 'video') throw new MediaError('noVideo')
  return { path: await encodeMadeVideo(v, io, o.metadata), temporary: true }
}

async function encodeMadeVideo(v: VideoValue, io: MediaValueIO, metadata: Record<string, string> | undefined): Promise<string> {
  checkBatch(v.frames.count, v.frames.w, v.frames.h, io.hosted)
  const sound = v.sound ? await readSound({ kind: 'files', files: [v.sound.file], sound: v.sound.note }, '', io) : null
  return encodeVideoParts({ frames: v.frames, sound, rate: pyStreamRate(v.fps) }, io, metadata)
}

/**
 * VideoFromComponents.save_to over parts already in hand (R5.4: also Save
 * video's re-encode of a file, whose rate Python keeps as the exact
 * average_rate): the kept frames, the sound's samples (or none), and the
 * stream rate as save_to sets it. Into a temporary file in the run's kept
 * folder (`dropVideoFile` lets it go).
 */
export async function encodeVideoParts(parts: { frames: { file: OutputFile; count: number; w: number; h: number }; sound: DecodedSound | null; rate: Rational }, io: MediaValueIO, metadata: Record<string, string> | undefined): Promise<string> {
  const { file, count, w, h } = parts.frames
  checkBatch(count, w, h, io.hosted)
  const fps = parts.rate
  const sound = parts.sound
  // Known gap (R5.2 review Minor 3, parked in the ledger): the bytes are verified, then the tool reopens the path.
  const framesPath = await io.access.verifiedPath(file)
  await io.kept.checkRoom(io.runId)
  const work = await io.kept.workDir(io.runId)
  const out = join(work, 'video.mp4')
  try {
    await encodeVideo({
      input: { kind: 'ffv1', path: framesPath, w, h },
      out, fps, quality: PYAV_H264_DEFAULT,
      sound: sound
        ? { source: { sound }, layout: layoutOf(sound.channels.length), rate: sound.rate, cutSamples: soundCutAt(sound.rate, fps, count) }
        : null,
      ...(metadata ? { metadata } : {}),
      userId: io.userId, signal: io.signal,
      roots: [io.access.rootOf(file)], outRoots: [work],
    })
    return out
  }
  catch (e) {
    await rm(work, { recursive: true, force: true })
    throw e
  }
}

/** Lets go of a temporary video file from `videoFileFor` (and its folder); a file video is left alone. */
export async function dropVideoFile(r: { path: string; temporary: boolean }): Promise<void> {
  if (r.temporary) await rm(dirname(r.path), { recursive: true, force: true })
}

// ── a video file's parts (R5.4, Get video components) ────────────────────────

/**
 * A file video's header, as Get video components and Save video read it: the
 * person's file, inside its store folder, judged by the video caps before any
 * decode (MEDIA_WORDS: noVideo for a file with no picture, as Python's
 * "No video stream found").
 */
export async function probeVideoFile(file: OutputFile, io: SoundReadIO): Promise<MediaProbe> {
  // Known gap (R5.2 review Minor 3, parked in the ledger): the bytes are verified, then the tool reopens the path.
  const path = await io.access.verifiedPath(file)
  const p = await probeMedia(path, { userId: io.userId, signal: io.signal, roots: [io.access.rootOf(file)], kind: 'video', ...(file.type === 'kept' ? { kept: true as const } : {}) })
  const word = file.type === 'kept' ? (p.video.length ? null : 'noVideo') : mediaCapsWord(p, 'video', io.hosted)
  if (word) throw new MediaError(word)
  return p
}

/**
 * get_components' frames of a file (video_types.py:252-265), kept as one
 * FFV1 batch in ONE job: the first video stream decoded exactly as
 * `decodeFrames` reads it (every frame with pts ≥ 0, rgb24 by PyAV's own
 * conversion), re-stamped one frame per millisecond as `writeFfv1` keeps a
 * batch, and written by the tool straight into the run's work folder, never
 * through memory. The same frames also go, as rawvideo, into the null muxer,
 * whose `-stats_mux_pre` reports each frame's size as it passes: a frame of
 * another size fails at once (sizeChanged, Python's torch.stack), and the
 * batch caps are held as the frames stream (never more than one frame's
 * report in hand).
 *
 * `before` (R5.4 fix round 1): the step that must succeed for the batch to be
 * kept (the file's sound). It runs once the frames are written and before
 * they are kept: when it fails or is stopped, the frames are removed with
 * the work folder, and never count toward the run's kept total.
 */
export async function keepVideoFrames(p: MediaProbe, io: MediaValueIO, o: { before?: () => Promise<void> } = {}): Promise<FramesValue> {
  const kept = await keepDecodedFrames(p, io, o)
  // Python's get_components makes an empty batch here (zeros(0, 3, 0, 0)); a kept batch has at least one frame.
  if (!kept) throw new MediaError('noVideo')
  return kept
}

/**
 * Load video frames' batch (R5.5) at the file's own size, in the same ONE
 * job: of the decoder's frames (no pts rule: `container.decode`), the ones
 * `pick` chooses, the decode stopped once `pick.count` are out. Null when it
 * chooses none (a start past the end): nothing is kept, and the caller keeps
 * Python's 64 × 64 black frame instead.
 */
export async function keepPickedFrames(p: MediaProbe, io: MediaValueIO, pick: FramePick): Promise<FramesValue | null> {
  try { return await keepDecodedFrames(p, io, { pick }) }
  catch (e) {
    if (!(e instanceof FirstFrameSize)) throw e
    // The first frame picked isn't the header's size (a video whose size changes, R5.5): Python keeps
    // the frames at their own size (no resize is asked for), so the batch is kept at that frame's size,
    // and a frame of yet another size fails as torch.stack does.
    const size = await pickedFrameSize(p, io, pick.start)
    const v = p.video[0]!
    if (!size || (size.w === v.w && size.h === v.h)) throw new MediaError('sizeChanged')
    return keepDecodedFrames(p, io, { pick, size })
  }
}

/** keepDecodedFrames' first picked frame came out another size than the header's. */
class FirstFrameSize extends MediaError {
  constructor() { super('sizeChanged') }
}

/** The size of the decoder's frame number `n` (0, 1, 2… in the order it hands them over), or null. */
async function pickedFrameSize(p: MediaProbe, io: MediaValueIO, n: number): Promise<{ w: number; h: number } | null> {
  const j = await ffprobeJson(p.path, p.format, ['-select_streams', 'v:0', '-show_entries', 'frame=width,height', '-read_intervals', `%+#${n + 65}`], {
    userId: io.userId, signal: io.signal,
    // A decode up to the frame, not a header read: the job's own limit.
    timeoutMs: io.hosted ? MEDIA_JOB_TIMEOUT_MS.hosted : MEDIA_JOB_TIMEOUT_MS.local,
  })
  const frames = Array.isArray(j.frames) ? (j.frames as { width?: unknown; height?: unknown }[]) : []
  const f = frames[n]
  const w = Number(f?.width)
  const h = Number(f?.height)
  return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? { w, h } : null
}

async function keepDecodedFrames(p: MediaProbe, io: MediaValueIO, o: { before?: () => Promise<void>; pick?: FramePick; size?: { w: number; h: number } }): Promise<FramesValue | null> {
  const v = p.video[0]
  if (!v) throw new MediaError('noVideo')
  const { w, h } = o.size ?? v
  checkBatch(0, w, h, io.hosted)
  const caps = capsOf(io.hosted)
  const frameBytes = w * h * 3
  await io.kept.checkRoom(io.runId)
  const work = await io.kept.workDir(io.runId)
  try {
    const out = join(work, 'frames.mkv')
    let count = 0
    let text = ''
    // R5.5: the decode stops once the pick's frames are out (each output stops at its count).
    const frameLimit = o.pick ? ['-frames:v', String(o.pick.count)] : []
    // At the first picked frame's own size (R5.5, `size`): the kept branch converts to that size, so the
    // FFV1 is made at it (the graph was set up at the header's); the checked branch keeps each frame at its
    // own size, so a frame of yet another size still fails.
    const graph = o.size && o.pick
      ? `[0:v:0]${pickFilter(o.pick)},split=2[a][b];[a]${framesScale(v, o.size)},settb=expr=1/${FFV1_KEPT_RATE},setpts=N[k];[b]${framesScale(v)}[c]`
      : `[0:v:0]${framesFilter(v, o.pick)},settb=expr=1/${FFV1_KEPT_RATE},setpts=N,split=2[k][c]`
    const args = [
      '-copyts', '-reinit_filter', '0', '-noautorotate', ...inputArgs(p.path, p.format),
      '-filter_complex', graph,
      '-map', '[k]', '-fps_mode', 'passthrough', '-c:v', 'ffv1', '-threads:v', '1', '-pix_fmt', 'bgr0',
      ...frameLimit,
      '-map_metadata', '-1', '-fflags', '+bitexact', '-f', 'matroska', '-y', `file:${out}`,
      '-map', '[c]', '-fps_mode', 'passthrough', '-c:v', 'rawvideo', ...frameLimit,
      '-stats_mux_pre', 'pipe:3', '-stats_mux_pre_fmt', '{size}', '-f', 'null', 'pipe:1',
    ]
    await runMedia({
      tool: 'ffmpeg', args, userId: io.userId, signal: io.signal, workDir: work, cleanup: [out],
      onSide: (chunk) => {
        if (chunk === null) return
        text += Buffer.from(chunk).toString('latin1')
        let nl: number
        while ((nl = text.indexOf('\n')) >= 0) {
          const line = text.slice(0, nl).trim()
          text = text.slice(nl + 1)
          if (!line) continue
          if (!/^\d+$/.test(line)) throw new MediaError('failed')
          if (Number(line) !== frameBytes) throw o.pick && !o.size && count === 0 ? new FirstFrameSize() : new MediaError('sizeChanged')
          const word = batchWord(count + 1, w, h, caps)
          if (word) throw new MediaError(word)
          count++
        }
      },
    })
    if (text.trim()) throw new MediaError('failed')
    if (count === 0) return null
    if (o.before) await o.before()
    if (io.signal?.aborted) throw new MediaError('stopped')
    const file = await io.kept.putPath(io.runId, out, 'mkv')
    return { kind: 'frames', file, count, w, h }
  }
  finally {
    await rm(work, { recursive: true, force: true })
  }
}

/**
 * get_components' sound of a file (video_types.py:269-307): the last sound
 * stream, `fltp`, with Python's seek and skip rule (decodeAudio 'fltp'),
 * judged by the video caps the file came in under; null where Python's is
 * None (no sound stream, or no samples from t = 0).
 */
export async function videoSoundOf(p: MediaProbe, file: OutputFile, io: SoundReadIO): Promise<DecodedSound | null> {
  if (!p.sound.length) return null
  const s = await decodeAudio(p.path, {
    decoder: 'fltp', userId: io.userId, signal: io.signal, maxSamples: capsOf(io.hosted).soundSamples,
    roots: [io.access.rootOf(file)], probe: p, within: 'video',
  })
  return (s.channels[0]?.length ?? 0) > 0 ? s : null
}

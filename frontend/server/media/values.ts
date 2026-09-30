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
import { MEDIA_CAPS, type MediaCaps } from '#shared/runner/media'
import type { FileAccess } from '../runner/fileAccess'
import type { KeptBytes } from '../runner/keptBytes'
import type { OutputFile, RunnerValue, SoundNote } from '../runner/types'
import { decodeAudio, decodeFrames, type DecodedSound, type SoundDecoder } from './decode'
import { PYAV_H264_DEFAULT, encodeVideo, floatWav, pyStreamRate, writeFfv1, type SoundLayout } from './encode'
import { MediaError } from './run'

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
function batchWord(count: number, w: number, h: number, caps: Readonly<MediaCaps>): 'tooBig' | 'tooManyFrames' | null {
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
  const r = pyStreamRate(fps)
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
  const { file, count, w, h } = v.frames
  checkBatch(count, w, h, io.hosted)
  const fps = pyStreamRate(v.fps)
  const sound = v.sound ? await readSound({ kind: 'files', files: [v.sound.file], sound: v.sound.note }, '', io) : null
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
        ? { source: { sound }, layout: layoutOf(sound.channels.length), rate: sound.rate, cutSamples: madeVideoSoundCut(sound.rate, v.fps, count) }
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

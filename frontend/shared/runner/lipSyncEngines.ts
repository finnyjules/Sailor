/**
 * Lip-sync a character's other two engines in the runner (step 3, R11.3,
 * family `sound-in`): VEED Fabric 1.0 (a talking head from a face picture)
 * and Kling's lip-sync (a face video re-lipped), both on Replicate, as
 * LipSyncNode.execute (comfy_api_nodes/nodes_replicate.py :4925) calls them:
 *
 *   opts = json.loads(model_options or "{}")   (not a dict → {})
 *   face_image = <wired picture> or _resolve(opts["face_image"])
 *   video_src, audio_src = opts["face_video"], opts["audio"]
 *   resolution, sync_mode, engine = opts.get(…, <widget>)
 *   eng = _lipsync_resolve_engine(engine, bool(face_image), bool(video_src))
 *       "fabric" / "sync" win; else a video → "sync", otherwise "fabric"
 *   _lipsync_build_input(eng, …):
 *       no sound            → raise "Lip-sync requires an audio clip."
 *       "sync" (Kling)      → kwaivgi/kling-lip-sync {video_url, audio_file}
 *                             (no video → raise); both hosted to fal storage
 *       otherwise (Fabric)  → veed/fabric-1.0 {image, audio, resolution}
 *                             (no picture → raise)
 *   A wired sound is Python's 16-bit WAV of its first 60 s.
 *
 * What the runner reads before the run, and so what it takes (the rest stays
 * with the engine until R11.8/R11.9, named in R11.3's report):
 *   - Fabric: the sound wired from an Audio card, or a `/view` upload (its
 *     length is the price); the face a `/view` upload or an https address;
 *   - Kling: the face video a `/view` upload (its length is the price); the
 *     sound wired, a `/view` upload or an https address.
 * A blank picture, video or sound is taken and refused before the hold, in
 * plain words (Python raises before its call).
 *
 * Pure; relative imports only.
 */
import { isLink } from './graph'
import { pyTruthy } from './pyText'
import { SYNC_3_ENGINE, lipSyncEngine, lipSyncOptions } from './lipSync'
import { readViewRef } from '../pricing/clipSettings'

export { FABRIC_LIPSYNC_RESOLUTIONS, fabricLipSyncResolution } from './lipSync'

export const FABRIC_LIPSYNC_SLUG = 'veed/fabric-1.0'
export const KLING_LIPSYNC_SLUG = 'kwaivgi/kling-lip-sync'

/** The engine a LipSyncNode runs, as the runner names it (Python's "sync" is Kling's lip-sync). */
export type LipSyncRunEngine = typeof SYNC_3_ENGINE | 'fabric' | 'kling'

/**
 * `_lipsync_resolve_engine` over the engine LipSyncNode.execute reads, plus
 * the runner's own sync-3. Null where it can't be known before the run: a
 * wired or unreadable `model_options`, or a wired engine the options don't override.
 */
export function lipSyncRunEngine(inputs: Record<string, unknown>): LipSyncRunEngine | null {
  const opts = lipSyncOptions(inputs.model_options)
  if (opts === null) return null
  const engine = lipSyncEngine(inputs)
  if (isLink(engine)) return null
  if (engine === SYNC_3_ENGINE) return SYNC_3_ENGINE
  if (engine === 'fabric') return 'fabric'
  if (engine === 'sync') return 'kling'
  return pyTruthy(opts.face_video) ? 'kling' : 'fabric'
}

/** One of the node's media, as the runner reads it before the run. */
export type LipSyncMediaRef =
  | { blank: true }
  | { wired: [string, number] }
  | { upload: string }
  | { https: string }
  /** Anything else (a data: link, http, a link Python's parser refuses): left to the engine. */
  | { other: true }

/** A `model_options` media value: blank (Python's falsy), a `/view` upload, an https address, or other. */
export function lipSyncMediaRef(v: unknown): LipSyncMediaRef {
  if (!pyTruthy(v)) return { blank: true }
  if (typeof v !== 'string') return { other: true }
  const r = readViewRef(v)
  if (r) return r.name && !r.refused ? { upload: r.name } : { other: true }
  return /^https:\/\//i.test(v) ? { https: v } : { other: true }
}

export interface LipSyncEngineMedia {
  /** Fabric's face picture (a wired picture is left to the engine: the row refuses the link). */
  image: LipSyncMediaRef
  /** Kling's face video. */
  video: LipSyncMediaRef
  /** The sound: the wired Audio card wins, as `execute` reads a wired `audio` first. */
  audio: LipSyncMediaRef
}

/** The node's media as Fabric and Kling read them (`model_options` unreadable: all blank). */
export function lipSyncEngineMedia(inputs: Record<string, unknown>): LipSyncEngineMedia {
  const opts = lipSyncOptions(inputs.model_options) ?? {}
  const audio: LipSyncMediaRef = isLink(inputs.audio) ? { wired: [String(inputs.audio[0]), Number(inputs.audio[1])] } : lipSyncMediaRef(opts.audio)
  return { image: lipSyncMediaRef(opts.face_image), video: lipSyncMediaRef(opts.face_video), audio }
}

/**
 * Whether the runner takes a Fabric or Kling node (the row's input check):
 * every medium it sends is one it can read, size or send as typed. Sync-3
 * and an unknown engine aren't judged here.
 */
export function lipSyncEngineMediaTaken(inputs: Record<string, unknown>): boolean {
  const engine = lipSyncRunEngine(inputs)
  if (engine !== 'fabric' && engine !== 'kling') return true
  const m = lipSyncEngineMedia(inputs)
  // R11.9a fix round 1 (ruling 5): a sound (Fabric) or face video (Kling) at an https address is held at its
  // cap (ruling (k): Fabric 60 s, Kling 10 s); a data: link or another odd address is refused plainly.
  if (engine === 'fabric') return !('other' in m.image) && !('other' in m.audio)
  return !('other' in m.video) && !('other' in m.audio)
}

/** Kling's lip-sync takes face videos up to 10 s (its schema): an unmeasured one (an https address) is held there. */
export const KLING_LIPSYNC_MAX_VIDEO_SECONDS = 10

/**
 * R11.9a (R11.3's named stop-gaps 1–3): what a Fabric or Kling node sends
 * that isn't a file in Sailor (a web address, a data: link), or null: the
 * words of its plain refusal, before the hold.
 */
export function lipSyncEngineMediaWords(inputs: Record<string, unknown>): string | null {
  const engine = lipSyncRunEngine(inputs)
  if (engine !== 'fabric' && engine !== 'kling') return null
  const m = lipSyncEngineMedia(inputs)
  if (engine === 'fabric' && 'other' in m.image) return LIPSYNC_UPLOAD_FACE
  if (engine === 'kling' && 'other' in m.video) return LIPSYNC_UPLOAD_VIDEO
  if ('other' in m.audio) return LIPSYNC_UPLOAD_SOUND
  return null
}

// ── Words (sentence case, no names of fields) ──

/** R11.9a: a medium given as a data: link, http or another odd address (not https, not a Sailor file). */
export const LIPSYNC_UPLOAD_SOUND = 'This lip-sync’s sound isn’t a Sailor file or an https address. Upload the sound to Sailor.'
export const LIPSYNC_UPLOAD_FACE = 'This lip-sync’s face picture isn’t a Sailor file or an https address. Upload the picture to Sailor.'
export const LIPSYNC_UPLOAD_VIDEO = 'This lip-sync’s face video isn’t a Sailor file or an https address. Upload the video to Sailor.'

/** Python's three raises, before its call (refused here before the hold). */
export const LIPSYNC_NEEDS_SOUND = 'This lip-sync has no sound. Add a voice, or link an Audio card.'
export const FABRIC_LIPSYNC_NEEDS_FACE = 'Fabric needs a picture of the face. Upload a picture as the face.'
export const KLING_LIPSYNC_NEEDS_VIDEO = 'Lip-syncing a video needs a video of the face. Upload a video as the face.'
export const LIPSYNC_ENGINE_TOO_LONG = 'Lip-syncs here are up to 60 seconds. Use a shorter sound or video.'
export const LIPSYNC_ENGINE_FILE_MISSING = 'A file this lip-sync needs is missing. Upload it again.'
export const LIPSYNC_ENGINE_CHANGED = 'The sound or face video changed after you pressed Run. Run it again.'
/** kwaivgi/kling-lip-sync's schema: "Must be .mp3, .wav, .m4a, or .aac and less than 5MB". */
export const KLING_LIPSYNC_MAX_SOUND_BYTES = 5_000_000
export const KLING_LIPSYNC_SOUND_TOO_LARGE = 'Kling’s lip-sync takes sounds up to 5 MB. Use a shorter sound.'
/**
 * Fix round 1: a wired sound whose size can't be bounded before the run (Kling's 5 MB can't be judged).
 * R11.8: a run-made sound from music, speech or a cloned voice is bounded by its maker
 * (#shared/runner/sourceBounds) and taken; only a sound no maker bounds is refused with these words.
 */
export const KLING_LIPSYNC_SOUND_UNSIZED = 'Kling’s lip-sync takes sounds up to 5 MB, and Sailor can’t tell this sound’s size before the run. Load the sound from a file, or upload it as the voice.'

/** Python's WAV header (`_audio_dict_to_wav_data_url`: a plain 44-byte RIFF header; PyAV adds a LIST chunk, under 64 bytes). */
const WAV_HEADER_BOUND = 128

/**
 * Fix round 1: the most bytes Python's WAV of a sound can take, from its
 * shape (rate, channels, samples; `exact` false = a header's figure, a
 * second of slack added): its first 60 s, 16-bit, mono or stereo.
 */
export function pythonWavBytesBound(shape: { rate: number, channels: number, samples: number, exact: boolean }): number {
  const samples = shape.samples + (shape.exact ? 0 : shape.rate)
  const frames = Math.min(samples, Math.floor(60 * shape.rate))
  return WAV_HEADER_BOUND + frames * Math.min(Math.max(shape.channels, 1), 2) * 2
}

/** What stops a Fabric or Kling node before anything is read or held (Python's raises), or null. */
export function lipSyncEngineProblem(inputs: Record<string, unknown>): { input: string, message: string } | null {
  const engine = lipSyncRunEngine(inputs)
  if (engine !== 'fabric' && engine !== 'kling') return null
  const m = lipSyncEngineMedia(inputs)
  if ('blank' in m.audio) return { input: 'model_options', message: LIPSYNC_NEEDS_SOUND }
  if (engine === 'kling' && 'blank' in m.video) return { input: 'model_options', message: KLING_LIPSYNC_NEEDS_VIDEO }
  if (engine === 'fabric' && 'blank' in m.image) return { input: 'model_options', message: FABRIC_LIPSYNC_NEEDS_FACE }
  return null
}

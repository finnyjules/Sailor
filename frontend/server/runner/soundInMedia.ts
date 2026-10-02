/**
 * The sound a sound-in node sends (step 3, R3.10, family `sound-in`), read
 * and measured before anything is held, as the other media nodes' files are
 * (./nodeMedia.ts): its price is the seconds of sound it sends (at most 60).
 *   - the start of a run (engine.ts startRun), before the hold: a sound the
 *     prompt alone names (a Load audio or Record audio file, an Audio card's
 *     own file, through Audio cards) is decoded as Python's AUDIO holds it
 *     and made into Python's WAV (./soundWav.ts); its seconds and the WAV's
 *     sha256 are recorded, and the hold is its price. A sound made in the
 *     run is not known yet: nothing is recorded, and the hold is the 60 s
 *     ceiling.
 *   - the node's own turn (engine.ts execNode), before the hand-off: the WAV
 *     is made from what the wire brought (`reads.soundWav`, made once for the
 *     turn, and the very WAV the plan sends), and must be the one recorded;
 *     its seconds are what the node is charged.
 * Sync lips' video address is judged here too, with the same words as the
 * plan: blank refused; hosted, only an https address or a `/view` link to an
 * upload (ruling (r)), whose owner the start of the run judged by its name.
 */
import { isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import {
  LIPSYNC_SILENCE_NEEDS_UPLOAD, LIPSYNC_SILENCE_TOO_LONG, LIPSYNC_NEEDS_VIDEO, LIPSYNC_VIDEO_ADDRESS, LIPSYNC_VIDEO_MISSING, SOUND_IN_CHANNELS, SOUND_IN_EMPTY, SOUND_IN_NEEDS_SOUND, isLipsync2ProClass, lipsyncVideoOf,
} from '#shared/runner/soundIn'
import { MEDIA_WORDS } from '#shared/runner/media'
import { MediaError } from '../media/run'
import { probeVideoFile, type SoundReadIO } from '../media/values'
import { SOUND_FILE_MISSING } from './media/soundNodes'
import { sha256Hex } from './handoff'
import { parseInputFileRef } from './inputs'
import { isPieced, silenceWav, silentCardAt, soundFileBeforeRun, vocalsSilence, whisperSilenceWav, type PythonWav } from './soundWav'
import { VOCALS_CLASS, WHISPER_CLASS } from '#shared/runner/localModels'
import { measureMediaFile, type MediaReads, type MediaRule } from './mediaInputs'
import { LIPSYNC_MAX_SECONDS } from '#shared/pricing/clipSettings'
import type { MeasuredMedia, OutputFile } from './types'

export interface SoundInReads {
  /** Hosted: an address that isn't https or an upload is refused. */
  strict: boolean
  /** At the node's turn: the WAV of what the wire brought (made once for the turn). */
  soundWav?(link: ApiLink): Promise<PythonWav>
  /** At the start of a run: the WAV of a file the prompt names. Absent: nothing measured (held at the ceiling). */
  soundFileWav?(file: OutputFile): Promise<PythonWav>
  /**
   * Hosted (fix round 1, Minor 5): Sync lips' uploaded video judged against
   * the media module's video caps from its header, at the start and again at
   * the node's turn; the plain words of its refusal, or null. A file that is
   * gone refuses as LIPSYNC_VIDEO_MISSING. Absent: not judged.
   */
  videoUploadProblem?(file: OutputFile): Promise<string | null>
}

/** Words a person can read for a failed read: the media module's and this node's own, never the file system's. */
export function soundInWords(e: unknown): string {
  if (e instanceof MediaError) return e.message
  if (e instanceof Error && SOUND_IN_WORDS.has(e.message)) return e.message
  return MEDIA_WORDS.unreadable
}

const SOUND_IN_WORDS: ReadonlySet<string> = new Set([SOUND_IN_NEEDS_SOUND, SOUND_IN_EMPTY, SOUND_IN_CHANNELS, SOUND_FILE_MISSING])

/** What was measured of a WAV: its seconds and its sha256. */
export function measuredWav(w: PythonWav): MeasuredMedia {
  // R11.5: a sound in pieces is measured by its converted file (read once as it streamed).
  return { seconds: { audio: w.seconds }, sha: { audio: isPieced(w) ? w.pieces.sha : sha256Hex(w.wav) } }
}

/** The Audio card's second of silence as this class sends (and measures) it. */
export function cardSilenceFor(classType: string): PythonWav {
  if (classType === WHISPER_CLASS) return whisperSilenceWav()
  if (classType === VOCALS_CLASS) return vocalsSilence()
  return silenceWav()
}

/** The node's video address judged (Sync lips only), or null. */
function videoProblem(classType: string, inputs: Record<string, unknown>, strict: boolean): string | null {
  if (!isLipsync2ProClass(classType)) return null
  const s = lipsyncVideoOf(inputs.video_url)
  if ('blank' in s) return LIPSYNC_NEEDS_VIDEO
  if ('refused' in s) return s.refused
  if (strict && 'other' in s) return LIPSYNC_VIDEO_ADDRESS
  return null
}

/** The node's sound (and Sync lips' address), judged: a refusal, what was measured, or null (nothing to measure yet). */
export async function soundInMediaCheck(prompt: ApiPrompt, nodeId: string, reads: SoundInReads & Partial<MediaReads>): Promise<{ problem: string } | { problem: null, measured: MeasuredMedia } | null> {
  const node = prompt[nodeId]
  if (!node) return null
  const inputs = node.inputs ?? {}
  const bad = videoProblem(node.class_type, inputs, reads.strict)
  if (bad) return { problem: bad }
  if (reads.strict && isLipsync2ProClass(node.class_type) && reads.videoUploadProblem) {
    const s = lipsyncVideoOf(inputs.video_url)
    if ('upload' in s) {
      const why = await reads.videoUploadProblem({ filename: s.upload, subfolder: '', type: 'input' }).catch(() => LIPSYNC_VIDEO_MISSING)
      if (why) return { problem: why }
    }
  }
  const link = inputs.audio
  if (!isLink(link)) return { problem: SOUND_IN_NEEDS_SOUND }
  const sound = await wiredSoundCheck(prompt, link, node.class_type, reads)
  // R11.3, ruling (o): Sync lips in "silence" makes the whole face video, so its length is measured too.
  if (isLipsync2ProClass(node.class_type) && inputs.sync_mode === 'silence') {
    if (sound && sound.problem !== null) return sound
    const video = await silenceVideoCheck(inputs, reads)
    if ('problem' in video) return { problem: video.problem }
    // A sound made in the run (not known yet): only the video's bound is recorded, so the hold is
    // the 60 s sound ceiling against it, and the node's turn measures both.
    if (!sound) return { problem: null, measured: { seconds: { videoUpTo: video.seconds }, sha: {} } }
    return { problem: null, measured: { seconds: { ...sound.measured.seconds, video: video.seconds }, sha: { ...sound.measured.sha, video: video.sha } } }
  }
  return sound
}

/**
 * A wired sound, as a sound-in node sends it (also Lip-sync a character's
 * Fabric, R11.3): at the node's turn the WAV the wire brought; before the run
 * an Audio card's 1 s of silence, or the WAV of a file the prompt names; null
 * when it is made in the run (not known yet).
 */
export async function wiredSoundCheck(prompt: ApiPrompt, link: ApiLink, classType: string, reads: Omit<SoundInReads, 'strict'>): Promise<{ problem: string } | { problem: null, measured: MeasuredMedia } | null> {
  try {
    if (reads.soundWav) return { problem: null, measured: measuredWav(await reads.soundWav(link)) }
    // An Audio card's 1 s of silence (fix round 1, Important): known before the run, priced at 1 s
    // (R7.7: Whisper transcribe's own 16 kHz WAV of it; R7.8: Vocal separator's stereo silence).
    if (silentCardAt(prompt, link)) return { problem: null, measured: measuredWav(cardSilenceFor(classType)) }
    const file = soundFileBeforeRun(prompt, link, parseInputFileRef)
    if (!file || !reads.soundFileWav) return null
    return { problem: null, measured: measuredWav(await reads.soundFileWav(file)) }
  }
  catch (e) {
    return { problem: soundInWords(e) }
  }
}

/** The face video Sync lips sends in "silence" (an upload): its formats, size, and a length that must be read. */
export const LIPSYNC_SILENCE_VIDEO_RULE: MediaRule = {
  kind: 'video',
  formats: ['mp4', 'mov', 'webm'],
  maxBytes: 100_000_000,
  words: {
    tooLarge: 'Sync lips takes face videos up to 100 MB. Make this one smaller first.',
    wrongFormat: 'Sync lips takes MP4, MOV or WebM face videos.',
    unmeasured: 'Sailor can’t read how long this face video is, so it can’t price silence mode. Try an MP4 video.',
  },
}

/** Sync lips' uploaded face video in "silence", read and measured (always strictly: its length is the price). */
async function silenceVideoCheck(inputs: Record<string, unknown>, reads: Omit<SoundInReads, 'strict'> & Partial<MediaReads>): Promise<{ problem: string } | { seconds: number, sha: string }> {
  const s = lipsyncVideoOf(inputs.video_url)
  if (!('upload' in s) || !reads.read) return { problem: LIPSYNC_SILENCE_NEEDS_UPLOAD }
  const file: OutputFile = { filename: s.upload, subfolder: '', type: 'input' }
  const m = await measureMediaFile(file, LIPSYNC_SILENCE_VIDEO_RULE, { read: reads.read, ...(reads.size ? { size: reads.size } : {}), strict: true }, LIPSYNC_VIDEO_MISSING)
  if (m.problem !== null) return { problem: m.problem }
  const seconds = m.facts.seconds
  if (seconds == null) return { problem: LIPSYNC_SILENCE_VIDEO_RULE.words.unmeasured }
  if (Math.round(seconds * 1e6) / 1e6 > LIPSYNC_MAX_SECONDS) return { problem: LIPSYNC_SILENCE_TOO_LONG }
  return { seconds, sha: m.sha }
}

/** The input files a sound-in node would send (for the ownership check at the start of a run): the sound's file, Sync lips' upload. */
export function soundInInputFiles(prompt: ApiPrompt, nodeId: string): OutputFile[] {
  const node = prompt[nodeId]
  if (!node) return []
  const inputs = node.inputs ?? {}
  const out: OutputFile[] = []
  if (isLink(inputs.audio)) {
    const f = soundFileBeforeRun(prompt, inputs.audio, parseInputFileRef)
    if (f) out.push(f)
  }
  if (isLipsync2ProClass(node.class_type)) {
    const s = lipsyncVideoOf(inputs.video_url)
    if ('upload' in s) out.push({ filename: s.upload, subfolder: '', type: 'input' })
  }
  return out
}

/**
 * Sync lips' uploaded video in hosted (fix round 1, Minor 5): gone → plain
 * words; else its header judged by the media module's video caps (size,
 * pixels, length; a file with no picture), as the video nodes judge theirs.
 */
export async function lipsyncUploadProblem(file: OutputFile, io: SoundReadIO): Promise<string | null> {
  if (!(await io.access.exists(file))) return LIPSYNC_VIDEO_MISSING
  try {
    await probeVideoFile(file, io)
    return null
  }
  catch (e) {
    return e instanceof MediaError ? e.message : MEDIA_WORDS.unreadable
  }
}

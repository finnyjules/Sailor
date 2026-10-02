/**
 * Lip-sync a character on Fabric or Kling (step 3, R11.3, family
 * `sound-in`): the media the price reads, read and measured before anything
 * is held (the start of a run) and again at the node's turn, as sync-3's are
 * (./sync3Media.ts):
 *   - Fabric bills the clip it makes, the sound's length: a wired sound is
 *     Python's WAV of its first 60 s (./soundInMedia.ts wiredSoundCheck); an
 *     uploaded sound is measured from its file and refused over 60 s (Fabric's
 *     longest clip, the price's cap);
 *   - Kling bills the clip it makes, the face video's length: an uploaded
 *     video, refused over 60 s. Its sound isn't priced; one over the
 *     schema's 5 MB is refused here, before the hold (an upload by its size;
 *     a wired sound by the bound of the WAV sent, fix round 1).
 * A file whose length can't be read is priced at the 60 s cap locally and
 * refused in hosted (`strict`, the media rule's words).
 */
import { isLink, type ApiLink, type ApiPrompt } from '#shared/runner/graph'
import { LIPSYNC_MAX_SECONDS, type InputSeconds } from '#shared/pricing/clipSettings'
import { mediaInfoOfBytes } from '../utils/graphInputSeconds'
import {
  KLING_LIPSYNC_MAX_SOUND_BYTES, KLING_LIPSYNC_MAX_VIDEO_SECONDS, KLING_LIPSYNC_SOUND_TOO_LARGE, KLING_LIPSYNC_SOUND_UNSIZED, LIPSYNC_ENGINE_FILE_MISSING, LIPSYNC_ENGINE_TOO_LONG,
  lipSyncEngineMedia, lipSyncEngineProblem, lipSyncRunEngine, pythonWavBytesBound, type LipSyncMediaRef,
} from '#shared/runner/lipSyncEngines'
import { measureMediaFile, type MediaRule } from './mediaInputs'
import { soundInWords, wiredSoundCheck } from './soundInMedia'
import type { SoundShape } from './video/table'
import { soundFileBeforeRun } from './soundWav'
import { parseInputFileRef } from './inputs'
import type { NodeMediaCheck, NodeMediaReads } from './nodeMedia'
import type { OutputFile } from './types'

export const LIPSYNC_ENGINE_SOUND_RULE: MediaRule = {
  kind: 'audio',
  formats: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'mp4', 'aac'],
  maxBytes: 50_000_000,
  words: {
    tooLarge: 'Lip-sync takes sounds up to 50 MB. Make this one smaller first.',
    wrongFormat: 'Lip-sync takes sounds as WAV, MP3, Ogg, FLAC, M4A, MP4 or AAC files. Save this one as one of those first.',
    unmeasured: 'Sailor can’t read how long this sound is, so it can’t price the lip-sync. Try a WAV or MP3 file.',
  },
}

/** kwaivgi/kling-lip-sync's schema: "an .mp4 or .mov file, … less than 100MB". */
export const KLING_LIPSYNC_VIDEO_RULE: MediaRule = {
  kind: 'video',
  formats: ['mp4', 'mov'],
  maxBytes: 100_000_000,
  words: {
    tooLarge: 'Kling’s lip-sync takes face videos up to 100 MB. Make this one smaller first.',
    wrongFormat: 'Kling’s lip-sync takes MP4 or MOV face videos.',
    unmeasured: 'Sailor can’t read how long this face video is, so it can’t price the lip-sync. Try an MP4 video.',
  },
}

const inputFile = (name: string): OutputFile => ({ filename: name, subfolder: '', type: 'input' })
const over = (s: number | null) => s != null && Math.round(s * 1e6) / 1e6 > LIPSYNC_MAX_SECONDS

/** A Fabric or Kling node's media judged: a refusal, what was measured, or null (nothing to measure yet). */
export async function lipSyncEngineMediaCheck(prompt: ApiPrompt, nodeId: string, reads: NodeMediaReads): Promise<NodeMediaCheck | null> {
  const node = prompt[nodeId]
  if (!node) return null
  const inputs = node.inputs ?? {}
  const engine = lipSyncRunEngine(inputs)
  if (engine !== 'fabric' && engine !== 'kling') return null
  const bad = lipSyncEngineProblem(inputs)
  if (bad) return { problem: bad.message }
  const m = lipSyncEngineMedia(inputs)
  if (engine === 'fabric') {
    if ('wired' in m.audio) return wiredSoundCheck(prompt, m.audio.wired as ApiLink, node.class_type, reads)
    // R11.9a fix round 1 (ruling 5, ruling (k)): a sound at an https address can't be measured before the run: held at
    // Fabric's 60 s cap (the price's own "not measured", billedSeconds).
    if ('https' in m.audio) return { problem: null, measured: { seconds: { audioUpTo: LIPSYNC_MAX_SECONDS }, sha: {} } }
    if (!('upload' in m.audio)) return null
    const a = await measureMediaFile(inputFile(m.audio.upload), LIPSYNC_ENGINE_SOUND_RULE, reads, LIPSYNC_ENGINE_FILE_MISSING)
    if (a.problem !== null) return { problem: a.problem }
    if (over(a.facts.seconds)) return { problem: LIPSYNC_ENGINE_TOO_LONG }
    return { problem: null, measured: { seconds: a.facts.seconds != null ? { audio: a.facts.seconds } : {}, sha: { audio: a.sha } } }
  }
  // Fix round 1: a wired sound goes as Python's WAV, judged against Kling's 5 MB before the hold: at the
  // start of the run, bounded from its source's shape (a header, or a card's known silence); at the node's
  // turn, the WAV itself. One that can't be bounded is refused plainly (Python would fail at Replicate).
  if ('wired' in m.audio) {
    const link = m.audio.wired as ApiLink
    if (reads.soundWav) {
      let bytes: number
      try { bytes = (await reads.soundWav(link)).wav.byteLength }
      catch (e) { return { problem: soundInWords(e) } }
      if (bytes > KLING_LIPSYNC_MAX_SOUND_BYTES) return { problem: KLING_LIPSYNC_SOUND_TOO_LARGE }
    }
    else if (reads.soundShape) {
      let shape: SoundShape | null
      try { shape = await reads.soundShape(link) }
      catch (e) { return { problem: soundInWords(e) } }
      if (!shape || !(shape.rate > 0)) return { problem: KLING_LIPSYNC_SOUND_UNSIZED }
      // R11.8: a paid maker's sound (music, speech, a cloned voice) is bounded from its settings (`upTo`). Fix round 1
      // (I3): judged on that bound before the hold, so a maker is never charged and its sound then refused here; past
      // 5 MB it is refused as before the task, in the same words (its real size isn't known before the run).
      if (pythonWavBytesBound(shape) > KLING_LIPSYNC_MAX_SOUND_BYTES) return { problem: shape.upTo ? KLING_LIPSYNC_SOUND_UNSIZED : KLING_LIPSYNC_SOUND_TOO_LARGE }
    }
  }
  if ('upload' in m.audio && reads.size) {
    const bytes = await reads.size(inputFile(m.audio.upload)).catch(() => null)
    if (bytes != null && bytes > KLING_LIPSYNC_MAX_SOUND_BYTES) return { problem: KLING_LIPSYNC_SOUND_TOO_LARGE }
  }
  // R11.9a fix round 1 (ruling 5, ruling (k)): a face video at an https address is held at Kling's 10 s (its schema's longest).
  if ('https' in m.video) return { problem: null, measured: { seconds: { videoUpTo: KLING_LIPSYNC_MAX_VIDEO_SECONDS }, sha: {} } }
  if (!('upload' in m.video)) return null
  const v = await measureMediaFile(inputFile(m.video.upload), KLING_LIPSYNC_VIDEO_RULE, reads, LIPSYNC_ENGINE_FILE_MISSING)
  if (v.problem !== null) return { problem: v.problem }
  if (over(v.facts.seconds)) return { problem: LIPSYNC_ENGINE_TOO_LONG }
  return { problem: null, measured: { seconds: v.facts.seconds != null ? { video: v.facts.seconds } : {}, sha: { video: v.sha } } }
}

/** The input files a Fabric or Kling node would send (for the ownership check at the start of a run). */
export function lipSyncEngineInputFiles(prompt: ApiPrompt, nodeId: string): OutputFile[] {
  const inputs = prompt[nodeId]?.inputs ?? {}
  const m = lipSyncEngineMedia(inputs)
  const out: OutputFile[] = []
  const add = (r: LipSyncMediaRef) => { if ('upload' in r) out.push(inputFile(r.upload)) }
  add(m.image)
  add(m.video)
  add(m.audio)
  if (isLink(inputs.audio)) {
    const f = soundFileBeforeRun(prompt, inputs.audio as ApiLink, parseInputFileRef)
    if (f) out.push(f)
  }
  return out
}

/**
 * R11.9a fix round 1 (ruling (k)): a lip-sync held at its cap because its
 * medium is at an https address (never measured before the run) is charged on
 * the clip it delivers, never above the hold. The figure the delivered clip's
 * length stands for: Fabric's sound (its video runs the sound's length) or
 * Kling's face video (its answer is that video, lip-synced); null for
 * anything else (charged as held).
 */
export function httpsHeldBasis(classType: string, inputs: Record<string, unknown>, seconds: InputSeconds | undefined): 'audio' | 'video' | null {
  if (!seconds || classType !== 'LipSyncNode') return null
  const engine = lipSyncRunEngine(inputs)
  const m = lipSyncEngineMedia(inputs)
  if (engine === 'fabric' && 'https' in m.audio && seconds.audio == null && seconds.audioUpTo != null) return 'audio'
  if (engine === 'kling' && 'https' in m.video && seconds.video == null && seconds.videoUpTo != null) return 'video'
  return null
}

/** The seconds a delivered clip runs (its video track, read from its bytes), or null when it can't be read. */
export async function deliveredClipSeconds(bytes: Uint8Array): Promise<number | null> {
  const info = await mediaInfoOfBytes(bytes, 'video').catch(() => null)
  return info && Number.isFinite(info.seconds) && info.seconds > 0 ? info.seconds : null
}

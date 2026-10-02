/**
 * sync-3's face video and sound, read and measured before anything is sent
 * or charged (model line-up F22). Two places ask, with the same rules:
 *   - the start of a run (engine.ts startRun), before the hold: a file sync-3
 *     can't take refuses the run in plain words, nothing held;
 *   - the node's own turn (engine.ts execNode), before the hand-off: the
 *     files are read again, the node fails plainly if one no longer fits
 *     (its hold is released), and the lengths measured here are what the
 *     node is charged (shared/pricing/clipSettings.ts: the sound's length,
 *     or the shorter of sound and video for cut off, whole seconds).
 *
 * The limits (the saved schema states none; sync.so's own documents, read
 * 2026-09-25: sync.so/docs/compatibility-and-tips/media-formats-support.md
 * and developer-guides/sync-mode.md):
 *   - video: MP4, MOV or WebM (both sync.so's list and fal's upload list),
 *     up to 4096 × 2160 ("Videos above 4096×2160 are rejected"; either way
 *     round), up to 100 MB (a Sailor limit: a minute of 4K at 10 Mbps);
 *   - sound: WAV, MP3, Ogg, FLAC, M4A, MP4 or AAC, up to 50 MB (a Sailor
 *     limit). An MP4-container recording (Safari's, any ftyp brand) counts
 *     when it has a sound track: sync.so lists "audio/mp4 .mp4 MP4 Audio"
 *     and fal's upload list M4A (F22 fix round 1). WebM/Opus sound is on
 *     neither list, so it is refused, naming the formats taken;
 *   - the clip made: 60 s at most (the node's own cap, LIPSYNC_MAX_SECONDS,
 *     which the hold and the badge's "up to" price), from the measured
 *     lengths and the sync mode.
 * `strict` (hosted): a file whose length can't be measured is refused, since
 * its price can't be read. Otherwise it runs, priced at the 60 s cap.
 */
import type { ApiLink, ApiPrompt } from '#shared/runner/graph'
import { LIPSYNC_MAX_SECONDS, type InputSeconds } from '#shared/pricing/clipSettings'
import { lipSyncSyncMode, sync3OutputSeconds } from '#shared/runner/lipSync'
import { measureMediaFile, type MediaReads, type MediaRule } from './mediaInputs'
import { SYNC_3_NEEDS_SOUND, SYNC_3_NEEDS_VIDEO, sync3Sources, type Sync3Source } from './generators/sync3'
import { wiredSoundCheck, type SoundInReads } from './soundInMedia'
import type { MeasuredMedia, OutputFile } from './types'

export const SYNC_3_MAX_VIDEO_BYTES = 100_000_000
export const SYNC_3_MAX_SOUND_BYTES = 50_000_000

export const SYNC_3_VIDEO_RULE: MediaRule = {
  kind: 'video',
  formats: ['mp4', 'mov', 'webm'],
  maxBytes: SYNC_3_MAX_VIDEO_BYTES,
  maxLongSide: 4096,
  maxShortSide: 2160,
  words: {
    tooLarge: 'sync-3 takes face videos up to 100 MB. Make this one smaller first.',
    wrongFormat: 'sync-3 takes MP4, MOV or WebM face videos.',
    tooManyPixels: 'sync-3 takes face videos up to 4K (4096 × 2160). Make this one smaller first.',
    unmeasured: 'Sailor can’t read how long this face video is, so it can’t price the lip-sync. Try an MP4 video.',
  },
}

export const SYNC_3_SOUND_RULE: MediaRule = {
  kind: 'audio',
  formats: ['wav', 'mp3', 'ogg', 'flac', 'm4a', 'mp4', 'aac'],
  maxBytes: SYNC_3_MAX_SOUND_BYTES,
  words: {
    tooLarge: 'sync-3 takes sounds up to 50 MB. Make this one smaller first.',
    wrongFormat: 'sync-3 takes sounds as WAV, MP3, Ogg, FLAC, M4A, MP4 or AAC files. Save this one as one of those first.',
    unmeasured: 'Sailor can’t read how long this sound is, so it can’t price the lip-sync. Try a WAV or MP3 file.',
  },
}

export const SYNC_3_TOO_LONG = `sync-3 makes lip-syncs up to ${LIPSYNC_MAX_SECONDS} seconds. Use a shorter sound.`
export const SYNC_3_FILE_MISSING = 'A file this lip-sync needs is missing. Upload it again.'
export const SYNC_3_CHANGED = 'The sound or face video changed after you pressed Run. Run it again.'

/** What the check found: a refusal, or the files to hand off and their measured lengths. */
export type Sync3MediaCheck =
  | { problem: string }
  /**
   * `audio` null: a sound made in the run (R3.8, an Audio card showing a music
   * or speech node's sound), not read yet at the start of the run: the video
   * alone was judged, and the sound is held at the 60 s cap until its turn.
   */
  /** `audioMeasured` (R11.3): a sound sent as Python's WAV (`audio` null) whose length was measured. */
  | { problem: null, video: OutputFile, audio: OutputFile | null, seconds: InputSeconds, sha: MeasuredMedia['sha'], audioMeasured?: boolean }

export interface Sync3MediaReads extends MediaReads, Omit<SoundInReads, 'strict'> {
  /** At the node's turn: the files a link brought (the Audio card's). Absent: the card's own file, from the prompt. */
  filesFrom?(link: ApiLink): OutputFile[]
}

/** A measured length to the millionth of a second (float noise off the container duration). */
const tidy = (s: number) => Math.round(s * 1e6) / 1e6

/** The node's two files, read and judged; the first problem, or the files and their lengths. */
export async function sync3MediaCheck(prompt: ApiPrompt, nodeId: string, o: Sync3MediaReads): Promise<Sync3MediaCheck> {
  const sources = sync3Sources(prompt, nodeId)
  if (!('file' in sources.video)) return { problem: 'problem' in sources.video ? sources.video.problem : SYNC_3_NEEDS_VIDEO }
  if ('problem' in sources.audio) return { problem: sources.audio.problem }
  const video = sources.video.file
  if ('wav' in sources.audio) return wavSoundCheck(prompt, nodeId, video, sources.audio.wav, o)
  const produced = 'produced' in sources.audio
  // A sound made in the run: at the node's turn, what its link brought; at the start, nothing yet.
  const audio = 'produced' in sources.audio
    ? (o.filesFrom ? o.filesFrom(sources.audio.produced)[0] ?? null : null)
    : fileOf(sources.audio, o)
  if (produced && o.filesFrom && !audio) return { problem: SYNC_3_NEEDS_SOUND }
  const measure = (file: OutputFile, rule: MediaRule) => measureMediaFile(file, rule, o, SYNC_3_FILE_MISSING)
  const [v, a] = await Promise.all([measure(video, SYNC_3_VIDEO_RULE), audio ? measure(audio, SYNC_3_SOUND_RULE) : null])
  if (v.problem !== null) return { problem: v.problem }
  if (a && a.problem !== null) return { problem: a.problem }
  const audioSeconds = a ? a.facts.seconds : null
  // The clip it makes, as far as it was measured (an unmeasured length can't shorten it).
  const made = sync3OutputSeconds(lipSyncSyncMode(prompt[nodeId]?.inputs ?? {}), audioSeconds ?? Infinity, v.facts.seconds ?? Infinity)
  if (made != null && Number.isFinite(made) && tidy(made) > LIPSYNC_MAX_SECONDS) return { problem: SYNC_3_TOO_LONG }
  const seconds: InputSeconds = {}
  if (audioSeconds != null) seconds.audio = audioSeconds
  if (v.facts.seconds != null) seconds.video = v.facts.seconds
  return { problem: null, video, audio, seconds, sha: { video: v.sha, ...(a ? { audio: a.sha } : {}) } }
}

/**
 * R11.3 (R5.3 case A): the face video measured, and a card's runner sound as
 * the WAV sent (at the node's turn the one the wire brought; before the run a
 * file the prompt names; a sound made in the run is held at the 60 s cap).
 */
async function wavSoundCheck(prompt: ApiPrompt, nodeId: string, video: OutputFile, link: ApiLink, o: Sync3MediaReads): Promise<Sync3MediaCheck> {
  const v = await measureMediaFile(video, SYNC_3_VIDEO_RULE, o, SYNC_3_FILE_MISSING)
  if (v.problem !== null) return { problem: v.problem }
  const s = await wiredSoundCheck(prompt, link, 'LipSyncNode', o)
  if (s && s.problem !== null) return { problem: s.problem }
  const audioSeconds = s?.measured.seconds.audio ?? null
  const made = sync3OutputSeconds(lipSyncSyncMode(prompt[nodeId]?.inputs ?? {}), audioSeconds ?? Infinity, v.facts.seconds ?? Infinity)
  if (made != null && Number.isFinite(made) && tidy(made) > LIPSYNC_MAX_SECONDS) return { problem: SYNC_3_TOO_LONG }
  const seconds: InputSeconds = {}
  if (audioSeconds != null) seconds.audio = audioSeconds
  if (v.facts.seconds != null) seconds.video = v.facts.seconds
  const sha = { video: v.sha, ...(s?.measured.sha.audio ? { audio: s.measured.sha.audio } : {}) }
  return { problem: null, video, audio: null, seconds, sha, audioMeasured: !!s }
}

/**
 * What the start of the run recorded, from a check's result (the tight hold,
 * F22 fix round 1).
 */
export function measuredOf(check: Extract<Sync3MediaCheck, { problem: null }>): MeasuredMedia {
  return { seconds: { ...check.seconds }, sha: { ...check.sha } }
}

/** The sound's file: what its link brought at the node's turn, else the Audio card's own file. */
function fileOf(source: Extract<Sync3Source, { file: OutputFile }>, o: Sync3MediaReads): OutputFile {
  if (source.link && o.filesFrom) return o.filesFrom(source.link)[0] ?? source.file
  return source.file
}

/** The input files a sync-3 node would send (for the ownership check at the start of a run). */
export function sync3InputFiles(prompt: ApiPrompt, nodeId: string): OutputFile[] {
  const s = sync3Sources(prompt, nodeId)
  return [s.video, s.audio].flatMap(x => ('file' in x ? [x.file] : []))
}

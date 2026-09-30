/**
 * Sound and video files the runner hands a provider (model line-up F22,
 * sync-3 lip-sync; built so F23's video upscale reuses it). The hand-off
 * itself is the pictures' one (./handoff.ts: read the file through the
 * result store, upload it to fal storage once, send the link): this file only
 * says what a file IS before it goes, so a model's limits are checked in
 * plain words before anything is sent or charged:
 *   - its format, from its first bytes (never its name);
 *   - its length (and, for a video, its size in pixels), measured with
 *     mediabunny from the bytes, never decoded (server/utils/graphInputSeconds.ts).
 * A model states its limits as a MediaRule; `mediaRuleProblem` judges a file
 * against it. Nothing here reads a file: the caller hands the bytes in.
 */
import { mediaInfoOfBytes, type MediaKind } from '../utils/graphInputSeconds'
import { sha256Hex } from './handoff'
import type { MeasuredMedia, OutputFile } from './types'

export type { MediaKind }

/** The containers the runner can tell apart from a file's first bytes. */
export type MediaFormat = 'mp4' | 'mov' | 'm4a' | 'webm' | 'mkv' | 'wav' | 'avi' | 'mp3' | 'ogg' | 'flac' | 'aac'
  | 'mpegts' | 'mpegps' | 'flv' | 'asf'

/** The first bytes a sniff needs: MPEG-TS is told by its sync byte at three packet starts (188 or 192 bytes apart). */
export const MEDIA_SNIFF_BYTES = 1024

/** ASF's header object GUID (WMV, WMA). */
const ASF_GUID = [0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C]

/** QuickTime atoms a MOV may begin with instead of `ftyp` (older cameras and editors). */
const QT_FIRST_ATOMS = ['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0))

/**
 * A media file's container, from its first bytes: MP4 / MOV / M4A (an ISO
 * `ftyp` box, told apart by its brand), WebM or other Matroska (an EBML header
 * naming "webm" or "matroska"), WAV (RIFF…WAVE), AVI (RIFF…AVI), MP3 (an ID3
 * tag or an MPEG audio frame), Ogg, FLAC, or AAC (an ADTS frame). Null for
 * anything else (GIF, a picture, a playlist, text). R5.4 fix round 1: also
 * QuickTime with no `ftyp` (its first atom moov, mdat, wide, free, skip or
 * pnot), MPEG-TS (sync bytes at three packet starts, 188 or 192 apart),
 * MPEG-PS (a pack header), FLV and ASF (WMV, WMA), which Python's LoadVideo
 * reads and a person can upload. The media module names
 * ffmpeg's demuxer from this answer, never from a file's name (R5 rule 6).
 */
export function mediaFormat(bytes: Uint8Array): MediaFormat | null {
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 'ftyp')) {
    if (ascii(bytes, 8, 'qt  ')) return 'mov'
    if (ascii(bytes, 8, 'M4A ') || ascii(bytes, 8, 'M4B ')) return 'm4a'
    return 'mp4'
  }
  if (bytes.byteLength >= 8 && QT_FIRST_ATOMS.some(a => ascii(bytes, 4, a))) {
    // An atom's size is 1 (a 64-bit size follows) or at least its 8-byte header.
    const size = ((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!
    if (size === 1 || size >= 8) return 'mov'
  }
  for (const step of [188, 192]) {
    const at = step === 192 ? 4 : 0
    if (bytes.byteLength >= at + 2 * step + 1 && [0, 1, 2].every(k => bytes[at + k * step] === 0x47)) return 'mpegts'
  }
  if (bytes[0] === 0x00 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0xBA) return 'mpegps'
  if (ascii(bytes, 0, 'FLV') && bytes[3] === 0x01) return 'flv'
  if (bytes.byteLength >= 16 && ASF_GUID.every((b, i) => bytes[i] === b)) return 'asf'
  if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
    const head = String.fromCharCode(...bytes.subarray(0, 64))
    return head.includes('webm') ? 'webm' : head.includes('matroska') ? 'mkv' : null
  }
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return 'wav'
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'AVI ')) return 'avi'
  if (ascii(bytes, 0, 'OggS')) return 'ogg'
  if (ascii(bytes, 0, 'fLaC')) return 'flac'
  if (ascii(bytes, 0, 'ID3')) return 'mp3'
  if (bytes[0] === 0xFF && bytes[1] !== undefined) {
    // ADTS (AAC): sync 0xFFF, layer 00. MPEG audio (MP3): sync 0xFFE, layer not 00.
    if ((bytes[1] & 0xF6) === 0xF0) return 'aac'
    if ((bytes[1] & 0xE0) === 0xE0 && (bytes[1] & 0x06) !== 0) return 'mp3'
  }
  return null
}

/** What the runner learned about one media file before handing it on. */
export interface MediaFacts {
  bytes: number
  format: MediaFormat | null
  /** Seconds of the primary track of the kind asked for; null when it couldn't be measured. */
  seconds: number | null
  /** A video's display size (after rotation); null for a sound, or when unmeasured. */
  width: number | null
  height: number | null
  /** A video's frames a second, when its rule asks (`frameRate`); null otherwise, or when unmeasured. */
  fps: number | null
}

/**
 * The facts of one file. It is measured only when its size and format pass
 * `rule` (a file refused anyway is never parsed), and never above `maxBytes`.
 */
export async function mediaFacts(bytes: Uint8Array, rule: MediaRule): Promise<MediaFacts> {
  const format = mediaFormat(bytes)
  const facts: MediaFacts = { bytes: bytes.byteLength, format, seconds: null, width: null, height: null, fps: null }
  if (bytes.byteLength > rule.maxBytes || !format || !rule.formats.includes(format)) return facts
  const info = await mediaInfoOfBytes(bytes, rule.kind, { maxBytes: rule.maxBytes, ...(rule.frameRate ? { frameRate: true } : {}) })
  if (info) {
    facts.seconds = info.seconds
    facts.width = info.width
    facts.height = info.height
    facts.fps = info.fps ?? null
  }
  return facts
}

/** A model's limits for one media input, with the plain words for each refusal. */
export interface MediaRule {
  kind: MediaKind
  formats: readonly MediaFormat[]
  maxBytes: number
  /** A video's largest size, either way round (the long side, then the short side). */
  maxLongSide?: number
  maxShortSide?: number
  /** Also read a video's frame rate (a price that depends on it: Topaz video upscale, F23). */
  frameRate?: true
  words: {
    tooLarge: string
    wrongFormat: string
    /** Over maxLongSide / maxShortSide. */
    tooManyPixels?: string
    /** Couldn't be measured, where the caller needs the length (`strict`). */
    unmeasured: string
  }
}

/**
 * A file over the rule's size, judged from its size alone before it is read
 * (F22 fix round 1: a file too large is never loaded). Null when it fits.
 */
export function mediaSizeProblem(bytes: number, rule: MediaRule): string | null {
  return bytes > rule.maxBytes ? rule.words.tooLarge : null
}

/**
 * Why `facts` can't be sent under `rule`, or null. `strict`: a file whose
 * length couldn't be measured is refused (its price or limit can't be
 * checked); otherwise it is left to the caller (priced at its cap).
 */
export function mediaRuleProblem(facts: MediaFacts, rule: MediaRule, strict: boolean): string | null {
  const tooLarge = mediaSizeProblem(facts.bytes, rule)
  if (tooLarge) return tooLarge
  if (!facts.format || !rule.formats.includes(facts.format)) return rule.words.wrongFormat
  if (facts.seconds == null) return strict ? rule.words.unmeasured : null
  if (rule.kind === 'video' && facts.width != null && facts.height != null && rule.words.tooManyPixels) {
    const long = Math.max(facts.width, facts.height)
    const short = Math.min(facts.width, facts.height)
    if ((rule.maxLongSide !== undefined && long > rule.maxLongSide) || (rule.maxShortSide !== undefined && short > rule.maxShortSide)) {
      return rule.words.tooManyPixels
    }
  }
  return null
}

/** How the caller reads a file for a check (the engine's result store). */
export interface MediaReads {
  read(file: OutputFile): Promise<Uint8Array>
  /** The file's size without reading it (a file over the limit is never loaded). Absent: judged after the read. */
  size?(file: OutputFile): Promise<number | null>
  /** Hosted: a file whose length can't be measured is refused (`mediaRuleProblem`). */
  strict: boolean
}

/** One file, judged against its rule: the first problem, or its facts and the sha256 of the bytes read. */
export type MeasuredFile =
  | { problem: string, facts: null, sha: '' }
  | { problem: null, facts: MediaFacts, sha: string }

/**
 * Stat, read and judge one file (F22 fix round 1: the size before the read,
 * so a file too large is never loaded). `missing`: the words when it can't be
 * read. The sha256 is of the very bytes measured.
 */
export async function measureMediaFile(file: OutputFile, rule: MediaRule, reads: MediaReads, missing: string): Promise<MeasuredFile> {
  const size = reads.size ? await reads.size(file).catch(() => null) : null
  const tooLarge = size != null ? mediaSizeProblem(size, rule) : null
  if (tooLarge) return { problem: tooLarge, facts: null, sha: '' }
  let bytes: Uint8Array
  try { bytes = await reads.read(file) }
  catch { return { problem: missing, facts: null, sha: '' } }
  const facts = await mediaFacts(bytes, rule)
  const problem = mediaRuleProblem(facts, rule, reads.strict)
  return problem ? { problem, facts: null, sha: '' } : { problem: null, facts, sha: sha256Hex(bytes) }
}

/** A measured figure to the millionth (float noise off the container's figures). */
const tidy = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * Whether a node's files at its turn are not the ones recorded at the start
 * of the run (the tight hold, F22 fix round 1): a length, size or frame rate
 * that differs (to the millionth; one that appeared or went missing counts),
 * or bytes that differ (sha256).
 */
export function measuredMediaChanged(recorded: MeasuredMedia, now: MeasuredMedia): boolean {
  const same = (a?: number | null, b?: number | null) => (a == null && b == null) || (a != null && b != null && tidy(a) === tidy(b))
  const figures = ['audio', 'video', 'videoWidth', 'videoHeight', 'videoFps'] as const
  return figures.some(k => !same(recorded.seconds[k], now.seconds[k]))
    || recorded.sha.audio !== now.sha.audio || recorded.sha.video !== now.sha.video
}

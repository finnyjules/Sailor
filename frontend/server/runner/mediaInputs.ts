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

export type { MediaKind }

/** The containers the runner can tell apart from a file's first bytes. */
export type MediaFormat = 'mp4' | 'mov' | 'm4a' | 'webm' | 'wav' | 'mp3' | 'ogg' | 'flac' | 'aac'

const ascii = (bytes: Uint8Array, at: number, text: string) =>
  [...text].every((c, i) => bytes[at + i] === c.charCodeAt(0))

/**
 * A media file's container, from its first bytes: MP4 / MOV / M4A (an ISO
 * `ftyp` box, told apart by its brand), WebM (an EBML header naming "webm"),
 * WAV (RIFF…WAVE), MP3 (an ID3 tag or an MPEG audio frame), Ogg, FLAC, or
 * AAC (an ADTS frame). Null for anything else (Matroska that isn't WebM, AVI,
 * GIF, a picture, text).
 */
export function mediaFormat(bytes: Uint8Array): MediaFormat | null {
  if (bytes.byteLength >= 12 && ascii(bytes, 4, 'ftyp')) {
    if (ascii(bytes, 8, 'qt  ')) return 'mov'
    if (ascii(bytes, 8, 'M4A ') || ascii(bytes, 8, 'M4B ')) return 'm4a'
    return 'mp4'
  }
  if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
    const head = String.fromCharCode(...bytes.subarray(0, 64))
    return head.includes('webm') ? 'webm' : null
  }
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return 'wav'
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
}

/**
 * The facts of one file. It is measured only when its size and format pass
 * `rule` (a file refused anyway is never parsed), and never above `maxBytes`.
 */
export async function mediaFacts(bytes: Uint8Array, rule: MediaRule): Promise<MediaFacts> {
  const format = mediaFormat(bytes)
  const facts: MediaFacts = { bytes: bytes.byteLength, format, seconds: null, width: null, height: null }
  if (bytes.byteLength > rule.maxBytes || !format || !rule.formats.includes(format)) return facts
  const info = await mediaInfoOfBytes(bytes, rule.kind, { maxBytes: rule.maxBytes })
  if (info) {
    facts.seconds = info.seconds
    facts.width = info.width
    facts.height = info.height
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
 * Why `facts` can't be sent under `rule`, or null. `strict`: a file whose
 * length couldn't be measured is refused (its price or limit can't be
 * checked); otherwise it is left to the caller (priced at its cap).
 */
export function mediaRuleProblem(facts: MediaFacts, rule: MediaRule, strict: boolean): string | null {
  if (facts.bytes > rule.maxBytes) return rule.words.tooLarge
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

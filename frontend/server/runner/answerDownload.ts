/**
 * Downloading a provider's answer files (R3.1 fix round 1): the pictures,
 * videos, sounds and 3D files a finished call points at, for provider nodes
 * and pipelines alike. Every download goes through the layout images' fetch
 * policy (server/templates/safeFetch.ts `safeFetch`): http(s) only, no
 * private, loopback or reserved address at any hop (the connection is pinned
 * to the checked address), at most 3 redirects each checked again, a time
 * limit, the run's Stop, and a byte cap per kind of file:
 *   pictures, sounds, 3D files  512 MiB, 10 minutes
 *   videos                      2 GiB, 30 minutes (no lower limit than before)
 *   JSON (R3.6, Layerize's      1 MiB, 30 seconds (Python's own time limit;
 *   layer data)                 a value holds at most 262,144 characters)
 * What is kept is checked by kind too: a sound by its header (WAV, MP3,
 * FLAC, Ogg, MP4 audio, AAC), a 3D file by GLB's magic (`glTF`); a picture
 * or a video keeps an extension from its kind's list only, never whatever a
 * URL says.
 */
import { safeFetch, type SafeFetchPolicy } from '../templates/safeFetch'
import { extFor } from './results'

export type AnswerKind = 'image' | 'video' | 'audio' | 'glb' | 'json'

const MIB = 1024 * 1024
/** The most bytes one answer file may be, by kind (controller ruling, R3.1 fix round 1). */
export const ANSWER_MAX_BYTES: Readonly<Record<AnswerKind, number>> = {
  image: 512 * MIB, audio: 512 * MIB, glb: 512 * MIB, video: 2048 * MIB, json: MIB,
}
/** How long one answer file may take to download, by kind. */
export const ANSWER_TIMEOUT_MS: Readonly<Record<AnswerKind, number>> = {
  image: 10 * 60_000, audio: 10 * 60_000, glb: 10 * 60_000, video: 30 * 60_000, json: 30_000,
}

const NOUN: Record<AnswerKind, string> = { image: 'picture', video: 'video', audio: 'sound', glb: '3D model', json: 'data' }
const sizeWords = (bytes: number) => bytes >= 1024 * MIB ? `${bytes / (1024 * MIB)} GB` : `${Math.floor(bytes / MIB)} MB`

export const ANSWER_REFUSED = 'The service’s result points at a private network address, which is not allowed'
export const answerTooLarge = (kind: AnswerKind, maxBytes: number) => `The ${NOUN[kind]} the service made is too large to keep (over ${sizeWords(maxBytes)})`
const timeWords = (ms: number) => (ms < 60_000 ? `${ms / 1000} seconds` : `${ms / 60_000} minutes`)
export const answerTimeout = (kind: AnswerKind) => `The ${NOUN[kind]} the service made took longer than ${timeWords(ANSWER_TIMEOUT_MS[kind])} to download`
export const ANSWER_NOT_GLB = 'The 3D model the service made isn’t a GLB file, so it can’t be kept'
export const ANSWER_NOT_SOUND = 'The sound the service made isn’t a kind Sailor can keep'

/** The cap a caller asked for, never above its kind's. */
export function answerCap(kind: AnswerKind, asked?: number): number {
  const cap = ANSWER_MAX_BYTES[kind]
  return asked !== undefined && Number.isFinite(asked) && asked >= 0 ? Math.min(asked, cap) : cap
}

/** One try at an answer file under the policy (falQueue.ts downloadResult retries it). */
export type AnswerFetchOnce = (url: string, o: { maxBytes?: number; signal?: AbortSignal }) => Promise<{ status: number; contentType: string | null; bytes: Uint8Array }>

/** The runner's answer fetcher for one kind of file: no loopback exception, locally or hosted. */
export function safeAnswerFetch(o: { hosted: boolean; kind: AnswerKind }): AnswerFetchOnce {
  return async (url, f) => {
    const maxBytes = answerCap(o.kind, f.maxBytes)
    const policy: SafeFetchPolicy = {
      hosted: o.hosted, loopbackView: false, timeoutMs: ANSWER_TIMEOUT_MS[o.kind], maxBytes, accept: '*/*',
      words: { refused: ANSWER_REFUSED, tooLarge: answerTooLarge(o.kind, maxBytes), timeout: answerTimeout(o.kind) },
    }
    const r = await safeFetch(url, policy, f.signal ? { signal: f.signal } : {})
    return { status: r.status, contentType: r.contentType, bytes: new Uint8Array(r.data) }
  }
}

const ascii = (b: Uint8Array, at: number, text: string) => b.length >= at + text.length && [...text].every((c, i) => b[at + i] === c.charCodeAt(0))

/** A sound's extension by its header, or null for anything else. */
export function soundExtOf(b: Uint8Array): string | null {
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return 'wav'
  if (ascii(b, 0, 'fLaC')) return 'flac'
  if (ascii(b, 0, 'OggS')) return 'ogg'
  if (ascii(b, 0, 'ID3')) return 'mp3'
  if (ascii(b, 4, 'ftyp')) return 'm4a'
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) {
    // Frame sync: MPEG audio (layer bits set) or ADTS AAC (layer bits 00).
    return (b[1]! & 0x06) === 0 ? 'aac' : 'mp3'
  }
  return null
}

/** Whether the bytes are a GLB (binary glTF). */
export const isGlb = (b: Uint8Array): boolean => ascii(b, 0, 'glTF')

/** The extensions a picture or a video may be saved with; anything else takes the kind's default. */
const SAVED_EXTS: Record<'image' | 'video', readonly string[]> = {
  image: ['png', 'jpg', 'webp', 'gif', 'avif'],
  video: ['mp4', 'webm', 'mov'],
}
const DEFAULT_EXT: Record<AnswerKind, string> = { image: 'png', video: 'mp4', audio: 'wav', glb: 'glb', json: 'json' }

/**
 * The extension an answer file is saved with, checked by its kind: a 3D file
 * must be a GLB and a sound one of the known kinds (else a plain refusal);
 * a picture or a video takes its type's or its address's extension only
 * from its kind's list.
 */
export function answerExt(kind: AnswerKind, bytes: Uint8Array, contentType: string | null, url: string): string {
  if (kind === 'glb') {
    if (!isGlb(bytes)) throw new Error(ANSWER_NOT_GLB)
    return 'glb'
  }
  if (kind === 'audio') {
    const ext = soundExtOf(bytes)
    if (!ext) throw new Error(ANSWER_NOT_SOUND)
    return ext
  }
  // Layer data (R3.6) is read as text, never saved.
  if (kind === 'json') return 'json'
  const ext = extFor(contentType, url, DEFAULT_EXT[kind])
  return SAVED_EXTS[kind].includes(ext) ? ext : DEFAULT_EXT[kind]
}

/** A sound or a 3D file checked by its bytes (a pipeline's download of that kind); pictures and videos pass. */
export function checkAnswerBytes(kind: AnswerKind, bytes: Uint8Array): void {
  if (kind === 'glb' && !isGlb(bytes)) throw new Error(ANSWER_NOT_GLB)
  if (kind === 'audio' && !soundExtOf(bytes)) throw new Error(ANSWER_NOT_SOUND)
}

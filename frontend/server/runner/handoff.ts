/**
 * Hands one of our saved files (a picture, a video or a sound) to the next
 * model: uploads its bytes to fal storage and sends the link. Never base64 in
 * the request, and never fal's own result link (it can expire while a Gate
 * waits).
 *
 * A link is remembered by the sha256 of the BYTES uploaded (and their type),
 * never by the file's name (F22 review, critical): a file overwritten under
 * the same name is new bytes, so it is uploaded again. `toUrlBytes` uploads
 * exactly the bytes the caller already read — the engine measures and prices
 * a file from one read and hands off that same read, so what is charged and
 * what is sent are one set of bytes (there is no hand-off that reads a file
 * itself: a second read could differ from the one measured). A link is
 * reused for a day. Also remembers what each link contained, so a request's
 * fingerprint depends on the picture, not on which upload link it happened
 * to get.
 *
 * What it remembers is bounded (final review finding 10; final fix F10):
 * each new upload first forgets every link older than a day, and at most
 * HANDOFF_MAX_REMEMBERED uploads are kept (the oldest forgotten first), each
 * with what its link contained. A forgotten link only costs a fresh upload,
 * and a fingerprint that then names the link instead of its bytes (a missed
 * reuse, never a wrong one).
 */
import { createHash } from 'node:crypto'
import type { OutputFile } from './types'

export interface Handoff {
  /** Hands off exactly `bytes` (the caller's own read of `file`, which names the upload and its type). */
  toUrlBytes(file: OutputFile, bytes: Uint8Array): Promise<string>
  hashOf(url: string): string | undefined
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * The upload's type, by the file's name. Sounds and videos go the same way as
 * pictures (model line-up F22: sync-3's face video and sound; F23 reuses it).
 */
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac',
}

export function mimeFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}

/** A remembered upload link is used for a day, then the file is uploaded again. */
export const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000

/** The most uploads remembered at once; past it, the oldest is forgotten. */
export const HANDOFF_MAX_REMEMBERED = 2000

interface Remembered { url: Promise<string>; at: number; link?: string }

export function createHandoff(d: {
  upload(bytes: Uint8Array, name: string, mime: string): Promise<string>
  now?: () => number
}): Handoff {
  const now = d.now ?? Date.now
  // Oldest first (a Map keeps insertion order, and an entry is only ever added at the end).
  const byBytes = new Map<string, Remembered>()
  const hashByUrl = new Map<string, string>()
  const forget = (key: string, e: Remembered) => {
    byBytes.delete(key)
    if (e.link !== undefined) hashByUrl.delete(e.link)
  }
  /** Before a new upload is remembered: every expired link, then the oldest past the bound. */
  const prune = () => {
    const t = now()
    for (const [key, e] of byBytes) if (t - e.at >= HANDOFF_TTL_MS) forget(key, e)
    while (byBytes.size >= HANDOFF_MAX_REMEMBERED) {
      const [key, e] = byBytes.entries().next().value as [string, Remembered]
      forget(key, e)
    }
  }
  const toUrlBytes = (file: OutputFile, bytes: Uint8Array): Promise<string> => {
    const sha = sha256Hex(bytes)
    const mime = mimeFor(file.filename)
    const key = `${sha}:${mime}`
    const hit = byBytes.get(key)
    if (hit && now() - hit.at < HANDOFF_TTL_MS) return hit.url
    prune()
    const entry = { at: now() } as Remembered
    entry.url = (async () => {
      const url = await d.upload(bytes, file.filename, mime)
      // Forgotten while it uploaded: nothing is kept for it.
      if (byBytes.get(key) === entry) {
        entry.link = url
        hashByUrl.set(url, sha)
      }
      return url
    })()
    byBytes.set(key, entry)
    entry.url.catch(() => { if (byBytes.get(key) === entry) byBytes.delete(key) })
    return entry.url
  }
  return {
    toUrlBytes,
    hashOf(url) {
      return hashByUrl.get(url)
    },
  }
}

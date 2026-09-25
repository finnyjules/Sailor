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
 * what is sent are one set of bytes. A link is reused for a day. Also
 * remembers what each link contained, so a request's fingerprint depends on
 * the picture, not on which upload link it happened to get.
 */
import { createHash } from 'node:crypto'
import type { OutputFile } from './types'

export interface Handoff {
  /** Reads the file now and hands off those bytes. */
  toUrl(file: OutputFile): Promise<string>
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

export function createHandoff(d: {
  read(file: OutputFile): Promise<Uint8Array>
  upload(bytes: Uint8Array, name: string, mime: string): Promise<string>
  now?: () => number
}): Handoff {
  const now = d.now ?? Date.now
  const byBytes = new Map<string, { url: Promise<string>; at: number }>()
  const hashByUrl = new Map<string, string>()
  const toUrlBytes = (file: OutputFile, bytes: Uint8Array): Promise<string> => {
    const sha = sha256Hex(bytes)
    const mime = mimeFor(file.filename)
    const key = `${sha}:${mime}`
    const hit = byBytes.get(key)
    if (hit && now() - hit.at < HANDOFF_TTL_MS) return hit.url
    const entry = {
      at: now(),
      url: (async () => {
        const url = await d.upload(bytes, file.filename, mime)
        hashByUrl.set(url, sha)
        return url
      })(),
    }
    byBytes.set(key, entry)
    entry.url.catch(() => { if (byBytes.get(key) === entry) byBytes.delete(key) })
    return entry.url
  }
  return {
    async toUrl(file) {
      return toUrlBytes(file, await d.read(file))
    },
    toUrlBytes,
    hashOf(url) {
      return hashByUrl.get(url)
    },
  }
}

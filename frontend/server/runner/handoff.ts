/**
 * Hands one of our saved files to the next model: uploads it to fal storage
 * once and reuses the link. Never base64 in the request, and never fal's own
 * result link (it can expire while a Gate waits). Also remembers what each
 * link contained, so a request's fingerprint depends on the picture, not on
 * which upload link it happened to get.
 */
import { createHash } from 'node:crypto'
import type { OutputFile } from './types'

export interface Handoff {
  toUrl(file: OutputFile): Promise<string>
  hashOf(url: string): string | undefined
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
}

export function mimeFor(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}

export function createHandoff(d: {
  read(file: OutputFile): Promise<Uint8Array>
  upload(bytes: Uint8Array, name: string, mime: string): Promise<string>
}): Handoff {
  const byFile = new Map<string, Promise<string>>()
  const hashByUrl = new Map<string, string>()
  return {
    toUrl(file) {
      const key = `${file.type}:${file.subfolder}:${file.filename}`
      let p = byFile.get(key)
      if (!p) {
        p = (async () => {
          const bytes = await d.read(file)
          const url = await d.upload(bytes, file.filename, mimeFor(file.filename))
          hashByUrl.set(url, sha256Hex(bytes))
          return url
        })()
        byFile.set(key, p)
        p.catch(() => byFile.delete(key))
      }
      return p
    },
    hashOf(url) {
      return hashByUrl.get(url)
    },
  }
}

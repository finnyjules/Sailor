/**
 * A `/view` path read by Sailor itself, for server code that used to fetch it
 * from the engine's port (step 3, R10.8): the bytes come off disk, resolved by
 * name exactly as GET /view resolves them (./view.ts). Hosted callers apply
 * ./viewGate.ts first, as GET /view does.
 */
import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { resolveViewTarget, viewContentType, type ViewQuery } from './view'

/** A URL's query as /view reads it (every value of a repeated key; the resolver takes the first). */
export function viewQueryOf(params: URLSearchParams): ViewQuery {
  const q: ViewQuery = {}
  for (const k of new Set(params.keys())) {
    const all = params.getAll(k)
    q[k] = all.length === 1 ? all[0] : all
  }
  return q
}

export type ViewRead =
  | { kind: 'file'; data: Buffer; contentType: string; filename: string }
  | { kind: 'status'; status: 400 | 403 | 404 }
  | { kind: 'tooLarge' }

/** Where GET /view keeps a copy of a temp file (temp/ is emptied each time the engine starts). */
export const VIEW_CACHE_DIR = join(process.cwd(), '.cache', 'images')
let cacheDirOverride: string | null = null
export function __setViewCacheDirForTests(dir: string | null): void { cacheDirOverride = dir }
const cacheDir = () => cacheDirOverride ?? VIEW_CACHE_DIR

/** The copy's file for a request's own filename, type and subfolder (GET /view's key). */
export function viewCacheFile(filename: string, type: string, subfolder: string, dir = cacheDir()): string {
  const hash = createHash('sha256').update(`${type}:${subfolder}:${filename}`).digest('hex').slice(0, 16)
  // Keep the original extension for MIME type detection
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : ''
  return join(dir, `${hash}${ext}`)
}

const firstOf = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)

/** Read a file whole when it is at most `maxBytes`; null when it can't be read. */
async function readCapped(file: string, maxBytes: number): Promise<Buffer | 'tooLarge' | null> {
  let size: number
  try { size = (await fsp.stat(file)).size }
  catch { return null }
  if (size > maxBytes) return 'tooLarge'
  let data: Buffer
  try { data = await fsp.readFile(file) }
  catch { return null }
  // Grown since the stat: still refused past the cap.
  return data.byteLength > maxBytes ? 'tooLarge' : data
}

/**
 * The file a `/view` query names, read whole when it is at most `maxBytes`.
 * A file no longer on disk is read from GET /view's kept copy when there is
 * one (R10.8 fix round 1), as GET /view answers it.
 */
export async function readViewFile(query: ViewQuery, maxBytes: number): Promise<ViewRead> {
  const target = resolveViewTarget(query)
  if (target.kind === 'file') {
    const data = await readCapped(target.file, maxBytes)
    if (data === 'tooLarge') return { kind: 'tooLarge' }
    if (data) return { kind: 'file', data, contentType: viewContentType(target.filename), filename: target.filename }
  }
  else if (target.status !== 404) return target
  // Not on disk: GET /view's fallback, keyed by the request's own names.
  const filename = firstOf(query.filename)
  if (!filename) return { kind: 'status', status: 404 }
  const cached = viewCacheFile(filename, firstOf(query.type) || 'output', firstOf(query.subfolder) || '')
  const data = await readCapped(cached, maxBytes)
  if (data === 'tooLarge') return { kind: 'tooLarge' }
  if (!data) return { kind: 'status', status: 404 }
  return { kind: 'file', data, contentType: viewContentType(cached), filename: filename.split('/').pop() || filename }
}

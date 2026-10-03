/**
 * A `/view` path read by Sailor itself, for server code that used to fetch it
 * from the engine's port (step 3, R10.8): the bytes come off disk, resolved by
 * name exactly as GET /view resolves them (./view.ts). Hosted callers apply
 * ./viewGate.ts first, as GET /view does.
 */
import { promises as fsp } from 'node:fs'
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

/** The file a `/view` query names, read whole when it is at most `maxBytes`. */
export async function readViewFile(query: ViewQuery, maxBytes: number): Promise<ViewRead> {
  const target = resolveViewTarget(query)
  if (target.kind === 'status') return target
  let size: number
  try { size = (await fsp.stat(target.file)).size }
  catch { return { kind: 'status', status: 404 } }
  if (size > maxBytes) return { kind: 'tooLarge' }
  let data: Buffer
  try { data = await fsp.readFile(target.file) }
  catch { return { kind: 'status', status: 404 } }
  // Grown since the stat: still refused past the cap.
  if (data.byteLength > maxBytes) return { kind: 'tooLarge' }
  return { kind: 'file', data, contentType: viewContentType(target.filename), filename: target.filename }
}

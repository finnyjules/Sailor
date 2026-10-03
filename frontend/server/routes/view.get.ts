import { readFile, copyFile, mkdir } from 'node:fs/promises'
import { createReadStream, existsSync, openSync } from 'node:fs'
import { dirname } from 'node:path'
import { getRequestHeaders, setResponseStatus } from 'h3'
import { deployMode } from '../utils/deployMode'
import { hostedViewGate } from '../native/viewGate'
import { viewCacheFile } from '../native/viewRead'
import { VIEW_SECURITY_HEADERS, resolveViewTarget, viewFileResponse, type ViewQuery } from '../native/view'


export default defineEventHandler(async (event) => {
  // On every answer — files, 206/304/416, the cache fallback and errors.
  setResponseHeaders(event, VIEW_SECURITY_HEADERS)
  const query = getQuery(event)
  const filename = query.filename as string
  const type = query.type as string || 'output'
  const subfolder = query.subfolder as string || ''

  if (!filename) {
    throw createError({ statusCode: 400, message: 'Missing filename' })
  }

  // Stage 5 Task 5 + review C2: hosted output reads are tenant-scoped, and
  // the EFFECTIVE type is whatever the ENGINE will resolve — a trailing
  // `[output]` annotation on the filename outranks `type` (folder_paths.
  // annotated_filepath runs first), so `?type=temp&filename=x [output]`
  // used to walk straight past a `type === 'output'` gate and return the
  // protected bytes. viewGateDecision resolves it the engine's way.
  // type=temp/type=input stay ungated this stage (documented gap).
  if (deployMode() === 'hosted') await hostedViewGate(event.context.userId, query as ViewQuery)

  // Engine-free Phase A: the bytes come straight off disk, resolved exactly as
  // ComfyUI's view_image resolved them (server/native/view.ts).
  const target = resolveViewTarget(query as ViewQuery)
  const res = target.kind === 'file' ? viewFileResponse(target, getRequestHeaders(event)) : null
  if (target.kind === 'file' && res) {
    setResponseStatus(event, res.status)
    setResponseHeaders(event, { ...res.headers, 'cache-control': 'public, max-age=86400' })
    // temp/ is emptied every time the engine starts, so a copy is kept for
    // pages that still show those images afterwards (read back below).
    if (target.type === 'temp' && res.status === 200) {
      const cacheFile = viewCacheFile(filename, type, subfolder)
      if (!existsSync(cacheFile)) {
        mkdir(dirname(cacheFile), { recursive: true })
          .then(() => copyFile(target.file, cacheFile))
          .catch(() => {})
      }
    }
    if (!res.range || event.method === 'HEAD') return ''
    // Opened here, not lazily by the stream: a file removed after the stat
    // above must not surface later as an unhandled stream error.
    let fd: number
    try { fd = openSync(target.file, 'r') }
    catch { throw createError({ statusCode: 404, message: 'Image not found' }) }
    const stream = createReadStream('', { fd, start: res.range.start, end: res.range.end })
    stream.on('error', (e) => { console.error('[view] read failed', target.file, e) })
    return stream
  }
  // (A file that vanished between resolve and stat is a plain 404.)
  if (target.kind === 'status' && target.status !== 404) throw createError({ statusCode: target.status, message: 'Invalid image request' })

  // Fallback: a copy kept by the cache above (or by the proxy this route used
  // to be), for a file that is no longer on disk.
  const cacheFile = viewCacheFile(filename, type, subfolder)
  if (existsSync(cacheFile)) {
    const buffer = await readFile(cacheFile)
    const ext = cacheFile.slice(cacheFile.lastIndexOf('.') + 1).toLowerCase()
    const mimeMap: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      mp4: 'video/mp4',
      webm: 'video/webm',
    }
    setResponseHeaders(event, {
      'content-type': mimeMap[ext] || 'application/octet-stream',
      'cache-control': 'public, max-age=86400',
    })
    return buffer
  }

  throw createError({ statusCode: 404, message: 'Image not found' })
})

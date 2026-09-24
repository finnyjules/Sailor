import { createHash } from 'node:crypto'
import { readFile, copyFile, mkdir } from 'node:fs/promises'
import { createReadStream, existsSync, openSync } from 'node:fs'
import { join } from 'node:path'
import { getRequestHeaders, setResponseStatus } from 'h3'
import { deployMode } from '../utils/deployMode'
import { ownedOutputKeys } from '../utils/graphRuns'
import { harvestPendingOutputs, viewGateDecision } from '../utils/engineGate'
import { VIEW_SECURITY_HEADERS, resolveViewTarget, viewFileResponse, type ViewQuery } from '../native/view'

const CACHE_DIR = join(process.cwd(), '.cache', 'images')

function cacheKey(filename: string, type: string, subfolder: string): string {
  const hash = createHash('sha256').update(`${type}:${subfolder}:${filename}`).digest('hex').slice(0, 16)
  // Keep the original extension for MIME type detection
  const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : ''
  return `${hash}${ext}`
}

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
  if (deployMode() === 'hosted') {
    const userId = event.context.userId
    if (!userId) throw createError({ statusCode: 401, message: 'Sign in required' })
    // Round-2 review F5: `?filename=a.png&filename=b.png` makes getQuery return
    // an ARRAY, and the `as string` cast above is a lie the gate then trips
    // over — viewGateDecision calls .startsWith on it and the tenant check dies
    // with a TypeError, i.e. a 500 instead of a decision. Reject rather than
    // coerce: String(['a','b']) is "a,b", which is neither what the gate would
    // check nor what the loop below forwards for a repeated key, so coercion
    // would let the gate key and the engine request disagree about the file.
    if (Array.isArray(query.filename) || Array.isArray(query.type) || Array.isArray(query.subfolder)) {
      throw createError({ statusCode: 400, message: 'invalid filename' })
    }
    const gate = viewGateDecision({ filename, type, subfolder })
    if (gate.kind === 'reject') throw createError({ statusCode: gate.status, message: gate.message })
    if (gate.kind === 'check') {
      let owned = await ownedOutputKeys(userId)
      if (!owned.has(gate.key)) {
        // Race window: the client saw the WS 'executed' event a beat before
        // the settle watcher recorded outputs. Harvest this user's pending
        // runs once, then re-check.
        await harvestPendingOutputs(userId)
        owned = await ownedOutputKeys(userId)
        if (!owned.has(gate.key)) throw createError({ statusCode: 404, message: 'Image not found' })
      }
    }
  }

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
      const cacheFile = join(CACHE_DIR, cacheKey(filename, type, subfolder))
      if (!existsSync(cacheFile)) {
        mkdir(CACHE_DIR, { recursive: true })
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
  const cacheFile = join(CACHE_DIR, cacheKey(filename, type, subfolder))
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

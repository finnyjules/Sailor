// Turn a web image URL (a pick from the image-search results, or a generated
// picture's public URL) into an input-folder file the unified Image node can
// load. The browser can't fetch arbitrary image hosts (CORS), so the bytes come
// through here and are written by Sailor's own upload (server/native/uploads.ts)
// — the same landing spot as the Assets-panel copy in
// VueNodeCanvas.ensureInputFilename. Nothing reaches the engine (step 3, R10.8).
//
// The URL is external input: it is fetched under the server's one safe-fetch
// policy (server/templates/safeFetch.ts) — http(s) only, every address the
// host resolves to checked (no loopback or private network, locally or
// hosted), each redirect checked again, 20 seconds and 30 MB at most.
// Hosted, the stored file is recorded as the caller's own upload.
import { dispatchUpload } from '../native/router'
import { parseUploadForm } from '../utils/multipart'
import { canonicalUploadKey, recordUpload } from '../utils/inputUploads'
import { isHosted } from '../utils/deployMode'
import { FetchRefused, TooManyRedirects, safeFetch, type SafeFetchPolicy } from '../templates/safeFetch'
import { sniffPictureFormat } from '../utils/graphInputPixels'
import { assertRateLimit } from '../lib/rateLimit'

const MAX_BYTES = 30 * 1024 * 1024 // a full-res press photo is <10MB; 30 is generous

/** The pictures kept, by what their first bytes say (never the host's Content-Type). */
const EXT_BY_FORMAT: Record<string, string> = { png: '.png', jpeg: '.jpg', webp: '.webp', gif: '.gif' }

const WORDS = {
  refused: 'Refusing to fetch a local/private address',
  tooLarge: 'Image too large to import (>30MB)',
  timeout: 'The image took longer than 20 seconds to download',
}

export default defineEventHandler(async (event) => {
  const hosted = isHosted()
  const userId: string | null = event.context.userId ?? null
  if (hosted && !userId) throw createError({ statusCode: 401, message: 'Sign in required' })
  // Each call may write 30 MB into the input folder: per person (hosted), else per address.
  assertRateLimit(event, 'image-fetch', 30)

  const body = await readBody(event)
  const url = typeof body?.url === 'string' ? body.url.trim() : ''

  let parsed: URL
  try { parsed = new URL(url) } catch { throw createError({ statusCode: 400, message: 'Invalid image url' }) }
  if (!/^https?:$/.test(parsed.protocol)) throw createError({ statusCode: 400, message: 'Only http(s) urls can be imported' })

  const policy: SafeFetchPolicy = { hosted, loopbackView: false, timeoutMs: 20_000, maxBytes: MAX_BYTES, words: WORDS, accept: 'image/*' }
  let res: Awaited<ReturnType<typeof safeFetch>>
  try { res = await safeFetch(url, policy) }
  catch (err) {
    if (err instanceof FetchRefused) {
      throw createError({ statusCode: err.message === WORDS.tooLarge ? 413 : err.message === WORDS.timeout ? 504 : 400, message: err.message })
    }
    if (err instanceof TooManyRedirects) throw createError({ statusCode: 502, message: 'Could not download the image: too many redirects' })
    throw createError({ statusCode: 502, message: `Could not download the image: ${err instanceof Error ? err.message : String(err)}` })
  }
  if (res.status < 200 || res.status >= 300) throw createError({ statusCode: 502, message: `The image host returned ${res.status}` })

  const mime = (res.contentType || '').split(';')[0]!.trim().toLowerCase()
  if (!mime.startsWith('image/')) throw createError({ statusCode: 415, message: `Not an image (${mime || 'unknown type'})` })
  const buf = res.data
  if (buf.byteLength === 0) throw createError({ statusCode: 502, message: 'The image was empty' })
  if (buf.byteLength > MAX_BYTES) throw createError({ statusCode: 413, message: WORDS.tooLarge })
  // The bytes must really be a PNG, JPEG, WebP or GIF, whatever the host said.
  const format = sniffPictureFormat(new Uint8Array(buf, 0, Math.min(buf.byteLength, 32)))
  const ext = format ? EXT_BY_FORMAT[format] : undefined
  if (!ext) throw createError({ statusCode: 415, message: 'Not a PNG, JPEG, WebP or GIF picture' })

  // A readable, collision-safe input filename: sanitized url basename + short stamp.
  let rawBase = parsed.pathname.split('/').pop() || 'image'
  try { rawBase = decodeURIComponent(rawBase) } catch { /* a malformed escape stays literal */ }
  const base = rawBase.replace(/\.[a-z0-9]+$/i, '').replace(/[^a-z0-9._-]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'image'
  const filename = `websearch_${base}_${Date.now().toString(36)}${ext}`

  // Sailor's own upload, as POST /upload/image: no overwrite — a name already
  // taken gets the upload's own ` (1)` suffix, never someone else's file.
  const fd = new FormData()
  fd.append('image', new Blob([buf], { type: `image/${format}` }), filename)
  fd.append('type', 'input')
  const encoded = new Response(fd)
  const form = await parseUploadForm(new Uint8Array(await encoded.arrayBuffer()), encoded.headers.get('content-type') || '')
  const upload = await dispatchUpload('/upload/image', 'POST', form)
  if (upload.status < 200 || upload.status >= 300) {
    throw createError({ statusCode: 502, message: upload.status === 503 ? 'The input folder could not be found' : `The image could not be saved (${upload.status})` })
  }
  const stored = upload.body as { name?: unknown, subfolder?: unknown, type?: unknown }
  const name = typeof stored?.name === 'string' && stored.name ? stored.name : filename
  if (hosted && userId) {
    await recordUpload(userId, canonicalUploadKey('input', typeof stored?.subfolder === 'string' ? stored.subfolder : '', name))
  }
  return { name }
})

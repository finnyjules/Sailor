/**
 * POST /api/depth/surfaces — photo surfaces from MoGe-2 on fal, for the
 * Relight layer effect (stage 2, Task 1). Replaces the dev-only prototype
 * route `depth/moge-normals.post.ts` (untracked, deleted by this task).
 *
 * Body:    { filename, subfolder?, type?, peek? } — same addressing as /api/depth/estimate.
 * Returns: { normalsFilename, subfolder: 'sailor_depth', cached }
 *          503 { off: true }  — kill switch (NUXT_RELIGHT_SURFACES=off), or a hosted
 *                               unpriced/unmetered refusal: the client stays on local depth
 *          402 { message }    — hosted, not enough credits (also quiet on the client)
 *          503 { retryLater } — fal had not finished within the 600 s poll
 *          4xx/5xx { message } — path/ownership/provider failures
 *
 * `peek: true` (2026-09-30, "Read shape" button): a FREE probe — same gates (kill switch,
 * rate limit, path safety, ownership) and the same cache check, but it NEVER calls fal. A
 * cached photo answers exactly like a normal read (`{ normalsFilename, subfolder, cached:
 * true }`); an uncached one answers 200 `{ absent: true }` instead of starting a read. The
 * Frame editor peeks every visible Relight layer's photo for free so an already-cached photo
 * keeps lighting automatically; an explicit "Read shape" click is what starts the paid read.
 * Peeks share the kill switch and ownership gates with a real read (so they can't be used to
 * probe files that aren't the caller's own) but use a separate, more generous rate-limit
 * bucket — they cost nothing and the Frame editor calls one per visible Relight photo.
 *
 * One read per photo at a time: a second request for a photo already being read
 * waits for that read and answers `cached: true` (free — it made no call). The
 * cache file is written to a temp name and renamed, so a reader never sees half
 * a PNG. The photo is sent at most 1536 px on its long edge (the cache key stays
 * the ORIGINAL file's content hash).
 *
 * The map is fal's normal PNG as is: red = right, green = UP, blue = toward the
 * camera. Cached by content hash next to the depth maps (`moge_<hash>.png`), so a
 * photo is paid for once (global-constraints.md: $0.0125/call, metered through
 * runFal). A cache hit never calls fal and is never metered.
 *
 * Hosted: rate-limited, and the source file must be readable by the caller
 * (assertInputOwned: an input they own, an output of their own run — the /view
 * gate — or temp, ungated as /view leaves it). runFal takes the ledger hold
 * before dispatch and releases it on any throw.
 */
import { readFile, mkdir, writeFile, access, rename, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import sharp from 'sharp'
import { depthCacheKey, assetType, safeAssetRelPath } from '../../utils/depthCache'
import { assertRateLimit } from '../../lib/rateLimit'
import { assertInputOwned } from '../../utils/inputOwnership'
import { runFal } from '../../utils/falRun'
import { MeterRefusalError } from '../../utils/requestMeter'
import { downloadResult } from '../../runner/falQueue'
import { SURFACES_APP } from '../../../shared/pricing/relightSurfaces'
import { dataPath } from '../../utils/dataRoot'

const CACHE_SUBDIR = 'sailor_depth'
// Fix round 1 (review): the old `fetch(url).arrayBuffer()` had no size cap and no
// content-type check — a compromised or misbehaving fal endpoint could hand back an
// arbitrarily large or non-image body and this route would write it straight into the
// cache. downloadResult (falQueue.ts's capped, retried download helper — the same one
// the runner uses for a finished provider answer) drives a fetchOnce that caps the read
// WHILE STREAMING (never buffers an oversized body first) and reports the content-type
// for the check below. `sleep` is a no-op: a too-large or wrong-shape body will not fix
// itself on retry, so there is no reason to wait between the (still retried, for a
// genuine transient network blip) attempts.
const NORMAL_MAP_MAX_BYTES = 64 * 1024 * 1024

/** One try at the normal-map download: same shape as answerDownload.ts's
 *  AnswerFetchOnce, but over the plain global `fetch` (this route's downloads are
 *  always fal's own CDN URL from a trusted provider response, not a URL a caller
 *  picks — no SSRF surface to defend, unlike a layout's user-supplied image URLs). */
async function cappedFetchOnce(url: string, o: { maxBytes?: number; signal?: AbortSignal }): Promise<{ status: number; contentType: string | null; bytes: Uint8Array }> {
  const res = await fetch(url, o.signal ? { signal: o.signal } : {})
  const contentType = res.headers.get('content-type')
  if (!res.ok) return { status: res.status, contentType, bytes: new Uint8Array(0) }
  const cap = o.maxBytes
  const len = res.headers.get('content-length')
  if (cap !== undefined && len && Number(len) > cap) {
    throw new Error(`normal map is too large (${len} bytes, over the ${cap}-byte cap)`)
  }
  const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader?.()
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer())
    if (cap !== undefined && buf.byteLength > cap) throw new Error(`normal map is too large (over the ${cap}-byte cap)`)
    return { status: res.status, contentType, bytes: buf }
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (cap !== undefined && total > cap) {
      await reader.cancel().catch(() => {})
      throw new Error(`normal map is too large (over the ${cap}-byte cap)`)
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) { bytes.set(c, offset); offset += c.byteLength }
  return { status: res.status, contentType, bytes }
}

/** Pure path derivation from an engine root — factored out so tests can point
 *  it at a scratch directory instead of the real ComfyUI checkout. */
export function surfacesPaths(root: string): { comfyRoot: string; cacheDir: string } {
  return { comfyRoot: root, cacheDir: join(root, 'input', CACHE_SUBDIR) }
}

let rootOverride: string | undefined
/** Test-only seam: point the route at a scratch engine root. */
export function __setSurfacesRootForTests(root: string | undefined): void { rootOverride = root }

function engineRoot(): string {
  return rootOverride ?? dataPath()
}

const exists = (p: string) => access(p).then(() => true, () => false)

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

/** Normals drive lighting, not detail — like the depth route's MAX_EDGE, a bound on the
 *  work: sources run to 4k, and a smaller upload is cheaper and faster on fal. */
const SEND_MAX_EDGE = 1536

/** Poll for up to 10 minutes (cold starts measured at 203 s). Past that runFal gives up on
 *  the request without cancelling it (it only throws — no cancel call), so fal may still
 *  finish and bill it; the hold is released and the answer is 503 { retryLater }. */
const POLL_DEADLINE_MS = 600_000

/** The photo as a data URI, downscaled to SEND_MAX_EDGE on the long edge when larger.
 *  Bytes sharp cannot read are sent as they are (fal answers for them). */
async function photoDataUri(bytes: Uint8Array, ext: string): Promise<string> {
  let meta: { width?: number; height?: number } | null = null
  try { meta = await sharp(bytes).metadata() } catch { meta = null }
  const long = Math.max(meta?.width ?? 0, meta?.height ?? 0)
  if (long > SEND_MAX_EDGE) {
    const png = await sharp(bytes)
      .resize({ width: SEND_MAX_EDGE, height: SEND_MAX_EDGE, fit: 'inside' })
      .png()
      .toBuffer()
    return `data:image/png;base64,${png.toString('base64')}`
  }
  return `data:${MIME[ext] ?? 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`
}

/** A read's non-provider outcome, answered with its own status (not thrown as a 502). */
class SurfacesAnswer extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown>) { super(String(body.message ?? status)) }
}

/** One in-flight read per cache file: a concurrent request for the same photo awaits it. */
const inFlight = new Map<string, Promise<void>>()

export default defineEventHandler(async (event) => {
  if (process.env.NUXT_RELIGHT_SURFACES === 'off') {
    setResponseStatus(event, 503)
    return { off: true }
  }

  const body = await readBody<{ filename?: string; subfolder?: string; type?: string; peek?: boolean }>(event)
  const peek = body?.peek === true

  assertRateLimit(event, peek ? 'depth-surfaces-peek' : 'depth-surfaces', peek ? 120 : 20)

  const root = assetType(body?.type)
  if (!root) throw createError({ statusCode: 400, message: `unknown asset type: ${body?.type}` })
  const rel = safeAssetRelPath(body?.filename ?? '', body?.subfolder)
  if (!rel) throw createError({ statusCode: 400, message: 'a safe filename is required' })

  await assertInputOwned(event, root, body?.subfolder ?? '', body?.filename ?? '')

  const { comfyRoot, cacheDir } = surfacesPaths(engineRoot())

  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(await readFile(join(comfyRoot, root, rel)))
  } catch {
    throw createError({ statusCode: 404, message: `not found in ${root}: ${rel}` })
  }

  const name = `moge_${depthCacheKey(bytes)}.png`
  const outPath = join(cacheDir, name)
  if (await exists(outPath)) return { normalsFilename: name, subfolder: CACHE_SUBDIR, cached: true }

  // A peek never calls fal: nothing cached means "absent", not a read.
  if (peek) return { absent: true }

  const ext = rel.split('.').pop()?.toLowerCase() ?? 'png'

  const pending = inFlight.get(name)
  let job: Promise<void>
  let joined = false
  if (pending) {
    job = pending
    joined = true
  } else {
    job = readSurfaces(bytes, ext, cacheDir, outPath).finally(() => { inFlight.delete(name) })
    inFlight.set(name, job)
  }

  try {
    await job
  } catch (err) {
    if (err instanceof SurfacesAnswer) {
      setResponseStatus(event, err.status)
      return err.body
    }
    throw err
  }
  // A joined request made no call of its own: for it the map was already paid for.
  return { normalsFilename: name, subfolder: CACHE_SUBDIR, cached: joined }
})

async function readSurfaces(bytes: Uint8Array, ext: string, cacheDir: string, outPath: string): Promise<void> {
  const dataUri = await photoDataUri(bytes, ext)

  let out: { normal_map?: { url?: string } }
  try {
    out = await runFal<{ normal_map?: { url?: string } }>(SURFACES_APP, {
      image_url: dataUri,
      model: 'vitl-normal',
      apply_mask: false,
      export_glb: false,
      export_ply: false,
    }, { pollDeadlineMs: POLL_DEADLINE_MS })
  } catch (err) {
    // Hosted refusals pass through as themselves: 402 no balance; an unpriced/unmetered
    // refusal is a server decision the user can't act on, so it is quiet like the kill switch.
    if (err instanceof MeterRefusalError) {
      if (err.statusCode === 402) throw new SurfacesAnswer(402, { message: err.message })
      throw new SurfacesAnswer(503, { off: true, message: err.message })
    }
    const message = (err as Error).message
    if (/^fal request timed out/.test(message)) {
      throw new SurfacesAnswer(503, { retryLater: true, message: 'moge-2 is still reading this photo' })
    }
    throw createError({ statusCode: 502, message: `moge-2: ${message}` })
  }

  const url = out.normal_map?.url
  if (!url) throw createError({ statusCode: 502, message: 'moge-2 returned no normal map' })

  let pngBytes: Uint8Array
  let contentType: string | null
  try {
    const dl = await downloadResult(url, {
      maxBytes: NORMAL_MAP_MAX_BYTES,
      signal: AbortSignal.timeout(60_000),
      fetchOnce: cappedFetchOnce,
      sleep: async () => {},
    })
    pngBytes = dl.bytes
    contentType = dl.contentType
  } catch (err) {
    throw createError({ statusCode: 502, message: `normal map download: ${(err as Error).message}` })
  }
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    throw createError({ statusCode: 502, message: `normal map download returned a non-image content-type: ${contentType}` })
  }

  await mkdir(cacheDir, { recursive: true })
  // Temp name + rename: a concurrent reader (or /view) never sees a half-written map.
  const tmp = `${outPath}.tmp-${randomBytes(6).toString('hex')}`
  try {
    await writeFile(tmp, pngBytes)
    await rename(tmp, outPath)
  } catch (err) {
    await unlink(tmp).catch(() => {})
    throw err
  }
}


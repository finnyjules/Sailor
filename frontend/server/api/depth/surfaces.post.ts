/**
 * POST /api/depth/surfaces — photo surfaces from MoGe-2 on fal, for the
 * Relight layer effect (stage 2, Task 1). Replaces the dev-only prototype
 * route `depth/moge-normals.post.ts` (untracked, deleted by this task).
 *
 * Body:    { filename, subfolder?, type? } — same addressing as /api/depth/estimate.
 * Returns: { normalsFilename, subfolder: 'sailor_depth', cached }
 *          503 { off: true }  — kill switch (NUXT_RELIGHT_SURFACES=off)
 *          4xx/5xx { message } — path/ownership/provider failures
 *
 * The map is fal's normal PNG as is: red = right, green = UP, blue = toward the
 * camera. Cached by content hash next to the depth maps (`moge_<hash>.png`), so a
 * photo is paid for once (global-constraints.md: $0.0125/call, metered through
 * runFal). A cache hit never calls fal and is never metered.
 *
 * Hosted: rate-limited, and the source file must be owned by the caller
 * (assertInputOwned) — the moodboards/refs.post.ts pattern. runFal takes the
 * ledger hold before dispatch and releases it on any throw.
 */
import { readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { join } from 'node:path'
import { depthCacheKey, assetType, safeAssetRelPath } from '../../utils/depthCache'
import { assertRateLimit } from '../../lib/rateLimit'
import { assertInputOwned } from '../../utils/inputOwnership'
import { runFal } from '../../utils/falRun'
import { downloadResult } from '../../runner/falQueue'
import { SURFACES_APP } from '../../../shared/pricing/relightSurfaces'

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
  return rootOverride ?? join(process.cwd(), '..')
}

const exists = (p: string) => access(p).then(() => true, () => false)

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }

export default defineEventHandler(async (event) => {
  if (process.env.NUXT_RELIGHT_SURFACES === 'off') {
    setResponseStatus(event, 503)
    return { off: true }
  }

  assertRateLimit(event, 'depth-surfaces', 20)

  const body = await readBody<{ filename?: string; subfolder?: string; type?: string }>(event)
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

  const ext = rel.split('.').pop()?.toLowerCase() ?? 'png'
  const dataUri = `data:${MIME[ext] ?? 'image/png'};base64,${Buffer.from(bytes).toString('base64')}`

  let out: { normal_map?: { url?: string } }
  try {
    out = await runFal<{ normal_map?: { url?: string } }>(SURFACES_APP, {
      image_url: dataUri,
      model: 'vitl-normal',
      apply_mask: false,
      export_glb: false,
      export_ply: false,
    }, { pollDeadlineMs: 300_000 })
  } catch (err) {
    throw createError({ statusCode: 502, message: `moge-2: ${(err as Error).message}` })
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
  await writeFile(outPath, pngBytes)
  return { normalsFilename: name, subfolder: CACHE_SUBDIR, cached: false }
})

/**
 * GET /api/scene3d/hdri/:slug
 * Streams a Poly Haven studio .hdr equirect, caching it under the engine's
 * `input/sailor_hdri/<slug>_<res>.hdr` on first request. Same-origin so the browser's
 * RGBELoader never touches an external host (avoids CSP/CORS surprises), and the file is
 * fetched from Poly Haven's CDN only once — thereafter served straight off disk (offline-safe).
 *
 * The slug is validated to Poly Haven's own casing and dropped into a FIXED CDN URL, so it can
 * only ever address a Poly Haven HDRI — never an arbitrary host (no SSRF).
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { engineDirForType } from '../../../utils/inputUploads'

const RES = '2k' // studio HDRIs: 2k gives crisp specular reflections (gem sparkle) yet caches small
const DOWNLOAD_TIMEOUT_MS = 60_000

const inflight = new Map<string, Promise<Uint8Array>>()

function cacheDirOrThrow(): string {
  const dir = engineDirForType('input')
  if (!dir) throw createError({ statusCode: 502, message: "Couldn't find the engine's input folder on this server" })
  return join(dir, 'sailor_hdri')
}

async function readIfPresent(path: string): Promise<Uint8Array | null> {
  try {
    await access(path)
    return new Uint8Array(await readFile(path))
  } catch {
    return null
  }
}

async function downloadHdri(cacheDir: string, slug: string): Promise<Uint8Array> {
  const file = join(cacheDir, `${slug}_${RES}.hdr`)
  const onDisk = await readIfPresent(file)
  if (onDisk) return onDisk

  const url = `https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/${RES}/${slug}_${RES}.hdr`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS)
  let bytes: Uint8Array
  try {
    const r = await fetch(url, { redirect: 'follow', signal: ctrl.signal })
    if (r.status === 404) throw createError({ statusCode: 404, message: `unknown HDRI: ${slug}` })
    if (!r.ok) throw new Error(`Poly Haven download ${r.status}`)
    bytes = new Uint8Array(await r.arrayBuffer())
  } finally {
    clearTimeout(timer)
  }
  await mkdir(cacheDir, { recursive: true })
  await writeFile(file, bytes)
  return bytes
}

export default defineEventHandler(async (event) => {
  const slug = String(getRouterParam(event, 'slug') ?? '').trim()
  // Poly Haven slugs are lowercase alphanumerics + underscores. This is also the security check:
  // the slug becomes a path segment AND fills the fixed CDN URL.
  if (!/^[a-z0-9_]{1,80}$/.test(slug)) throw createError({ statusCode: 400, message: 'invalid HDRI slug' })

  const cacheDir = cacheDirOrThrow()

  let p = inflight.get(slug)
  if (!p) {
    p = downloadHdri(cacheDir, slug).finally(() => inflight.delete(slug))
    inflight.set(slug, p)
  }
  let bytes: Uint8Array
  try {
    bytes = await p
  } catch (err: any) {
    if (err?.statusCode === 404) throw err
    throw createError({ statusCode: 502, message: `Couldn't download this HDRI: ${err?.message ?? err}` })
  }

  setHeader(event, 'Content-Type', 'image/vnd.radiance')
  setHeader(event, 'Cache-Control', 'public, max-age=31536000, immutable')
  return bytes
})

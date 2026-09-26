/**
 * Render a template layout to a PNG: layout JSON → satori (SVG) → resvg
 * (PNG). Both libraries are pure JS, no native browser needed. Curated fonts
 * are loaded once and reused across renders.
 *
 * Called by the route (server/api/render-template.post.ts) and by the
 * runner's Smart Layout card (server/runner/cards/smartLayout.ts), which
 * hands every image layer as a `data:` URL (it has no HTTP origin).
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RenderRequest } from './schema'
import { readManifest, USER_FONTS_DIR } from './fonts-store'
import { ImageAddressError, ImageLimitError, tableTreeImages, type ImageFetcher } from './inlineImages'
import { TemplateSizeError, templateToSatori } from './translate'
import { LAYOUT_BAD_SHAPE, LAYOUT_MAX_REMOTE_FONTS, LAYOUT_TOO_MANY_FONTS } from '../../shared/template-grid/limits'
import { safeImageFetcher } from './safeFetch'
import { RENDER_TIMEOUT, svgToPngInProcess } from './renderProcess'
import { isHosted } from '../utils/deployMode'
import { TEMPLATE_FONTS } from '../../shared/template-fonts'
import { resolveTokens } from '../../shared/template-grid/tokens'
import { resolveLibraryFaceByFamily } from '../utils/libraryFontManifest'

interface LoadedFont {
  name: string
  data: ArrayBuffer
  weight: 400 | 700
  style: 'normal'
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

// Curated families (shared/template-fonts.ts) — read once from node_modules.
let curatedCache: LoadedFont[] | null = null

async function loadCuratedFonts(): Promise<LoadedFont[]> {
  if (curatedCache) return curatedCache
  const out: LoadedFont[] = []
  for (const fam of TEMPLATE_FONTS) {
    for (const w of fam.weights) {
      try {
        const buf = await readFile(join(process.cwd(), 'node_modules', w.modulePath))
        out.push({ name: fam.name, data: toArrayBuffer(buf), weight: w.weight, style: 'normal' })
      } catch {
        // Missing fontsource file — skip; Inter (also curated) still covers.
      }
    }
  }
  curatedCache = out
  return out
}

// Uploaded ("Brand fonts") families — read from the gitignored user dir each
// render (few, small files; avoids cross-render staleness on re-upload). The
// single-covers-both manifest mirror means a one-file family registers 400+700.
async function loadUploadedFonts(): Promise<LoadedFont[]> {
  const manifest = await readManifest()
  const out: LoadedFont[] = []
  const bytesByFile = new Map<string, ArrayBuffer>()  // mirror reads once per render
  for (const fam of manifest) {
    for (const weight of ['400', '700'] as const) {
      const file = fam.weights[weight]
      if (!file) continue
      let data = bytesByFile.get(file)
      if (!data) {
        try {
          data = toArrayBuffer(await readFile(join(USER_FONTS_DIR, file)))
        } catch {
          continue // file removed out from under the manifest — skip
        }
        bytesByFile.set(file, data)
      }
      out.push({ name: fam.family, data, weight: Number(weight) as 400 | 700, style: 'normal' })
    }
  }
  return out
}

// Pangram/Off-Type library families: resolve straight from the committed
// manifest to an on-disk OTF (no network). Checked before Google so a
// library family is never also attempted as a Google family (which would
// 404 — the manifest's family names aren't Google families).
async function loadLibraryFonts(families: string[]): Promise<LoadedFont[]> {
  const out: LoadedFont[] = []
  for (const family of families) {
    for (const weight of [400, 700] as const) {
      const face = resolveLibraryFaceByFamily(family, weight, false)
      if (!face) continue
      try {
        const buf = await readFile(face.path)
        out.push({ name: family, data: toArrayBuffer(buf), weight, style: 'normal' })
      } catch {
        // File missing on disk despite manifest entry — skip this weight.
      }
    }
  }
  return out
}

// Non-curated families picked in the editor's font picker: fetch TTFs from
// Google Fonts on first use and keep them for later renders. A non-browser
// User-Agent makes Google return TTF sources — satori can't parse woff2.
//
// Fix round 4: both caches are bounded (least recently used goes first), each
// fetch has its own time limit and ends with the render (Stop, deadline), a
// font file is at most GOOGLE_FONT_MAX_BYTES and comes from Google's font
// host, and a render may name at most LAYOUT_MAX_REMOTE_FONTS such families.
export const GOOGLE_FONT_TIMEOUT_MS = 10_000
export const GOOGLE_FONT_MAX_BYTES = 10 * 1024 * 1024
export const GOOGLE_CACHE_MAX_FAMILIES = 64
export const GOOGLE_CACHE_MAX_BYTES = 64 * 1024 * 1024
export const GOOGLE_FAILED_MAX = 1024
const googleCache = new Map<string, LoadedFont[]>()
let googleCacheBytes = 0
const googleFailed = new Set<string>()
const fontBytes = (fonts: LoadedFont[]) => fonts.reduce((n, f) => n + f.data.byteLength, 0)

function cacheGoogle(family: string, fonts: LoadedFont[]): void {
  const old = googleCache.get(family)
  if (old) { googleCache.delete(family); googleCacheBytes -= fontBytes(old) }
  googleCache.set(family, fonts)
  googleCacheBytes += fontBytes(fonts)
  for (const [k, v] of googleCache) {
    if (googleCache.size <= GOOGLE_CACHE_MAX_FAMILIES && googleCacheBytes <= GOOGLE_CACHE_MAX_BYTES) break
    if (k === family) continue
    googleCache.delete(k)
    googleCacheBytes -= fontBytes(v)
  }
}

function markFailed(family: string): void {
  googleFailed.delete(family)
  googleFailed.add(family)
  for (const k of googleFailed) {
    if (googleFailed.size <= GOOGLE_FAILED_MAX) break
    googleFailed.delete(k)
  }
}

/** A response's body, at most `max` bytes (null past it). */
async function readCapped(res: Response, max: number): Promise<ArrayBuffer | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) { await res.body?.cancel().catch(() => {}); return null }
  if (!res.body) return new ArrayBuffer(0)
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const c of res.body as unknown as AsyncIterable<Uint8Array>) {
    size += c.byteLength
    if (size > max) return null
    chunks.push(c)
  }
  const buf = Buffer.concat(chunks)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

export async function loadGoogleFamily(family: string, signal?: AbortSignal): Promise<LoadedFont[]> {
  const cached = googleCache.get(family)
  if (cached) {
    googleCache.delete(family)
    googleCache.set(family, cached)
    return cached
  }
  if (googleFailed.has(family)) return []
  const timeout = AbortSignal.timeout(g.__sailorGoogleFontTimeoutMs ?? GOOGLE_FONT_TIMEOUT_MS)
  const s = signal ? AbortSignal.any([signal, timeout]) : timeout
  try {
    const f = encodeURIComponent(family).replace(/%20/g, '+')
    const cssRes = await (g.__sailorGoogleFetch ?? fetch)(
      `https://fonts.googleapis.com/css2?family=${f}:wght@400;700&display=swap`,
      { headers: { 'User-Agent': 'curl/8' }, signal: s },
    )
    if (!cssRes.ok) throw new Error(`css ${cssRes.status}`)
    const cssBytes = await readCapped(cssRes, 256 * 1024)
    if (!cssBytes) throw new Error('css too large')
    const css = Buffer.from(cssBytes).toString('utf8')
    const fonts: LoadedFont[] = []
    for (const block of css.split('@font-face').slice(1)) {
      const weight = /font-weight:\s*(\d+)/.exec(block)?.[1]
      const url = /src:\s*url\(([^)]+\.ttf)\)/.exec(block)?.[1]
      if (!url || (weight !== '400' && weight !== '700')) continue
      if (!url.startsWith('https://fonts.gstatic.com/')) continue
      const ttf = await (g.__sailorGoogleFetch ?? fetch)(url, { signal: s })
      if (!ttf.ok) continue
      const data = await readCapped(ttf, GOOGLE_FONT_MAX_BYTES)
      if (!data) continue
      fonts.push({ name: family, data, weight: Number(weight) as 400 | 700, style: 'normal' })
    }
    if (!fonts.length) throw new Error('no ttf faces')
    cacheGoogle(family, fonts)
    return fonts
  } catch (e) {
    // The render stopped (Stop, disconnect, deadline): the render ends, the family isn't marked.
    if (signal?.aborted) throw e
    markFailed(family)  // don't re-fetch a broken (or hung) family every render
    return []
  }
}

/** Every fontFamily the translated layout shows: the rendered format only
 * (fix round 4), hidden and culled elements left out. `{{ brand.* }}`
 * tokens resolve against the merged brand so brand-bound fonts are fetched too. */
function treeFamilies(tree: unknown, brand: Record<string, unknown>): string[] {
  const fams = new Set<string>()
  const stack: unknown[] = [tree]
  while (stack.length) {
    const n = stack.pop() as { props?: { style?: { fontFamily?: unknown }; children?: unknown } } | null
    if (!n || typeof n !== 'object') continue
    const f = n.props?.style?.fontFamily
    if (typeof f === 'string' && f.trim()) {
      const r = String(resolveTokens(f.trim(), {}, brand)).trim()
      if (r) fams.add(r)
    }
    const kids = n.props?.children
    if (Array.isArray(kids)) stack.push(...kids)
    else if (kids && typeof kids === 'object') stack.push(kids)
  }
  return [...fams]
}

async function loadFonts(tree: unknown, template: unknown, brand: Record<string, unknown>, signal?: AbortSignal): Promise<LoadedFont[]> {
  const merged = { ...((template as any)?.brand ?? {}), ...brand }
  // Tiers: curated → uploaded → library → Google. Google fills only families
  // in none of the local sets, so a library (or uploaded) family wins a name
  // collision with a Google one, and is never ALSO attempted as Google.
  const curated = await loadCuratedFonts()
  const uploaded = await loadUploadedFonts()
  const referenced = treeFamilies(tree, merged)
  const library = await loadLibraryFonts(referenced.filter(n =>
    !curated.some(f => f.name === n) && !uploaded.some(f => f.name === n)))
  const localNames = new Set([...curated, ...uploaded, ...library].map(f => f.name))
  const remote = referenced.filter(n => !localNames.has(n))
  if (remote.length > LAYOUT_MAX_REMOTE_FONTS) throw new TemplateSizeError(LAYOUT_TOO_MANY_FONTS)
  const extra = (await Promise.all(remote.map(n => loadGoogleFamily(n, signal)))).flat()
  return [...curated, ...uploaded, ...library, ...extra]
}

/** An image in the layout could not be fetched: the route answers 502. */
export class TemplateImageError extends Error {}

export interface RenderOptions {
  /** How http(s) images are fetched: the safe fetcher (./safeFetch.ts) by default. */
  fetcher?: ImageFetcher
  /** Stops the render (its process is killed). */
  signal?: AbortSignal
}

/** One render's whole deadline (fix round 3): fetches, bakes and the render together, queue waits included. */
export const RENDER_DEADLINE_MS = 60_000

/**
 * The PNG for one render request: the route's body before R1.6, with the
 * satori and resvg steps in the render process (./renderProcess.ts) and images
 * fetched under the safe policy (fix round 1). Same code, same fonts, same bytes.
 * Round 3: one deadline for the whole render, and Stop (or the client going
 * away) ends its fetches and bakes too; the pictures' limits refused plainly.
 */
export async function renderTemplatePng(body: RenderRequest, opts: RenderOptions = {}): Promise<Uint8Array> {
  const deadline = AbortSignal.timeout(g.__sailorRenderDeadlineMs ?? RENDER_DEADLINE_MS)
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline
  const stopped = () => new Error(deadline.aborted && !opts.signal?.aborted ? RENDER_TIMEOUT : 'Stopped')

  // The layout's own shape and limits first (size, elements, text): nothing is loaded for one refused.
  let translated: ReturnType<typeof templateToSatori>
  try {
    translated = templateToSatori(
      body.template,
      body.aspect,
      body.props ?? {},
      body.brand ?? {},
      body.width && body.height ? { width: body.width, height: body.height } : undefined,
      body.outputId,
    )
  } catch (e) {
    // Backstop (fix round 4): a layout the shape check let through but the
    // translation can't read is refused plainly, never a server error.
    if (e instanceof TypeError) throw new TemplateSizeError(LAYOUT_BAD_SHAPE)
    throw e
  }
  const { tree, width, height } = translated

  let fonts: LoadedFont[]
  try {
    fonts = await loadFonts(tree, body.template, (body.brand ?? {}) as Record<string, unknown>, signal)
  } catch (e) {
    if (signal.aborted) throw stopped()
    throw e
  }
  if (signal.aborted) throw stopped()

  // Every remote image fetched BEFORE satori: its own remote loading fails
  // silently (a 404 just skips the image → plausible-but-wrong output). A dead
  // URL now rejects the render with a clear error instead. Each distinct
  // picture travels to the render process once (fix round 4).
  let images: Awaited<ReturnType<typeof tableTreeImages>>
  try {
    images = await tableTreeImages(tree, opts.fetcher ?? safeImageFetcher({ hosted: isHosted() }), { signal })
  } catch (e) {
    if (signal.aborted) throw stopped()
    if (e instanceof ImageLimitError || e instanceof ImageAddressError) throw new TemplateSizeError(e.message)
    throw new TemplateImageError(String((e as Error).message ?? e).slice(0, 200))
  }

  // satori → SVG, resvg → PNG (fitTo: original honours the size satori sized
  // to), in the render process: the tree is plain objects, the fonts and
  // pictures their bytes.
  return svgToPngInProcess({
    tree, width, height, images,
    fonts: fonts.map((f) => ({ name: f.name, data: f.data, weight: f.weight, style: f.style })),
  }, signal)
}

const g = globalThis as unknown as { __sailorRenderDeadlineMs?: number; __sailorGoogleFontTimeoutMs?: number; __sailorGoogleFetch?: typeof fetch | null }

/** Tests only: the render's whole deadline (null restores a minute). */
export function __setRenderDeadlineForTests(ms: number | null): void {
  g.__sailorRenderDeadlineMs = ms ?? undefined
}

/** Tests only: Google Fonts' fetch and its per-fetch limit (null restores them), and the caches' sizes. */
export function __setGoogleFontsForTests(o: { fetch?: typeof fetch | null; timeoutMs?: number | null; clear?: boolean }): { cached: number; cachedBytes: number; failed: number } {
  if (o.fetch !== undefined) g.__sailorGoogleFetch = o.fetch
  if (o.timeoutMs !== undefined) g.__sailorGoogleFontTimeoutMs = o.timeoutMs ?? undefined
  if (o.clear) { googleCache.clear(); googleCacheBytes = 0; googleFailed.clear() }
  return { cached: googleCache.size, cachedBytes: googleCacheBytes, failed: googleFailed.size }
}

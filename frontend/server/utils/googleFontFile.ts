/**
 * Shared, fail-closed(-ish) Google Fonts cut fetcher.
 *
 * `validateGoogleCut` checks a `family`/`weight` pair against the server's
 * Google Fonts catalog (server/utils/googleCatalog.ts) BEFORE any upstream
 * fetch happens. The FAMILY is fail-closed — unknown, empty, or junk is
 * refused with a 400, never silently substituted or fetched anyway. The
 * WEIGHT is not: a family that doesn't ship the requested weight SNAPS to its
 * nearest shipped one (`nearestWeight`, ties → the lower) rather than
 * refusing outright — Archivo Black ships only 400, and a caller with a
 * hardcoded `@700` default (several studios do) would otherwise 400 for no
 * benefit when 400 is the honest, requestable answer anyway. A non-finite or
 * missing weight still falls back the same way, to the nearest shipped
 * weight to 400.
 *
 * `fetchGoogleCutTtf` is the actual proxy: the Google Fonts CSS endpoint
 * (fonts.googleapis.com/css2) serves woff2 to modern browser user-agents but
 * plain truetype to old clients — we send an explicit `curl/8` User-Agent to
 * force the ttf variant, since opentype.js (the 3D Studio's font parser)
 * can't read woff2. In-memory cache keyed `family@weight`, 24h TTL, ~50-entry
 * cap (evict oldest by `at`) — mirrors googleCatalog.ts's cache style.
 *
 * Used by both server/api/fonts/google-file.get.ts (Vector Type, validated)
 * and server/api/scene3d/google-font-file.get.ts (a re-export of the same
 * handler, so the 3D Studio inherits the same validation).
 */

export interface GoogleCatalogEntry {
  family: string
  weights: number[]
}

export type ValidateGoogleCutResult =
  | { ok: true; family: string; weight: number }
  | { ok: false; status: 400; message: string }

function nearestWeight(weights: number[], target = 400): number {
  return weights.reduce((best, w) => (Math.abs(w - target) < Math.abs(best - target) ? w : best), weights[0]!)
}

export function validateGoogleCut(
  catalog: readonly GoogleCatalogEntry[],
  family: unknown,
  weight: unknown,
): ValidateGoogleCutResult {
  const familyStr = typeof family === 'string' ? family.trim() : ''
  if (!familyStr) return { ok: false, status: 400, message: 'family is required' }

  const entry = catalog.find(f => f.family === familyStr)
  if (!entry || !entry.weights.length) {
    return { ok: false, status: 400, message: `Unknown font family: ${familyStr}` }
  }

  if (weight === undefined || weight === null || weight === '') {
    return { ok: true, family: entry.family, weight: nearestWeight(entry.weights, 400) }
  }

  const weightNum = Number(weight)
  if (!Number.isFinite(weightNum)) {
    return { ok: false, status: 400, message: `Invalid weight: ${String(weight)}` }
  }
  const rounded = Math.round(weightNum)

  return { ok: true, family: entry.family, weight: nearestWeight(entry.weights, rounded) }
}

const TTL_MS = 24 * 60 * 60 * 1000
const MAX_ENTRIES = 50
const CURL_UA = 'curl/8'

interface CacheEntry {
  at: number
  buf: Buffer
}

const cache = new Map<string, CacheEntry>()

function evictIfNeeded() {
  if (cache.size < MAX_ENTRIES) return
  let oldestKey: string | null = null
  let oldestAt = Infinity
  for (const [key, entry] of cache) {
    if (entry.at < oldestAt) {
      oldestAt = entry.at
      oldestKey = key
    }
  }
  if (oldestKey) cache.delete(oldestKey)
}

export async function fetchGoogleCutTtf(family: string, weight: number): Promise<Buffer> {
  const cacheKey = `${family}@${weight}`
  const cached = cache.get(cacheKey)
  if (cached && Date.now() - cached.at < TTL_MS) {
    return cached.buf
  }

  // css2 convention: spaces in family names become `+` (not %20). Percent-encode
  // everything else first so a stray `&`/`#` in a family value can't inject
  // extra query params into the upstream request.
  const familyParam = encodeURIComponent(family).replace(/%20/g, '+')
  const cssUrl = `https://fonts.googleapis.com/css2?family=${familyParam}:wght@${weight}&display=swap`

  let css: string
  try {
    const r = await fetch(cssUrl, { headers: { 'User-Agent': CURL_UA }, signal: AbortSignal.timeout(10_000) })
    if (!r.ok) {
      if (r.status === 400 || r.status === 404) {
        throw createError({ statusCode: 404, message: 'Unknown font family or unsupported weight' })
      }
      throw createError({ statusCode: 502, message: `Google Fonts css2 returned ${r.status}` })
    }
    css = await r.text()
  } catch (err: any) {
    if (err?.statusCode) throw err
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw createError({ statusCode: 502, message: 'Google Fonts timed out' })
    }
    throw createError({ statusCode: 502, message: `Couldn't reach Google Fonts: ${err?.message ?? err}` })
  }

  const match = css.match(/url\((https:\/\/fonts\.gstatic\.com\/[^)]+)\)\s*format\('truetype'\)/)
  const ttfUrl = match?.[1]
  if (!ttfUrl) {
    throw createError({ statusCode: 502, message: 'No truetype font URL found in Google Fonts response' })
  }

  let buf: Buffer
  try {
    const r = await fetch(ttfUrl, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) throw createError({ statusCode: 502, message: `Font binary fetch returned ${r.status}` })
    buf = Buffer.from(await r.arrayBuffer())
  } catch (err: any) {
    if (err?.statusCode) throw err
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
      throw createError({ statusCode: 502, message: 'Google Fonts timed out' })
    }
    throw createError({ statusCode: 502, message: `Couldn't fetch font binary: ${err?.message ?? err}` })
  }

  evictIfNeeded()
  cache.set(cacheKey, { at: Date.now(), buf })

  return buf
}

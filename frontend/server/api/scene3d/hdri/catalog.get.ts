/**
 * GET /api/scene3d/hdri/catalog
 * The browsable Poly Haven HDRI library — {slug, name, categories}[] — fetched from Poly Haven's
 * public API once and cached in memory. Server-side so the browser never depends on that API's CORS,
 * and so a restart with Poly Haven unreachable still serves the last good list. Thumbnails and the
 * .hdr files load separately (thumbnails direct from the CDN, files via [slug].get.ts).
 */
const SOURCE = 'https://api.polyhaven.com/assets?type=hdris'
const TTL_MS = 6 * 60 * 60 * 1000 // 6h — the library changes rarely
const FETCH_TIMEOUT_MS = 20_000

export interface HdriCatalogEntry { slug: string; name: string; categories: string[] }

let cache: { at: number; entries: HdriCatalogEntry[] } | null = null
let inflight: Promise<HdriCatalogEntry[]> | null = null

async function fetchCatalog(): Promise<HdriCatalogEntry[]> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const r = await fetch(SOURCE, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`Poly Haven catalog ${r.status}`)
    const raw = (await r.json()) as Record<string, { name?: unknown; categories?: unknown }>
    const entries: HdriCatalogEntry[] = []
    for (const [slug, v] of Object.entries(raw)) {
      if (!/^[a-z0-9_]{1,80}$/.test(slug)) continue // matches the file route's slug guard
      entries.push({
        slug,
        name: typeof v?.name === 'string' ? v.name : slug,
        categories: Array.isArray(v?.categories) ? v.categories.filter((c): c is string => typeof c === 'string') : [],
      })
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return entries
  } finally {
    clearTimeout(timer)
  }
}

export default defineEventHandler(async () => {
  if (cache && Date.now() - cache.at < TTL_MS) return { entries: cache.entries }
  if (!inflight) {
    inflight = fetchCatalog()
      .then((entries) => { cache = { at: Date.now(), entries }; return entries })
      .finally(() => { inflight = null })
  }
  try {
    return { entries: await inflight }
  } catch (err: any) {
    if (cache) return { entries: cache.entries } // serve stale on a failed refresh
    throw createError({ statusCode: 502, message: `Couldn't load the HDRI library: ${err?.message ?? err}` })
  }
})

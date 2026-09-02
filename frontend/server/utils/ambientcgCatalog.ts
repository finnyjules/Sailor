/**
 * ambientCG material catalog — fetched from the public v2 JSON API, slimmed to what
 * the 3D Studio texture picker and the phrase resolver need, cached in memory for a
 * day. Mirrors googleCatalog.ts. The raw payload is ~14.6 MB; the slim list is well
 * under 1 MB. A failed refresh serves the stale copy rather than an empty picker —
 * the site is run by one person and the API is not built for production reliability.
 */
import { createError } from 'h3'

const SOURCE = 'https://ambientcg.com/api/v2/full_json?type=Material&limit=5000'
const TTL_MS = 24 * 60 * 60 * 1000
const THUMB_KEY = '256-JPG-242424'

export interface AmbientcgSet {
  id: string
  name: string
  category: string
  tags: string[]
  thumb: string
  popularity: number
}

let cache: { at: number; sets: AmbientcgSet[] } | null = null

export function slimCatalog(raw: unknown): AmbientcgSet[] {
  const list = Array.isArray((raw as any)?.foundAssets) ? (raw as any).foundAssets as any[] : []
  const out: AmbientcgSet[] = []
  for (const a of list) {
    if (!a || typeof a.assetId !== 'string' || !/^[A-Za-z0-9]+$/.test(a.assetId)) continue
    if (a.dataType !== 'Material') continue
    out.push({
      id: a.assetId,
      name: typeof a.displayName === 'string' ? a.displayName : a.assetId,
      category: typeof a.displayCategory === 'string' ? a.displayCategory : 'Other',
      tags: Array.isArray(a.tags) ? a.tags.filter((t: unknown) => typeof t === 'string').map((t: string) => t.toLowerCase()) : [],
      thumb: typeof a.previewImage?.[THUMB_KEY] === 'string' ? a.previewImage[THUMB_KEY] : '',
      popularity: Number.isFinite(a.popularityScore) ? a.popularityScore : 0,
    })
  }
  return out
}

export async function getAmbientcgCatalog(fetchImpl: typeof fetch = fetch): Promise<AmbientcgSet[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.sets
  try {
    const r = await fetchImpl(SOURCE, { headers: { Accept: 'application/json' } })
    if (!r.ok) throw new Error(`ambientCG catalog ${r.status}`)
    const sets = slimCatalog(await r.json())
    if (!sets.length) throw new Error('ambientCG catalog was empty')
    cache = { at: Date.now(), sets }
    return sets
  } catch (err: any) {
    if (cache) return cache.sets // stale beats empty
    throw createError({ statusCode: 502, message: `Couldn't reach the ambientCG texture library: ${err?.message ?? err}` })
  }
}

/** Tests only. `expireOnly` keeps the data but makes it stale. */
export function __resetAmbientcgCatalogForTest(expireOnly = false): void {
  if (expireOnly && cache) cache = { at: 0, sets: cache.sets }
  else cache = null
}

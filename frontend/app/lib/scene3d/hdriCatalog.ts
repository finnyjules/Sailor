// Client side of the browsable Poly Haven HDRI library: loads the catalog (once) from our
// same-origin cache route, and provides the rail/search filtering + thumbnail URLs the picker needs.
// The curated HDRI_ENVIRONMENTS (hdri.ts) become the "Featured" rail.
import { HDRI_ENVIRONMENTS } from './hdri'

export interface HdriCatalogEntry { slug: string; name: string; categories: string[] }

export interface HdriRail { id: string; label: string; category?: string }

// Featured first (the hand-picked studio set), then useful Poly Haven category tags (verified counts:
// studio 96, indoor 301, skies 299, sunrise-sunset 225, nature 532, night 61).
export const HDRI_RAILS: HdriRail[] = [
  { id: 'featured', label: 'Featured' },
  { id: 'studio', label: 'Studio', category: 'studio' },
  { id: 'indoor', label: 'Indoor', category: 'indoor' },
  { id: 'skies', label: 'Skies', category: 'skies' },
  { id: 'sunrise-sunset', label: 'Sunrise / sunset', category: 'sunrise-sunset' },
  { id: 'nature', label: 'Nature', category: 'nature' },
  { id: 'night', label: 'Night', category: 'night' },
]

/** Poly Haven thumbnail (CORS-open CDN). 256px is plenty for a picker card. */
export function hdriThumbUrl(slug: string): string {
  return `https://cdn.polyhaven.com/asset_img/thumbs/${slug}.png?width=256&height=256`
}

let catalogPromise: Promise<HdriCatalogEntry[]> | null = null

/** Load the full library once per session (the server caches it across sessions). */
export function loadHdriCatalog(fetchImpl: typeof fetch = fetch): Promise<HdriCatalogEntry[]> {
  if (!catalogPromise) {
    catalogPromise = fetchImpl('/api/scene3d/hdri/catalog')
      .then((r) => { if (!r.ok) throw new Error(`catalog ${r.status}`); return r.json() })
      .then((d: { entries?: HdriCatalogEntry[] }) => d.entries ?? [])
      .catch((err) => { catalogPromise = null; throw err })
  }
  return catalogPromise
}

const FEATURED = new Set(HDRI_ENVIRONMENTS.map((h) => h.slug))

/** The entries a rail/search shows. Search (any query) wins over the rail and scans the whole
 *  library by name + slug; the Featured rail keeps the curated order; a category rail filters by tag. */
export function filterHdris(entries: HdriCatalogEntry[], railId: string, query: string): HdriCatalogEntry[] {
  const q = query.trim().toLowerCase()
  if (q) return entries.filter((e) => e.name.toLowerCase().includes(q) || e.slug.includes(q))
  if (railId === 'featured') {
    // Curated order, resolved against the live catalog (fall back to a bare entry if absent).
    return HDRI_ENVIRONMENTS.map((h) => entries.find((e) => e.slug === h.slug) ?? { slug: h.slug, name: h.label, categories: [] })
  }
  const rail = HDRI_RAILS.find((r) => r.id === railId)
  if (!rail?.category) return entries
  return entries.filter((e) => e.categories.includes(rail.category!))
}

export { FEATURED as FEATURED_HDRI_SLUGS }

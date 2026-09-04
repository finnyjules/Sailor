/**
 * Vector Type Studio — the font layer.
 *
 * Fetches a ttf and parses it with fontkit, so glyphs can be asked for their
 * outline. THREE routes feed it, one per token shape (`fontToken.ts`), and
 * `vtFontFileUrl` is what picks between them — nothing here branches on source:
 *  - `/api/fonts/variable?id=…` — a curated family, the VARIABLE file, the only
 *    one whose outline can be asked for at an interpolated axis position;
 *  - `/api/fonts/google-file?family=…&weight=…` — one STATIC cut of any Google
 *    family, through the css2 → gstatic proxy;
 *  - `/api/library-font/<faceId>` — one static face out of the committed
 *    library manifest.
 * The last two have no `fvar` at all, so `axes` is legitimately `[]` — a static
 * font, not a broken one.
 *
 * three's vendored opentype parser is not an option for the variable route: it
 * reads `fvar` (it can name the axes) but has no `gvar` support, so it can never
 * produce the outline at an interpolated position.
 *
 * Two gotchas encoded here, both paid for once already:
 *  - fontkit has NO default export. `import fontkit from 'fontkit'` type-checks
 *    and then blows up at runtime. It must be `import * as fontkit`.
 *  - a VARIABLE file cannot come from fonts.googleapis.com/css2, which only ever
 *    serves static instances — hence the separate variable route. See
 *    server/api/fonts/variable.get.ts.
 */
import * as fontkit from 'fontkit'
import { parseVtFontToken, variableFontUrl, vtFontFileUrl } from './fontToken'

/** Re-exported so existing importers keep working — the implementation now
 *  lives in `fontToken.ts` to avoid a cycle (Task 2's `fontToken` import of
 *  `font.ts` would otherwise import back into itself). */
export { variableFontUrl }

/** One variation axis, normalised out of fontkit's keyed record. */
export interface VtAxis {
  tag: string
  /** Human name from the font's `fvar`, falling back to the tag. */
  name: string
  min: number
  default: number
  max: number
}

export interface VtFont {
  /** The token it was loaded from (`fontToken.ts`) — a curated catalog id, or a
   *  `google:`/`local:` token; not necessarily a catalog id any more. */
  id: string
  /** Every axis the FILE declares — not the catalog's curated subset. */
  axes: VtAxis[]
  unitsPerEm: number
  /** The fontkit font. `raw.getVariation(coords)` is the whole point. */
  raw: any
}

/** Axes users expect first; everything else follows alphabetically. Purely a
 *  presentation order, but a stable one, so the inspector doesn't reshuffle. */
const PREFERRED_ORDER = ['wght', 'wdth', 'opsz', 'slnt', 'ital']

/** An OpenType axis tag is exactly four printable-ASCII characters. */
export function isValidAxisTag(tag: unknown): boolean {
  return typeof tag === 'string' && /^[\x20-\x7E]{4}$/.test(tag)
}

/**
 * fontkit's `variationAxes` is `{ wght: { name, min, default, max }, … }`.
 * Flatten to a sorted array, dropping anything malformed — a font with a
 * junk axis should lose that axis, not fail to load.
 */
export function normaliseAxes(raw: unknown): VtAxis[] {
  if (!raw || typeof raw !== 'object') return []
  const out: VtAxis[] = []
  for (const [tag, value] of Object.entries(raw as Record<string, any>)) {
    if (!isValidAxisTag(tag)) continue
    if (!value || typeof value !== 'object') continue
    const min = Number(value.min)
    const max = Number(value.max)
    const def = Number(value.default)
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(def)) continue
    if (max < min) continue
    out.push({
      tag,
      name: typeof value.name === 'string' && value.name ? value.name : tag,
      min,
      max,
      // A default outside [min,max] is a broken font; clamp rather than trust it.
      default: Math.min(max, Math.max(min, def)),
    })
  }
  return out.sort((a, b) => {
    const ia = PREFERRED_ORDER.indexOf(a.tag)
    const ib = PREFERRED_ORDER.indexOf(b.tag)
    if (ia !== ib) return (ia < 0 ? PREFERRED_ORDER.length : ia) - (ib < 0 ? PREFERRED_ORDER.length : ib)
    return a.tag.localeCompare(b.tag)
  })
}

/** Every axis at its font-declared default, as a fontkit coords object. */
export function defaultCoords(font: VtFont): Record<string, number> {
  const out: Record<string, number> = {}
  for (const a of font.axes) out[a.tag] = a.default
  return out
}

/** Clamp a coords object to the font's declared ranges, dropping unknown tags.
 *  fontkit silently ignores out-of-range values; we'd rather they be honest. */
export function clampCoords(font: VtFont, coords: Record<string, number>): Record<string, number> {
  const byTag = new Map(font.axes.map(a => [a.tag, a]))
  const out: Record<string, number> = {}
  for (const [tag, raw] of Object.entries(coords ?? {})) {
    const axis = byTag.get(tag)
    if (!axis) continue
    const v = Number(raw)
    if (!Number.isFinite(v)) continue
    out[tag] = Math.min(axis.max, Math.max(axis.min, v))
  }
  return out
}

/** In-flight and settled loads, keyed by the TOKEN (not a resolved id) — so
 *  caches, thumbs and race guards all key on what `config.fontId` actually
 *  holds. Promises are cached (not just results) so N simultaneous callers
 *  share one fetch. A rejected load is evicted, so a transient network
 *  failure — or an unresolvable library face — doesn't poison the token
 *  forever. */
const cache = new Map<string, Promise<VtFont>>()

/** How many fonts stay resident. A parsed fontkit font holds the file's whole
 *  glyph/variation tables, so this is megabytes each, and a session that browses
 *  the Google catalog would otherwise pin every family it ever previewed for the
 *  life of the tab. 24 is comfortably more than any one composition uses (the
 *  layer stack, the moves, the thumbs) while keeping the walk bounded. */
const CACHE_MAX = 24

/** Map preserves insertion order, so "oldest key" IS the least-recently-used one
 *  as long as every touch re-inserts. Delete-then-set is the whole LRU. */
function touch(token: string, p: Promise<VtFont>): void {
  cache.delete(token)
  cache.set(token, p)
}

/**
 * Load ANY of the three token shapes (`fontToken.ts`) into a `VtFont`.
 * A Google cut and a library face have no variation axes at all — that's not
 * a broken font, it's a static one, so `axes` may legitimately be `[]` and
 * every axis-consuming call site already treats an empty list as "no
 * variation, only the outline as-shipped." Only a malformed token or an
 * unresolvable library face is an error; a font that merely doesn't vary
 * is not.
 */
export async function loadVectorFont(token: string): Promise<VtFont> {
  const hit = cache.get(token)
  if (hit) { touch(token, hit); return hit }

  const ref = parseVtFontToken(token)
  if (!ref) throw new Error(`Invalid font token: ${token}`)
  const url = vtFontFileUrl(ref)
  if (!url) throw new Error(`Unknown library face: ${token}`)

  const p = (async (): Promise<VtFont> => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Font ${token}: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const font: any = (fontkit as any).create(bytes)
    const axes = normaliseAxes(font?.variationAxes)
    return { id: token, axes, unitsPerEm: Number(font?.unitsPerEm) || 1000, raw: font }
  })()

  cache.set(token, p)
  // The cap is enforced when a load SETTLES, not when it starts: an in-flight
  // fetch that got evicted mid-flight would leave its callers sharing a promise
  // nobody can find again, and the next caller would fetch the same bytes twice.
  p.then(
    () => { while (cache.size > CACHE_MAX) { const lru = cache.keys().next().value; if (lru === undefined) break; cache.delete(lru) } },
    () => { cache.delete(token) },
  )
  return p
}

/** Documented alias — kept for one release while call sites migrate to the
 *  name that reflects what it now loads (any of the three token shapes, not
 *  only a variable font). Remove once nothing imports the old name. */
export const loadVariableFont = loadVectorFont

/** Test/HMR seam — forget everything loaded so far. */
export function clearVectorFontCache(): void {
  cache.clear()
}

/** Documented alias, same reason as `loadVariableFont` above: the cache holds
 *  any of the three token shapes now, not only variable fonts. */
export const clearVariableFontCache = clearVectorFontCache

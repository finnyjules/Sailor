/**
 * Vector Type Studio — the font layer.
 *
 * Loads a VARIABLE ttf through `/api/fonts/variable` and parses it with
 * fontkit, so glyphs can be asked for their outline at any axis position.
 * three's vendored opentype parser is not an option here: it reads `fvar` (it
 * can name the axes) but has no `gvar` support, so it can never produce the
 * outline at an interpolated position.
 *
 * Two gotchas encoded here, both paid for once already:
 *  - fontkit has NO default export. `import fontkit from 'fontkit'` type-checks
 *    and then blows up at runtime. It must be `import * as fontkit`.
 *  - the font file cannot come from fonts.googleapis.com/css2, which only ever
 *    serves static instances. See server/api/fonts/variable.get.ts.
 */
import * as fontkit from 'fontkit'
import { VARIABLE_FONTS_BY_ID } from '~/data/variable-fonts'
import { variableFontUrl } from './fontToken'

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
  /** Catalog id it was loaded from. */
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

/** In-flight and settled loads, keyed by catalog id. Promises are cached (not
 *  just results) so N simultaneous callers share one fetch. A rejected load is
 *  evicted, so a transient network failure doesn't poison the id forever. */
const cache = new Map<string, Promise<VtFont>>()

export async function loadVariableFont(id: string): Promise<VtFont> {
  const hit = cache.get(id)
  if (hit) return hit

  const entry = VARIABLE_FONTS_BY_ID[id]
  if (!entry?.ttfPath) throw new Error(`Unknown variable font id: ${id}`)

  const p = (async (): Promise<VtFont> => {
    const res = await fetch(variableFontUrl(id))
    if (!res.ok) throw new Error(`Variable font ${id}: HTTP ${res.status}`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    const font: any = (fontkit as any).create(bytes)
    const axes = normaliseAxes(font?.variationAxes)
    if (!axes.length) throw new Error(`Variable font ${id}: parsed, but no variation axes — this is a static cut`)
    return { id, axes, unitsPerEm: Number(font?.unitsPerEm) || 1000, raw: font }
  })()

  cache.set(id, p)
  p.catch(() => cache.delete(id))
  return p
}

/** Test/HMR seam — forget everything loaded so far. */
export function clearVariableFontCache(): void {
  cache.clear()
}

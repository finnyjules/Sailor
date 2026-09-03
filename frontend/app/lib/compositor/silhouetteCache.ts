/**
 * Per-layer cache for the silhouette effects (torn edge + feather).
 *
 * Both effects are per-pixel CPU passes over the layer's rasterized alpha, and
 * paintLayer used to re-run them on EVERY repaint — so dragging a torn-edge brush
 * layer re-tore the whole device-resolution bitmap on every pointer move even
 * though only x/y had changed. Baking the layer's own local box once and stamping
 * that raster under the layer transform makes a drag a `drawImage`.
 *
 * CPU-only on purpose (no DOM at module scope): the cached value is a generic
 * parameter, so the canvas type only appears at the call site.
 */

/** Fields of a layer that do NOT change the pixels of its own local box: outer transform,
 *  opacity/blend (applied at stamp time), cloner (paintLayer expands it), bookkeeping. */
export const SILHOUETTE_KEY_STRIP = ['id', 'x', 'y', 'rotation', 'opacity', 'blend', 'cloner', 'skewX', 'skewY', 'cornerPin', 'name', 'visible', 'locked', 'groupId'] as const

/** Recursively sorts object keys (arrays keep their order) so the cache key is
 *  canonical regardless of property insertion order at ANY depth — a top-level-only
 *  sort would still vary the key for two layers whose nested objects (tornEdge,
 *  feather, strokes' point objects, …) were built with keys in a different order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (value && typeof value === 'object') {
    const o: Record<string, unknown> = {}
    for (const k of Object.keys(value as Record<string, unknown>).sort()) o[k] = canonicalize((value as Record<string, unknown>)[k])
    return o
  }
  return value
}

/** Cache key for a layer's baked local box: everything that changes the box's pixels,
 *  plus the raster size (device px), the device scale `s` and the logical frame width W
 *  (drawLayerContent sizes fonts/strokes off W). */
export function silhouetteCacheKey(layer: Record<string, unknown>, s: number, bwDev: number, bhDev: number, W: number): string {
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(layer).sort()) if (!(SILHOUETTE_KEY_STRIP as readonly string[]).includes(k)) o[k] = canonicalize(layer[k])
  return `${JSON.stringify(o)}|W${W}|s${s}|${bwDev}x${bhDev}`
}

/**
 * Transparent margin (LOGICAL px) to leave around the content in a baked raster.
 *
 * Torn edge and feather both work from each opaque pixel's distance to the nearest
 * TRANSPARENT pixel (see `distanceInside`). A layer's own box is tight around its
 * ink — a rect fills its box exactly, `strokeBounds` hugs a brush — so a raster
 * sized to the bare box has no transparent pixel at those edges and the effect
 * silently no-ops there. The full-canvas path this replaces had the whole frame
 * around the layer, so it never hit this; the box-sized raster must supply it.
 */
export const SILHOUETTE_RASTER_PAD_PX = 2

/** Padding (logical px) around `localLayerBox` for a baked silhouette raster.
 *  Pure: the composable resolves the layer down to these primitives (kind, and the
 *  font-size/stroke-width already scaled to logical px by W) so this stays CPU-only.
 *
 *  - `basePad`: an outside-aligned stroke paints wholly beyond the box (outsideStrokePadPx).
 *  - text ink overshoots the measured line block on a tight lineHeight, a descender,
 *    italics or letter-spacing overhang, so text gets a FULL em (`fontPx`, not half) plus
 *    the stroke width — a bigger raster is cheap, a clipped glyph is a visible bug.
 *  - `rasterMargin`: both effects need a transparent margin to measure the edge from at
 *    all (SILHOUETTE_RASTER_PAD_PX). That margin must be >= 2 DEVICE px, so at device
 *    scale s < 1 (zoomed out / low dpr) it has to grow in LOGICAL px to still cover 2
 *    device px; at s >= 1 it never shrinks below SILHOUETTE_RASTER_PAD_PX logical px.
 *
 *  `fontPx`/`strokePx` are guarded against non-finite input (NaN/Infinity) so a caller's
 *  bad measurement can never produce a NaN raster size downstream. */
export function silhouettePadPx(basePad: number, kind: string, fontPx: number, strokePx: number, s: number): number {
  const rasterMargin = Math.max(SILHOUETTE_RASTER_PAD_PX, SILHOUETTE_RASTER_PAD_PX / s)
  const fp = Number.isFinite(fontPx) ? fontPx : 0
  const sp = Number.isFinite(strokePx) ? strokePx : 0
  return basePad + rasterMargin + (kind === 'text' ? fp + sp : 0)
}

/** Whether everything a layer draws with is actually in hand: image layers and image
 *  fills paint a placeholder until their bitmap decodes, and text falls back to another
 *  font until the real one loads — none of that is visible to the cache key, so baking a
 *  raster while any of it is unready would freeze the placeholder/fallback glyphs for as
 *  long as nothing else about the layer changes. Pure: the composable owns the DOM/cache
 *  lookups (document.fonts, the image cache, the fill-bitmap cache) and passes booleans. */
export function silhouetteContentReady(kind: string, ready: { font: boolean; image: boolean; fillBitmaps: boolean }): boolean {
  if (kind === 'text' && !ready.font) return false
  if (kind === 'image' && !ready.image) return false
  if (!ready.fillBitmaps) return false
  return true
}

/** Ceiling on a baked raster's device-pixel area. Past the browser's canvas-area limit
 *  (varies by engine, roughly in this neighborhood) `getContext('2d')` does not return
 *  null — it hands back a context backed by a blank surface, so drawing into it and
 *  caching the result would silently cache emptiness for a huge layer. Keeping the cap
 *  well under that limit means the uncached fallback (same as a null context) kicks in
 *  before the browser's own limit would bite. */
export const SILHOUETTE_RASTER_MAX_PX = 16_000_000

/** Pure size check for a candidate raster (device px). False for non-finite or
 *  sub-1px dimensions too, so a bad measurement never reaches `canvas.width = NaN`. */
export function silhouetteRasterFits(bwD: number, bhD: number): boolean {
  if (!Number.isFinite(bwD) || !Number.isFinite(bhD)) return false
  if (bwD < 1 || bhD < 1) return false
  return bwD * bhD <= SILHOUETTE_RASTER_MAX_PX
}

/** Tiny insertion-order LRU: `get` refreshes recency; `set` evicts the oldest past `cap`. */
export class LruCache<V> {
  private m = new Map<string, V>()
  constructor(private cap: number) {}
  get(k: string): V | undefined { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v) } return v }
  set(k: string, v: V): void { this.m.delete(k); this.m.set(k, v); while (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as string) }
  get size(): number { return this.m.size }
  clear(): void { this.m.clear() }
}

export const SILHOUETTE_CACHE_CAP = 24

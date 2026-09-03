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

/** Cache key for a layer's baked local box: everything that changes the box's pixels,
 *  plus the raster size (device px), the device scale `s` and the logical frame width W
 *  (drawLayerContent sizes fonts/strokes off W). */
export function silhouetteCacheKey(layer: Record<string, unknown>, s: number, bwDev: number, bhDev: number, W: number): string {
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(layer).sort()) if (!(SILHOUETTE_KEY_STRIP as readonly string[]).includes(k)) o[k] = layer[k]
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

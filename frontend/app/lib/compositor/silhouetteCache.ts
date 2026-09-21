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
 *
 * WHAT THE CACHE DOES NOT PRESERVE (all deliberate, all visible if you look for it):
 *
 *  - The tear/feather noise is sampled in the LAYER BOX's space, not the frame's.
 *    The old full-canvas pass tore at the layer's position in the frame, so dragging
 *    a layer slid it through a fixed noise field; now the tear travels WITH its
 *    layer. That is the point (it is what makes a drag a `drawImage`) — but two
 *    layers that used to tear differently because they sat in different places now
 *    tear identically if everything else about them matches.
 *  - Feather depth is measured on the UNROTATED box. A rotated layer's feather is
 *    therefore rotated along with it rather than re-measured in frame space, so a
 *    non-uniform (anisotropic) edge falloff turns with the layer.
 *  - Rotation and skew are applied by RESAMPLING the raster, not by drawing the
 *    vector under the transform. A rotated torn edge is a resampled bitmap edge, a
 *    touch softer than a freshly-drawn one; the eligibility gate keeps the cases
 *    where that would be obvious (corner-pin, DOF, cloner scale != 1) on the old path.
 *  - The device scale `s` is in the cache key, so a motion `scale` that changes `s`
 *    every frame RE-BAKES every frame. That is still cheaper than the old
 *    full-canvas pass it replaces (a box-sized raster vs. the whole frame), but it
 *    churns the cache — each frame's key is new, and the LRU sheds the old ones.
 */

/** Fields of a layer that do NOT change the pixels of its own local box: outer transform,
 *  opacity/blend (applied at stamp time), cloner (paintLayer expands it), bookkeeping.
 *
 *  `textMotion` is the odd one out — it very much DOES change the pixels, every single
 *  frame. It is stripped because a layer carrying it is disqualified from the cache
 *  outright (see `silhouetteCacheable`), so its key is never asked for; stripping it as
 *  well keeps a stringify of the whole behaviour list out of the key should that gate ever
 *  be loosened, and keeps every existing layer's key byte-identical. */
export const SILHOUETTE_KEY_STRIP = ['id', 'x', 'y', 'rotation', 'opacity', 'blend', 'cloner', 'skewX', 'skewY', 'cornerPin', 'name', 'visible', 'locked', 'groupId', 'textMotion', 'motionReveal'] as const

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
 *  (drawLayerContent sizes fonts/strokes off W).
 *
 *  `tint`/`tintStrength` are Cloner Vary's per-copy colour, which the raster bakes IN —
 *  before the edge passes, so the torn edge's opaque lip keeps `lipColor` instead of
 *  being washed by a tint applied afterwards. Two copies of one layer in different
 *  swatches are therefore different pictures and must be different entries. The suffix
 *  is appended ONLY when a tint is present, so every untinted key is byte-identical to
 *  the ones this function returned before Vary existed (a cold cache on upgrade would
 *  be harmless but pointless). */
export function silhouetteCacheKey(
  layer: Record<string, unknown>, s: number, bwDev: number, bhDev: number, W: number,
  tint?: string | null, tintStrength?: number,
): string {
  const o: Record<string, unknown> = {}
  for (const k of Object.keys(layer).sort()) if (!(SILHOUETTE_KEY_STRIP as readonly string[]).includes(k)) o[k] = canonicalize(layer[k])
  const vary = tint ? `|tint${tint}@${tintStrength ?? 0}` : ''
  return `${JSON.stringify(o)}|W${W}|s${s}|${bwDev}x${bhDev}${vary}`
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

/** The primitives a layer's INK OVERHANG is computed from — everything `drawLayerContent`
 *  paints outside what `localLayerBox` measures. The composable resolves the layer down
 *  to these (sizes already scaled to logical px by W) so this file stays CPU-only. */
export interface SilhouetteInkInput {
  /** Layer kind ('rect' | 'text' | 'line' | 'brush' | …). */
  kind: string
  /** The layer's REAL alignment (`strokeAlignOf`), not a guess — the default is 'center'.
   *  Only consulted when `strokeReachPx` is absent. */
  strokeAlign: 'inside' | 'center' | 'outside'
  /** The stack's widest outline, logical px (already × W, and × the path's own scale for a
   *  path). A legacy single-stroke layer reads through as one entry, so this is that
   *  stroke's width. For TEXT it is the furthest a stroke REACHES past the glyphs — its
   *  width plus any positive `distance`, since a distant text stroke is a dilation band
   *  (`paintTextStrokeBands`) and no width alone describes where it lands. Shape kinds pass
   *  `strokeReachPx` for that instead and leave this as the plain width. */
  strokePx: number
  /** Shape kinds only: how far the stack's furthest-reaching stroke lands BEYOND the
   *  silhouette edge, logical px — `strokeReachPx`, which already folds in every
   *  stroke's alignment, its `distance`, and a path's own scale.
   *
   *  Supplied because `strokeAlign`/`strokePx` describe ONE stroke and cannot express a
   *  list: a layer with a hairline outside stroke and a fat one pushed 20 px out has no
   *  single (align, width) pair, and picking either one bakes the wrong silhouette for
   *  the torn-edge and feather effects — silently, as a slightly wrong SHAPE rather than
   *  an error. Absent ⇒ fall back to the single-stroke alignment rules below, which is
   *  what every caller predating the stack passes. */
  strokeReachPx?: number
  /** Text only: font size in logical px. */
  fontPx: number
  /** Text only: the layer's height box (`boxH` × W), 0 when it has none. */
  boxHPx: number
  /** Text only: what `localLayerBox` measured for the same layer (`lines × lineHeight`). */
  boxHeightPx: number
  /** Text only: the widest of `wrappedTextLines`' lines, measured with the layer's real
   *  font (logical px). 0 when unknown/unmeasured. */
  maxLineWPx: number
  /** Text only: the box width `localLayerBox` measured for the same layer (logical px). */
  boxWidthPx: number
}

/**
 * How far a layer's ink reaches beyond `localLayerBox`, in logical px.
 *
 * Broader than the shape pad `strokeReachPx` computes: text and line have overhang
 * rules of their own that no stroke geometry describes. For the SHAPE kinds the caller
 * passes that pad in as `strokeReachPx` and it is used verbatim, so the two can't disagree
 * about how far an outline reaches.
 *
 *  - shape strokes: `strokeReachPx` when the caller supplies it (the stack's furthest
 *    reach: alignment, `distance` and a path's own scale all folded in). Without it, the
 *    single-stroke rules — 'outside' paints the whole ring beyond the edge (`strokePx`),
 *    'center' straddles it (`strokePx / 2`), 'inside' stays within it (0). The DEFAULT
 *    alignment is 'center', so padding by an outside-only amount would clip the outer half
 *    of every default stroke out of the cached raster, in preview and in export alike.
 *  - `line`: `drawLayerContent` strokes it with `lineCap = 'round'`, so each cap bulges
 *    half a stroke width past the endpoint — and `localLayerBox` gives a line exactly
 *    `w × W`, with no cap allowance. Alignment is meaningless for a line (no interior).
 *  - `text`: ink overshoots the measured line block on a tight lineHeight, a descender,
 *    italics or letter-spacing overhang, so text gets a FULL em (`fontPx`, not half) plus
 *    `strokePx`, which for text is the outline's whole REACH (width plus any positive
 *    distance) — a bigger raster is cheap, a clipped glyph is a visible bug. On
 *    top of that, `drawText` positions its lines anywhere within ±boxH/2 under `valign`
 *    while `localLayerBox` reports only `lines × lineHeight`, so a short block in a tall
 *    height box sits up to half the slack outside the measured box. And with a fixed
 *    `boxW`, `wrappedTextLines` only breaks on WHITESPACE — a single word or URL wider
 *    than the box is emitted as one over-long line, while `localLayerBox` still reports
 *    `w = boxW` for that layer. `drawText` centers each line at the box's own center, so
 *    an over-long line straddles the box edges evenly — pad by half the overflow.
 *
 * Every input is guarded against non-finite values (NaN/Infinity count as 0) so a bad
 * measurement upstream can never produce a NaN raster size downstream.
 */
export function silhouetteInkOverhangPx(input: SilhouetteInkInput): number {
  const fin = (v: number) => (Number.isFinite(v) ? Math.max(0, v) : 0)
  const strokePx = fin(input.strokePx)
  if (input.kind === 'text') {
    const boxHPx = fin(input.boxHPx)
    const valignSlack = boxHPx > 0 ? Math.max(0, (boxHPx - fin(input.boxHeightPx)) / 2) : 0
    const lineOverflowSlack = Math.max(0, (fin(input.maxLineWPx) - fin(input.boxWidthPx)) / 2)
    return fin(input.fontPx) + strokePx + valignSlack + lineOverflowSlack
  }
  if (input.kind === 'line') return strokePx / 2
  // A shape kind's stack knows its own reach exactly (alignment + distance, over every
  // stroke); prefer it over re-deriving one from a single alignment. Non-finite values
  // fall through to the rules below rather than poisoning the raster size.
  if (typeof input.strokeReachPx === 'number' && Number.isFinite(input.strokeReachPx)) {
    return Math.max(0, input.strokeReachPx)
  }
  if (input.strokeAlign === 'outside') return strokePx
  if (input.strokeAlign === 'inside') return 0
  return strokePx / 2
}

/** Padding (logical px) around `localLayerBox` for a baked silhouette raster:
 *  the raster margin plus the layer's ink overhang.
 *
 *  - `rasterMargin`: both effects need a transparent margin to measure the edge from at
 *    all (SILHOUETTE_RASTER_PAD_PX). That margin must be >= 2 DEVICE px, so at device
 *    scale s < 1 (zoomed out / low dpr) it has to grow in LOGICAL px to still cover 2
 *    device px; at s >= 1 it never shrinks below SILHOUETTE_RASTER_PAD_PX logical px.
 *  - the overhang is everything the layer paints outside its own box — see
 *    `silhouetteInkOverhangPx`, which is where the alignment/cap/height-box rules live. */
export function silhouettePadPx(ink: SilhouetteInkInput, s: number): number {
  const rasterMargin = Math.max(SILHOUETTE_RASTER_PAD_PX, SILHOUETTE_RASTER_PAD_PX / s)
  return rasterMargin + silhouetteInkOverhangPx(ink)
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

/** Ceiling on a baked raster's device-pixel AREA. Past the browser's canvas-area limit
 *  `getContext('2d')` does not return null — it hands back a context backed by a blank
 *  surface, so drawing into it and caching the result would silently cache emptiness for
 *  a huge layer. 16 Mpx sits just under the tightest engine's limit (mobile Safari's
 *  ~16.78 Mpx / 4096²), so the uncached fallback (same as a null context) kicks in
 *  before the browser's own limit would bite. */
export const SILHOUETTE_RASTER_MAX_PX = 16_000_000

/** Ceiling on either SIDE of a baked raster, in device px. The area cap alone is not
 *  enough: a 32768 × 480 raster is only 15.7 Mpx — inside the area ceiling — but past
 *  every engine's per-dimension limit, so it comes back blank and the cache would store
 *  that emptiness for a layer that then simply vanishes. A very wide, very short layer
 *  (a rule, a long single line of text) reaches this shape easily. */
export const SILHOUETTE_RASTER_MAX_DIM = 16_384

/** Pure size check for a candidate raster (device px). False for non-finite or
 *  sub-1px dimensions too, so a bad measurement never reaches `canvas.width = NaN`. */
export function silhouetteRasterFits(bwD: number, bhD: number): boolean {
  if (!Number.isFinite(bwD) || !Number.isFinite(bhD)) return false
  if (bwD < 1 || bhD < 1) return false
  if (bwD > SILHOUETTE_RASTER_MAX_DIM || bhD > SILHOUETTE_RASTER_MAX_DIM) return false
  return bwD * bhD <= SILHOUETTE_RASTER_MAX_PX
}

/** Optional byte accounting for `LruCache`. Without it the cache is count-capped only,
 *  exactly as before. */
export interface LruCacheOptions<V> {
  /** Bytes one value occupies. For a canvas: `c.width * c.height * 4`. */
  sizeOf?: (v: V) => number
  /** Total byte budget; entries are shed (LRU first) until the total is back under it. */
  maxBytes?: number
}

/**
 * Tiny insertion-order LRU: `get` refreshes recency; `set` sheds the least-recently-used
 * until BOTH the count cap and the byte budget hold.
 *
 * The byte budget matters because a count cap bounds nothing useful when the values are
 * device-resolution canvases — 24 full-screen retina rasters is already hundreds of MB
 * in a module-global cache that never empties on its own.
 *
 * One exception: a single entry larger than the whole budget is KEPT rather than evicted
 * on the way in, since shedding it would turn every `set` into a guaranteed miss. The
 * raster caps above bound one raster to 16 Mpx (64 MB), well inside
 * SILHOUETTE_CACHE_MAX_BYTES, so this is a safety valve rather than a live case.
 */
export class LruCache<V> {
  private m = new Map<string, V>()
  private sizes = new Map<string, number>()
  private total = 0
  private sizeOf?: (v: V) => number
  private maxBytes: number
  constructor(private cap: number, opts: LruCacheOptions<V> = {}) {
    this.sizeOf = opts.sizeOf
    this.maxBytes = opts.maxBytes ?? Infinity
  }
  get(k: string): V | undefined { const v = this.m.get(k); if (v !== undefined) { this.m.delete(k); this.m.set(k, v) } return v }
  set(k: string, v: V): void {
    this.drop(k)
    this.m.set(k, v)
    const n = this.sizeOf ? this.sizeOf(v) : 0
    const bytes = Number.isFinite(n) ? Math.max(0, n) : 0
    this.sizes.set(k, bytes)
    this.total += bytes
    while (this.m.size > this.cap || (this.total > this.maxBytes && this.m.size > 1)) {
      this.drop(this.m.keys().next().value as string)
    }
  }
  /** Remove one key and give its bytes back. No-op for a key that isn't held. */
  private drop(k: string): void {
    if (!this.m.has(k)) return
    this.m.delete(k)
    this.total -= this.sizes.get(k) ?? 0
    this.sizes.delete(k)
  }
  get size(): number { return this.m.size }
  /** Total accounted bytes held; 0 when no `sizeOf` was supplied. */
  get bytes(): number { return this.total }
  clear(): void { this.m.clear(); this.sizes.clear(); this.total = 0 }
}

export const SILHOUETTE_CACHE_CAP = 24

/** Byte budget for the silhouette raster cache. The rasters are device-resolution
 *  canvases (4 bytes per device px), so the count cap alone can run to hundreds of MB;
 *  192 MB is a few full-screen retina layers' worth and comfortably above one
 *  maximum-legal raster (SILHOUETTE_RASTER_MAX_PX × 4 = 64 MB), so the cache is never
 *  reduced to a single entry by the budget in practice. */
export const SILHOUETTE_CACHE_MAX_BYTES = 192 * 1024 * 1024

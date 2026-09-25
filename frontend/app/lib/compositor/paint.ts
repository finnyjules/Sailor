/**
 * Paint — the compositor's fill/stroke value: a plain CSS color string, a
 * gradient, or a Type-Studio `Fill` (ombre/grid/noise/checkerboard/stripes/qr/
 * shader/…). Moved down from `composables/useCompositorLayers.ts` (which still
 * re-exports everything here for its ~40 existing importers) so CPU-only `lib/`
 * modules — namely `fillTile.ts`, whose `Fill` this type embeds — can reference
 * `Paint` without reaching up to a composable. Gradient geometry is
 * resolution-independent: it's resolved against a box at draw/tile time, so it
 * scales with whatever it's painting.
 *
 * CPU-only: no `three`, no DOM access at module scope (matches the contract in
 * `fillTile.ts`'s header — `paintTileBox` below only touches `document` inside
 * its own function body, exactly like `fillTileBox`/`fillTileCanvas` there).
 */
import { type Fill, effectiveTileFill, fillTileBox } from '~/lib/spacetype/fillTile'
import { gradientUnitAxis, orderGradientStops } from '~/lib/vector/svg'
import { getFillBitmap } from '~/lib/paint/imageFillCache'
// Type-only: `finishPass.ts` imports nothing from this module (or from anything that
// does), so this is not a cycle — just the metal vocabulary the GPU pass itself owns.
import { METALS, type FoilMetal } from '~/lib/compositor/finishPass'

export interface GradientStop { offset: number; color: string } // offset 0..1
export interface LinearGradient { type: 'linear'; angle: number; stops: GradientStop[] } // angle in degrees
export interface RadialGradient { type: 'radial'; stops: GradientStop[] }
export type Gradient = LinearGradient | RadialGradient
export interface ImageFill {
  type: 'image'
  src: string                              // snapshot URL of the picked node's image
  fit: 'cover' | 'contain' | 'tile' | 'stretch'
  scale?: number                           // default 1
  offset?: { x: number; y: number }        // fraction of box, 0-centered; default {0,0}
}
/** A foil paint — metal, brushed, pressed in, grain. Rendered by `applyFinish(off, 'gold_foil', …)`
 *  over the region's own offscreen (Task 2); `resolvePaint` below is its non-GPU fallback (the
 *  metal's mid colour), used for thumbnails, previews and anywhere `drawLayerContent` doesn't reach.
 *  Frame-only: `FillControl` offers it only behind `allowFoil` (Task 3), so Space Type, Shape Studio
 *  and Vector Type never see this variant. */
export interface FoilFill {
  type: 'foil'
  metal: FoilMetal
  brushed: number
  pressed: number
  grain: number
}
export const DEFAULT_FOIL_FILL: FoilFill = { type: 'foil', metal: 'gold', brushed: 0.5, pressed: 0.5, grain: 0.4 }

export type Paint = string | Gradient | Fill | ImageFill | FoilFill

export function isGradient(p: Paint | undefined): p is Gradient {
  return !!p && typeof p === 'object' && ((p as Gradient).type === 'linear' || (p as Gradient).type === 'radial')
}
// A Fill is distinguished from a Gradient by its `a`/`density` fields (Gradient has `stops`).
export function isFill(p: Paint | undefined): p is Fill {
  return !!p && typeof p === 'object' && 'a' in p && 'density' in p
}
// An ImageFill is the only Paint whose discriminant `type` is 'image'.
export function isImageFill(p: Paint | undefined): p is ImageFill {
  return !!p && typeof p === 'object' && (p as ImageFill).type === 'image' && 'src' in p
}
// A FoilFill is the only Paint whose discriminant `type` is 'foil'.
export function isFoilFill(p: Paint | undefined): p is FoilFill {
  return !!p && typeof p === 'object' && (p as FoilFill).type === 'foil'
}

/** Sort a gradient's stops by offset and clamp each to 0..1 (non-finite offsets sink to 0).
 *  Exported (not just internal) so `~/lib/shaderfill/descriptor.ts`'s `inputKey` can encode
 *  a gradient's stops in the SAME canonical order `paintTileBox` renders them in — sorting
 *  twice (once here, once by hand in the key) would let the two silently drift apart. */
export function sortedClampedStops(stops: GradientStop[]): GradientStop[] {
  // The rule itself lives in the vector spine, which has to apply it too (SVG
  // PINS an out-of-order offset to its predecessor, where canvas does not, so
  // an unsorted list is two different ramps on the two surfaces). One
  // implementation, three callers.
  return orderGradientStops(stops)
}

/**
 * Build a (w×h) tile for any `Paint` — the `Paint` equivalent of `fillTileBox`.
 * Three arms:
 *  - `string`   → flat fillStyle rect
 *  - `Gradient` → a `CanvasGradient` in CORNER-origin geometry (the tile spans
 *                 `[0,0]..[w,h]`, unlike `resolvePaint` in useCompositorLayers.ts,
 *                 which builds gradients CENTRED on the origin for its centred
 *                 shape-drawing convention — do not copy that geometry here)
 *  - `Fill`     → delegates to `fillTileBox` verbatim, routed through
 *                 `effectiveTileFill` first so a shader-typed fill unwraps to
 *                 its `input` instead of re-entering the field renderer
 *                 (mirrors `getInputTile`'s reentrancy guard)
 */
export function paintTileBox(paint: Paint, w: number, h: number): HTMLCanvasElement {
  const W = Math.max(1, Math.round(w)), H = Math.max(1, Math.round(h))
  if (isFill(paint)) return fillTileBox(effectiveTileFill(paint), W, H)
  const c = document.createElement('canvas'); c.width = W; c.height = H
  const ctx = c.getContext('2d')!
  if (isImageFill(paint)) {
    const img = getFillBitmap(paint.src)
    const iw = img ? (img.naturalWidth || img.width) : 0
    const ih = img ? (img.naturalHeight || img.height) : 0
    if (img && iw && ih) {
      // corner-origin single tile: 'tile' collapses to cover for this incidental
      // path (only shader-input/material previews reach paintTileBox).
      const fit = paint.fit === 'tile' ? 'cover' : paint.fit
      const { dx, dy, dw, dh } = imageFillRect(fit, iw, ih, W, H, paint.scale ?? 1, paint.offset ?? { x: 0, y: 0 })
      ctx.drawImage(img, dx, dy, dw, dh)
    }
    return c   // transparent when unloaded
  }
  if (isFoilFill(paint)) {
    // Same non-GPU fallback as `resolvePaint` (resolve.ts): the metal's mid colour, flat.
    ctx.fillStyle = METALS[paint.metal]?.[2] ?? METALS.gold[2]; ctx.fillRect(0, 0, W, H)
    return c
  }
  if (!isGradient(paint)) {
    ctx.fillStyle = paint; ctx.fillRect(0, 0, W, H); return c
  }
  const stops = sortedClampedStops(paint.stops)
  let g: CanvasGradient
  if (paint.type === 'radial') {
    const r = Math.max(W, H) / 2
    g = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(r, 0.0001))
  } else {
    // Corner-origin (this function's convention): the shared unit axis scaled
    // onto the tile. Same arithmetic as the `W/2 ± cos·W/2` it replaces — the
    // third and last copy of that trig, now all three reading one definition.
    const ax = gradientUnitAxis(paint.angle ?? 0)
    g = ctx.createLinearGradient(ax.x1 * W, ax.y1 * H, ax.x2 * W, ax.y2 * H)
  }
  for (const s of stops) g.addColorStop(s.offset, s.color)
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
  return c
}

/** Destination rect (tile px) to draw a source image into a tw×th tile per `fit`,
 *  then zoomed by `scale` and shifted by `offset` (fraction of the tile). Pure.
 *  `'tile'` is NOT handled here — the caller builds a repeating cell instead. */
export function imageFillRect(
  fit: 'cover' | 'contain' | 'stretch',
  iw: number, ih: number, tw: number, th: number,
  scale = 1, offset: { x: number; y: number } = { x: 0, y: 0 },
): { dx: number; dy: number; dw: number; dh: number } {
  const s = scale > 0 ? scale : 1
  let dw: number, dh: number
  if (fit === 'stretch') { dw = tw * s; dh = th * s }
  else {
    const base = fit === 'cover' ? Math.max(tw / iw, th / ih) : Math.min(tw / iw, th / ih)
    dw = iw * base * s; dh = ih * base * s
  }
  const dx = (tw - dw) / 2 + (offset.x || 0) * tw
  const dy = (th - dh) / 2 + (offset.y || 0) * th
  return { dx, dy, dw, dh }
}

/** Pure helper (no canvas) so unit tests in the node/no-DOM vitest environment can
 *  exercise stop sorting + clamping without invoking `paintTileBox` itself. */
export const __test__ = { sortedClampedStops }

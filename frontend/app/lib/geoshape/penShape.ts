/**
 * Pure geometry for hosting the shared pen over Shape Studio's preview.
 *
 * Three spaces meet here:
 *  - drawing units — the pen's `SketchDoc` coordinates (Decision 1: 1:1 with mark units);
 *  - mark units — the Drawn base shape as `drawnPath` emits it: the drawing scaled by
 *    `k = size / naturalExtent` about its outline bbox centre, centre on the origin;
 *  - doc units — the layer's placement applied: `offset.xy + R(offset.rotate°)·(offset.scale·m)`
 *    (`applyLayerOffset` in render.ts → `transformCommands`, `flipY: false`, rotate in degrees,
 *    positive = x toward y — clockwise on a y-down screen);
 *  - CSS px — the preview overlay: `(cssW/2, cssH/2) + frame.scale·(doc − (cx, cy))`.
 *
 * Every extent here is `sketchOutlineBounds` — the same flattened-outline box
 * `drawnPath` fits by — so the pen's view and the renderer can never disagree.
 */
import type { SketchDoc } from '~/lib/sketch/model'
import type { ViewMatrix } from '~/lib/sketch/view'
import { cloneDoc } from '~/lib/sketch/clone'
import { sketchOutlineBounds } from './shapes'

/** The larger side of the drawing's outline, in drawing units; 0 when there is no outline. */
export function naturalExtent(sketch: SketchDoc | undefined): number {
  const b = sketchOutlineBounds(sketch)
  if (!b) return 0
  const ext = Math.max(b.maxX - b.minX, b.maxY - b.minY)
  return ext > 0 && Number.isFinite(ext) ? ext : 0
}

/** The factor `drawnPath(sketch, size)` scales the drawing by (mark units per drawing unit):
 *  `size / naturalExtent`. 1 for an empty drawing — and for a non-positive `size`, which
 *  would otherwise collapse the pen's view to a point. */
export function refitFactor(sketch: SketchDoc | undefined, size: number): number {
  const ext = naturalExtent(sketch)
  if (!(ext > 0) || !(size > 0)) return 1
  const k = size / ext
  return Number.isFinite(k) && k > 0 ? k : 1
}

/** A fixed preview framing. Mirrors `drawToCanvas`'s fit, frozen. */
export interface PreviewFrame {
  /** Doc-space x of the point drawn at the canvas centre (doc units). */
  cx: number
  /** Doc-space y of the point drawn at the canvas centre (doc units). */
  cy: number
  /** CSS px per doc unit. (`drawToCanvas` on a backing store takes `scale × dpr`.) */
  scale: number
  /** The preview canvas's CSS width (CSS px). */
  cssW: number
  /** The preview canvas's CSS height (CSS px). */
  cssH: number
}

/**
 * The framing to hold while the pen is open (Decision 5): the union of the current
 * content bounds (doc units, as `contentBounds` returns; `null` = no content) and a
 * `size × size` square (doc units) centred on the layer's origin (doc units), fitted
 * into `cssW × cssH` CSS px with `padCss` CSS px clear on every side. The caller passes
 * the unit's doc-space extent as `size` (e.g. mark size × offset.scale). A zero-sized
 * union is treated as 1 doc unit, and the usable box is floored at 1 CSS px, so the
 * scale is always finite and positive.
 */
export function frozenPreviewFrame(
  contentBounds: { minX: number; minY: number; w: number; h: number } | null,
  layerOrigin: { x: number; y: number },
  size: number,
  cssW: number, cssH: number, padCss: number,
): PreviewFrame {
  const half = Math.max(0, size) / 2
  let minX = layerOrigin.x - half, maxX = layerOrigin.x + half
  let minY = layerOrigin.y - half, maxY = layerOrigin.y + half
  if (contentBounds) {
    minX = Math.min(minX, contentBounds.minX)
    minY = Math.min(minY, contentBounds.minY)
    maxX = Math.max(maxX, contentBounds.minX + contentBounds.w)
    maxY = Math.max(maxY, contentBounds.minY + contentBounds.h)
  }
  const uw = maxX - minX || 1, uh = maxY - minY || 1
  const pad = Math.max(0, padCss)
  const aw = Math.max(1, cssW - 2 * pad), ah = Math.max(1, cssH - 2 * pad)
  return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2, scale: Math.min(aw / uw, ah / uh), cssW, cssH }
}

/**
 * The pen's view matrix onto the preview (drawing units → CSS px):
 *   p → m = k·(p − centre) → doc = offset.xy + R(offset.rotate°)·(offset.scale·m)
 *     → CSS = (cssW/2, cssH/2) + frame.scale·(doc − (cx, cy)).
 * `k` = `refitFactor(sketch, size)` and `centre` = the drawing's outline bbox centre
 * (drawing units), both captured ONCE when the pen opens, so the view stays put while
 * the drawing changes under it.
 */
export function shapePenView(
  frame: PreviewFrame,
  offset: { x: number; y: number; scale: number; rotate: number },
  k: number,
  centre: { x: number; y: number },
): ViewMatrix {
  const rad = (offset.rotate * Math.PI) / 180
  const cos = offset.rotate === 0 ? 1 : Math.cos(rad)
  const sin = offset.rotate === 0 ? 0 : Math.sin(rad)
  const L = frame.scale * offset.scale * k
  const a = L * cos, b = L * sin, c = -L * sin, d = L * cos
  const tx = frame.cssW / 2 + frame.scale * (offset.x - frame.cx)
  const ty = frame.cssH / 2 + frame.scale * (offset.y - frame.cy)
  return { a, b, c, d, e: tx - (a * centre.x + c * centre.y), f: ty - (b * centre.x + d * centre.y) }
}

/**
 * The commit rule (Decision 3): move the drawing so its outline bbox centre is the
 * origin, and set `size = k × naturalExtent` so `refitFactor` stays `k` — the unit
 * neither jumps nor rescales. Every point entity moves (anchors, arc centres, handles,
 * circle centres, construction points); radii and constraint values are translation-
 * invariant. The input is not mutated. `null` when the drawing has no outline.
 */
export function commitDrawn(sketch: SketchDoc, k: number): { sketch: SketchDoc; size: number } | null {
  const b = sketchOutlineBounds(sketch)
  if (!b) return null
  const ext = Math.max(b.maxX - b.minX, b.maxY - b.minY)
  if (!(ext > 0) || !Number.isFinite(ext)) return null
  const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2
  const out = cloneDoc(sketch)
  for (const e of out.entities) {
    if (e.kind === 'point') { e.x -= cx; e.y -= cy }
  }
  return { sketch: out, size: k * ext }
}

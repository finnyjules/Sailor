// Freehand brush strokes → white alpha coverage on a canvas. Strokes are stored
// width-normalized (both axes / artboard width); `base` is the px-per-unit for the
// target canvas (its width when a stroke spans the full artboard). The renderer
// then source-in-fills this alpha with any Paint. See the paintbrush design spec.

import { type TipStroke, isTipStroke, tipStrokePad } from '~/lib/brushTips/record'

export interface PaintStroke {
  points: { x: number; y: number }[] // width-normalized (both axes ÷ artboard width)
  radius: number                     // width-normalized brush radius
  hardness: number                   // 1 = hard edge … 0 = fully soft
  opacity: number                    // 0..1 FLOW: paint deposited per dab; overlapping dabs build up toward opaque
  erase: boolean                     // erase strokes carve alpha back out (at the same flow rate)
}

/**
 * Convert a SCREEN-normalized pointer coord (`nx` = x/rectW, `ny` = y/rectH, both
 * in [0..1] of the artboard rect) into the WIDTH-normalized space strokes are
 * stored in (both axes ÷ artboard width). Only Y changes: a screen fraction of
 * HEIGHT becomes a fraction of WIDTH by scaling by the aspect (h/w). On a square
 * artboard (w===h) Y is unchanged; on a 2:1 landscape ny=1 maps to y=0.5.
 */
export function toWidthNorm(nx: number, ny: number, w: number, h: number): { x: number; y: number } {
  return { x: nx, y: ny * (h / w) }
}

/**
 * Convert a mask stroke captured in ABSOLUTE artboard (width-normalized) space
 * into the target layer's LOCAL frame, so the mask FOLLOWS the layer when it is
 * moved or rotated. The renderer (applyStrokeMask) replays the same transform the
 * content uses — `translate(x*W, y*H)` then `rotate(rotation)` (paintLayer's
 * applyXform for the base instance) — so a local point maps back to exactly the
 * artboard pixel it was painted on at capture time.
 *
 * `aspect` = artboard H/W. A layer's Y position is a fraction of HEIGHT while
 * strokes are width-normalized on BOTH axes, so the layer origin sits at
 * width-normalized (x, y*aspect). Only translation and rotation are inverted here
 * (scale/skew are not part of an image layer's content transform — its size lives
 * in w/h, and applyXform's own scale is the cloner's, 1 for the base instance).
 */
export function maskStrokeToLocal(
  stroke: PaintStroke,
  xf: { x: number; y: number; rotation: number },
  aspect: number,
): PaintStroke {
  const rot = -((xf.rotation || 0) * Math.PI) / 180 // inverse rotation
  const cos = Math.cos(rot), sin = Math.sin(rot)
  const cx = xf.x, cy = xf.y * aspect
  const points = stroke.points.map(p => {
    const ox = p.x - cx, oy = p.y - cy
    return { x: ox * cos - oy * sin, y: ox * sin + oy * cos }
  })
  return { ...stroke, points }
}

/** Catmull-Rom resample: smooth a polyline through its points. Endpoints are kept
 *  exactly; interior gets `samples` interpolated points per segment. */
export function smoothPoints(points: { x: number; y: number }[], samples = 8): { x: number; y: number }[] {
  const n = points.length
  if (n < 3) return points
  const out: { x: number; y: number }[] = [points[0]!]
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i - 1] ?? points[i]!
    const p1 = points[i]!
    const p2 = points[i + 1]!
    const p3 = points[i + 2] ?? p2
    for (let s = 1; s <= samples; s++) {
      const t = s / samples
      const t2 = t * t, t3 = t2 * t
      const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3)
      const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
      out.push({ x, y })
    }
  }
  // Catmull-Rom's last sample is mathematically exactly the final input point,
  // but floating-point rounding can leave a sub-epsilon residual; snap it back
  // so endpoints really are preserved exactly (see doc comment above).
  out[out.length - 1] = points[n - 1]!
  return out
}

/** Width-normalized radius → target px, floored so a dot always shows. */
export function strokeRadiusPx(stroke: PaintStroke, base: number): number {
  return Math.max(0.5, stroke.radius * base)
}

/** A brush layer stroke: either a legacy freehand `PaintStroke` or a tip-authored `TipStroke`. */
export type BrushStroke = PaintStroke | TipStroke

/** Tight bounds of all strokes in WIDTH-normalized artboard coords, expanded by each
 *  stroke's radius so the painted marks sit fully inside. Empty → a zero box at origin. */
interface Box { minX: number; minY: number; maxX: number; maxY: number }
// A tip stroke's padded box, memoised per stroke object and keyed on how many pts it has
// been measured over. A committed stroke is immutable, so it is measured once; the live
// stroke only ever appends samples, so each call extends its box by the new ones.
const tipBoxes = new WeakMap<TipStroke, { n: number; box: Box }>()
function tipStrokeBox(s: TipStroke): Box {
  const pts = s.pts, n = pts.length - (pts.length % 3)
  let m = tipBoxes.get(s)
  if (m && m.n === n) return m.box
  if (!m || m.n > n) { m = { n: 0, box: { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity } }; tipBoxes.set(s, m) }
  const pad = tipStrokePad(s), b = m.box
  for (let i = m.n; i < n; i += 3) {
    const x = pts[i]!, y = pts[i + 1]!
    if (x - pad.side < b.minX) b.minX = x - pad.side
    if (y - pad.up < b.minY) b.minY = y - pad.up
    if (x + pad.side > b.maxX) b.maxX = x + pad.side
    if (y + pad.down > b.maxY) b.maxY = y + pad.down
  }
  m.n = n
  return b
}

export function strokeBounds(strokes: BrushStroke[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const s of strokes) {
    if (isTipStroke(s)) {
      const b = tipStrokeBox(s)
      if (b.minX < minX) minX = b.minX
      if (b.minY < minY) minY = b.minY
      if (b.maxX > maxX) maxX = b.maxX
      if (b.maxY > maxY) maxY = b.maxY
      continue
    }
    const r = Math.max(0, s.radius)
    for (const p of s.points) {
      if (p.x - r < minX) minX = p.x - r
      if (p.y - r < minY) minY = p.y - r
      if (p.x + r > maxX) maxX = p.x + r
      if (p.y + r > maxY) maxY = p.y + r
    }
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 }
  return { minX, minY, maxX, maxY }
}

/** Derive a brush layer's placement box from its strokes. `w`/`h` are width-normalized
 *  (like every shape layer); `x` is a fraction of WIDTH and `y` a fraction of HEIGHT
 *  (the layer-position convention — `applyXform` translates to `x*W, y*H`). Strokes are
 *  width-normalized on both axes, so `y` is converted by the aspect (H/W). */
export function brushBoxFromStrokes(strokes: BrushStroke[], aspect: number): { x: number; y: number; w: number; h: number } {
  const b = strokeBounds(strokes)
  const w = Math.max(1e-4, b.maxX - b.minX)
  const h = Math.max(1e-4, b.maxY - b.minY)
  return { x: (b.minX + b.maxX) / 2, y: ((b.minY + b.maxY) / 2) / Math.max(1e-6, aspect), w, h }
}

/** Stamp ONE stroke as a run of round dabs along its (smoothed) path. The CALLER
 *  sets `ctx.globalAlpha` (= the stroke's flow) and the composite op; because each
 *  dab is a separate fill at that alpha, overlapping dabs BUILD UP toward opaque —
 *  low flow deposits little per pass and darkens where the stroke overlaps itself
 *  or is painted over again (Photoshop "Flow"). Dab spacing is a quarter-radius so
 *  a single pass stays continuous. Hard = solid discs; soft = radial-gradient discs
 *  (solid core out to `hardness`, fading to transparent at the edge). */
export function drawStrokeAlpha(ctx: CanvasRenderingContext2D, stroke: PaintStroke, base: number): void {
  const hard = stroke.hardness >= 0.999
  const pts = smoothPoints(stroke.points, hard ? 4 : 8)
  if (!pts.length) return
  const r = strokeRadiusPx(stroke, base)
  const inner = Math.max(0, Math.min(0.95, stroke.hardness))
  const step = Math.max(1, r * 0.25) // < radius so consecutive dabs stay continuous
  ctx.save()
  const dab = (x: number, y: number) => {
    if (hard) {
      ctx.fillStyle = '#fff'
    } else {
      const g = ctx.createRadialGradient(x, y, r * inner, x, y, r)
      g.addColorStop(0, '#fff'); g.addColorStop(inner, '#fff'); g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
    }
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill()
  }
  let prev = pts[0]!
  dab(prev.x * base, prev.y * base)
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!
    const dx = (p.x - prev.x) * base, dy = (p.y - prev.y) * base
    const dist = Math.hypot(dx, dy)
    const steps = Math.max(1, Math.floor(dist / step))
    for (let s = 1; s <= steps; s++) dab((prev.x * base) + (dx * s) / steps, (prev.y * base) + (dy * s) / steps)
    prev = p
  }
  ctx.restore()
}

/** Composite all strokes onto `ctx`, in order. A non-erase stroke deposits paint
 *  with `source-over` at its `opacity` (= flow) PER DAB, so a stroke that overlaps
 *  itself — and successive strokes over the same area — build up toward opaque
 *  instead of clamping to a flat per-stroke alpha. Erase strokes carve with
 *  `destination-out` at the same flow rate. */
export function stampStrokes(
  ctx: CanvasRenderingContext2D,
  strokes: PaintStroke[],
  base: number,
): void {
  for (const s of strokes) {
    if (!s.points.length) continue
    ctx.save()
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over'
    ctx.globalAlpha = Math.max(0, Math.min(1, s.opacity))
    drawStrokeAlpha(ctx, s, base)
    ctx.restore()
  }
}

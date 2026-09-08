/**
 * Geometry for a SHAPES stroke: library shapes marching along a shape's edge.
 *
 * Two pure steps, both testable as data:
 *   1. offset the flattened outline as a POLYLINE (each vertex along its angle bisector) —
 *      the easy half of the offset problem. Offsetting a bezier path is the hard half, the
 *      one `lib/vectortype/extrude.ts` says out loud that paper 0.12 cannot do.
 *   2. walk the resulting `Guide` by arc length, placing a mark every `spacing`.
 *
 * Nothing here draws. The painter decides what a mark looks like.
 */
import { type FlatPoint, longestSubpath } from '~/lib/compositor/pathFlatten'
import { type Guide, guideFromPolyline } from '~/lib/compositor/textPath'

/** A hard ceiling on marks per stroke. A spacing near zero would otherwise ask for
 *  millions and hang the draw loop; the cap turns a bad dial into a dense ring. */
export const SHAPE_STROKE_MAX_MARKS = 2000

const dedupe = (pts: readonly FlatPoint[]): FlatPoint[] => {
  const out: FlatPoint[] = []
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) < 1e-12 && Math.abs(last.y - p.y) < 1e-12) continue
    out.push({ x: p.x, y: p.y })
  }
  return out
}

/** Signed area × 2. Positive for counter-clockwise in a y-down space. */
function shoelace(pts: readonly FlatPoint[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!, q = pts[(i + 1) % pts.length]!
    a += p.x * q.y - q.x * p.y
  }
  return a
}

/**
 * Move every vertex along its angle bisector by `distance`, outward for a positive value.
 *
 * OUTWARD is defined by the polygon's own winding for a closed ring, so a shape authored
 * clockwise and the same shape authored counter-clockwise both GROW — otherwise the same
 * dial would grow one library shape and shrink the next, which is exactly the class of bug
 * the type-on-a-path work hit with path direction.
 *
 * Concave corners can self-cross at a large distance; that is a known and accepted limit
 * (the spec says to measure where it starts rather than pre-build a cleanup pass).
 */
export function offsetPolyline(pts: readonly FlatPoint[], closed: boolean, distance: number): FlatPoint[] {
  const src = dedupe(pts)
  if (src.length < 2) return []
  if (!Number.isFinite(distance) || distance === 0) return src
  const n = src.length
  const sign = closed && shoelace(src) < 0 ? -1 : 1
  const out: FlatPoint[] = []
  for (let i = 0; i < n; i++) {
    const prev = src[(i - 1 + n) % n]!, cur = src[i]!, next = src[(i + 1) % n]!
    // Segment normals either side of this vertex (y-down space: left normal of (dx,dy) is (dy,-dx)).
    const nrm = (a: FlatPoint, b: FlatPoint) => {
      const dx = b.x - a.x, dy = b.y - a.y
      const len = Math.hypot(dx, dy) || 1
      return { x: dy / len, y: -dx / len }
    }
    let nx = 0, ny = 0
    const hasPrev = closed || i > 0
    const hasNext = closed || i < n - 1
    if (hasPrev) { const m = nrm(prev, cur); nx += m.x; ny += m.y }
    if (hasNext) { const m = nrm(cur, next); nx += m.x; ny += m.y }
    const len = Math.hypot(nx, ny)
    if (len < 1e-9) { out.push({ x: cur.x, y: cur.y }); continue }
    nx /= len; ny /= len
    // Miter length: the bisector must travel further than the offset at a sharp corner so
    // the two offset segments actually meet. Capped so a needle-thin spike cannot shoot off.
    let scale = 1
    if (hasPrev && hasNext) {
      const a = nrm(prev, cur), b = nrm(cur, next)
      const cos = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))
      scale = Math.min(10, 1 / Math.max(0.1, Math.sqrt((1 + cos) / 2)))
    }
    const step = distance * sign * scale
    out.push({ x: cur.x + nx * step, y: cur.y + ny * step })
  }
  return out
}

export interface ShapePlacement { x: number; y: number; angle: number }

/**
 * Marks along a guide, every `spacing` of arc length.
 *
 * On a CLOSED guide the count is `round(length / spacing)` and the actual step is
 * `length / count`, so the last mark never lands on top of the first and there is no seam
 * gap — asking for a spacing the perimeter does not divide gives evenly spread marks at
 * close to the requested spacing.
 */
export function shapePlacements(guide: Guide, spacing: number): ShapePlacement[] {
  if (!(spacing > 0) || !(guide.length > 0)) return []
  const wanted = guide.closed
    ? Math.max(1, Math.round(guide.length / spacing))
    : Math.max(1, Math.floor(guide.length / spacing) + 1)
  const count = Math.min(wanted, SHAPE_STROKE_MAX_MARKS)
  const step = guide.closed ? guide.length / count : spacing
  const out: ShapePlacement[] = []
  for (let i = 0; i < count; i++) out.push(guide.at(i * step))
  return out
}

/**
 * A guide plus the translation that puts it back where the shape is drawn.
 *
 * `guideFromPolyline` RE-CENTRES its input on the polyline's own bounding-box midpoint.
 * That is what type-on-a-path wants (and it is a no-op for a `PathLayer`, whose `d` is
 * stored bbox-centred already), but it is NOT a no-op for every outline a layer can have:
 * `polygonPathData` writes a pentagon spanning y ∈ [-1, 0.809] around the origin the
 * painter draws it at, so its bbox midpoint is 0.0955 off. Measured, not assumed — a
 * pentagon's guide put its topmost mark at y = -0.9045 while the apex is drawn at y = -1.
 *
 * `cx`/`cy` is the midpoint that was removed. A mark at guide point `p` belongs at
 * `(p.x + cx, p.y + cy)` in the space `d` was written in. Handing it back here, rather
 * than changing the shared `guideFromPolyline`, keeps type-on-a-path's geometry untouched.
 */
export interface StrokeGuideFit {
  guide: Guide
  /** The bbox midpoint of the OFFSET outline, in `d`'s own coordinates. */
  cx: number
  cy: number
}

export function shapeStrokeGuideFit(d: string, distance: number, tolerance?: number): StrokeGuideFit | null {
  const sub = longestSubpath(d, tolerance ? { tolerance } : undefined)
  if (!sub) return null
  const pts = offsetPolyline(sub.pts, sub.closed, distance)
  if (pts.length < 2) return null
  const guide = guideFromPolyline(pts, sub.closed)
  if (!guide) return null
  // The same bbox `guideFromPolyline` measures, over the same points it measures it over
  // (it drops non-finite points first, so this does too).
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { guide, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 }
}

/** The guide a shapes stroke marches along: the layer's own outline, offset by `distance`.
 *  Only the LONGEST subpath is followed, so a shape with interior detail still runs its
 *  marks round the outline — the same rule type-on-a-path settled on.
 *
 *  Note the guide is in `guideFromPolyline`'s re-centred space; a caller that has to place
 *  a mark on the DRAWN edge wants `shapeStrokeGuideFit` above instead. */
export function shapeStrokeGuide(d: string, distance: number, tolerance?: number): Guide | null {
  return shapeStrokeGuideFit(d, distance, tolerance)?.guide ?? null
}

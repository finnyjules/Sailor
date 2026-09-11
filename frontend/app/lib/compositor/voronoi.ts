/**
 * Frame effects F3 (shatter) — a tiny, self-contained Voronoi diagram over a set of 2D seed
 * points, clipped to a rectangle. PURE math: no Vue, no canvas, no `document`, and — the point
 * of writing it here rather than pulling in `d3-delaunay` — NO dependency, so the shared
 * `package.json`/lockfile is untouched (see the F3 Task 6 report for the trade-off).
 *
 * METHOD: half-plane intersection, not Delaunay. A point's Voronoi cell is the set of points
 * closer to it than to any other seed, i.e. the intersection of one half-plane per other seed
 * (the side of the perpendicular bisector on the seed's own side). So for each seed we start
 * from the clip rectangle and successively clip it by every bisector via Sutherland–Hodgman
 * convex-polygon clipping — which is numerically stable (no circumcircle predicates) and
 * DETERMINISTIC. Cost is O(n²) clips of O(n)-vertex polygons → O(n³) overall, which for the
 * shatter effect's cell counts (tens, not thousands) is microseconds.
 *
 * The bisector between seeds p and q keeps the points x with |x−p|² ≤ |x−q|², which rearranges
 * to the linear half-plane  (q−p)·x ≤ (|q|²−|p|²)/2  — the form the clipper consumes.
 *
 * Each returned cell is a convex polygon (CCW or CW, as the clip rect was wound) with ≥ 3
 * points, or omitted entirely when a seed's cell is empty within the rectangle (duplicate or
 * dominated seed). Cell `i` corresponds to `points[i]`; the result is index-aligned with a
 * `null` for any seed whose cell vanished, so a caller can keep the seed↔cell correspondence.
 */
import type { Pt2 } from '~/lib/vector/pathOps'

export interface VRect { x0: number; y0: number; x1: number; y1: number }

/** Sutherland–Hodgman clip of a convex polygon by the half-plane `nx·x + ny·y ≤ c`.
 *  Inside is `d ≤ 0` where `d = nx·x + ny·y − c`. Returns the (possibly empty) clipped ring. */
function clipHalfPlane(poly: readonly Pt2[], nx: number, ny: number, c: number): Pt2[] {
  const out: Pt2[] = []
  const n = poly.length
  if (n === 0) return out
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!
    const da = nx * a.x + ny * a.y - c
    const db = nx * b.x + ny * b.y - c
    const aIn = da <= 0
    const bIn = db <= 0
    if (aIn) out.push({ x: a.x, y: a.y })
    // Edge crosses the boundary (strictly opposite signs): add the intersection point.
    if ((da < 0) !== (db < 0)) {
      const t = da / (da - db)
      out.push({ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) })
    }
  }
  return out
}

/**
 * Voronoi cells of `points`, each clipped to `rect`. Result is index-aligned with `points`:
 * `cells[i]` is the convex cell polygon (≥ 3 points) for `points[i]`, or `null` when that
 * seed's cell is empty inside the rectangle (a coincident or fully-dominated seed).
 *
 * A single seed (or none) yields just the whole rectangle for that seed. Non-finite seeds are
 * skipped (their cell is `null`) rather than corrupting every other cell's bisector.
 */
export function voronoiCells(points: readonly Pt2[], rect: VRect): (Pt2[] | null)[] {
  const { x0, y0, x1, y1 } = rect
  const base: Pt2[] = [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
  ]
  const finite = (p: Pt2) => Number.isFinite(p.x) && Number.isFinite(p.y)
  return points.map((p) => {
    if (!finite(p)) return null
    let cell: Pt2[] = base.map(v => ({ x: v.x, y: v.y }))
    for (const q of points) {
      if (q === p || !finite(q)) continue
      const nx = q.x - p.x
      const ny = q.y - p.y
      if (nx === 0 && ny === 0) continue // coincident seed → no bisector
      const c = (q.x * q.x + q.y * q.y - (p.x * p.x + p.y * p.y)) / 2
      cell = clipHalfPlane(cell, nx, ny, c)
      if (cell.length === 0) return null // clipped to nothing
    }
    return cell.length >= 3 ? cell : null
  })
}

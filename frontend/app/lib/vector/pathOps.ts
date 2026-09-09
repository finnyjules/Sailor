/**
 * Vector — shared path toolkit for Frame's geometry effects (F2). PURE.
 *
 * A thin, geometry-effect-shaped face over two engines that already exist and
 * are exercised elsewhere in the app:
 *
 *  - `app/lib/compositor/pathFlatten.ts` (`flattenPath`) turns an SVG `d` into
 *    subpaths of `{x,y}` points. This module does not reimplement any part of
 *    that parser/flattener — it calls it and reshapes the result.
 *  - `app/lib/compositor/strokeShapes.ts` (`resamplePolyline`/`resampleStep`)
 *    walks a flattened polyline at even arc length with a max-point guard.
 *    Reused as-is for `resampleByLength`.
 *
 * What's genuinely new here: a polyline→`d` serializer (`toPathD`) and two
 * small arc-length helpers (`pathLength`, `cumulativeLengths`) that Task 3/4's
 * trim/roughen/offset effects need and that neither engine currently exposes
 * as a standalone polyline op. `morph.ts`'s `subpathsToD` was considered, but
 * it serializes its own `Subpath` shape (`{start, segs: {kind:'line'|'cubic'}}`)
 * — round-tripping a plain polyline through that would cost more than a
 * straight M/L/Z writer.
 */
import { flattenPath, type FlattenOptions } from '~/lib/compositor/pathFlatten'
import { resamplePolyline } from '~/lib/compositor/strokeShapes'

// ── Types ───────────────────────────────────────────────────────────────────

export interface Pt2 { x: number; y: number }

/** A flattened or resampled polyline: points plus whether it closes back to
 *  its start. Matches `pathFlatten`'s `FlatSubpath` shape exactly, so a
 *  `flatten()` result can be handed to any other function in this module
 *  (or reassembled by `toPathD`) with no reshaping in between. */
export interface Polyline {
  pts: Pt2[]
  closed: boolean
}

// ── Flatten ─────────────────────────────────────────────────────────────────

/**
 * SVG `d` → subpaths of `{x,y}` points, one entry per subpath, in declaration
 * order. A thin reshape of `pathFlatten.flattenPath` — see that module's
 * header for the full command grammar, tolerance semantics, and the "never
 * throws" guarantee, all of which carry over unchanged.
 */
export function flatten(d: string, tolerance?: number): Polyline[] {
  const opts: FlattenOptions | undefined = typeof tolerance === 'number' ? { tolerance } : undefined
  return flattenPath(d, opts).map((sub) => ({ pts: sub.pts.map((p) => ({ x: p.x, y: p.y })), closed: sub.closed }))
}

// ── Resample ────────────────────────────────────────────────────────────────

/**
 * Resample a polyline at even arc length, `step` apart. Delegates entirely to
 * `strokeShapes.resamplePolyline`, which already folds in `resampleStep`'s
 * max-point guard (`WOBBLE_MAX_POINTS`) so a near-zero `step` degrades to a
 * coarser-but-bounded walk instead of hanging.
 */
export function resampleByLength(pts: readonly Pt2[], closed: boolean, step: number): Pt2[] {
  return resamplePolyline(pts, closed, step)
}

// ── Arc length ──────────────────────────────────────────────────────────────

/**
 * Total arc length of a polyline, including the implied closing chord when
 * `closed` (that chord is never stored in `pts` — see `pathFlatten`'s
 * `FlatSubpath.closed` doc — so callers must not append it themselves before
 * calling this).
 */
export function pathLength(pts: readonly Pt2[], closed: boolean): number {
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1] as Pt2
    const b = pts[i] as Pt2
    acc += Math.hypot(b.x - a.x, b.y - a.y)
  }
  if (closed && pts.length > 1) {
    const a = pts[pts.length - 1] as Pt2
    const b = pts[0] as Pt2
    acc += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return acc
}

/**
 * Cumulative arc length at each point: `out[0] === 0`, `out[i]` is the length
 * walked from `pts[0]` to `pts[i]`. Same length as `pts` — the closing chord
 * (when `closed`) contributes to `pathLength` but has no point of its own to
 * attach a cumulative value to, so it is not represented here.
 *
 * Monotonically non-decreasing; `out[out.length - 1] <= pathLength(pts, closed)`,
 * with equality when open (the last point IS the end of the last segment).
 */
export function cumulativeLengths(pts: readonly Pt2[], closed: boolean): number[] {
  void closed // symmetry with pathLength's signature; the closing chord has no point to index
  const out: number[] = new Array(pts.length)
  let acc = 0
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) {
      const a = pts[i - 1] as Pt2
      const b = pts[i] as Pt2
      acc += Math.hypot(b.x - a.x, b.y - a.y)
    }
    out[i] = acc
  }
  return out
}

// ── Serialize ───────────────────────────────────────────────────────────────

const fmt = (v: number, precision: number): string => {
  if (!Number.isFinite(v)) return '0'
  const r = Number(v.toFixed(precision))
  return String(r)
}

/**
 * Polylines → SVG `d`, one `M`+`L…` run per subpath, closed with `Z` when
 * `closed` (relying on `Z`'s implicit closing chord — the same convention
 * `pathFlatten` uses, so `flatten(toPathD(flatten(d)))` round-trips point-for-
 * point on a polygon). A subpath with fewer than 2 points is skipped; it has
 * no direction to draw.
 */
export function toPathD(subpaths: readonly Polyline[], precision = 3): string {
  const parts: string[] = []
  for (const sub of subpaths) {
    const pts = sub.pts
    if (pts.length < 2) continue
    const p0 = pts[0] as Pt2
    parts.push(`M${fmt(p0.x, precision)} ${fmt(p0.y, precision)}`)
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i] as Pt2
      parts.push(`L${fmt(p.x, precision)} ${fmt(p.y, precision)}`)
    }
    if (sub.closed) parts.push('Z')
  }
  return parts.join(' ')
}

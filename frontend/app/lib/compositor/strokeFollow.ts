/**
 * A stroke whose fill FOLLOWS THE LINE: the paint is drawn into a straight strip as long as the
 * band's centreline and as deep as the band, then bent round the stroke piece by piece.
 *
 * Pure: no canvas, no DOM. `paintFollowedBand` in useCompositorLayers.ts is the one painter.
 * Spec: docs/superpowers/specs/2026-09-25-stroke-fill-follows-line.md
 */
import type { FlatPoint } from '~/lib/compositor/pathFlatten'
import { isFill, isGradient, type Paint } from '~/lib/compositor/paint'

/** Which paints have anything to bend. A flat colour looks the same either way; foil and
 *  image fills are not in scope; a shader fill is a live field with no tile to repeat. */
export function paintCanFollow(paint: Paint | undefined): boolean {
  if (isGradient(paint)) return paint.stops.length > 0
  if (isFill(paint)) return paint.type !== 'solid' && paint.type !== 'shader'
  return false
}

/** Cap on `FollowFrame.reach`: how far past ±halfWidth the band mesh is allowed to stretch to
 *  cover a convex corner. */
export const FOLLOW_MAX_REACH = 2

/** The centreline, measured and given a normal at every sample. */
export interface FollowFrame {
  pts: FlatPoint[]
  /** Unit normals. Closed: pointing OUT of the shape. Open: the left-hand side of travel. */
  normals: FlatPoint[]
  /** How far past ±halfWidth the band mesh must reach at this sample so its edge does not fall
   *  short of the true offset curve near a convex corner (the smoothed normal undershoots a
   *  sharp turn); 1 = no extra reach needed, capped at `FOLLOW_MAX_REACH`. */
  reach: number[]
  /** `arc[i]` = distance along the line to `pts[i]`; one extra entry, the full length. */
  arc: number[]
  length: number
  closed: boolean
}

/**
 * Measure an evenly-sampled centreline and give each sample a normal.
 *
 * The normal at a sample is taken across a WINDOW of ±0.8·halfWidth of arc length, not from its
 * immediate neighbours. That is what rounds the bend at a corner: at a rect's corner the
 * neighbour normal would snap through 90° in one sample and the strip would tear open on the
 * outside and fold on the inside. The window is clamped to a quarter of the loop so a tiny
 * outline cannot average its normals away.
 *
 * That same smoothing is why the SMOOTHED normal undershoots a convex corner: the true offset
 * edge there is further out than `p + n·h` reaches. `reach` measures the shortfall (via the
 * angle between the smoothed and the raw, immediate-neighbour normal) so `bandTriangles` can
 * stretch the mesh out to cover it.
 */
export function followFrame(
  pts: readonly FlatPoint[], closed: boolean, halfWidth: number,
  /** −1 flips which side is outward — for a hole ring, whose outside is into the hole. */
  outward: 1 | -1 = 1,
): FollowFrame | null {
  const n = pts.length
  if (n < 2) return null
  const segs = closed ? n : n - 1
  const arc = [0]
  for (let i = 0; i < segs; i++) {
    const a = pts[i]!, b = pts[(i + 1) % n]!
    arc.push(arc[i]! + Math.hypot(b.x - a.x, b.y - a.y))
  }
  const length = arc[segs]!
  if (!(length > 0)) return null
  const step = length / segs
  const k = Math.max(1, Math.min(Math.max(1, Math.floor(n / 4)), Math.round((0.8 * Math.max(0, halfWidth)) / step)))
  let sign = 1
  if (closed) {
    let area = 0
    for (let i = 0; i < n; i++) { const a = pts[i]!, b = pts[(i + 1) % n]!; area += a.x * b.y - b.x * a.y }
    sign = area > 0 ? 1 : -1
  }
  sign *= outward   // both `normals` and `reach`'s raw normal are taken through `normalAt`, so both flip
  const at = (i: number) => (closed ? pts[((i % n) + n) % n]! : pts[Math.max(0, Math.min(n - 1, i))]!)
  const normalAt = (i: number, kk: number) => {
    const a = at(i - kk), b = at(i + kk)
    let tx = b.x - a.x, ty = b.y - a.y
    const l = Math.hypot(tx, ty) || 1
    tx /= l; ty /= l
    return { x: ty * sign, y: -tx * sign }
  }
  const normals = pts.map((_, i) => normalAt(i, k))
  const rawNormals = pts.map((_, i) => normalAt(i, 1))
  const reach = pts.map((_, i) => {
    const dot = normals[i]!.x * rawNormals[i]!.x + normals[i]!.y * rawNormals[i]!.y
    return Math.min(FOLLOW_MAX_REACH, 1 / Math.max(0.5, dot))
  })
  return { pts: pts.slice(), normals, reach, arc, length, closed }
}

export type Affine = [number, number, number, number, number, number]

/** The canvas `transform(a, b, c, d, e, f)` that carries triangle s0-s1-s2 onto d0-d1-d2.
 *  `null` when the source triangle has no area (nothing to map). */
export function triangleAffine(
  s0: FlatPoint, s1: FlatPoint, s2: FlatPoint, d0: FlatPoint, d1: FlatPoint, d2: FlatPoint,
): Affine | null {
  const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y)
  if (!(Math.abs(den) > 1e-12)) return null
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den
  const d = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den
  return [a, b, c, d, d0.x - a * s0.x - c * s0.y, d0.y - b * s0.x - d * s0.y]
}

export interface StripTriangle { src: [FlatPoint, FlatPoint, FlatPoint]; dst: [FlatPoint, FlatPoint, FlatPoint] }

const orient = (a: FlatPoint, b: FlatPoint, c: FlatPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)

/**
 * The strip → band mesh: FOUR triangles per centreline segment, split at the centreline into an
 * inner half (centre → inner edge) and an outer half (centre → outer edge). Strip `x` is arc
 * length, strip `y` stays 1:1 with distance from the centreline — `h` at the centre, `h − h·reach`
 * at the inner edge, `h + h·reach` at the outer edge — so it ranges over
 * `[h − h·FOLLOW_MAX_REACH, h + h·FOLLOW_MAX_REACH]` = `[−h, 3h]`. The mesh deliberately
 * OVER-reaches past the true band (`y ∈ [0, 2h]`) by up to `FOLLOW_MAX_REACH − 1` half-widths on
 * each side, because the smoothed normal undershoots a convex corner (see `followFrame`'s
 * `reach`); the painter must paint the strip over that wider range, `y ∈
 * [−h·(FOLLOW_MAX_REACH−1), 2h + h·(FOLLOW_MAX_REACH−1)]`, and the later band mask trims the
 * excess back to the true band.
 *
 * On the inside of a corner tighter than a half is deep, that half's edge runs BACKWARDS and its
 * triangles turn inside out. Those are dropped — found as the ones whose orientation (relative to
 * their source) disagrees with the majority, which is the right test whichever way the outline is
 * drawn. Splitting at the centreline means a fold on the concave side only drops that side's
 * triangles — the other half of the same segment survives untouched.
 */
export function bandTriangles(f: FollowFrame, halfWidth: number): StripTriangle[] {
  const n = f.pts.length, segs = f.closed ? n : n - 1, h = halfWidth
  const all: { t: StripTriangle; s: number }[] = []
  const push = (t: StripTriangle) => {
    const o = orient(t.dst[0], t.dst[1], t.dst[2]) * Math.sign(orient(t.src[0], t.src[1], t.src[2]))
    if (o !== 0) all.push({ t, s: Math.sign(o) })
  }
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n
    const p = f.pts[i]!, q = f.pts[j]!, np = f.normals[i]!, nq = f.normals[j]!
    const rp = f.reach[i]!, rq = f.reach[j]!
    const inP = { x: p.x - np.x * h * rp, y: p.y - np.y * h * rp }
    const outP = { x: p.x + np.x * h * rp, y: p.y + np.y * h * rp }
    const inQ = { x: q.x - nq.x * h * rq, y: q.y - nq.y * h * rq }
    const outQ = { x: q.x + nq.x * h * rq, y: q.y + nq.y * h * rq }
    const s0 = f.arc[i]!, s1 = f.arc[i + 1]!
    const yInP = h - h * rp, yInQ = h - h * rq, yOutP = h + h * rp, yOutQ = h + h * rq
    // inner half: centre p/q → inner edge
    push({ src: [{ x: s0, y: yInP }, { x: s1, y: yInQ }, { x: s0, y: h }], dst: [inP, inQ, p] })
    push({ src: [{ x: s1, y: yInQ }, { x: s1, y: h }, { x: s0, y: h }], dst: [inQ, q, p] })
    // outer half: centre p/q → outer edge
    push({ src: [{ x: s0, y: h }, { x: s1, y: h }, { x: s0, y: yOutP }], dst: [p, q, outP] })
    push({ src: [{ x: s1, y: h }, { x: s1, y: yOutQ }, { x: s0, y: yOutP }], dst: [q, outQ, outP] })
  }
  let vote = 0
  for (const e of all) vote += e.s
  const keep = vote >= 0 ? 1 : -1
  return all.filter(e => e.s === keep).map(e => e.t)
}

export type FollowStripPlan =
  | { kind: 'fade' }
  | { kind: 'stretch'; mirror: boolean }
  | { kind: 'tiles'; tiles: number; box: { w: number; h: number } }

/**
 * How the straight strip gets its paint.
 *
 * - ombre: a FADE map, dithered after bending (see `fadeStops`).
 * - gradients: stretched over the strip, and mirrored round a closed outline so the two ends
 *   meet on the same colour.
 * - everything else: the layer's OWN paint tile repeated along the strip, scaled so a whole
 *   number of tiles fits — the pattern closes without a seam and cells stay (almost) the size
 *   they are when the fill stays put. Scaling the whole tile (not re-deriving cell counts per
 *   fill type) is what makes this one rule serve grid, checkerboard, stripes, qr, shapes,
 *   noise and paper alike: every tile builder already fits whole cells across its tile.
 */
export function followStripPlan(
  paint: Paint | undefined, box: { w: number; h: number }, length: number, closed: boolean,
): FollowStripPlan | null {
  if (!paintCanFollow(paint)) return null
  if (isFill(paint) && paint.type === 'ombre') return { kind: 'fade' }
  if (isGradient(paint) || (isFill(paint) && paint.type === 'gradient')) return { kind: 'stretch', mirror: closed }
  const bw = box.w > 0 ? box.w : length
  const tiles = Math.max(1, Math.round(length / bw))
  const f = length / (tiles * bw)
  return { kind: 'tiles', tiles, box: { w: bw * f, h: (box.h > 0 ? box.h : bw) * f } }
}

/** The ombre fade as gradient stops: `t` 0 is colour A, 1 is colour B. 'across' runs inner
 *  edge → outer edge; 'along' goes out and back `repeats` times, so a closed loop meets itself
 *  on A with no seam. */
export function fadeStops(fade: 'across' | 'along', repeats: number): { axis: 'across' | 'along'; stops: { offset: number; t: number }[] } {
  if (fade === 'across') return { axis: 'across', stops: [{ offset: 0, t: 0 }, { offset: 1, t: 1 }] }
  const k = Math.max(1, Math.round(repeats))
  const stops: { offset: number; t: number }[] = []
  for (let i = 0; i < k; i++) stops.push({ offset: i / k, t: 0 }, { offset: (i + 0.5) / k, t: 1 })
  stops.push({ offset: 1, t: 0 })
  return { axis: 'along', stops }
}

const shoelaceSum = (pts: readonly FlatPoint[]) => {
  let a = 0
  for (let i = 0; i < pts.length; i++) { const p = pts[i]!, q = pts[(i + 1) % pts.length]!; a += p.x * q.y - q.x * p.y }
  return a
}

/**
 * Offset a polyline by `distance` the way the band MASK offsets its shape: a dilation (or, for a
 * negative distance, an erosion) with ROUND joins. `offsetPolyline` mitres every corner, which
 * is right for the wobbled band it draws but wrong for the straight band's mask
 * (`paintStrokeBand`, join 'round'): there a corner the offset turns AWAY from becomes an ARC of
 * radius |distance| centred on the shape's own corner, and a mitred centreline pushed out past
 * that arc leaves the mask's corner with no bent paint under it.
 *
 * Each segment is moved `distance` along its outward normal (outward = the ring's own winding,
 * the same convention as `offsetPolyline`, times `outward`). At a vertex:
 * - the offset edges SEPARATE (the line turns away from the offset side) → an arc round the
 *   source vertex at radius |distance|, sampled so its sagitta stays ≲ 0.1 units;
 * - the offset edges CROSS (the line turns towards the offset side) → their mitred
 *   intersection, which is genuinely sharp in the dilation / erosion (capped at 10×, as
 *   `offsetPolyline` caps its mitre, so a hairpin cannot shoot off).
 * `distance` 0 returns the points unchanged.
 */
export function roundOffsetPolyline(
  pts: readonly FlatPoint[], closed: boolean, distance: number, outward: 1 | -1 = 1,
): FlatPoint[] {
  if (!distance || !Number.isFinite(distance)) return pts.slice()
  // Consecutive duplicates (and a closing duplicate) have no direction to offset along.
  const src: FlatPoint[] = []
  for (const p of pts) { const q = src[src.length - 1]; if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-9) src.push(p) }
  if (closed && src.length > 1) { const a = src[0]!, b = src[src.length - 1]!; if (Math.hypot(a.x - b.x, a.y - b.y) <= 1e-9) src.pop() }
  const n = src.length
  if (n < 2) return src.map(p => ({ x: p.x, y: p.y }))
  const sign = (closed && shoelaceSum(src) < 0 ? -1 : 1) * outward
  const D = distance * sign
  const segs = closed ? n : n - 1
  // Per segment: unit direction and left normal (y-down: left of (dx, dy) is (dy, −dx)).
  const dir: FlatPoint[] = [], nrm: FlatPoint[] = []
  for (let i = 0; i < segs; i++) {
    const a = src[i]!, b = src[(i + 1) % n]!
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const u = { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
    dir.push(u); nrm.push({ x: u.y, y: -u.x })
  }
  const r = Math.abs(D)
  const maxStep = Math.min(0.2, Math.sqrt(0.8 / r))   // sagitta r·θ²/8 ≤ 0.1
  const out: FlatPoint[] = []
  const corner = (b: FlatPoint, i1: number, i2: number) => {
    const n1 = nrm[i1]!, n2 = nrm[i2]!, v = dir[i2]!
    const turn = (v.x * n1.x + v.y * n1.y) * D   // > 0: turning towards the offset side
    const dot = Math.max(-1, Math.min(1, n1.x * n2.x + n1.y * n2.y))
    if (turn < 0) {
      // The offset edges separate: the dilation's round join, centred on the source vertex.
      const ang = Math.atan2(n1.x * n2.y - n1.y * n2.x, dot)
      const steps = Math.max(1, Math.ceil(Math.abs(ang) / maxStep))
      for (let k = 0; k <= steps; k++) {
        const t = (ang * k) / steps, c = Math.cos(t), s = Math.sin(t)
        out.push({ x: b.x + (n1.x * c - n1.y * s) * D, y: b.y + (n1.x * s + n1.y * c) * D })
      }
    } else {
      // The offset edges cross (or run on, collinear): their intersection.
      const scale = Math.min(10, 1 / Math.max(0.1, Math.sqrt((1 + dot) / 2)))
      let mx = n1.x + n2.x, my = n1.y + n2.y
      const ml = Math.hypot(mx, my)
      if (ml < 1e-9) { mx = n1.x; my = n1.y } else { mx /= ml; my /= ml }
      out.push({ x: b.x + mx * D * scale, y: b.y + my * D * scale })
    }
  }
  if (closed) {
    for (let i = 0; i < n; i++) corner(src[i]!, (i - 1 + segs) % segs, i)
  } else {
    const a = src[0]!, z = src[n - 1]!
    out.push({ x: a.x + nrm[0]!.x * D, y: a.y + nrm[0]!.y * D })
    for (let i = 1; i < n - 1; i++) corner(src[i]!, i - 1, i)
    out.push({ x: z.x + nrm[segs - 1]!.x * D, y: z.y + nrm[segs - 1]!.y * D })
  }
  return out
}

/** Winding number of `ring` round (x, y). */
function windingOf(x: number, y: number, ring: readonly FlatPoint[]): number {
  let w = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!, b = ring[(i + 1) % ring.length]!
    const side = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y)
    if (a.y <= y) { if (b.y > y && side > 0) w++ }
    else if (b.y <= y && side < 0) w--
  }
  return w
}

/**
 * Is closed ring `i` a HOLE of the shape — the boundary where material gives way to empty on
 * its OWN inside? Decided the way the fill itself decides, under `fillRule`, over every closed
 * ring: a point a hair OUTSIDE the ring (along its own outward normal) is filled and a point a
 * hair INSIDE is not. So under 'nonzero' an inner ring wound the SAME way as the outer one is
 * not a hole (both sides are filled), while under 'evenodd' it is. Open subpaths never are.
 */
export function ringIsHole(
  rings: readonly { pts: readonly FlatPoint[]; closed: boolean }[], i: number, fillRule: CanvasFillRule = 'nonzero',
): boolean {
  const ring = rings[i]
  if (!ring || !ring.closed || ring.pts.length < 3) return false
  const pts = ring.pts
  // Test at the midpoint of the ring's longest edge: least likely to sit on another ring.
  let best = -1, bl = 0
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k]!, b = pts[(k + 1) % pts.length]!, l = Math.hypot(b.x - a.x, b.y - a.y)
    if (l > bl) { bl = l; best = k }
  }
  if (best < 0) return false
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y) }
  const eps = Math.max(1e-6, Math.min(bl * 0.25, Math.hypot(maxX - minX, maxY - minY) * 1e-4))
  const a = pts[best]!, b = pts[(best + 1) % pts.length]!
  const sign = shoelaceSum(pts) < 0 ? -1 : 1
  const nx = ((b.y - a.y) / bl) * sign, ny = (-(b.x - a.x) / bl) * sign   // own outward normal
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
  const filled = (x: number, y: number) => {
    let w = 0
    for (const r of rings) if (r.closed && r.pts.length >= 3) w += fillRule === 'evenodd' ? Math.abs(windingOf(x, y, r.pts)) % 2 : windingOf(x, y, r.pts)
    return fillRule === 'evenodd' ? w % 2 === 1 : w !== 0
  }
  return filled(mx + nx * eps, my + ny * eps) && !filled(mx - nx * eps, my - ny * eps)
}

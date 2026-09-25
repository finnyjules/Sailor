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

/** The centreline, measured and given a normal at every sample. */
export interface FollowFrame {
  pts: FlatPoint[]
  /** Unit normals. Closed: pointing OUT of the shape. Open: the left-hand side of travel. */
  normals: FlatPoint[]
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
 */
export function followFrame(pts: readonly FlatPoint[], closed: boolean, halfWidth: number): FollowFrame | null {
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
  const at = (i: number) => (closed ? pts[((i % n) + n) % n]! : pts[Math.max(0, Math.min(n - 1, i))]!)
  const normals = pts.map((_, i) => {
    const a = at(i - k), b = at(i + k)
    let tx = b.x - a.x, ty = b.y - a.y
    const l = Math.hypot(tx, ty) || 1
    tx /= l; ty /= l
    return { x: ty * sign, y: -tx * sign }
  })
  return { pts: pts.slice(), normals, arc, length, closed }
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
 * The strip → band mesh: two triangles per centreline segment. Strip `x` is arc length, strip
 * `y` runs 0 (inner edge, `p − n·h`) to `2h` (outer edge, `p + n·h`).
 *
 * On the inside of a corner tighter than the band is deep, the inner edge runs BACKWARDS and
 * its triangles turn inside out. Those are dropped — found as the ones whose orientation
 * (relative to their source) disagrees with the majority, which is the right test whichever
 * way the outline is drawn. The band mask trims what remains.
 */
export function bandTriangles(f: FollowFrame, halfWidth: number): StripTriangle[] {
  const n = f.pts.length, segs = f.closed ? n : n - 1, W = 2 * halfWidth
  const all: { t: StripTriangle; s: number }[] = []
  const push = (t: StripTriangle) => {
    const o = orient(t.dst[0], t.dst[1], t.dst[2]) * Math.sign(orient(t.src[0], t.src[1], t.src[2]))
    if (o !== 0) all.push({ t, s: Math.sign(o) })
  }
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n
    const p = f.pts[i]!, q = f.pts[j]!, np = f.normals[i]!, nq = f.normals[j]!
    const inP = { x: p.x - np.x * halfWidth, y: p.y - np.y * halfWidth }
    const outP = { x: p.x + np.x * halfWidth, y: p.y + np.y * halfWidth }
    const inQ = { x: q.x - nq.x * halfWidth, y: q.y - nq.y * halfWidth }
    const outQ = { x: q.x + nq.x * halfWidth, y: q.y + nq.y * halfWidth }
    const s0 = f.arc[i]!, s1 = f.arc[i + 1]!
    push({ src: [{ x: s0, y: 0 }, { x: s1, y: 0 }, { x: s0, y: W }], dst: [inP, inQ, outP] })
    push({ src: [{ x: s1, y: 0 }, { x: s1, y: W }, { x: s0, y: W }], dst: [inQ, outQ, outP] })
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

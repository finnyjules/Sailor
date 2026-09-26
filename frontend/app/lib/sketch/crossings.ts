import type { SketchDoc, EntityId } from './model'
import { getEntity, getPoint, lineEndpoints, circleCenter } from './model'
import type { Vec2 } from './geom'
import { sub, dot, cross, dist } from './geom'

const TAU = Math.PI * 2
const EPS_T = 1e-7
const EPS_LEN = 1e-6

export type CurveRef =
  | { kind: 'line'; id: EntityId }
  | { kind: 'circle'; id: EntityId }
  | { kind: 'seg'; pathId: EntityId; segIndex: number }

export interface CurveGeom {
  ref: CurveRef
  kind: 'line' | 'arc' | 'circle'
  a?: Vec2
  b?: Vec2
  c?: Vec2
  r?: number
  a0?: number
  sweepAngle?: number // signed; +CCW / -CW
}

function refEquals(a: CurveRef, b: CurveRef): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'seg' && b.kind === 'seg') return a.pathId === b.pathId && a.segIndex === b.segIndex
  if (a.kind === 'line' && b.kind === 'line') return a.id === b.id
  if (a.kind === 'circle' && b.kind === 'circle') return a.id === b.id
  return false
}

function normAngle(ang: number): number {
  return ((ang % TAU) + TAU) % TAU
}

export function curveGeom(doc: SketchDoc, ref: CurveRef): CurveGeom | null {
  if (ref.kind === 'line') {
    const e = getEntity(doc, ref.id)
    if (!e || e.kind !== 'line') return null
    const pts = lineEndpoints(doc, e)
    if (!pts) return null
    return { ref, kind: 'line', a: pts.a, b: pts.b }
  }
  if (ref.kind === 'circle') {
    const e = getEntity(doc, ref.id)
    if (!e || e.kind !== 'circle') return null
    const c = circleCenter(doc, e)
    if (!c || !(e.r > 0)) return null
    return { ref, kind: 'circle', c, r: e.r }
  }
  // seg
  const e = getEntity(doc, ref.pathId)
  if (!e || e.kind !== 'path') return null
  const segCount = e.closed ? e.anchors.length : e.anchors.length - 1
  if (ref.segIndex < 0 || ref.segIndex >= segCount) return null
  const seg = e.segments[ref.segIndex]
  if (!seg) return null
  const startPt = getPoint(doc, e.anchors[ref.segIndex]!)
  const endPt = getPoint(doc, e.anchors[(ref.segIndex + 1) % e.anchors.length]!)
  if (!startPt || !endPt) return null
  const a: Vec2 = { x: startPt.x, y: startPt.y }
  const b: Vec2 = { x: endPt.x, y: endPt.y }
  if (seg.kind === 'line') return { ref, kind: 'line', a, b }
  if (seg.kind === 'cubic') return null
  // arc — mirror sketchPath.ts's pathD convention exactly
  const cp = getPoint(doc, seg.center)
  if (!cp) return null
  const c: Vec2 = { x: cp.x, y: cp.y }
  const r = dist(c, a)
  if (r < EPS_LEN) return null
  const a0 = Math.atan2(a.y - c.y, a.x - c.x)
  const a1 = Math.atan2(b.y - c.y, b.x - c.x)
  const ccw = normAngle(a1 - a0)
  const span = seg.sweep === 1 ? ccw : TAU - ccw
  const sweepAngle = seg.sweep === 1 ? span : -span
  return { ref, kind: 'arc', a, b, c, r, a0, sweepAngle }
}

export function allCurves(doc: SketchDoc): CurveRef[] {
  const out: CurveRef[] = []
  for (const e of doc.entities) {
    if (e.kind === 'line') out.push({ kind: 'line', id: e.id })
    else if (e.kind === 'circle') out.push({ kind: 'circle', id: e.id })
    else if (e.kind === 'path') {
      const segCount = e.closed ? e.anchors.length : e.anchors.length - 1
      for (let i = 0; i < segCount; i++) {
        const seg = e.segments[i]
        if (seg && seg.kind !== 'cubic') out.push({ kind: 'seg', pathId: e.id, segIndex: i })
      }
    }
  }
  return out
}

export function pointAt(g: CurveGeom, t: number): Vec2 {
  if (g.kind === 'line') {
    const a = g.a!, b = g.b!
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  }
  if (g.kind === 'circle') {
    const c = g.c!, r = g.r!
    return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) }
  }
  const c = g.c!, r = g.r!
  const ang = g.a0! + g.sweepAngle! * t
  return { x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) }
}

// nearest-point parameter on the curve to p, clamped to the curve's own extent
function arcParamClamped(a0: number, sweepAngle: number, ang: number): number {
  const s = sweepAngle >= 0 ? 1 : -1
  const mag = Math.abs(sweepAngle)
  if (mag < 1e-12) return 0
  const delta = normAngle(s * (ang - a0))
  if (delta <= mag) return delta / mag
  const pastEnd = delta - mag
  const gap = TAU - mag
  return pastEnd < gap / 2 ? 1 : 0
}

export function paramOf(g: CurveGeom, p: Vec2): number {
  if (g.kind === 'line') {
    const a = g.a!, b = g.b!
    const d = sub(b, a)
    const L2 = dot(d, d)
    if (L2 < 1e-18) return 0
    let t = dot(sub(p, a), d) / L2
    if (t < 0) t = 0
    if (t > 1) t = 1
    return t
  }
  const c = g.c!
  const ang = Math.atan2(p.y - c.y, p.x - c.x)
  if (g.kind === 'circle') return normAngle(ang)
  return arcParamClamped(g.a0!, g.sweepAngle!, ang)
}

export function nearestCurve(doc: SketchDoc, p: Vec2, tol: number): { ref: CurveRef; t: number; dist: number } | null {
  let best: { ref: CurveRef; t: number; dist: number } | null = null
  for (const ref of allCurves(doc)) {
    const g = curveGeom(doc, ref)
    if (!g) continue
    const t = paramOf(g, p)
    const pt = pointAt(g, t)
    const d = dist(p, pt)
    if (d <= tol && (!best || d < best.dist)) best = { ref, t, dist: d }
  }
  return best
}

export interface Crossing { t: number; point: Vec2; cutter: CurveRef; cutterT: number }

// raw (unclamped) line parameter — used only to test extent membership for crossings
function lineParamRaw(a: Vec2, b: Vec2, p: Vec2): number {
  const d = sub(b, a)
  const L2 = dot(d, d)
  if (L2 < 1e-18) return 0
  return dot(sub(p, a), d) / L2
}

// raw arc parameter — null when the angle falls outside the swept extent
function arcParamRaw(a0: number, sweepAngle: number, ang: number): number | null {
  const s = sweepAngle >= 0 ? 1 : -1
  const mag = Math.abs(sweepAngle)
  if (mag < 1e-12) return null
  const delta = normAngle(s * (ang - a0))
  const t = delta / mag
  if (t < -EPS_T || t > 1 + EPS_T) return null
  return Math.min(1, Math.max(0, t))
}

interface IntersectionPoint { p: Vec2; tSelf: number; tOther: number }

function lineLine(g1: CurveGeom, g2: CurveGeom): IntersectionPoint[] {
  const a1 = g1.a!, b1 = g1.b!, a2 = g2.a!, b2 = g2.b!
  const d1 = sub(b1, a1), d2 = sub(b2, a2)
  const denom = cross(d1, d2)
  if (Math.abs(denom) < 1e-12) return [] // parallel (or collinear-overlap) — not a crossing in v1
  const t = cross(sub(a2, a1), d2) / denom
  const s = cross(sub(a2, a1), d1) / denom
  if (t < -EPS_T || t > 1 + EPS_T || s < -EPS_T || s > 1 + EPS_T) return []
  const tc = Math.min(1, Math.max(0, t))
  const sc = Math.min(1, Math.max(0, s))
  return [{ p: pointAt(g1, tc), tSelf: tc, tOther: sc }]
}

// gLine × (circle or arc) gC — returns tSelf = line param, tOther = circle/arc param
function lineCircleLike(gLine: CurveGeom, gC: CurveGeom): IntersectionPoint[] {
  const a = gLine.a!, b = gLine.b!
  const c = gC.c!, r = gC.r!
  const d = sub(b, a)
  const f = sub(a, c)
  const A = dot(d, d)
  if (A < 1e-18) return []
  const B = 2 * dot(f, d)
  const C = dot(f, f) - r * r
  const disc = B * B - 4 * A * C
  if (disc < -1e-9) return []
  const out: IntersectionPoint[] = []
  const tangent = disc < 1e-9
  const sq = Math.sqrt(Math.max(0, disc))
  const ts = tangent ? [(-B) / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]
  for (const tRaw of ts) {
    if (tRaw < -EPS_T || tRaw > 1 + EPS_T) continue
    const tc = Math.min(1, Math.max(0, tRaw))
    const p = pointAt(gLine, tc)
    const ang = Math.atan2(p.y - c.y, p.x - c.x)
    const tOther = gC.kind === 'circle' ? normAngle(ang) : arcParamRaw(gC.a0!, gC.sweepAngle!, ang)
    if (tOther === null) continue
    out.push({ p, tSelf: tc, tOther })
  }
  return out
}

// (circle or arc) × (circle or arc)
function circleCircleLike(g1: CurveGeom, g2: CurveGeom): IntersectionPoint[] {
  const c1 = g1.c!, r1 = g1.r!, c2 = g2.c!, r2 = g2.r!
  const d = dist(c1, c2)
  if (d < 1e-9) return [] // concentric (incl. identical) — not a crossing in v1
  if (d > r1 + r2 + 1e-9) return []
  if (d < Math.abs(r1 - r2) - 1e-9) return []
  const a = (d * d + r1 * r1 - r2 * r2) / (2 * d)
  const h2 = r1 * r1 - a * a
  const ux = (c2.x - c1.x) / d, uy = (c2.y - c1.y) / d
  const mx = c1.x + a * ux, my = c1.y + a * uy
  const pts: Vec2[] = []
  if (h2 < 1e-9) {
    pts.push({ x: mx, y: my })
  } else {
    const h = Math.sqrt(h2)
    pts.push({ x: mx - h * uy, y: my + h * ux })
    pts.push({ x: mx + h * uy, y: my - h * ux })
  }
  const out: IntersectionPoint[] = []
  for (const p of pts) {
    const ang1 = Math.atan2(p.y - c1.y, p.x - c1.x)
    const ang2 = Math.atan2(p.y - c2.y, p.x - c2.x)
    const t1 = g1.kind === 'circle' ? normAngle(ang1) : arcParamRaw(g1.a0!, g1.sweepAngle!, ang1)
    if (t1 === null) continue
    const t2 = g2.kind === 'circle' ? normAngle(ang2) : arcParamRaw(g2.a0!, g2.sweepAngle!, ang2)
    if (t2 === null) continue
    out.push({ p, tSelf: t1, tOther: t2 })
  }
  return out
}

function intersect(g1: CurveGeom, g2: CurveGeom): IntersectionPoint[] {
  if (g1.kind === 'line' && g2.kind === 'line') return lineLine(g1, g2)
  if (g1.kind === 'line') return lineCircleLike(g1, g2)
  if (g2.kind === 'line') return lineCircleLike(g2, g1).map(x => ({ p: x.p, tSelf: x.tOther, tOther: x.tSelf }))
  return circleCircleLike(g1, g2)
}

// every anchor point ref shares with other, when both are segments of the same path.
// A path can share BOTH its anchors with another segment (e.g. a two-arc "lens" or
// digon, and the closed-path wrap pair segIndex n-1 vs 0), so this returns every
// coincidence, not just the first.
function sharedAnchorPoints(doc: SketchDoc, ref: CurveRef, other: CurveRef): Vec2[] {
  if (ref.kind !== 'seg' || other.kind !== 'seg' || ref.pathId !== other.pathId) return []
  const path = getEntity(doc, ref.pathId)
  if (!path || path.kind !== 'path') return []
  const n = path.anchors.length
  const aIds = [path.anchors[ref.segIndex]!, path.anchors[(ref.segIndex + 1) % n]!]
  const bIds = [path.anchors[other.segIndex]!, path.anchors[(other.segIndex + 1) % n]!]
  const sharedIds = bIds.filter(id => aIds.includes(id))
  const out: Vec2[] = []
  for (const id of sharedIds) {
    const pt = getPoint(doc, id)
    if (pt) out.push({ x: pt.x, y: pt.y })
  }
  return out
}

export function crossingsOn(doc: SketchDoc, ref: CurveRef): Crossing[] {
  const g = curveGeom(doc, ref)
  if (!g) return []
  const out: Crossing[] = []
  for (const other of allCurves(doc)) {
    if (refEquals(ref, other)) continue
    const g2 = curveGeom(doc, other)
    if (!g2) continue
    const shared = sharedAnchorPoints(doc, ref, other)
    for (const ip of intersect(g, g2)) {
      if (shared.some(s => dist(ip.p, s) < EPS_LEN)) continue
      out.push({ t: ip.tSelf, point: ip.p, cutter: other, cutterT: ip.tOther })
    }
  }
  out.sort((a, b) => a.t - b.t)
  return out
}

export interface SpanEnd { t: number; point: Vec2; cutter: CurveRef | null; cutterT?: number }
export interface Span { ref: CurveRef; start: SpanEnd; end: SpanEnd; wraps?: boolean }

function findBracket(ext: Crossing[], tn: number): { start: Crossing; end: Crossing } | null {
  for (let i = 0; i < ext.length - 1; i++) {
    const cur = ext[i]!, next = ext[i + 1]!
    if (tn >= cur.t - 1e-9 && tn <= next.t + 1e-9) return { start: cur, end: next }
  }
  return null
}

// same bracket search as findBracket, but over SpanEnd boundaries (line/arc: the
// curve's own t=0/t=1 ends, cutter null, plus every crossing in between) — explicit,
// so it can't silently invert into "last assignment wins" if someone edits it later.
function findLinearBracket(ends: SpanEnd[], tc: number): { start: SpanEnd; end: SpanEnd } {
  for (let i = 0; i < ends.length - 1; i++) {
    const cur = ends[i]!, next = ends[i + 1]!
    if (tc >= cur.t - 1e-9 && tc <= next.t + 1e-9) return { start: cur, end: next }
  }
  // ends[0].t === 0 and ends[last].t === 1 always bracket [0,1]; unreachable in practice
  return { start: ends[0]!, end: ends[ends.length - 1]! }
}

export function spanAt(doc: SketchDoc, ref: CurveRef, t: number): Span | null {
  const g = curveGeom(doc, ref)
  if (!g) return null
  const crossings = crossingsOn(doc, ref)

  if (g.kind === 'circle') {
    const tn = normAngle(t)
    if (crossings.length === 0) {
      const p0 = pointAt(g, 0)
      return { ref, start: { t: 0, point: p0, cutter: null }, end: { t: TAU, point: p0, cutter: null }, wraps: true }
    }
    const first = crossings[0]!
    const wrapped: Crossing = { t: first.t + TAU, point: first.point, cutter: first.cutter, cutterT: first.cutterT }
    const ext = [...crossings, wrapped]
    const found = findBracket(ext, tn) ?? findBracket(ext, tn + TAU)
    if (!found) return null
    const wraps = found.end === wrapped
    return {
      ref,
      start: { t: found.start.t, point: found.start.point, cutter: found.start.cutter, cutterT: found.start.cutterT },
      end: { t: found.end.t, point: found.end.point, cutter: found.end.cutter, cutterT: found.end.cutterT },
      wraps,
    }
  }

  // line or arc segment: t in [0,1]
  const tc = Math.min(1, Math.max(0, t))
  const ends: SpanEnd[] = [
    { t: 0, point: pointAt(g, 0), cutter: null },
    ...crossings.map(cr => ({ t: cr.t, point: cr.point, cutter: cr.cutter, cutterT: cr.cutterT })),
    { t: 1, point: pointAt(g, 1), cutter: null },
  ]
  const { start, end } = findLinearBracket(ends, tc)
  return { ref, start, end }
}

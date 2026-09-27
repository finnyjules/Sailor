import type { SketchDoc, SketchConstraint, EntityId, ConstraintKind } from './model'
import { getEntity, getPoint, lineEndpoints, circleCenter } from './model'
import type { Vec2 } from './geom'
import { dist } from './geom'
import { tangentTouchPoint } from './tangency'

export interface ConstraintMark { id: EntityId; kind: ConstraintKind; glyph: string; x: number; y: number; text?: string }

const GLYPH: Record<ConstraintKind, string> = {
  tangentLineCircle: 'T', tangentCircleCircle: 'T', coincident: '=', concentric: '◎',
  horizontal: 'H', vertical: 'V', pointOnLine: '—', pointOnCircle: 'o', distance: '↔', radius: 'R',
  equalDist: 'E', rotatedFrom: '↻', mirroredFrom: '⇄', collinear: 'S',
  perpendicular: '⊥', parallel: '∥', midpoint: 'M', equalRadius: 'E',
  tangentLineArc: 'T', tangentArcs: 'T',
}

// a representative world point to anchor the badge near, for the first resolvable ref
function anchor(doc: SketchDoc, c: SketchConstraint): Vec2 | null {
  if (c.kind === 'tangentLineArc' || c.kind === 'tangentArcs') {
    const t = tangentTouchPoint(doc, c)
    if (t) return t
  }
  for (const ref of c.refs) {
    const e = getEntity(doc, ref)
    if (!e) continue
    if (e.kind === 'point') return { x: e.x, y: e.y }
    if (e.kind === 'line') { const ep = lineEndpoints(doc, e); if (ep) return { x: (ep.a.x + ep.b.x) / 2, y: (ep.a.y + ep.b.y) / 2 } }
    if (e.kind === 'circle') { const cen = circleCenter(doc, e); if (cen) return { x: cen.x + e.r, y: cen.y } }
    if (e.kind === 'path') {
      // midpoint of the first two resolvable anchors (i.e. the first segment's endpoints)
      const pts = e.anchors.map(id => getPoint(doc, id)).filter((p): p is NonNullable<typeof p> => !!p)
      if (pts.length >= 2) return { x: (pts[0]!.x + pts[1]!.x) / 2, y: (pts[0]!.y + pts[1]!.y) / 2 }
    }
  }
  return null
}

export interface ArcDimensionMark { id: string; x: number; y: number; text: string }

// persistent "R n.n" radius chips for every arc segment of every non-construction
// path, positioned in WORLD coords at the arc's true midpoint: the point at the
// mid-angle of the DRAWN arc, matching sketchPath.ts's sweep convention (so the
// chip lands on the visible side of the arc, not the opposite side). Using the
// mid-angle (rather than nudging the chord midpoint out to the circle) also
// keeps semicircles working: a semicircle's chord midpoint coincides with the
// center, which made the old approach degenerate and skip the mark entirely.
export function arcDimensionMarks(doc: SketchDoc): ArcDimensionMark[] {
  const out: ArcDimensionMark[] = []
  const TAU = Math.PI * 2
  for (const e of doc.entities) {
    if (e.kind !== 'path' || e.construction) continue
    for (let i = 0; i < e.segments.length; i++) {
      const seg = e.segments[i]!
      if (seg.kind !== 'arc') continue
      const startId = e.anchors[i]
      const endId = e.anchors[(i + 1) % e.anchors.length]
      const start = startId != null ? getPoint(doc, startId) : undefined
      const end = endId != null ? getPoint(doc, endId) : undefined
      const center = getPoint(doc, seg.center)
      if (!start || !end || !center) continue
      const c: Vec2 = { x: center.x, y: center.y }
      const s: Vec2 = { x: start.x, y: start.y }
      const en: Vec2 = { x: end.x, y: end.y }
      const radius = dist(c, s)
      if (!Number.isFinite(radius) || radius < 1e-6) continue
      const a0 = Math.atan2(s.y - c.y, s.x - c.x)
      const a1 = Math.atan2(en.y - c.y, en.x - c.x)
      const ccw = ((a1 - a0) % TAU + TAU) % TAU
      const midAngle = seg.sweep === 1 ? a0 + ccw / 2 : a0 - (TAU - ccw) / 2
      const arcMid: Vec2 = { x: c.x + radius * Math.cos(midAngle), y: c.y + radius * Math.sin(midAngle) }
      if (!Number.isFinite(arcMid.x) || !Number.isFinite(arcMid.y)) continue
      out.push({ id: `${e.id}:${i}`, x: arcMid.x, y: arcMid.y, text: `R ${radius.toFixed(1)}` })
    }
  }
  return out
}

export function constraintMarks(doc: SketchDoc): ConstraintMark[] {
  const out: ConstraintMark[] = []
  for (const c of doc.constraints) {
    // require every ref to resolve, matching residuals' skip behavior
    if (!c.refs.every(r => getEntity(doc, r))) continue
    const at = anchor(doc, c)
    if (!at) continue
    out.push({ id: c.id, kind: c.kind, glyph: GLYPH[c.kind], x: at.x, y: at.y, ...(c.value != null && c.kind !== 'tangentArcs' ? { text: String(Math.round(c.value * 100) / 100) } : {}) })
  }
  return out
}

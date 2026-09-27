// app/lib/sketch/tangency.ts
// Tangency, pen stage 4. Shared by the solver (the two new rule kinds read
// their circle operands here), the badges (the touch point), the rules row
// (which rule makes two pieces tangent) and the Pen's bow snap.
//
// A "circle operand" is how a tangency rule names a round thing: either a
// point pair [C, S] (centre, and any point on it — a path arc's centre and its
// start anchor) or a circle entity's id (its centre point and its r).
import type { SketchDoc, SketchEntity, SketchConstraint, PointEntity, CircleEntity, EntityId } from './model'
import type { Vec2 } from './geom'

export type CircleOperand =
  | { kind: 'pair'; c: PointEntity; s: PointEntity }
  | { kind: 'circle'; c: PointEntity; circle: CircleEntity }

/** Reads refs[start..] as circle operands: a circle id takes one ref, a point
 *  takes itself and the next ref (which must be a point). Null when anything
 *  is missing or of the wrong kind; the caller checks how many it needs. */
export function readCircleOperands(map: ReadonlyMap<EntityId, SketchEntity>, refs: EntityId[], start: number): CircleOperand[] | null {
  const out: CircleOperand[] = []
  let i = start
  while (i < refs.length) {
    const e = map.get(refs[i]!)
    if (!e) return null
    if (e.kind === 'circle') {
      const c = map.get(e.center)
      if (!c || c.kind !== 'point') return null
      out.push({ kind: 'circle', c, circle: e })
      i += 1
    } else if (e.kind === 'point') {
      const s = map.get(refs[i + 1] ?? '')
      if (!s || s.kind !== 'point') return null
      out.push({ kind: 'pair', c: e, s })
      i += 2
    } else {
      return null
    }
  }
  return out
}

export function operandRadius(o: CircleOperand): number {
  return o.kind === 'circle' ? o.circle.r : Math.hypot(o.s.x - o.c.x, o.s.y - o.c.y)
}

function entityMap(doc: SketchDoc): Map<EntityId, SketchEntity> {
  const m = new Map<EntityId, SketchEntity>()
  for (const e of doc.entities) m.set(e.id, e)
  return m
}

/** Where a tangentLineArc / tangentArcs rule touches (its badge sits here):
 *  the foot of the centre on the line, or the point on the line of centres at
 *  the first radius. Null for any other kind or unreadable refs. */
export function tangentTouchPoint(doc: SketchDoc, c: SketchConstraint): Vec2 | null {
  const map = entityMap(doc)
  if (c.kind === 'tangentLineArc') {
    const a = map.get(c.refs[0]!), b = map.get(c.refs[1]!)
    const ops = readCircleOperands(map, c.refs, 2)
    if (!a || a.kind !== 'point' || !b || b.kind !== 'point' || !ops || ops.length !== 1) return null
    const o = ops[0]!
    const dx = b.x - a.x, dy = b.y - a.y
    const L2 = dx * dx + dy * dy
    if (L2 < 1e-18) return null
    const t = ((o.c.x - a.x) * dx + (o.c.y - a.y) * dy) / L2
    return { x: a.x + t * dx, y: a.y + t * dy }
  }
  if (c.kind === 'tangentArcs') {
    const ops = readCircleOperands(map, c.refs, 0)
    if (!ops || ops.length !== 2) return null
    const [o1, o2] = ops as [CircleOperand, CircleOperand]
    const r1 = operandRadius(o1), r2 = operandRadius(o2)
    const dx = o2.c.x - o1.c.x, dy = o2.c.y - o1.c.y
    const d = Math.hypot(dx, dy)
    if (d < 1e-9) return { x: o1.c.x + r1, y: o1.c.y }
    // inside, first one smaller: it touches on its far side from the other centre
    const k = c.value === -1 && r1 < r2 ? -1 : 1
    return { x: o1.c.x + (k * r1 * dx) / d, y: o1.c.y + (k * r1 * dy) / d }
  }
  return null
}

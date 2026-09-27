import type { SketchDoc, SketchConstraint, SketchEntity, PointEntity, LineEntity, CircleEntity, EntityId } from './model'
import { dist, distPointToLine } from './geom'
import { readCircleOperands, operandRadius } from './tangency'

type EntityMap = Map<EntityId, SketchEntity>

function pointOf(map: EntityMap, id: EntityId): PointEntity | null {
  const e = map.get(id)
  return e && e.kind === 'point' ? e : null
}
function circleOf(map: EntityMap, id: EntityId): CircleEntity | null {
  const e = map.get(id)
  return e && e.kind === 'circle' ? e : null
}
function lineOf(map: EntityMap, id: EntityId): LineEntity | null {
  const e = map.get(id)
  return e && e.kind === 'line' ? e : null
}
// inline replacement for model.ts's lineEndpoints/circleCenter, resolved via the map
function lineEnds(map: EntityMap, l: LineEntity): { a: PointEntity; b: PointEntity } | null {
  const a = pointOf(map, l.p1); const b = pointOf(map, l.p2)
  if (!a || !b) return null
  return { a, b }
}
function circleCtr(map: EntityMap, c: CircleEntity): PointEntity | null {
  return pointOf(map, c.center)
}

function residualsFor(map: EntityMap, c: SketchConstraint): number[] | null {
  switch (c.kind) {
    case 'coincident': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      if (!a || !b) return null
      return [a.x - b.x, a.y - b.y]
    }
    case 'concentric': {
      const a = circleOf(map, c.refs[0]!); const b = circleOf(map, c.refs[1]!)
      if (!a || !b) return null
      const ca = circleCtr(map, a); const cb = circleCtr(map, b)
      if (!ca || !cb) return null
      return [ca.x - cb.x, ca.y - cb.y]
    }
    case 'pointOnLine': {
      const p = pointOf(map, c.refs[0]!); const l = lineOf(map, c.refs[1]!)
      if (!p || !l) return null
      const e = lineEnds(map, l); if (!e) return null
      return [distPointToLine({ x: p.x, y: p.y }, e.a, e.b)]
    }
    case 'pointOnCircle': {
      const p = pointOf(map, c.refs[0]!); const cir = circleOf(map, c.refs[1]!)
      if (!p || !cir) return null
      const cen = circleCtr(map, cir); if (!cen) return null
      return [dist({ x: p.x, y: p.y }, cen) - cir.r]
    }
    case 'tangentLineCircle': {
      const l = lineOf(map, c.refs[0]!); const cir = circleOf(map, c.refs[1]!)
      if (!l || !cir) return null
      const e = lineEnds(map, l); const cen = circleCtr(map, cir)
      if (!e || !cen) return null
      return [Math.abs(distPointToLine(cen, e.a, e.b)) - cir.r]
    }
    case 'tangentCircleCircle': {
      const a = circleOf(map, c.refs[0]!); const b = circleOf(map, c.refs[1]!)
      if (!a || !b) return null
      const ca = circleCtr(map, a); const cb = circleCtr(map, b)
      if (!ca || !cb) return null
      return [dist(ca, cb) - (a.r + b.r)]
    }
    case 'horizontal': {
      // refs=[lineId] (legacy) → endpoints of that line; else refs=[pA, pB] → the two points directly
      const l = lineOf(map, c.refs[0]!)
      if (l) {
        const e = lineEnds(map, l); if (!e) return null
        return [e.a.y - e.b.y]
      }
      const pA = pointOf(map, c.refs[0]!); const pB = pointOf(map, c.refs[1]!)
      if (!pA || !pB) return null
      return [pA.y - pB.y]
    }
    case 'vertical': {
      // refs=[lineId] (legacy) → endpoints of that line; else refs=[pA, pB] → the two points directly
      const l = lineOf(map, c.refs[0]!)
      if (l) {
        const e = lineEnds(map, l); if (!e) return null
        return [e.a.x - e.b.x]
      }
      const pA = pointOf(map, c.refs[0]!); const pB = pointOf(map, c.refs[1]!)
      if (!pA || !pB) return null
      return [pA.x - pB.x]
    }
    case 'distance': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      if (!a || !b || c.value == null) return null
      return [dist({ x: a.x, y: a.y }, { x: b.x, y: b.y }) - c.value]
    }
    case 'radius': {
      const cir = circleOf(map, c.refs[0]!)
      if (!cir || c.value == null) return null
      return [cir.r - c.value]
    }
    case 'equalDist': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      const p = pointOf(map, c.refs[2]!); const q = pointOf(map, c.refs[3]!)
      if (!a || !b || !p || !q) return null
      return [dist({ x: a.x, y: a.y }, { x: b.x, y: b.y }) - dist({ x: p.x, y: p.y }, { x: q.x, y: q.y })]
    }
    case 'rotatedFrom': {
      const cp = pointOf(map, c.refs[0]!); const og = pointOf(map, c.refs[1]!); const ce = pointOf(map, c.refs[2]!)
      if (!cp || !og || !ce || c.value == null) return null
      const a = c.value * Math.PI / 180
      const co = Math.cos(a), si = Math.sin(a)
      const dx = og.x - ce.x, dy = og.y - ce.y
      const rx = ce.x + co * dx - si * dy
      const ry = ce.y + si * dx + co * dy
      return [cp.x - rx, cp.y - ry]
    }
    case 'mirroredFrom': {
      const cp = pointOf(map, c.refs[0]!); const og = pointOf(map, c.refs[1]!); const l = lineOf(map, c.refs[2]!)
      if (!cp || !og || !l) return null
      const e = lineEnds(map, l); if (!e) return null
      const dirx = e.b.x - e.a.x, diry = e.b.y - e.a.y
      const L = Math.hypot(dirx, diry)
      if (L < 1e-12) return null
      const nx = -diry / L, ny = dirx / L                       // unit normal
      const s = (og.x - e.a.x) * nx + (og.y - e.a.y) * ny       // signed distance to axis
      const rx = og.x - 2 * s * nx
      const ry = og.y - 2 * s * ny
      return [cp.x - rx, cp.y - ry]
    }
    case 'collinear': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!); const p = pointOf(map, c.refs[2]!)
      if (!a || !b || !p) return null
      return [(b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)]
    }
    case 'perpendicular': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      const p = pointOf(map, c.refs[2]!); const q = pointOf(map, c.refs[3]!)
      if (!a || !b || !p || !q) return null
      const ux = b.x - a.x, uy = b.y - a.y, vx = q.x - p.x, vy = q.y - p.y
      if (Math.hypot(ux, uy) < 1e-9 || Math.hypot(vx, vy) < 1e-9) return null
      return [ux * vx + uy * vy]
    }
    case 'parallel': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      const p = pointOf(map, c.refs[2]!); const q = pointOf(map, c.refs[3]!)
      if (!a || !b || !p || !q) return null
      const ux = b.x - a.x, uy = b.y - a.y, vx = q.x - p.x, vy = q.y - p.y
      if (Math.hypot(ux, uy) < 1e-9 || Math.hypot(vx, vy) < 1e-9) return null
      return [ux * vy - uy * vx]
    }
    case 'midpoint': {
      // refs=[P, A, B] — P pinned to the middle of segment A–B
      const p = pointOf(map, c.refs[0]!); const a = pointOf(map, c.refs[1]!); const b = pointOf(map, c.refs[2]!)
      if (!p || !a || !b) return null
      return [p.x - (a.x + b.x) / 2, p.y - (a.y + b.y) / 2]
    }
    case 'equalRadius': {
      // refs=[cA, cB] — two circle entity ids directly
      const a = circleOf(map, c.refs[0]!); const b = circleOf(map, c.refs[1]!)
      if (!a || !b) return null
      return [a.r - b.r]
    }
    case 'tangentLineArc': {
      // refs=[A, B, C, S] or [A, B, circleId] — |distance from the centre to line AB| = radius
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      const ops = readCircleOperands(map, c.refs, 2)
      if (!a || !b || !ops || ops.length !== 1) return null
      const o = ops[0]!
      return [Math.abs(distPointToLine({ x: o.c.x, y: o.c.y }, a, b)) - operandRadius(o)]
    }
    case 'tangentArcs': {
      // two circle operands; value +1 outside each other, −1 one inside the other
      const ops = readCircleOperands(map, c.refs, 0)
      if (!ops || ops.length !== 2 || (c.value !== 1 && c.value !== -1)) return null
      const [o1, o2] = ops as [typeof ops[0], typeof ops[0]]
      const d = dist({ x: o1.c.x, y: o1.c.y }, { x: o2.c.x, y: o2.c.y })
      const r1 = operandRadius(o1), r2 = operandRadius(o2)
      return [c.value === 1 ? d - (r1 + r2) : d - Math.abs(r1 - r2)]
    }
    case 'offsetLine': {
      // refs=[A, B, P]: P's signed distance from A→B (left +) minus d; a
      // zero-length line scores nothing (jacobian.ts skips it the same way)
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!); const p = pointOf(map, c.refs[2]!)
      if (!a || !b || !p || c.value == null) return null
      const dx = b.x - a.x, dy = b.y - a.y
      const L = Math.hypot(dx, dy)
      if (L < 1e-12) return null
      return [(dx * (p.y - a.y) - dy * (p.x - a.x)) / L - c.value]
    }
    case 'offsetRadius': {
      // two circle operands ([C, S] pairs or circle ids): r2 − r1 − d
      const ops = readCircleOperands(map, c.refs, 0)
      if (!ops || ops.length !== 2 || c.value == null) return null
      return [operandRadius(ops[1]!) - operandRadius(ops[0]!) - c.value]
    }
    case 'translatedFrom': {
      // refs=[copy, orig, from, to]: copy = orig + k·(to − from)
      const cp = pointOf(map, c.refs[0]!); const og = pointOf(map, c.refs[1]!)
      const fr = pointOf(map, c.refs[2]!); const to = pointOf(map, c.refs[3]!)
      if (!cp || !og || !fr || !to || c.value == null) return null
      const k = c.value
      return [cp.x - og.x - k * (to.x - fr.x), cp.y - og.y - k * (to.y - fr.y)]
    }
    default:
      return null
  }
}

export function constraintResiduals(doc: SketchDoc): number[] {
  const map: EntityMap = new Map()
  for (const e of doc.entities) map.set(e.id, e)
  const out: number[] = []
  for (const c of doc.constraints) {
    const r = residualsFor(map, c)
    if (r) out.push(...r)
  }
  return out
}

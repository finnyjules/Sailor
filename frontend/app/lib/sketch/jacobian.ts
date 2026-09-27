// Analytic Jacobian for the sketch solver — replaces the finite-difference
// Jacobian previously computed inline in solve.ts. Each constraint kind emits
// its residuals' partial derivatives in closed form; only `mirroredFrom`
// falls back to a *local* numerical derivative (see below) because deriving
// the reflection-across-a-line partials by hand is error-prone and the
// correctness gate (tests/unit/sketch-jacobian.unit.spec.ts) is what actually
// matters here, not purity.
//
// ANALYTIC (closed-form): coincident, concentric, pointOnLine, pointOnCircle,
//   tangentLineCircle, tangentCircleCircle, horizontal, vertical, distance,
//   radius, equalDist, rotatedFrom, collinear, perpendicular, parallel,
//   midpoint, equalRadius, tangentLineArc, tangentArcs, offsetLine,
//   offsetRadius, translatedFrom.
// NUMERIC FALLBACK (local central-difference over ≤6 coords — orig.x/y and
//   the axis line's two endpoints; the `copy` point's own partials are the
//   trivial identity and ARE analytic): mirroredFrom.
//
// Row order matches constraintResiduals(doc) exactly because both iterate
// doc.constraints in the same order and apply the same null-skip rule per
// constraint (dangling refs / degenerate geometry that residualsFor would
// also refuse to score).

import type { SketchDoc, SketchConstraint, SketchEntity, PointEntity, LineEntity, CircleEntity, EntityId } from './model'
import type { DerivedRule } from './substitute'
import { derivedGradients } from './substitute'
import { readCircleOperands, operandRadius, type CircleOperand } from './tangency'

type EntityMap = Map<EntityId, SketchEntity>

// A free parameter: a point's x or y coordinate, or a circle's radius.
// Uses the same 'px' | 'py' | 'r' vocabulary as solve.ts's Slot so solve.ts
// can pass its Slot[] straight through (structurally compatible — the extra
// `e` field on Slot is simply ignored here).
export type ParamComp = 'px' | 'py' | 'r'
export interface ParamRef { id: EntityId; comp: ParamComp }
export interface JacEntry { param: ParamRef; d: number }
export interface SlotRef { kind: ParamComp; id: EntityId }

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
function lineEnds(map: EntityMap, l: LineEntity): { a: PointEntity; b: PointEntity } | null {
  const a = pointOf(map, l.p1); const b = pointOf(map, l.p2)
  if (!a || !b) return null
  return { a, b }
}
function circleCtr(map: EntityMap, c: CircleEntity): PointEntity | null {
  return pointOf(map, c.center)
}

const px = (id: EntityId, d: number): JacEntry => ({ param: { id, comp: 'px' }, d })
const py = (id: EntityId, d: number): JacEntry => ({ param: { id, comp: 'py' }, d })
const pr = (id: EntityId, d: number): JacEntry => ({ param: { id, comp: 'r' }, d })

// Signed perpendicular distance from P=(px,py) to the infinite line through
// A=(ax,ay)→B=(bx,by), plus its analytic partials w.r.t. all 6 coordinates.
// Matches geom.ts's distPointToLine exactly (num/L with num = cross(d, P-a)).
// Returns null for a degenerate (near-zero-length) line.
function signedDistPartials(
  Px: number, Py: number, Ax: number, Ay: number, Bx: number, By: number
): { s: number; dPx: number; dPy: number; dAx: number; dAy: number; dBx: number; dBy: number } | null {
  const dx = Bx - Ax, dy = By - Ay
  const L = Math.hypot(dx, dy)
  if (L < 1e-12) return null
  const num = dx * (Py - Ay) - dy * (Px - Ax)
  const s = num / L
  const L2 = L * L
  return {
    s,
    dPx: -dy / L,
    dPy: dx / L,
    dAx: (By - Py) / L + (s * dx) / L2,
    dAy: (Px - Bx) / L + (s * dy) / L2,
    dBx: (Py - Ay) / L - (s * dx) / L2,
    dBy: (Ax - Px) / L - (s * dy) / L2,
  }
}

// Local reflection of `og` across the infinite line a→b — used only for the
// mirroredFrom numeric fallback (a pure function of these 6 numbers, so a
// local central-difference is exact w.r.t. the whole-doc residual too; no
// other entity influences this constraint's residual).
function reflectAcrossLine(ogx: number, ogy: number, ax: number, ay: number, bx: number, by: number): { rx: number; ry: number } | null {
  const dirx = bx - ax, diry = by - ay
  const L = Math.hypot(dirx, diry)
  if (L < 1e-12) return null
  const nx = -diry / L, ny = dirx / L
  const s = (ogx - ax) * nx + (ogy - ay) * ny
  return { rx: ogx - 2 * s * nx, ry: ogy - 2 * s * ny }
}

// ∂(k·radius)/∂params for a circle operand: a circle's r directly, or |C S|
// through its two points
function radiusEntries(o: CircleOperand, k: number): JacEntry[] {
  if (o.kind === 'circle') return [pr(o.circle.id, k)]
  const dx = o.s.x - o.c.x, dy = o.s.y - o.c.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-9) return []
  const ux = dx / d, uy = dy / d
  return [px(o.s.id, k * ux), py(o.s.id, k * uy), px(o.c.id, -k * ux), py(o.c.id, -k * uy)]
}

function rowsFor(map: EntityMap, c: SketchConstraint): JacEntry[][] | null {
  switch (c.kind) {
    case 'coincident': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      if (!a || !b) return null
      return [[px(a.id, 1), px(b.id, -1)], [py(a.id, 1), py(b.id, -1)]]
    }
    case 'concentric': {
      const a = circleOf(map, c.refs[0]!); const b = circleOf(map, c.refs[1]!)
      if (!a || !b) return null
      const ca = circleCtr(map, a); const cb = circleCtr(map, b)
      if (!ca || !cb) return null
      return [[px(ca.id, 1), px(cb.id, -1)], [py(ca.id, 1), py(cb.id, -1)]]
    }
    case 'pointOnLine': {
      const p = pointOf(map, c.refs[0]!); const l = lineOf(map, c.refs[1]!)
      if (!p || !l) return null
      const e = lineEnds(map, l); if (!e) return null
      const sd = signedDistPartials(p.x, p.y, e.a.x, e.a.y, e.b.x, e.b.y)
      if (!sd) return [[]] // degenerate line → residual is the constant 0
      return [[
        px(p.id, sd.dPx), py(p.id, sd.dPy),
        px(e.a.id, sd.dAx), py(e.a.id, sd.dAy),
        px(e.b.id, sd.dBx), py(e.b.id, sd.dBy),
      ]]
    }
    case 'pointOnCircle': {
      const p = pointOf(map, c.refs[0]!); const cir = circleOf(map, c.refs[1]!)
      if (!p || !cir) return null
      const cen = circleCtr(map, cir); if (!cen) return null
      const dx = p.x - cen.x, dy = p.y - cen.y
      const d = Math.hypot(dx, dy)
      if (d < 1e-9) return [[pr(cir.id, -1)]]
      const ux = dx / d, uy = dy / d
      return [[px(p.id, ux), py(p.id, uy), px(cen.id, -ux), py(cen.id, -uy), pr(cir.id, -1)]]
    }
    case 'tangentLineCircle': {
      const l = lineOf(map, c.refs[0]!); const cir = circleOf(map, c.refs[1]!)
      if (!l || !cir) return null
      const e = lineEnds(map, l); const cen = circleCtr(map, cir)
      if (!e || !cen) return null
      const sd = signedDistPartials(cen.x, cen.y, e.a.x, e.a.y, e.b.x, e.b.y)
      if (!sd) return [[pr(cir.id, -1)]] // degenerate line → |0| - r, only r-partial survives
      const sign = sd.s >= 0 ? 1 : -1
      return [[
        px(cen.id, sign * sd.dPx), py(cen.id, sign * sd.dPy),
        px(e.a.id, sign * sd.dAx), py(e.a.id, sign * sd.dAy),
        px(e.b.id, sign * sd.dBx), py(e.b.id, sign * sd.dBy),
        pr(cir.id, -1),
      ]]
    }
    case 'tangentCircleCircle': {
      const a = circleOf(map, c.refs[0]!); const b = circleOf(map, c.refs[1]!)
      if (!a || !b) return null
      const ca = circleCtr(map, a); const cb = circleCtr(map, b)
      if (!ca || !cb) return null
      const dx = ca.x - cb.x, dy = ca.y - cb.y
      const d = Math.hypot(dx, dy)
      if (d < 1e-9) return [[pr(a.id, -1), pr(b.id, -1)]]
      const ux = dx / d, uy = dy / d
      return [[px(ca.id, ux), py(ca.id, uy), px(cb.id, -ux), py(cb.id, -uy), pr(a.id, -1), pr(b.id, -1)]]
    }
    case 'horizontal': {
      const l = lineOf(map, c.refs[0]!)
      if (l) {
        const e = lineEnds(map, l); if (!e) return null
        return [[py(e.a.id, 1), py(e.b.id, -1)]]
      }
      const pA = pointOf(map, c.refs[0]!); const pB = pointOf(map, c.refs[1]!)
      if (!pA || !pB) return null
      return [[py(pA.id, 1), py(pB.id, -1)]]
    }
    case 'vertical': {
      const l = lineOf(map, c.refs[0]!)
      if (l) {
        const e = lineEnds(map, l); if (!e) return null
        return [[px(e.a.id, 1), px(e.b.id, -1)]]
      }
      const pA = pointOf(map, c.refs[0]!); const pB = pointOf(map, c.refs[1]!)
      if (!pA || !pB) return null
      return [[px(pA.id, 1), px(pB.id, -1)]]
    }
    case 'distance': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      if (!a || !b || c.value == null) return null
      const dx = a.x - b.x, dy = a.y - b.y
      const d = Math.hypot(dx, dy)
      if (d < 1e-9) return [[]]
      const ux = dx / d, uy = dy / d
      return [[px(a.id, ux), py(a.id, uy), px(b.id, -ux), py(b.id, -uy)]]
    }
    case 'radius': {
      const cir = circleOf(map, c.refs[0]!)
      if (!cir || c.value == null) return null
      return [[pr(cir.id, 1)]]
    }
    case 'equalDist': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      const p = pointOf(map, c.refs[2]!); const q = pointOf(map, c.refs[3]!)
      if (!a || !b || !p || !q) return null
      const abx = a.x - b.x, aby = a.y - b.y
      const dab = Math.hypot(abx, aby)
      const pqx = p.x - q.x, pqy = p.y - q.y
      const dpq = Math.hypot(pqx, pqy)
      const row: JacEntry[] = []
      if (dab >= 1e-9) {
        const ux = abx / dab, uy = aby / dab
        row.push(px(a.id, ux), py(a.id, uy), px(b.id, -ux), py(b.id, -uy))
      }
      if (dpq >= 1e-9) {
        const wx = pqx / dpq, wy = pqy / dpq
        row.push(px(p.id, -wx), py(p.id, -wy), px(q.id, wx), py(q.id, wy))
      }
      return [row]
    }
    case 'rotatedFrom': {
      const cp = pointOf(map, c.refs[0]!); const og = pointOf(map, c.refs[1]!); const ce = pointOf(map, c.refs[2]!)
      if (!cp || !og || !ce || c.value == null) return null
      const a = c.value * Math.PI / 180
      const co = Math.cos(a), si = Math.sin(a)
      const row0: JacEntry[] = [
        px(cp.id, 1),
        px(og.id, -co), py(og.id, si),
        px(ce.id, co - 1), py(ce.id, -si),
      ]
      const row1: JacEntry[] = [
        py(cp.id, 1),
        px(og.id, -si), py(og.id, -co),
        px(ce.id, si), py(ce.id, co - 1),
      ]
      return [row0, row1]
    }
    case 'mirroredFrom': {
      const cp = pointOf(map, c.refs[0]!); const og = pointOf(map, c.refs[1]!); const l = lineOf(map, c.refs[2]!)
      if (!cp || !og || !l) return null
      const e = lineEnds(map, l); if (!e) return null
      const base = reflectAcrossLine(og.x, og.y, e.a.x, e.a.y, e.b.x, e.b.y)
      if (!base) return null
      // NUMERIC FALLBACK: central-difference the local reflect() over its 6
      // inputs (og.x, og.y, a.x, a.y, b.x, b.y). `copy`'s partials are the
      // trivial identity and are set analytically below.
      const h = 1e-6
      const coords: [PointEntity, 'x' | 'y'][] = [[og, 'x'], [og, 'y'], [e.a, 'x'], [e.a, 'y'], [e.b, 'x'], [e.b, 'y']]
      const drx: number[] = []; const dry: number[] = []
      for (const [pt, comp] of coords) {
        const orig = pt[comp]
        pt[comp] = orig + h
        // Safe: `base` above already proved L >= 1e-12, and an h=1e-6 perturbation can't cross that threshold.
        const plus = reflectAcrossLine(og.x, og.y, e.a.x, e.a.y, e.b.x, e.b.y)!
        pt[comp] = orig - h
        const minus = reflectAcrossLine(og.x, og.y, e.a.x, e.a.y, e.b.x, e.b.y)!
        pt[comp] = orig
        drx.push((plus.rx - minus.rx) / (2 * h))
        dry.push((plus.ry - minus.ry) / (2 * h))
      }
      const row0: JacEntry[] = [px(cp.id, 1)]
      const row1: JacEntry[] = [py(cp.id, 1)]
      const ids = [og.id, og.id, e.a.id, e.a.id, e.b.id, e.b.id]
      const comps: ParamComp[] = ['px', 'py', 'px', 'py', 'px', 'py']
      for (let i = 0; i < 6; i++) {
        row0.push({ param: { id: ids[i]!, comp: comps[i]! }, d: -drx[i]! })
        row1.push({ param: { id: ids[i]!, comp: comps[i]! }, d: -dry[i]! })
      }
      return [row0, row1]
    }
    case 'collinear': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!); const p = pointOf(map, c.refs[2]!)
      if (!a || !b || !p) return null
      return [[
        px(a.id, b.y - p.y), py(a.id, p.x - b.x),
        px(b.id, p.y - a.y), py(b.id, a.x - p.x),
        px(p.id, a.y - b.y), py(p.id, b.x - a.x),
      ]]
    }
    case 'perpendicular': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      const p = pointOf(map, c.refs[2]!); const q = pointOf(map, c.refs[3]!)
      if (!a || !b || !p || !q) return null
      const ux = b.x - a.x, uy = b.y - a.y, vx = q.x - p.x, vy = q.y - p.y
      if (Math.hypot(ux, uy) < 1e-9 || Math.hypot(vx, vy) < 1e-9) return null
      return [[
        px(a.id, -vx), py(a.id, -vy),
        px(b.id, vx), py(b.id, vy),
        px(p.id, -ux), py(p.id, -uy),
        px(q.id, ux), py(q.id, uy),
      ]]
    }
    case 'parallel': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      const p = pointOf(map, c.refs[2]!); const q = pointOf(map, c.refs[3]!)
      if (!a || !b || !p || !q) return null
      const ux = b.x - a.x, uy = b.y - a.y, vx = q.x - p.x, vy = q.y - p.y
      if (Math.hypot(ux, uy) < 1e-9 || Math.hypot(vx, vy) < 1e-9) return null
      return [[
        px(a.id, -vy), py(a.id, vx),
        px(b.id, vy), py(b.id, -vx),
        px(p.id, uy), py(p.id, -ux),
        px(q.id, -uy), py(q.id, ux),
      ]]
    }
    case 'midpoint': {
      const p = pointOf(map, c.refs[0]!); const a = pointOf(map, c.refs[1]!); const b = pointOf(map, c.refs[2]!)
      if (!p || !a || !b) return null
      return [
        [px(p.id, 1), px(a.id, -0.5), px(b.id, -0.5)],
        [py(p.id, 1), py(a.id, -0.5), py(b.id, -0.5)],
      ]
    }
    case 'equalRadius': {
      const a = circleOf(map, c.refs[0]!); const b = circleOf(map, c.refs[1]!)
      if (!a || !b) return null
      return [[pr(a.id, 1), pr(b.id, -1)]]
    }
    case 'tangentLineArc': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!)
      const ops = readCircleOperands(map, c.refs, 2)
      if (!a || !b || !ops || ops.length !== 1) return null
      const o = ops[0]!
      const row: JacEntry[] = []
      const sd = signedDistPartials(o.c.x, o.c.y, a.x, a.y, b.x, b.y)
      if (sd) {
        const sign = sd.s >= 0 ? 1 : -1
        row.push(
          px(o.c.id, sign * sd.dPx), py(o.c.id, sign * sd.dPy),
          px(a.id, sign * sd.dAx), py(a.id, sign * sd.dAy),
          px(b.id, sign * sd.dBx), py(b.id, sign * sd.dBy),
        )
      }
      row.push(...radiusEntries(o, -1))
      return [row]
    }
    case 'tangentArcs': {
      const ops = readCircleOperands(map, c.refs, 0)
      if (!ops || ops.length !== 2 || (c.value !== 1 && c.value !== -1)) return null
      const [o1, o2] = ops as [CircleOperand, CircleOperand]
      const row: JacEntry[] = []
      const dx = o1.c.x - o2.c.x, dy = o1.c.y - o2.c.y
      const d = Math.hypot(dx, dy)
      if (d >= 1e-9) {
        const ux = dx / d, uy = dy / d
        row.push(px(o1.c.id, ux), py(o1.c.id, uy), px(o2.c.id, -ux), py(o2.c.id, -uy))
      }
      if (c.value === 1) {
        row.push(...radiusEntries(o1, -1), ...radiusEntries(o2, -1))
      } else {
        const sg = operandRadius(o1) - operandRadius(o2) >= 0 ? 1 : -1
        row.push(...radiusEntries(o1, -sg), ...radiusEntries(o2, sg))
      }
      return [row]
    }
    case 'offsetLine': {
      const a = pointOf(map, c.refs[0]!); const b = pointOf(map, c.refs[1]!); const p = pointOf(map, c.refs[2]!)
      if (!a || !b || !p || c.value == null) return null
      // the same signed distance residualsFor scores (num / L); null for a
      // zero-length line, which residualsFor skips too — rows stay aligned
      const sd = signedDistPartials(p.x, p.y, a.x, a.y, b.x, b.y)
      if (!sd) return null
      return [[
        px(p.id, sd.dPx), py(p.id, sd.dPy),
        px(a.id, sd.dAx), py(a.id, sd.dAy),
        px(b.id, sd.dBx), py(b.id, sd.dBy),
      ]]
    }
    case 'offsetRadius': {
      const ops = readCircleOperands(map, c.refs, 0)
      if (!ops || ops.length !== 2 || c.value == null) return null
      return [[...radiusEntries(ops[1]!, 1), ...radiusEntries(ops[0]!, -1)]]
    }
    case 'translatedFrom': {
      const cp = pointOf(map, c.refs[0]!); const og = pointOf(map, c.refs[1]!)
      const fr = pointOf(map, c.refs[2]!); const to = pointOf(map, c.refs[3]!)
      if (!cp || !og || !fr || !to || c.value == null) return null
      const k = c.value
      // from = to (one id): the ±k entries land in one column and cancel
      return [
        [px(cp.id, 1), px(og.id, -1), px(to.id, -k), px(fr.id, k)],
        [py(cp.id, 1), py(og.id, -1), py(to.id, -k), py(fr.id, k)],
      ]
    }
    default:
      return null
  }
}

// Per-constraint analytic (or, for mirroredFrom, locally-numeric) partials.
// One array of nonzero-partial entries per residual the constraint emits —
// mirrors residualsFor's per-kind residual arrays 1:1.
export function jacobianRows(doc: SketchDoc, constraint: SketchConstraint): JacEntry[][] | null {
  const map: EntityMap = new Map()
  for (const e of doc.entities) map.set(e.id, e)
  return rowsFor(map, constraint)
}

const slotKey = (id: EntityId, comp: ParamComp): string => `${comp}:${id}`

// Assemble the full m×n dense Jacobian for the solver. Rows follow
// constraintResiduals(doc)'s order exactly (same doc.constraints iteration,
// same null-skip rule). Columns follow `slots`' order; params not present in
// slots (fixed points, the held/dragged point) are simply skipped — their
// column doesn't exist, so their partial contributes nothing to the row.
export function buildJacobian(doc: SketchDoc, slots: SlotRef[]): number[][] {
  const map: EntityMap = new Map()
  for (const e of doc.entities) map.set(e.id, e)

  const colIndex = new Map<string, number>()
  slots.forEach((s, i) => colIndex.set(slotKey(s.id, s.kind), i))
  const n = slots.length

  const out: number[][] = []
  for (const c of doc.constraints) {
    const rows = rowsFor(map, c)
    if (!rows) continue
    for (const row of rows) {
      const rv = new Array(n).fill(0)
      for (const entry of row) {
        const idx = colIndex.get(slotKey(entry.param.id, entry.param.comp))
        if (idx != null) rv[idx] += entry.d
      }
      out.push(rv)
    }
  }
  return out
}

// Substituted Jacobian: same as buildJacobian, but (a) iterates a FILTERED
// constraint list (the defining rules of derived points are excluded — they
// hold exactly by construction) and (b) chain-rules any partial against a
// DERIVED point back onto that point's source parameters. A JacEntry whose
// `id` is a derived point D is replaced by entries against D's sources,
// multiplied by ∂D/∂source (from substitute.ts:derivedGradients) — recursively,
// so a source that is itself derived is expanded in turn (dependency order in
// the derived map guarantees termination). Rows follow the filtered
// constraint order exactly (chaining only remaps columns, never rows), so the
// row layout still matches constraintResiduals over the same filtered set.
//
// With an empty `derived` map this is identical to buildJacobian over
// `constraints`.
export function buildJacobianSubstituted(
  doc: SketchDoc,
  slots: SlotRef[],
  constraints: SketchConstraint[],
  derived: Map<EntityId, DerivedRule>,
): number[][] {
  const map: EntityMap = new Map()
  for (const e of doc.entities) map.set(e.id, e)

  const colIndex = new Map<string, number>()
  slots.forEach((s, i) => colIndex.set(slotKey(s.id, s.kind), i))
  const n = slots.length

  // Cache each derived point's gradient blocks for this build (mirror blocks
  // depend on current geometry, so they're recomputed per build, once per id).
  const gradCache = new Map<EntityId, { gx: { id: EntityId; comp: ParamComp; d: number }[]; gy: { id: EntityId; comp: ParamComp; d: number }[] }>()
  const gradOf = (id: EntityId) => {
    let g = gradCache.get(id)
    if (!g) { g = derivedGradients(derived.get(id)!, map); gradCache.set(id, g) }
    return g
  }

  const addEntry = (rv: number[], id: EntityId, comp: ParamComp, d: number): void => {
    if (comp !== 'r' && derived.has(id)) {
      const g = gradOf(id)
      const cs = comp === 'px' ? g.gx : g.gy
      for (const ct of cs) addEntry(rv, ct.id, ct.comp, d * ct.d)
      return
    }
    const idx = colIndex.get(slotKey(id, comp))
    if (idx != null) rv[idx] = (rv[idx] ?? 0) + d
  }

  const out: number[][] = []
  for (const c of constraints) {
    const rows = rowsFor(map, c)
    if (!rows) continue
    for (const row of rows) {
      const rv = new Array(n).fill(0)
      for (const entry of row) addEntry(rv, entry.param.id, entry.param.comp, entry.d)
      out.push(rv)
    }
  }
  return out
}

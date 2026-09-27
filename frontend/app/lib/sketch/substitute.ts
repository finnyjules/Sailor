// Copy-point substitution layer for the sketch solver.
//
// A `rotatedFrom` / `mirroredFrom` constraint makes one point (`refs[0]`, the
// "copy") a DETERMINISTIC function of a small set of source points:
//   rotatedFrom[D, orig, center], θ°:  D = center + R(θ)·(orig − center)
//   mirroredFrom[D, orig, line(a,b)]:  D = reflect(orig; a, b)
//   translatedFrom[D, orig, from, to], k:  D = orig + k·(to − from)
//
// At mandala scale (repeat×N) the vast majority of points are such copies:
// ~175 of a 181-point mandala are copies of ~6 base points. Keeping them as
// free parameters makes the solver's dense O(n³) normal-equation solve pay for
// hundreds of parameters that carry no real freedom. This module identifies
// those DERIVED points, so solve.ts can:
//   * drop them from the free-parameter set (and their circle-free x/y slots),
//   * forward-substitute their exact positions each residual evaluation,
//   * exclude their defining rules from the residual/Jacobian set (satisfied
//     by construction), and
//   * chain-rule any OTHER constraint's dependence on a derived point back
//     into that point's SOURCE parameters (see jacobian.ts:buildJacobianSubstituted).
//
// Non-repeat docs contain zero derived points → every export here is a no-op
// and solve.ts's behavior is byte-identical to the pre-substitution solver.

import type { SketchDoc, EntityId, PointEntity, SketchEntity } from './model'

export type ParamComp2 = 'px' | 'py'

// One nonzero entry of ∂D.{x|y}/∂(source param).
export interface Contribution { id: EntityId; comp: ParamComp2; d: number }

export interface DerivedRule {
  id: EntityId            // the derived (copy) point D
  constraintId: EntityId  // the defining rule — excluded from residuals/Jacobian
  kind: 'rotatedFrom' | 'mirroredFrom' | 'translatedFrom'
  origId: EntityId        // refs[1]
  centerId?: EntityId     // rotatedFrom: refs[2]
  axisAId?: EntityId      // mirroredFrom: axis line p1
  axisBId?: EntityId      // mirroredFrom: axis line p2
  fromId?: EntityId       // translatedFrom: refs[2]
  toId?: EntityId         // translatedFrom: refs[3]
  k?: number              // translatedFrom: value
  cos: number             // rotatedFrom: cos θ (unused for mirror)
  sin: number             // rotatedFrom: sin θ
}

export interface DerivedAnalysis {
  rules: Map<EntityId, DerivedRule>  // derived point id → its rule
  order: EntityId[]                  // topo order: sources before dependents
  excluded: Set<EntityId>            // defining-rule constraint ids to skip
}

type EntityMap = Map<EntityId, SketchEntity>

function pt(map: EntityMap, id: EntityId): PointEntity | null {
  const e = map.get(id)
  return e && e.kind === 'point' ? e : null
}

export function buildEntityMap(doc: SketchDoc): EntityMap {
  const m: EntityMap = new Map()
  for (const e of doc.entities) m.set(e.id, e)
  return m
}

// Reflection of (ogx,ogy) across the infinite line a→b. Null for a degenerate
// (near-zero-length) axis. Pure function of its 6 numbers — matches
// residuals.ts's mirroredFrom math exactly.
const COPY_KINDS = new Set<string>(['rotatedFrom', 'mirroredFrom', 'translatedFrom'])

function reflect(ogx: number, ogy: number, ax: number, ay: number, bx: number, by: number): { rx: number; ry: number } | null {
  const dx = bx - ax, dy = by - ay
  const L = Math.hypot(dx, dy)
  if (L < 1e-12) return null
  const nx = -dy / L, ny = dx / L
  const s = (ogx - ax) * nx + (ogy - ay) * ny
  return { rx: ogx - 2 * s * nx, ry: ogy - 2 * s * ny }
}

// Identify derived points and order them for forward substitution.
// A point D is derived iff it is the copy ref (refs[0]) of EXACTLY ONE
// rotatedFrom/mirroredFrom constraint (across both kinds), is a resolvable
// point, is not fixed, and is not currently held (dragged). `held` is the
// solver's held set (the dragged point) — a point being dragged keeps its
// defining rule active so the solver moves its sources to honor the drag,
// rather than overwriting the drag target with the rule value.
export function analyzeDerived(doc: SketchDoc, held: Set<EntityId>): DerivedAnalysis {
  const map = buildEntityMap(doc)

  // How many rotate/mirror constraints name each point as their copy (refs[0]).
  const copyCount = new Map<EntityId, number>()
  for (const c of doc.constraints) {
    if (COPY_KINDS.has(c.kind)) {
      const d = c.refs[0]!
      copyCount.set(d, (copyCount.get(d) ?? 0) + 1)
    }
  }

  const rules = new Map<EntityId, DerivedRule>()
  for (const c of doc.constraints) {
    if (!COPY_KINDS.has(c.kind)) continue
    const d = c.refs[0]!
    if ((copyCount.get(d) ?? 0) !== 1) continue  // copy of >1 rule → keep free
    if (rules.has(d)) continue
    const D = pt(map, d)
    if (!D || D.fixed || held.has(d)) continue
    if (c.kind === 'rotatedFrom') {
      const og = pt(map, c.refs[1]!); const ce = pt(map, c.refs[2]!)
      if (!og || !ce || c.value == null) continue
      const a = c.value * Math.PI / 180
      rules.set(d, { id: d, constraintId: c.id, kind: 'rotatedFrom', origId: og.id, centerId: ce.id, cos: Math.cos(a), sin: Math.sin(a) })
    } else if (c.kind === 'translatedFrom') {
      const og = pt(map, c.refs[1]!); const fr = pt(map, c.refs[2]!); const to = pt(map, c.refs[3]!)
      if (!og || !fr || !to || c.value == null) continue
      rules.set(d, { id: d, constraintId: c.id, kind: 'translatedFrom', origId: og.id, fromId: fr.id, toId: to.id, k: c.value, cos: 0, sin: 0 })
    } else {
      const og = pt(map, c.refs[1]!); const l = map.get(c.refs[2]!)
      if (!og || !l || l.kind !== 'line') continue
      const a = pt(map, l.p1); const b = pt(map, l.p2)
      if (!a || !b) continue
      rules.set(d, { id: d, constraintId: c.id, kind: 'mirroredFrom', origId: og.id, axisAId: a.id, axisBId: b.id, cos: 0, sin: 0 })
    }
  }

  // Topological sort: a derived point must be substituted AFTER any of its
  // sources that are themselves derived. Emit any rule whose derived sources
  // are all already emitted; anything left when progress stalls is part of a
  // dependency cycle (shouldn't happen) → drop it back to a free parameter
  // (its defining rule stays active — correctness over speed).
  const sourcesOf = (r: DerivedRule): EntityId[] =>
    r.kind === 'rotatedFrom' ? [r.origId, r.centerId!]
    : r.kind === 'translatedFrom' ? [r.origId, r.fromId!, r.toId!]
    : [r.origId, r.axisAId!, r.axisBId!]
  const emitted = new Set<EntityId>()
  const order: EntityId[] = []
  let progress = true
  while (progress) {
    progress = false
    for (const [id, r] of rules) {
      if (emitted.has(id)) continue
      const pending = sourcesOf(r).some(s => rules.has(s) && !emitted.has(s))
      if (!pending) { emitted.add(id); order.push(id); progress = true }
    }
  }

  const excluded = new Set<EntityId>()
  for (const [id, r] of [...rules]) {
    if (!emitted.has(id)) { rules.delete(id); continue }  // cycle member → free fallback
    excluded.add(r.constraintId)
  }

  return { rules, order, excluded }
}

// Recompute every derived point's position from its rule, in dependency order,
// writing straight into the live entity objects (`map` shares references with
// the doc). Call after writing the free parameters and before evaluating
// residuals / building the Jacobian.
export function forwardSubstitute(map: EntityMap, order: EntityId[], rules: Map<EntityId, DerivedRule>): void {
  for (const id of order) {
    const r = rules.get(id)!
    const D = map.get(id) as PointEntity
    if (r.kind === 'rotatedFrom') {
      const og = map.get(r.origId) as PointEntity
      const ce = map.get(r.centerId!) as PointEntity
      const dx = og.x - ce.x, dy = og.y - ce.y
      D.x = ce.x + r.cos * dx - r.sin * dy
      D.y = ce.y + r.sin * dx + r.cos * dy
    } else if (r.kind === 'translatedFrom') {
      const og = map.get(r.origId) as PointEntity
      const fr = map.get(r.fromId!) as PointEntity
      const to = map.get(r.toId!) as PointEntity
      D.x = og.x + r.k! * (to.x - fr.x)
      D.y = og.y + r.k! * (to.y - fr.y)
    } else {
      const og = map.get(r.origId) as PointEntity
      const a = map.get(r.axisAId!) as PointEntity
      const b = map.get(r.axisBId!) as PointEntity
      const ref = reflect(og.x, og.y, a.x, a.y, b.x, b.y)
      if (ref) { D.x = ref.rx; D.y = ref.ry }  // degenerate axis → leave as-is
    }
  }
}

// ∂D.x/∂source and ∂D.y/∂source as lists of nonzero entries, for chain-ruling
// a constraint's dependence on D back onto D's sources.
//   rotatedFrom: constant blocks — ∂D/∂orig = R(θ), ∂D/∂center = I − R(θ).
//   mirroredFrom: local central-difference of reflect() over its 6 source
//     coords (orig.x/y, a.x/y, b.x/y) — a pure function of those numbers, so
//     the local numeric derivative is exact w.r.t. the whole-doc residual
//     (matches jacobian.ts's existing mirroredFrom fallback).
export function derivedGradients(r: DerivedRule, map: EntityMap): { gx: Contribution[]; gy: Contribution[] } {
  if (r.kind === 'rotatedFrom') {
    const { cos, sin, origId } = r
    const centerId = r.centerId!
    return {
      gx: [
        { id: origId, comp: 'px', d: cos }, { id: origId, comp: 'py', d: -sin },
        { id: centerId, comp: 'px', d: 1 - cos }, { id: centerId, comp: 'py', d: sin },
      ],
      gy: [
        { id: origId, comp: 'px', d: sin }, { id: origId, comp: 'py', d: cos },
        { id: centerId, comp: 'px', d: -sin }, { id: centerId, comp: 'py', d: 1 - cos },
      ],
    }
  }
  if (r.kind === 'translatedFrom') {
    const k = r.k!
    return {
      gx: [{ id: r.origId, comp: 'px', d: 1 }, { id: r.toId!, comp: 'px', d: k }, { id: r.fromId!, comp: 'px', d: -k }],
      gy: [{ id: r.origId, comp: 'py', d: 1 }, { id: r.toId!, comp: 'py', d: k }, { id: r.fromId!, comp: 'py', d: -k }],
    }
  }
  const og = map.get(r.origId) as PointEntity
  const a = map.get(r.axisAId!) as PointEntity
  const b = map.get(r.axisBId!) as PointEntity
  const base = reflect(og.x, og.y, a.x, a.y, b.x, b.y)
  if (!base) return { gx: [], gy: [] }  // degenerate axis → no derivative
  const h = 1e-6
  const coords = [og.x, og.y, a.x, a.y, b.x, b.y]
  const ids: EntityId[] = [r.origId, r.origId, r.axisAId!, r.axisAId!, r.axisBId!, r.axisBId!]
  const comps: ParamComp2[] = ['px', 'py', 'px', 'py', 'px', 'py']
  const gx: Contribution[] = []; const gy: Contribution[] = []
  for (let i = 0; i < 6; i++) {
    const save = coords[i]!
    coords[i] = save + h
    const plus = reflect(coords[0]!, coords[1]!, coords[2]!, coords[3]!, coords[4]!, coords[5]!)!
    coords[i] = save - h
    const minus = reflect(coords[0]!, coords[1]!, coords[2]!, coords[3]!, coords[4]!, coords[5]!)!
    coords[i] = save
    gx.push({ id: ids[i]!, comp: comps[i]!, d: (plus.rx - minus.rx) / (2 * h) })
    gy.push({ id: ids[i]!, comp: comps[i]!, d: (plus.ry - minus.ry) / (2 * h) })
  }
  return { gx, gy }
}

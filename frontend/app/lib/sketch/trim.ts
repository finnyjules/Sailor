// Topology behind the pen's Trim, Cut and Dissolve tools and point merging.
// Pure edits on a SketchDoc; geometry comes from crossings.ts.
import type { SketchDoc, EntityId, PathEntity, SegmentSpec, SketchConstraint } from './model'
import { getEntity, getPoint } from './model'
import type { Vec2 } from './geom'
import { dist, sub, cross, dot, distPointToLine } from './geom'
import type { CurveRef, Span, SpanEnd } from './crossings'
import { curveGeom, pointAt } from './crossings'
import { addPoint, addLine, addConstraint, deleteEntity, isPointReferenced } from './edit'
import { freshId } from './ids'

const TAU = Math.PI * 2
const EPS_T = 1e-7

export interface TrimResult { ok: boolean; droppedRules: number }

const FAIL: TrimResult = { ok: false, droppedRules: 0 }

// ── helpers ──────────────────────────────────────────────────────────────────

function segCount(p: PathEntity): number {
  return p.closed ? p.anchors.length : p.anchors.length - 1
}

function segEnds(p: PathEntity, i: number): [EntityId, EntityId] {
  return [p.anchors[i]!, p.anchors[(i + 1) % p.anchors.length]!]
}

function isArcInvariant(c: SketchConstraint, center: EntityId, a: EntityId, b: EntityId): boolean {
  if (c.kind !== 'equalDist' || c.refs.length !== 4) return false
  const [r0, r1, r2, r3] = c.refs
  if (r0 !== center || r2 !== center) return false
  return (r1 === a && r3 === b) || (r1 === b && r3 === a)
}

function removeArcInvariant(doc: SketchDoc, center: EntityId, a: EntityId, b: EntityId): void {
  const i = doc.constraints.findIndex(c => isArcInvariant(c, center, a, b))
  if (i >= 0) doc.constraints.splice(i, 1)
}

// ids of every arc invariant currently in the doc — edits never count these as dropped rules
function arcInvariantIds(doc: SketchDoc): Set<EntityId> {
  const out = new Set<EntityId>()
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    e.segments.forEach((s, i) => {
      if (s.kind !== 'arc') return
      const [a, b] = segEnds(e, i)
      for (const c of doc.constraints) if (isArcInvariant(c, s.center, a, b)) out.add(c.id)
    })
  }
  return out
}

function arcCentres(doc: SketchDoc): Set<EntityId> {
  const out = new Set<EntityId>()
  for (const e of doc.entities) {
    if (e.kind === 'path') for (const s of e.segments) if (s.kind === 'arc') out.add(s.center)
  }
  return out
}

// Counts rules removed as a side effect of an edit. Arc invariants, and rules an
// edit removes knowingly because they became redundant (excuse), are not counted.
interface Tracker { count(): number; excuse(id: EntityId): void }
function ruleTracker(doc: SketchDoc): Tracker {
  const before = doc.constraints.map(c => c.id)
  const skip = arcInvariantIds(doc)
  return {
    count: () => {
      const now = new Set(doc.constraints.map(c => c.id))
      return before.filter(id => !now.has(id) && !skip.has(id)).length
    },
    excuse: id => { skip.add(id) },
  }
}

function removeRules(doc: SketchDoc, ids: Set<EntityId>): void {
  if (ids.size) doc.constraints = doc.constraints.filter(c => !ids.has(c.id))
}

// delete points that nothing uses any more (never fixed ones, never `keep`)
function cleanOrphans(doc: SketchDoc, ids: Iterable<EntityId>, keep?: EntityId): void {
  for (const id of new Set(ids)) {
    if (id === keep) continue
    const p = getPoint(doc, id)
    if (!p || p.fixed) continue
    if (!isPointReferenced(doc, id)) deleteEntity(doc, id)
  }
}

function drawingTol(doc: SketchDoc): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const e of doc.entities) {
    if (e.kind !== 'point') continue
    minX = Math.min(minX, e.x); maxX = Math.max(maxX, e.x)
    minY = Math.min(minY, e.y); maxY = Math.max(maxY, e.y)
  }
  const size = Number.isFinite(minX) ? Math.hypot(maxX - minX, maxY - minY) : 0
  return 1e-6 * Math.max(size, 1)
}

const sameKey = (c: SketchConstraint) => `${c.kind}|${c.refs.join(',')}|${c.value ?? ''}`

// ── point-pair rules ─────────────────────────────────────────────────────────
// The pen stores segment rules as point pairs: horizontal/vertical [a,b],
// parallel/perpendicular [a,b,c,d] (Right angle [prev,c,c,next]), equalDist
// [a,b,c,d], distance [a,b]; a point pinned to a path line segment is
// collinear [A,B,p]. When a segment's pair changes, these follow it.

type PairEvent =
  | { kind: 'removed' }                                  // (a,b) is gone
  | { kind: 'moved'; from: EntityId; to: EntityId }      // one end moved along the same curve
  | { kind: 'split'; x0: EntityId; x1: EntityId }        // (a,b) → (a,x0) + (x1,b)
  | { kind: 'grow'; from: EntityId; to: EntityId }       // dissolve: (a,q) → (a,b)

type PairCat = 'dir' | 'len' | 'pin'

function pairSlots(doc: SketchDoc, c: SketchConstraint, centres: Set<EntityId>): { cat: PairCat; slots: [number, number][] } | null {
  const r = c.refs
  switch (c.kind) {
    case 'horizontal':
    case 'vertical':
      return r.length === 2 && getPoint(doc, r[0]!) ? { cat: 'dir', slots: [[0, 1]] } : null
    case 'parallel':
    case 'perpendicular':
      return r.length === 4 ? { cat: 'dir', slots: [[0, 1], [2, 3]] } : null
    case 'distance':
      return { cat: 'len', slots: [[0, 1]] }
    case 'equalDist':
      // centre-form rules ([C,p,C,q] on an arc centre) are arc radii, not segment lengths
      if (r[0] === r[2] && centres.has(r[0]!)) return null
      return r.length === 4 ? { cat: 'len', slots: [[0, 1], [2, 3]] } : null
    case 'collinear':
      return r.length === 3 ? { cat: 'pin', slots: [[0, 1]] } : null
    default:
      return null
  }
}

function followPair(doc: SketchDoc, a: EntityId, b: EntityId, ev: PairEvent): void {
  if (a === b) return
  const centres = arcCentres(doc)
  const remove = new Set<EntityId>()
  const copies: SketchConstraint[] = []
  for (const c of doc.constraints) {
    const info = pairSlots(doc, c, centres)
    if (!info) continue
    const matched = info.slots.filter(([i, j]) => (c.refs[i] === a && c.refs[j] === b) || (c.refs[i] === b && c.refs[j] === a))
    if (!matched.length) continue
    const rewrite = (from: EntityId, to: EntityId) => {
      const refs = [...c.refs]
      for (const [i, j] of matched) for (const k of [i, j]) if (refs[k] === from) refs[k] = to
      return refs
    }
    if (ev.kind === 'removed') {
      if (info.cat !== 'pin') remove.add(c.id)        // a pin still holds on the line through a, b
    } else if (ev.kind === 'moved' || ev.kind === 'grow') {
      if (info.cat === 'len') remove.add(c.id)        // the length changed
      else c.refs = rewrite(ev.from, ev.to)
    } else {
      if (info.cat === 'len') { remove.add(c.id); continue }
      const first = rewrite(b, ev.x0)
      const second = rewrite(a, ev.x1)
      c.refs = first
      if (info.cat === 'dir') copies.push({ ...c, refs: second })
    }
  }
  removeRules(doc, remove)
  for (const k of copies) addConstraint(doc, k.kind, k.refs, k.value)
}

// arc radius pins [C,p,C,q]: when anchor `from` of an arc on centre C is gone, re-aim them at `to`
function followRadius(doc: SketchDoc, centre: EntityId, from: EntityId, to: EntityId): void {
  if (isPointReferenced(doc, from)) return   // still an anchor of another arc: its pins stay valid
  for (const c of doc.constraints) {
    if (c.kind !== 'equalDist' || c.refs[0] !== centre || c.refs[2] !== centre) continue
    if (c.refs[1] === from) c.refs[1] = to
    if (c.refs[3] === from) c.refs[3] = to
  }
}

// line-entity rules by line id that should hold on both halves of a split line
function copyLineDirection(doc: SketchDoc, from: EntityId, to: EntityId): void {
  for (const c of [...doc.constraints]) {
    if ((c.kind === 'horizontal' || c.kind === 'vertical') && c.refs.length === 1 && c.refs[0] === from) {
      addConstraint(doc, c.kind, [to])
    }
  }
}

// ── pinning ──────────────────────────────────────────────────────────────────

// the cutter's own anchor points (the ones a crossing may land on)
function curveAnchors(doc: SketchDoc, ref: CurveRef): EntityId[] {
  if (ref.kind === 'line') {
    const e = getEntity(doc, ref.id)
    return e && e.kind === 'line' ? [e.p1, e.p2] : []
  }
  if (ref.kind === 'circle') return []
  const p = getEntity(doc, ref.pathId)
  if (!p || p.kind !== 'path' || ref.segIndex < 0 || ref.segIndex >= segCount(p)) return []
  return segEnds(p, ref.segIndex)
}

function anchorAt(doc: SketchDoc, ref: CurveRef, at: Vec2): EntityId | null {
  const tol = drawingTol(doc)
  for (const id of curveAnchors(doc, ref)) {
    const q = getPoint(doc, id)
    if (q && dist(q, at) <= tol) return id
  }
  return null
}

function addPinRule(doc: SketchDoc, p: EntityId, cutter: CurveRef): void {
  if (cutter.kind === 'line') { addConstraint(doc, 'pointOnLine', [p, cutter.id]); return }
  if (cutter.kind === 'circle') { addConstraint(doc, 'pointOnCircle', [p, cutter.id]); return }
  const path = getEntity(doc, cutter.pathId)
  if (!path || path.kind !== 'path') return
  const seg = path.segments[cutter.segIndex]
  if (!seg) return
  const [a, b] = segEnds(path, cutter.segIndex)
  if (seg.kind === 'line') addConstraint(doc, 'collinear', [a, b, p])
  else if (seg.kind === 'arc') addConstraint(doc, 'equalDist', [seg.center, p, seg.center, a])
}

/** Pin p to a cutter curve. When `at` lands on one of the cutter's own anchors,
 *  that anchor is returned instead (no rule added, p untouched — the caller uses
 *  the returned id). Otherwise the spec's rule is added and p is returned. */
export function pinToCurve(doc: SketchDoc, p: EntityId, cutter: CurveRef, at: Vec2): EntityId {
  const reuse = anchorAt(doc, cutter, at)
  if (reuse) return reuse
  addPinRule(doc, p, cutter)
  return p
}

// rules pinning point e onto curve `self` (they become redundant once e is self's end)
function pinsOnto(doc: SketchDoc, e: EntityId, self: CurveRef): SketchConstraint[] {
  if (self.kind === 'line') return doc.constraints.filter(c => c.kind === 'pointOnLine' && c.refs[0] === e && c.refs[1] === self.id)
  if (self.kind === 'circle') return doc.constraints.filter(c => c.kind === 'pointOnCircle' && c.refs[0] === e && c.refs[1] === self.id)
  const path = getEntity(doc, self.pathId)
  if (!path || path.kind !== 'path') return []
  const seg = path.segments[self.segIndex]
  if (!seg) return []
  const [a, b] = segEnds(path, self.segIndex)
  if (seg.kind === 'line') {
    return doc.constraints.filter(c => c.kind === 'collinear' && c.refs[2] === e &&
      ((c.refs[0] === a && c.refs[1] === b) || (c.refs[0] === b && c.refs[1] === a)))
  }
  if (seg.kind === 'arc') {
    return doc.constraints.filter(c => c.kind === 'equalDist' && c.refs[0] === seg.center && c.refs[2] === seg.center &&
      (c.refs[1] === e || c.refs[3] === e) && !isArcInvariant(c, seg.center, a, b))
  }
  return []
}

// the point a span end becomes: the trimmed curve's own end when the crossing sits
// on it; the cutter's anchor when the crossing is on that (its pins onto the
// trimmed curve go, uncounted); else a new point at the crossing pinned to the cutter
function endPoint(doc: SketchDoc, tr: Tracker, end: SpanEnd, self: CurveRef, construction: boolean): EntityId {
  const own = anchorAt(doc, self, end.point)
  if (own) return own
  const cutter = end.cutter!
  const reuse = anchorAt(doc, cutter, end.point)
  if (reuse) {
    const pins = pinsOnto(doc, reuse, self)
    for (const c of pins) tr.excuse(c.id)
    removeRules(doc, new Set(pins.map(c => c.id)))
    return reuse
  }
  const id = addPoint(doc, end.point.x, end.point.y, construction ? { construction: true } : {})
  addPinRule(doc, id, cutter)
  return id
}

// line/seg spans: a crossing sitting on the curve's own end is that end (no cutter)
function normaliseSpan(doc: SketchDoc, span: Span): Span | null {
  const g = curveGeom(doc, span.ref)
  if (!g) return null
  if (g.kind === 'circle') return span
  const tol = drawingTol(doc)
  const startOwn = !span.start.cutter || span.start.t <= EPS_T || dist(span.start.point, g.a!) <= tol
  const endOwn = !span.end.cutter || span.end.t >= 1 - EPS_T || dist(span.end.point, g.b!) <= tol
  return {
    ...span,
    start: startOwn ? { t: 0, point: g.a!, cutter: null } : span.start,
    end: endOwn ? { t: 1, point: g.b!, cutter: null } : span.end,
  }
}

// ── path topology ────────────────────────────────────────────────────────────

// insert existing point x as a new anchor inside segment i (x must lie on it)
function splitSegment(doc: SketchDoc, path: PathEntity, i: number, x: EntityId): void {
  const seg = path.segments[i]!
  const [a, b] = segEnds(path, i)
  path.anchors.splice(i + 1, 0, x)
  path.segments.splice(i + 1, 0, { ...seg })
  if (seg.kind === 'arc') {
    removeArcInvariant(doc, seg.center, a, b)
    addConstraint(doc, 'equalDist', [seg.center, a, seg.center, x])
    addConstraint(doc, 'equalDist', [seg.center, x, seg.center, b])
  }
}

function pushPath(doc: SketchDoc, anchors: EntityId[], segments: SegmentSpec[], closed: boolean, construction?: boolean): EntityId {
  const id = freshId(doc, 'P')
  doc.entities.push({ id, kind: 'path', anchors, segments, closed, ...(construction ? { construction: true } : {}) })
  return id
}

function dropPathEntity(doc: SketchDoc, path: PathEntity): void {
  doc.entities = doc.entities.filter(e => e.id !== path.id)
  doc.constraints = doc.constraints.filter(c => !c.refs.includes(path.id))
}

// remove segment i structurally (its invariant and pair rules go); returns points that may now be orphans
function cutOutSegment(doc: SketchDoc, path: PathEntity, i: number): EntityId[] {
  const seg = path.segments[i]!
  const [a, b] = segEnds(path, i)
  const loose = [a, b]
  if (seg.kind === 'arc') { removeArcInvariant(doc, seg.center, a, b); loose.push(seg.center) }
  if (seg.kind === 'cubic') { if (seg.h1) loose.push(seg.h1); if (seg.h2) loose.push(seg.h2) }
  followPair(doc, a, b, { kind: 'removed' })

  if (path.closed) {
    const n = path.anchors.length
    const anchors: EntityId[] = []
    const segments: SegmentSpec[] = []
    for (let k = 1; k <= n; k++) anchors.push(path.anchors[(i + k) % n]!)
    for (let k = 1; k < n; k++) segments.push(path.segments[(i + k) % n]!)
    path.anchors = anchors
    path.segments = segments
    path.closed = false
    return loose
  }

  const firstA = path.anchors.slice(0, i + 1)
  const firstS = path.segments.slice(0, i)
  const secondA = path.anchors.slice(i + 1)
  const secondS = path.segments.slice(i + 1)
  if (firstS.length > 0) {
    path.anchors = firstA
    path.segments = firstS
    if (secondS.length > 0) pushPath(doc, secondA, secondS, false, path.construction)
  } else if (secondS.length > 0) {
    path.anchors = secondA
    path.segments = secondS
  } else {
    dropPathEntity(doc, path)   // nothing left (its only invariant is already gone)
  }
  return loose
}

// ── removal ──────────────────────────────────────────────────────────────────

/** Remove a whole path segment. Open → split into up to two open paths (the first
 *  keeps the id); closed → one open path starting just after the gap. */
export function removeSegment(doc: SketchDoc, pathId: EntityId, segIndex: number): TrimResult {
  const path = getEntity(doc, pathId)
  if (!path || path.kind !== 'path' || segIndex < 0 || segIndex >= segCount(path)) return FAIL
  const tr = ruleTracker(doc)
  const loose = cutOutSegment(doc, path, segIndex)
  cleanOrphans(doc, loose)
  return { ok: true, droppedRules: tr.count() }
}

function removeLineSpan(doc: SketchDoc, span: Span & { ref: { kind: 'line' } }): TrimResult {
  const line = getEntity(doc, span.ref.id)
  if (!line || line.kind !== 'line') return FAIL
  const tr = ruleTracker(doc)
  const { p1, p2 } = line
  const cons = !!line.construction
  const self = span.ref
  if (!span.start.cutter && !span.end.cutter) {
    followPair(doc, p1, p2, { kind: 'removed' })
    deleteEntity(doc, line.id)
    cleanOrphans(doc, [p1, p2])
  } else if (!span.start.cutter) {
    const x = endPoint(doc, tr, span.end, self, cons)
    followPair(doc, p1, p2, { kind: 'moved', from: p1, to: x })
    line.p1 = x
    cleanOrphans(doc, [p1])
  } else if (!span.end.cutter) {
    const x = endPoint(doc, tr, span.start, self, cons)
    followPair(doc, p1, p2, { kind: 'moved', from: p2, to: x })
    line.p2 = x
    cleanOrphans(doc, [p2])
  } else {
    const x0 = endPoint(doc, tr, span.start, self, cons)
    const x1 = endPoint(doc, tr, span.end, self, cons)
    followPair(doc, p1, p2, { kind: 'split', x0, x1 })
    line.p2 = x0
    const L2 = addLine(doc, x1, p2, cons ? { construction: true } : {})
    copyLineDirection(doc, line.id, L2)
  }
  return { ok: true, droppedRules: tr.count() }
}

function removeSegSpan(doc: SketchDoc, span: Span & { ref: { kind: 'seg' } }): TrimResult {
  const path = getEntity(doc, span.ref.pathId)
  const i = span.ref.segIndex
  if (!path || path.kind !== 'path' || i < 0 || i >= segCount(path)) return FAIL
  const seg = path.segments[i]!
  if (seg.kind === 'cubic') return FAIL
  const tr = ruleTracker(doc)
  const cons = !!path.construction
  const [A, B] = segEnds(path, i)
  // pin both new ends first, while every cutter ref still points where it did
  const x0 = span.start.cutter ? endPoint(doc, tr, span.start, span.ref, cons) : null
  const x1 = span.end.cutter ? endPoint(doc, tr, span.end, span.ref, cons) : null
  if (x0 && x1) followPair(doc, A, B, { kind: 'split', x0, x1 })
  else if (x1) followPair(doc, A, B, { kind: 'moved', from: A, to: x1 })
  else if (x0) followPair(doc, A, B, { kind: 'moved', from: B, to: x0 })
  let target = i
  if (x1) splitSegment(doc, path, i, x1)                      // [A→X1][X1→B]
  if (x0) { splitSegment(doc, path, i, x0); target = i + 1 }  // [A→X0][X0→X1]…
  const loose = cutOutSegment(doc, path, target)
  if (seg.kind === 'arc') {
    if (x1 && !x0) followRadius(doc, seg.center, A, x1)
    if (x0 && !x1) followRadius(doc, seg.center, B, x0)
  }
  cleanOrphans(doc, loose)
  return { ok: true, droppedRules: tr.count() }
}

function removeCircleSpan(doc: SketchDoc, span: Span & { ref: { kind: 'circle' } }): TrimResult {
  const circ = getEntity(doc, span.ref.id)
  if (!circ || circ.kind !== 'circle') return FAIL
  const tr = ruleTracker(doc)
  const C = circ.center
  const cons = !!circ.construction
  const fewerThanTwo = !span.start.cutter || !span.end.cutter || span.end.t - span.start.t >= TAU - 1e-9
  if (fewerThanTwo) {
    deleteEntity(doc, circ.id)
    cleanOrphans(doc, [C])
    return { ok: true, droppedRules: tr.count() }
  }
  const x0 = endPoint(doc, tr, span.start, span.ref, cons)   // a reused end's pointOnCircle goes here
  const x1 = endPoint(doc, tr, span.end, span.ref, cons)
  if (x0 === x1) return { ok: false, droppedRules: tr.count() }
  // the rest runs CCW from the far crossing back round to the near one
  pushPath(doc, [x1, x0], [{ kind: 'arc', center: C, sweep: 1 }], false, cons)
  addConstraint(doc, 'equalDist', [C, x1, C, x0])
  let shareWith: EntityId | null = null
  const kept: SketchConstraint[] = []
  for (const c of doc.constraints) {
    if (!c.refs.includes(circ.id)) { kept.push(c); continue }
    if (c.kind === 'pointOnCircle' && c.refs[1] === circ.id) {
      const q = c.refs[0]!
      if (q === x0 || q === x1) { tr.excuse(c.id); continue }   // already an end of the arc
      kept.push({ id: c.id, kind: 'equalDist', refs: [C, q, C, x1] })
    } else if (c.kind === 'concentric') {
      const target = concentricCentre(doc, c, circ.id, C, shareWith)
      if (target) { shareWith = target; tr.excuse(c.id) }       // kept by sharing the centre
    }
    // every other circle rule (tangent, equal radius, radius…) is dropped and counted
  }
  doc.constraints = kept
  doc.entities = doc.entities.filter(e => e.id !== circ.id)
  if (shareWith && shareWith !== C) mergePoints(doc, C, shareWith)   // the arc takes that circle's centre
  return { ok: true, droppedRules: tr.count() }
}

// the centre point a concentric rule can be kept through, or null when it must be dropped
function concentricCentre(doc: SketchDoc, c: SketchConstraint, circId: EntityId, C: EntityId, already: EntityId | null): EntityId | null {
  const otherId = c.refs[0] === circId ? c.refs[1] : c.refs[0]
  const o = otherId ? getEntity(doc, otherId) : undefined
  if (!o || o.kind !== 'circle') return null
  if (already && already !== o.center) return null   // can only share one centre
  if (o.center === C) return C
  const oc = getPoint(doc, o.center), cc = getPoint(doc, C)
  if (!oc || !cc || dist(oc, cc) > drawingTol(doc)) return null
  if (oc.fixed && cc.fixed) return null
  return o.center
}

/** Remove the piece of a curve described by a span (see spanAt). A crossing that
 *  sits on a line's or segment's own end counts as that end. */
export function removeSpan(doc: SketchDoc, span: Span): TrimResult {
  if (span.ref.kind === 'circle') return removeCircleSpan(doc, span as Span & { ref: { kind: 'circle' } })
  const s = normaliseSpan(doc, span)
  if (!s) return FAIL
  if ((s.start.cutter || s.end.cutter) && dist(s.start.point, s.end.point) <= drawingTol(doc)) return FAIL   // zero-length piece
  if (s.ref.kind === 'line') return removeLineSpan(doc, s as Span & { ref: { kind: 'line' } })
  return removeSegSpan(doc, s as Span & { ref: { kind: 'seg' } })
}

// ── cut ──────────────────────────────────────────────────────────────────────

/** Add an anchor on a path line/arc segment (or split a line entity) at t without
 *  moving anything. Returns the new point id, or null when not allowed. */
export function cutAt(doc: SketchDoc, ref: CurveRef, t: number): EntityId | null {
  if (ref.kind === 'circle') return null
  if (!(t > 1e-9 && t < 1 - 1e-9)) return null
  const g = curveGeom(doc, ref)
  if (!g || g.kind === 'circle') return null
  const at = pointAt(g, t)
  if (ref.kind === 'line') {
    const line = getEntity(doc, ref.id)
    if (!line || line.kind !== 'line') return null
    const cons = !!line.construction
    const x = addPoint(doc, at.x, at.y, cons ? { construction: true } : {})
    const { p1, p2 } = line
    followPair(doc, p1, p2, { kind: 'split', x0: x, x1: x })
    line.p2 = x
    const L2 = addLine(doc, x, p2, cons ? { construction: true } : {})
    copyLineDirection(doc, line.id, L2)
    return x
  }
  const path = getEntity(doc, ref.pathId)
  if (!path || path.kind !== 'path') return null
  const [a, b] = segEnds(path, ref.segIndex)
  const x = addPoint(doc, at.x, at.y, path.construction ? { construction: true } : {})
  followPair(doc, a, b, { kind: 'split', x0: x, x1: x })
  splitSegment(doc, path, ref.segIndex, x)
  return x
}

// ── dissolve ─────────────────────────────────────────────────────────────────

function dissolveSegs(doc: SketchDoc, pathId: EntityId, k: number): { path: PathEntity; inSeg: number; outSeg: number } | null {
  const path = getEntity(doc, pathId)
  if (!path || path.kind !== 'path') return null
  const n = path.anchors.length
  if (k < 0 || k >= n) return null
  if (path.closed) {
    if (n < 3) return null
    return { path, inSeg: (k - 1 + n) % n, outSeg: k }
  }
  if (k === 0 || k === n - 1) return null
  return { path, inSeg: k - 1, outSeg: k }
}

/** Can the anchor at anchorIndex be removed by merging the two segments meeting there? */
export function canDissolve(doc: SketchDoc, pathId: EntityId, anchorIndex: number, tolUnits: number, tolDeg: number): boolean {
  const info = dissolveSegs(doc, pathId, anchorIndex)
  if (!info) return false
  const { path, inSeg, outSeg } = info
  const sIn = path.segments[inSeg]!, sOut = path.segments[outSeg]!
  const P = getPoint(doc, path.anchors[inSeg]!)
  const Q = getPoint(doc, path.anchors[anchorIndex]!)
  const R = getPoint(doc, path.anchors[(anchorIndex + 1) % path.anchors.length]!)
  if (!P || !Q || !R) return false
  if (path.anchors[inSeg] === path.anchors[(anchorIndex + 1) % path.anchors.length]) return false
  if (sIn.kind === 'line' && sOut.kind === 'line') {
    const u = sub(Q, P), v = sub(R, Q)
    const lu = Math.hypot(u.x, u.y), lv = Math.hypot(v.x, v.y)
    if (lu < 1e-12 || lv < 1e-12) return false
    const ang = Math.abs(Math.atan2(cross(u, v), dot(u, v))) * 180 / Math.PI
    if (ang > tolDeg) return false
    return Math.abs(distPointToLine(Q, P, R)) <= tolUnits
  }
  if (sIn.kind === 'arc' && sOut.kind === 'arc') {
    if (sIn.sweep !== sOut.sweep) return false
    const gIn = curveGeom(doc, { kind: 'seg', pathId, segIndex: inSeg })
    const gOut = curveGeom(doc, { kind: 'seg', pathId, segIndex: outSeg })
    if (!gIn || !gOut) return false
    if (sIn.center !== sOut.center) {
      if (dist(gIn.c!, gOut.c!) > tolUnits || Math.abs(gIn.r! - gOut.r!) > tolUnits) return false
    }
    // the merged arc must still be less than a full turn
    return Math.abs(gIn.sweepAngle!) + Math.abs(gOut.sweepAngle!) < TAU - 1e-9
  }
  return false
}

/** Merge the two segments at an interior anchor into one; the anchor goes if nothing
 *  else uses it. Pins and direction rules on either half move onto the merged
 *  segment; length rules on a half are dropped (and counted). */
export function dissolveAt(doc: SketchDoc, pathId: EntityId, anchorIndex: number, tolUnits: number, tolDeg: number): TrimResult {
  if (!canDissolve(doc, pathId, anchorIndex, tolUnits, tolDeg)) return FAIL
  const { path, inSeg, outSeg } = dissolveSegs(doc, pathId, anchorIndex)!
  const tr = ruleTracker(doc)
  const n = path.anchors.length
  const a = path.anchors[inSeg]!
  const q = path.anchors[anchorIndex]!
  const b = path.anchors[(anchorIndex + 1) % n]!
  const sIn = path.segments[inSeg]!, sOut = path.segments[outSeg]!
  const loose: EntityId[] = [q]
  const before = new Set(doc.constraints.map(c => c.id))
  followPair(doc, a, q, { kind: 'grow', from: q, to: b })
  followPair(doc, q, b, { kind: 'grow', from: q, to: a })
  if (sIn.kind === 'arc' && sOut.kind === 'arc') {
    const C = sIn.center, C2 = sOut.center
    removeArcInvariant(doc, C, a, q)
    removeArcInvariant(doc, C2, q, b)
    // radius pins on either arc → the kept centre and a surviving anchor
    for (const c of doc.constraints) {
      if (c.kind !== 'equalDist' || c.refs[0] !== c.refs[2] || (c.refs[0] !== C && c.refs[0] !== C2)) continue
      c.refs = [C, c.refs[1] === q ? a : c.refs[1]!, C, c.refs[3] === q ? a : c.refs[3]!]
    }
    addConstraint(doc, 'equalDist', [C, a, C, b])
    if (C2 !== C) loose.push(C2)
  }
  // pair k = (anchor k, segment k); dropping pair `anchorIndex` makes pair inSeg run a→b
  path.anchors.splice(anchorIndex, 1)
  path.segments.splice(outSeg, 1)
  // rewritten rules that became redundant (a pin onto its own end, a repeat) go uncounted
  const seen = new Set<string>()
  const redundant = new Set<EntityId>()
  for (const c of doc.constraints) {
    const key = sameKey(c)
    const trivial = (c.kind === 'collinear' || c.kind === 'equalDist') && isTrivial(doc, c)
    if (seen.has(key) || trivial) { redundant.add(c.id); if (before.has(c.id)) tr.excuse(c.id) }
    seen.add(key)
  }
  removeRules(doc, redundant)
  // any other rule the rewrite made meaningless is a real drop
  removeRules(doc, new Set(doc.constraints.filter(c => isTrivial(doc, c)).map(c => c.id)))
  cleanOrphans(doc, loose)
  return { ok: true, droppedRules: tr.count() }
}

// ── merge ────────────────────────────────────────────────────────────────────

function isTrivial(doc: SketchDoc, c: SketchConstraint): boolean {
  const r = c.refs
  const samePair = (i: number, j: number, k: number, l: number) =>
    (r[i] === r[k] && r[j] === r[l]) || (r[i] === r[l] && r[j] === r[k])
  switch (c.kind) {
    case 'coincident':
    case 'distance':
      return r[0] === r[1]
    case 'horizontal':
    case 'vertical':
      return r.length >= 2 && r[0] === r[1]
    case 'collinear':
      return r[0] === r[1] || r[1] === r[2] || r[0] === r[2]
    case 'equalDist':
      return samePair(0, 1, 2, 3)
    case 'perpendicular':
    case 'parallel':
      return r[0] === r[1] || r[2] === r[3] || samePair(0, 1, 2, 3)
    case 'midpoint':
      return r[0] === r[1] || r[0] === r[2]
    case 'pointOnLine': {
      const l = getEntity(doc, r[1]!)
      return !!l && l.kind === 'line' && (l.p1 === r[0] || l.p2 === r[0])
    }
    case 'pointOnCircle': {
      const ci = getEntity(doc, r[1]!)
      return !!ci && ci.kind === 'circle' && ci.center === r[0]
    }
    case 'concentric': {
      const a = getEntity(doc, r[0]!), b = getEntity(doc, r[1]!)
      return !!a && !!b && a.kind === 'circle' && b.kind === 'circle' && a.center === b.center
    }
    default:
      return false
  }
}

/** Make `from` and `into` one point: every reference to `from` becomes `into`,
 *  then whatever became degenerate is dropped. `into` keeps its position unless
 *  only `from` is fixed (then `into` moves there and is fixed). Refused (false,
 *  nothing changed) when both are fixed at different places, or the ids are bad. */
export function mergePoints(doc: SketchDoc, from: EntityId, into: EntityId): boolean {
  if (from === into) return false
  const pf = getPoint(doc, from), pi = getPoint(doc, into)
  if (!pf || !pi) return false
  if (pf.fixed) {
    if (pi.fixed && dist(pf, pi) > drawingTol(doc)) return false
    pi.x = pf.x; pi.y = pf.y; pi.fixed = true
  }
  const sw = (id: EntityId) => (id === from ? into : id)
  const touched = new Set<EntityId>()   // entity/rule ids whose refs changed
  for (const e of doc.entities) {
    if (e.kind === 'line') {
      if (e.p1 === from || e.p2 === from) { e.p1 = sw(e.p1); e.p2 = sw(e.p2); touched.add(e.id) }
    } else if (e.kind === 'circle') {
      if (e.center === from) { e.center = into; touched.add(e.id) }
    } else if (e.kind === 'path') {
      let hit = false
      e.anchors = e.anchors.map(a => { if (a === from) hit = true; return sw(a) })
      e.segments = e.segments.map(s => {
        if (s.kind === 'arc' && s.center === from) { hit = true; return { ...s, center: into } }
        if (s.kind === 'cubic' && (s.h1 === from || s.h2 === from)) {
          hit = true
          return { ...s, h1: s.h1 ? sw(s.h1) : null, h2: s.h2 ? sw(s.h2) : null }
        }
        return s
      })
      if (hit) touched.add(e.id)
    }
  }
  for (const c of doc.constraints) {
    if (c.refs.includes(from)) { c.refs = c.refs.map(sw); touched.add(c.id) }
  }
  doc.entities = doc.entities.filter(e => e.id !== from)

  // rules this merge touched that became meaningless or exact repeats
  const keys = new Set(doc.constraints.filter(c => !touched.has(c.id)).map(sameKey))
  doc.constraints = doc.constraints.filter(c => {
    const affected = touched.has(c.id) || c.refs.some(r => touched.has(r))
    if (!affected) return true
    if (isTrivial(doc, c)) return false
    if (!touched.has(c.id)) return true
    const key = sameKey(c)
    if (keys.has(key)) return false
    keys.add(key)
    return true
  })

  const loose: EntityId[] = []
  for (const e of [...doc.entities]) {
    if (!touched.has(e.id)) continue
    if (e.kind === 'line' && e.p1 === e.p2) deleteEntity(doc, e.id)
    else if (e.kind === 'path') collapsePath(doc, e, loose)
  }
  cleanOrphans(doc, loose, into)
  return true
}

// drop segments whose two anchors are now the same point; an open path whose ends met closes
function collapsePath(doc: SketchDoc, path: PathEntity, loose: EntityId[]): void {
  if (!path.closed && path.anchors.length > 2 && path.anchors[0] === path.anchors[path.anchors.length - 1]) {
    path.anchors.pop()
    path.closed = true
  }
  let i = 0
  while (i < segCount(path)) {
    const [a, b] = segEnds(path, i)
    if (a !== b) { i++; continue }
    const s = path.segments[i]!
    if (s.kind === 'arc') { removeArcInvariant(doc, s.center, a, b); loose.push(s.center) }
    if (s.kind === 'cubic') { if (s.h1) loose.push(s.h1); if (s.h2) loose.push(s.h2) }
    path.anchors.splice(i, 1)
    path.segments.splice(i, 1)
  }
  if (path.closed && path.anchors.length < 2) path.segments = []   // nothing drawable remains
  if (path.segments.length === 0) {
    loose.push(...path.anchors)
    dropPathEntity(doc, path)
  }
}

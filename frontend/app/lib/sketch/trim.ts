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

export interface TrimResult { ok: boolean; droppedRules: number }

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

// Counts rules removed as a side effect of an edit (arc invariants excluded).
function ruleTracker(doc: SketchDoc): () => number {
  const before = doc.constraints.map(c => c.id)
  const invariants = arcInvariantIds(doc)
  return () => {
    const now = new Set(doc.constraints.map(c => c.id))
    return before.filter(id => !now.has(id) && !invariants.has(id)).length
  }
}

// delete points that nothing uses any more (never fixed ones)
function cleanOrphans(doc: SketchDoc, ids: Iterable<EntityId>): void {
  for (const id of new Set(ids)) {
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

// the cutter's own anchor points (the ones a crossing may land on)
function cutterAnchors(doc: SketchDoc, cutter: CurveRef): EntityId[] {
  if (cutter.kind === 'line') {
    const e = getEntity(doc, cutter.id)
    return e && e.kind === 'line' ? [e.p1, e.p2] : []
  }
  if (cutter.kind === 'circle') return []
  const p = getEntity(doc, cutter.pathId)
  if (!p || p.kind !== 'path' || cutter.segIndex < 0 || cutter.segIndex >= segCount(p)) return []
  return segEnds(p, cutter.segIndex)
}

function reusableAnchor(doc: SketchDoc, cutter: CurveRef, at: Vec2): EntityId | null {
  const tol = drawingTol(doc)
  for (const id of cutterAnchors(doc, cutter)) {
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
  const reuse = reusableAnchor(doc, cutter, at)
  if (reuse) return reuse
  addPinRule(doc, p, cutter)
  return p
}

// the point a span end becomes: a new point at the crossing pinned to its cutter,
// or the cutter's anchor when the crossing is on it
function endPoint(doc: SketchDoc, end: SpanEnd, construction: boolean): EntityId {
  const cutter = end.cutter!
  const reuse = reusableAnchor(doc, cutter, end.point)
  if (reuse) return reuse
  const id = addPoint(doc, end.point.x, end.point.y, construction ? { construction: true } : {})
  addPinRule(doc, id, cutter)
  return id
}

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

// remove segment i structurally (invariant for it dropped); returns points that may now be orphans
function cutOutSegment(doc: SketchDoc, path: PathEntity, i: number): EntityId[] {
  const seg = path.segments[i]!
  const [a, b] = segEnds(path, i)
  const loose = [a, b]
  if (seg.kind === 'arc') { removeArcInvariant(doc, seg.center, a, b); loose.push(seg.center) }
  if (seg.kind === 'cubic') { if (seg.h1) loose.push(seg.h1); if (seg.h2) loose.push(seg.h2) }

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
    // nothing left: drop the path entity itself (its only invariant is already gone)
    doc.entities = doc.entities.filter(e => e.id !== path.id)
    doc.constraints = doc.constraints.filter(c => !c.refs.includes(path.id))
  }
  return loose
}

// ── removal ──────────────────────────────────────────────────────────────────

/** Remove a whole path segment. Open → split into up to two open paths (the first
 *  keeps the id); closed → one open path starting just after the gap. */
export function removeSegment(doc: SketchDoc, pathId: EntityId, segIndex: number): TrimResult {
  const path = getEntity(doc, pathId)
  if (!path || path.kind !== 'path' || segIndex < 0 || segIndex >= segCount(path)) return { ok: false, droppedRules: 0 }
  const dropped = ruleTracker(doc)
  const loose = cutOutSegment(doc, path, segIndex)
  cleanOrphans(doc, loose)
  return { ok: true, droppedRules: dropped() }
}

function removeLineSpan(doc: SketchDoc, span: Span & { ref: { kind: 'line' } }): TrimResult {
  const line = getEntity(doc, span.ref.id)
  if (!line || line.kind !== 'line') return { ok: false, droppedRules: 0 }
  const dropped = ruleTracker(doc)
  const { p1, p2 } = line
  const cons = !!line.construction
  const startOwn = !span.start.cutter
  const endOwn = !span.end.cutter
  if (startOwn && endOwn) {
    deleteEntity(doc, line.id)
    cleanOrphans(doc, [p1, p2])
  } else if (startOwn) {
    line.p1 = endPoint(doc, span.end, cons)
    cleanOrphans(doc, [p1])
  } else if (endOwn) {
    line.p2 = endPoint(doc, span.start, cons)
    cleanOrphans(doc, [p2])
  } else {
    const x0 = endPoint(doc, span.start, cons)
    const x1 = endPoint(doc, span.end, cons)
    line.p2 = x0
    addLine(doc, x1, p2, cons ? { construction: true } : {})
  }
  return { ok: true, droppedRules: dropped() }
}

function removeSegSpan(doc: SketchDoc, span: Span & { ref: { kind: 'seg' } }): TrimResult {
  const path = getEntity(doc, span.ref.pathId)
  const i = span.ref.segIndex
  if (!path || path.kind !== 'path' || i < 0 || i >= segCount(path)) return { ok: false, droppedRules: 0 }
  const seg = path.segments[i]!
  if (seg.kind === 'cubic') return { ok: false, droppedRules: 0 }
  const dropped = ruleTracker(doc)
  const cons = !!path.construction
  // pin both new ends first, while every cutter ref still points where it did
  const x0 = span.start.cutter ? endPoint(doc, span.start, cons) : null
  const x1 = span.end.cutter ? endPoint(doc, span.end, cons) : null
  let target = i
  if (x1) splitSegment(doc, path, i, x1)            // [A→X1][X1→B]
  if (x0) { splitSegment(doc, path, i, x0); target = i + 1 }  // [A→X0][X0→X1]…
  const loose = cutOutSegment(doc, path, target)
  cleanOrphans(doc, loose)
  return { ok: true, droppedRules: dropped() }
}

function removeCircleSpan(doc: SketchDoc, span: Span & { ref: { kind: 'circle' } }): TrimResult {
  const circ = getEntity(doc, span.ref.id)
  if (!circ || circ.kind !== 'circle') return { ok: false, droppedRules: 0 }
  const dropped = ruleTracker(doc)
  const C = circ.center
  const cons = !!circ.construction
  const fewerThanTwo = !span.start.cutter || !span.end.cutter || span.end.t - span.start.t >= TAU - 1e-9
  if (fewerThanTwo) {
    deleteEntity(doc, circ.id)
    cleanOrphans(doc, [C])
    return { ok: true, droppedRules: dropped() }
  }
  const x0 = endPoint(doc, span.start, cons)
  const x1 = endPoint(doc, span.end, cons)
  // the rest runs CCW from the far crossing back round to the near one
  pushPath(doc, [x1, x0], [{ kind: 'arc', center: C, sweep: 1 }], false, cons)
  addConstraint(doc, 'equalDist', [C, x1, C, x0])
  let shareWith: EntityId | null = null
  let resolved = 0   // concentric rules kept by sharing a centre: removed, but not a drop
  const kept: SketchConstraint[] = []
  for (const c of doc.constraints) {
    if (!c.refs.includes(circ.id)) { kept.push(c); continue }
    if (c.kind === 'pointOnCircle' && c.refs[1] === circ.id) {
      kept.push({ id: c.id, kind: 'equalDist', refs: [C, c.refs[0]!, C, x1] })
    } else if (c.kind === 'concentric') {
      const target = concentricCentre(doc, c, circ.id, C, shareWith)
      if (target) { shareWith = target; resolved++ }
    }
    // every other circle rule (tangent, equal radius, radius…) is dropped and counted
  }
  doc.constraints = kept
  doc.entities = doc.entities.filter(e => e.id !== circ.id)
  if (shareWith && shareWith !== C) mergePoints(doc, C, shareWith)   // the arc takes that circle's centre
  return { ok: true, droppedRules: dropped() - resolved }
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
  return o.center
}

/** Remove the piece of a curve described by a span (see spanAt). */
export function removeSpan(doc: SketchDoc, span: Span): TrimResult {
  if (span.ref.kind === 'line') return removeLineSpan(doc, span as Span & { ref: { kind: 'line' } })
  if (span.ref.kind === 'seg') return removeSegSpan(doc, span as Span & { ref: { kind: 'seg' } })
  return removeCircleSpan(doc, span as Span & { ref: { kind: 'circle' } })
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
    const p2 = line.p2
    line.p2 = x
    addLine(doc, x, p2, cons ? { construction: true } : {})
    return x
  }
  const path = getEntity(doc, ref.pathId)
  if (!path || path.kind !== 'path') return null
  const x = addPoint(doc, at.x, at.y, path.construction ? { construction: true } : {})
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

/** Merge the two segments at an interior anchor into one; the anchor goes if nothing else uses it. */
export function dissolveAt(doc: SketchDoc, pathId: EntityId, anchorIndex: number, tolUnits: number, tolDeg: number): boolean {
  if (!canDissolve(doc, pathId, anchorIndex, tolUnits, tolDeg)) return false
  const { path, inSeg, outSeg } = dissolveSegs(doc, pathId, anchorIndex)!
  const n = path.anchors.length
  const a = path.anchors[inSeg]!
  const q = path.anchors[anchorIndex]!
  const b = path.anchors[(anchorIndex + 1) % n]!
  const sIn = path.segments[inSeg]!, sOut = path.segments[outSeg]!
  const loose: EntityId[] = [q]
  if (sIn.kind === 'arc' && sOut.kind === 'arc') {
    removeArcInvariant(doc, sIn.center, a, q)
    removeArcInvariant(doc, sOut.center, q, b)
    addConstraint(doc, 'equalDist', [sIn.center, a, sIn.center, b])
    if (sOut.center !== sIn.center) loose.push(sOut.center)
  }
  // pair k = (anchor k, segment k); dropping pair `anchorIndex` makes pair inSeg run a→b
  path.anchors.splice(anchorIndex, 1)
  path.segments.splice(outSeg, 1)
  cleanOrphans(doc, loose)
  return true
}

// ── merge ────────────────────────────────────────────────────────────────────

function isTrivial(doc: SketchDoc, c: SketchConstraint): boolean {
  const r = c.refs
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
      return (r[0] === r[2] && r[1] === r[3]) || (r[0] === r[3] && r[1] === r[2])
    case 'perpendicular':
    case 'parallel':
      return r[0] === r[1] || r[2] === r[3]
    case 'midpoint':
      return r[0] === r[1] && r[1] === r[2]
    case 'pointOnLine': {
      const l = getEntity(doc, r[1]!)
      return !!l && l.kind === 'line' && (l.p1 === r[0] || l.p2 === r[0])
    }
    case 'concentric': {
      const a = getEntity(doc, r[0]!), b = getEntity(doc, r[1]!)
      return !!a && !!b && a.kind === 'circle' && b.kind === 'circle' && a.center === b.center
    }
    default:
      return false
  }
}

/** Make `from` and `into` one point: every reference to `from` becomes `into`
 *  (which keeps its position), then whatever became degenerate is dropped. */
export function mergePoints(doc: SketchDoc, from: EntityId, into: EntityId): void {
  if (from === into) return
  const pf = getPoint(doc, from), pi = getPoint(doc, into)
  if (!pf || !pi) return
  if (pf.fixed) pi.fixed = true
  const sw = (id: EntityId) => (id === from ? into : id)
  const touched = new Set<EntityId>()   // entity ids whose structure changed
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

  // rules that became meaningless (only those this merge touched)
  doc.constraints = doc.constraints.filter(c => {
    const affected = touched.has(c.id) || c.refs.some(r => touched.has(r))
    return !(affected && isTrivial(doc, c))
  })

  const loose: EntityId[] = []
  for (const e of [...doc.entities]) {
    if (!touched.has(e.id)) continue
    if (e.kind === 'line' && e.p1 === e.p2) {
      deleteEntity(doc, e.id)
    } else if (e.kind === 'path') {
      collapsePath(doc, e, loose)
    }
  }
  cleanOrphans(doc, loose)
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
  if (path.closed && path.anchors.length < 2) {
    // a closed path needs two anchors; one left means nothing drawable remains
    path.segments = []
  }
  if (path.segments.length === 0) {
    loose.push(...path.anchors)
    doc.entities = doc.entities.filter(e => e.id !== path.id)
    doc.constraints = doc.constraints.filter(c => !c.refs.includes(path.id))
  }
}

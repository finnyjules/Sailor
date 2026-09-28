// Topology behind the pen's Trim, Cut and Dissolve tools and point merging.
// Pure edits on a SketchDoc; geometry comes from crossings.ts.
import type { SketchDoc, EntityId, PathEntity, SegmentSpec, SketchConstraint } from './model'
import { getEntity, getPoint } from './model'
import type { Vec2 } from './geom'
import { dist, sub, cross, dot, distPointToLine } from './geom'
import type { CurveRef, Span, SpanEnd } from './crossings'
import { curveGeom, pointAt } from './crossings'
import { addPoint, addLine, addCircle, addConstraint, deleteEntity, isPointReferenced, sharpSideLengthRules } from './edit'
import { freshId } from './ids'
import { tangentTouchPoint } from './tangency'
import { splitSeeds, joinSeeds, renameSeedPoints } from './fills'

const TAU = Math.PI * 2
const EPS_T = 1e-7

export interface TrimResult { ok: boolean; droppedRules: number }

const FAIL: TrimResult = { ok: false, droppedRules: 0 }

// a removal's result plus the points that are now the removed piece's ends
// (the trim's own ends, where auto-join looks — see joinAtTrimEnds)
interface Removed extends TrimResult { ends: EntityId[] }
const NOT_REMOVED: Removed = { ...FAIL, ends: [] }

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

// Pins Trim itself put on the new end points it created, per doc object:
// rule id → { rule content, the pinned point }. Used only so that removing such an
// end later (e.g. trimming the rest of a line in one sweep) doesn't report Trim's
// own pin as a lost user rule. A cloned doc starts empty, so at worst a pin is counted.
const trimPins = new WeakMap<SketchDoc, Map<EntityId, { key: string; point: EntityId }>>()

function recordTrimPin(doc: SketchDoc, ruleId: EntityId, point: EntityId): void {
  const c = doc.constraints.find(k => k.id === ruleId)
  if (!c) return
  let m = trimPins.get(doc)
  if (!m) { m = new Map(); trimPins.set(doc, m) }
  m.set(ruleId, { key: sameKey(c), point })
}

// Counts rules removed as a side effect of an edit. Not counted: arc invariants,
// rules an edit removes knowingly because they became redundant (excuse), and
// pins Trim created on its own end points when that end point is deleted too.
interface Tracker { count(): number; excuse(id: EntityId): void }
function ruleTracker(doc: SketchDoc): Tracker {
  const own = trimPins.get(doc)
  const before = doc.constraints.map(c => {
    const rec = own?.get(c.id)
    return { id: c.id, trimPoint: rec && rec.key === sameKey(c) ? rec.point : null }
  })
  const skip = arcInvariantIds(doc)
  return {
    count: () => {
      const now = new Set(doc.constraints.map(c => c.id))
      return before.filter(({ id, trimPoint }) =>
        !now.has(id) && !skip.has(id) && !(trimPoint && !getPoint(doc, trimPoint))).length
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

/** Two rules with the same key are the same rule (kind, refs in order, value). */
export const sameKey = (c: SketchConstraint) => `${c.kind}|${c.refs.join(',')}|${c.value ?? ''}`

// ── point-pair rules ─────────────────────────────────────────────────────────
// The pen stores segment rules as point pairs: horizontal/vertical [a,b],
// parallel/perpendicular [a,b,c,d] (Right angle [prev,c,c,next]), equalDist
// [a,b,c,d], distance [a,b]; a point pinned to a path line segment is
// collinear [A,B,p]; a line tangent to a round piece is tangentLineArc
// [A,B,…]. When a segment's pair changes, these follow it.

type PairEvent =
  | { kind: 'removed' }                                  // (a,b) is gone
  | { kind: 'moved'; from: EntityId; to: EntityId }      // one end moved along the same curve
  | { kind: 'split'; x0: EntityId; x1: EntityId }        // (a,b) → (a,x0) + (x1,b)
  | { kind: 'grow'; from: EntityId; to: EntityId }       // dissolve: (a,q) → (a,b)
  | { kind: 'cut'; x: EntityId }                          // (a,b) → (a,x) + (x,b), nothing moves

// 'tan': a tangent line — follows its line like a direction, but on a split or
// cut only the half nearest the touch point keeps it (the arc touches one half).
// 'off': an offsetLine — the same, but nearest its offset point's foot on the line.
type PairCat = 'dir' | 'len' | 'pin' | 'tan' | 'off'

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
    case 'tangentLineArc':
      return r.length >= 3 ? { cat: 'tan', slots: [[0, 1]] } : null
    case 'offsetLine':
      return r.length === 3 ? { cat: 'off', slots: [[0, 1]] } : null
    default:
      return null
  }
}

function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const L2 = dx * dx + dy * dy
  const t = L2 < 1e-18 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

// the spot a rule on a line belongs near: a tangent line's touch point, an
// offset line's copy point dropped onto the line
function ruleSpot(doc: SketchDoc, c: SketchConstraint): Vec2 | null {
  if (c.kind === 'offsetLine') {
    const a = getPoint(doc, c.refs[0]!), b = getPoint(doc, c.refs[1]!), p = getPoint(doc, c.refs[2]!)
    if (!a || !b || !p) return null
    const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy
    if (L2 < 1e-18) return null
    const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2
    return { x: a.x + t * dx, y: a.y + t * dy }
  }
  return tangentTouchPoint(doc, c)
}

// of a tangent/offset rule's two candidate line pairs, the one whose piece is nearer where it touches
function nearerHalf(doc: SketchDoc, c: SketchConstraint, first: EntityId[], second: EntityId[]): EntityId[] {
  const touch = ruleSpot(doc, c)
  const d = (refs: EntityId[]) => {
    const a = getPoint(doc, refs[0]!), b = getPoint(doc, refs[1]!)
    return touch && a && b ? distToSegment(touch, a, b) : Infinity
  }
  return d(second) < d(first) ? second : first
}

// is the pair (a,b) currently a straight piece — a line entity, or one of a
// path's 'line' segments? Only such a piece can safely carry an offsetLine's
// re-aim (an arc that merely happens to touch the offset line must not).
function isStraightPair(doc: SketchDoc, a: EntityId, b: EntityId): boolean {
  const pair = (x: EntityId, y: EntityId) => (x === a && y === b) || (x === b && y === a)
  for (const e of doc.entities) {
    if (e.kind === 'line' && pair(e.p1, e.p2)) return true
    if (e.kind !== 'path') continue
    const n = e.anchors.length
    const count = e.closed ? n : n - 1
    for (let i = 0; i < count; i++) {
      if (e.segments[i]?.kind === 'line' && pair(e.anchors[i]!, e.anchors[(i + 1) % n]!)) return true
    }
  }
  return false
}

// X's signed distance from A→B (left of A→B positive) — the same convention
// as offsetLine's own residual (residuals.ts); null on a zero-length line
function signedOffsetDistance(doc: SketchDoc, A: EntityId, B: EntityId, X: EntityId): number | null {
  const a = getPoint(doc, A), b = getPoint(doc, B), x = getPoint(doc, X)
  if (!a || !b || !x) return null
  const dx = b.x - a.x, dy = b.y - a.y
  const L = Math.hypot(dx, dy)
  if (L < 1e-12) return null
  return (dx * (x.y - a.y) - dy * (x.x - a.x)) / L
}

// does X sit on offsetLine rule c's own line, at c's own distance, within tol?
// The only certain condition for re-aiming refs[2] onto X — geometry, not topology.
function onOffsetLine(doc: SketchDoc, c: SketchConstraint, X: EntityId, tol: number): boolean {
  if (c.value == null) return false
  const d = signedOffsetDistance(doc, c.refs[0]!, c.refs[1]!, X)
  return d != null && Math.abs(d - c.value) <= tol
}

// returns the ids of rules it rewrote or created
function followPair(doc: SketchDoc, a: EntityId, b: EntityId, ev: PairEvent): Set<EntityId> {
  const touched = new Set<EntityId>()
  if (a === b) return touched
  const centres = arcCentres(doc)
  // a rounded / chamfered corner's side removed: its lengths on the hidden
  // corner go too (re-review Minor 1)
  const remove = ev.kind === 'removed' ? sharpSideLengthRules(doc, a, b) : new Set<EntityId>()
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
      remove.add(c.id)
    } else if (ev.kind === 'moved' || ev.kind === 'grow') {
      if (info.cat === 'len') remove.add(c.id)        // the length changed
      else { c.refs = rewrite(ev.from, ev.to); touched.add(c.id) }
    } else if (ev.kind === 'cut' && (info.cat === 'tan' || info.cat === 'off')) {
      c.refs = nearerHalf(doc, c, rewrite(b, ev.x), rewrite(a, ev.x))
      touched.add(c.id)
    } else if (ev.kind === 'cut') {
      // nothing moves: lengths and pins still hold on a and b; directions go to both halves
      if (info.cat !== 'dir') continue
      const first = rewrite(b, ev.x)
      const second = rewrite(a, ev.x)
      c.refs = first
      touched.add(c.id)
      copies.push({ ...c, refs: second })
    } else {
      if (info.cat === 'len') { remove.add(c.id); continue }
      if (info.cat === 'tan' || info.cat === 'off') { c.refs = nearerHalf(doc, c, rewrite(b, ev.x0), rewrite(a, ev.x1)); touched.add(c.id); continue }
      const first = rewrite(b, ev.x0)
      const second = rewrite(a, ev.x1)
      c.refs = first
      touched.add(c.id)
      if (info.cat === 'dir') copies.push({ ...c, refs: second })
    }
  }
  // an offsetLine's third ref is a single point on the offset copy itself, not
  // part of a pair pairSlots tracks: when that exact end is trimmed away (its
  // piece is moved or grown, not the whole line removed), the rule follows to
  // the new end — the copy is still the same offset line, just shorter/longer
  // (the arc form already re-aims the same way through followArcOperands).
  // Certain geometry decides it, not topology (a same-source sibling scan can
  // be fooled by a second copy plus a connector between the two copies' ends):
  // re-aim only when the trimmed pair is a straight piece (a topology guess
  // alone can't rule out an arc that merely touches the line) AND both its
  // surviving end and the new end sit at the rule's own signed distance from
  // A→B, within the drawing's tolerance — i.e. the trimmed piece truly lies on
  // the offset line, so re-aiming can never move the rule's point off it.
  if (ev.kind === 'moved' || ev.kind === 'grow') {
    const other = ev.from === a ? b : a
    if (isStraightPair(doc, a, b)) {
      const tol = drawingTol(doc)
      for (const c of doc.constraints) {
        if (c.kind === 'offsetLine' && c.refs.length === 3 && c.refs[2] === ev.from && !touched.has(c.id) && !remove.has(c.id)) {
          if (!onOffsetLine(doc, c, other, tol) || !onOffsetLine(doc, c, ev.to, tol)) continue
          c.refs = [c.refs[0]!, c.refs[1]!, ev.to]
          touched.add(c.id)
        }
      }
    }
  }
  removeRules(doc, remove)
  for (const k of copies) touched.add(addConstraint(doc, k.kind, k.refs, k.value))
  return touched
}

// ── arc operands ─────────────────────────────────────────────────────────────
// Rules name a path arc as [C, S] — its centre and one of its anchors: radius
// pins and arc Equal (equalDist [C,S,…]), tangentLineArc [A,B,C,S], tangentArcs
// [C1,S1,C2,S2] (either pair may be a circle id instead). Such a pair stays good
// while S is an anchor of an arc on C; when an edit takes S off the arc it
// re-aims at the arc's surviving anchor, or the rule goes (and is counted).

// "C|S" for every anchor S of every arc segment on centre C
function arcAnchorPairs(doc: SketchDoc): Set<string> {
  const out = new Set<string>()
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    e.segments.forEach((s, i) => {
      if (s.kind !== 'arc') return
      const [a, b] = segEnds(e, i)
      out.add(`${s.center}|${a}`); out.add(`${s.center}|${b}`)
    })
  }
  return out
}

// the [centre, point] slots of a rule that may name a round piece
function operandSlots(doc: SketchDoc, c: SketchConstraint): [number, number][] {
  const r = c.refs
  if (c.kind === 'equalDist') return r.length === 4 ? [[0, 1], [2, 3]] : []
  if (c.kind === 'tangentLineArc') return r.length === 4 ? [[2, 3]] : []
  if (c.kind === 'offsetRadius') {
    const out: [number, number][] = []
    for (let i = 0; i < r.length;) {
      if (getEntity(doc, r[i]!)?.kind === 'circle') { i += 1; continue }
      out.push([i, i + 1]); i += 2
    }
    return out
  }
  if (c.kind !== 'tangentArcs') return []
  const out: [number, number][] = []
  for (let i = 0; i < r.length;) {
    const e = getEntity(doc, r[i]!)
    if (e?.kind === 'circle') { i += 1; continue }
    out.push([i, i + 1]); i += 2
  }
  return out
}

/** After an edit: every rule's [C, S] that named an arc anchor before (`before`,
 *  from arcAnchorPairs) but no longer does re-aims at `hints["C|S"]` when that is
 *  an anchor of an arc on C now, else the rule is removed. Arc invariants are
 *  never touched. */
function followArcOperands(doc: SketchDoc, before: Set<string>, hints: Map<string, EntityId> = new Map()): void {
  const now = arcAnchorPairs(doc)
  const invariants = arcInvariantIds(doc)
  const remove = new Set<EntityId>()
  for (const c of doc.constraints) {
    if (invariants.has(c.id)) continue
    for (const [i, j] of operandSlots(doc, c)) {
      const key = `${c.refs[i]}|${c.refs[j]}`
      if (!before.has(key) || now.has(key)) continue
      const to = hints.get(key)
      if (to && now.has(`${c.refs[i]}|${to}`)) { const refs = [...c.refs]; refs[j] = to; c.refs = refs }
      else remove.add(c.id)
    }
  }
  removeRules(doc, remove)
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

function addPinRule(doc: SketchDoc, p: EntityId, cutter: CurveRef): EntityId | null {
  if (cutter.kind === 'line') return addConstraint(doc, 'pointOnLine', [p, cutter.id])
  if (cutter.kind === 'circle') return addConstraint(doc, 'pointOnCircle', [p, cutter.id])
  const path = getEntity(doc, cutter.pathId)
  if (!path || path.kind !== 'path') return null
  const seg = path.segments[cutter.segIndex]
  if (!seg) return null
  const [a, b] = segEnds(path, cutter.segIndex)
  if (seg.kind === 'line') return addConstraint(doc, 'collinear', [a, b, p])
  if (seg.kind === 'arc') return addConstraint(doc, 'equalDist', [seg.center, p, seg.center, a])
  return null
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
  const rule = addPinRule(doc, id, cutter)
  if (rule) recordTrimPin(doc, rule, id)
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
  const arcsBefore = arcAnchorPairs(doc)
  const loose = cutOutSegment(doc, path, segIndex)
  followArcOperands(doc, arcsBefore)
  cleanOrphans(doc, loose)
  return { ok: true, droppedRules: tr.count() }
}

function removeLineSpan(doc: SketchDoc, span: Span & { ref: { kind: 'line' } }): Removed {
  const line = getEntity(doc, span.ref.id)
  if (!line || line.kind !== 'line') return NOT_REMOVED
  const tr = ruleTracker(doc)
  const { p1, p2 } = line
  const cons = !!line.construction
  const self = span.ref
  let ends: EntityId[]
  if (!span.start.cutter && !span.end.cutter) {
    followPair(doc, p1, p2, { kind: 'removed' })
    deleteEntity(doc, line.id)
    cleanOrphans(doc, [p1, p2])
    ends = [p1, p2]
  } else if (!span.start.cutter) {
    const x = endPoint(doc, tr, span.end, self, cons)
    followPair(doc, p1, p2, { kind: 'moved', from: p1, to: x })
    line.p1 = x
    cleanOrphans(doc, [p1])
    ends = [p1, x]
  } else if (!span.end.cutter) {
    const x = endPoint(doc, tr, span.start, self, cons)
    followPair(doc, p1, p2, { kind: 'moved', from: p2, to: x })
    line.p2 = x
    cleanOrphans(doc, [p2])
    ends = [x, p2]
  } else {
    const x0 = endPoint(doc, tr, span.start, self, cons)
    const x1 = endPoint(doc, tr, span.end, self, cons)
    followPair(doc, p1, p2, { kind: 'split', x0, x1 })
    line.p2 = x0
    const L2 = addLine(doc, x1, p2, cons ? { construction: true } : {})
    copyLineDirection(doc, line.id, L2)
    ends = [x0, x1]
  }
  return { ok: true, droppedRules: tr.count(), ends }
}

function removeSegSpan(doc: SketchDoc, span: Span & { ref: { kind: 'seg' } }): Removed {
  const path = getEntity(doc, span.ref.pathId)
  const i = span.ref.segIndex
  if (!path || path.kind !== 'path' || i < 0 || i >= segCount(path)) return NOT_REMOVED
  const seg = path.segments[i]!
  if (seg.kind === 'cubic') return NOT_REMOVED
  const tr = ruleTracker(doc)
  const cons = !!path.construction
  const [A, B] = segEnds(path, i)
  const arcsBefore = arcAnchorPairs(doc)
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
  // the arc's removed end → its new end on the same side
  const hints = new Map<string, EntityId>()
  if (seg.kind === 'arc') {
    if (x1 && !x0) hints.set(`${seg.center}|${A}`, x1)
    if (x0 && !x1) hints.set(`${seg.center}|${B}`, x0)
  }
  followArcOperands(doc, arcsBefore, hints)
  cleanOrphans(doc, loose)
  return { ok: true, droppedRules: tr.count(), ends: [x0 ?? A, x1 ?? B] }
}

function removeCircleSpan(doc: SketchDoc, span: Span & { ref: { kind: 'circle' } }): Removed {
  const circ = getEntity(doc, span.ref.id)
  if (!circ || circ.kind !== 'circle') return NOT_REMOVED
  const tr = ruleTracker(doc)
  const C = circ.center
  const cons = !!circ.construction
  const fewerThanTwo = !span.start.cutter || !span.end.cutter || span.end.t - span.start.t >= TAU - 1e-9
  if (fewerThanTwo) {
    // points held only by their pin to this circle go with it (the joined point
    // a closed one-arc path leaves); their pins are not lost user rules
    const held = pinnedOnlyTo(doc, circ.id)
    for (const c of doc.constraints) if (c.kind === 'pointOnCircle' && c.refs[1] === circ.id && held.has(c.refs[0]!)) tr.excuse(c.id)
    deleteEntity(doc, circ.id)
    cleanOrphans(doc, [C, ...held])
    return { ok: true, droppedRules: tr.count(), ends: [] }
  }
  // points held only by their pin to this circle that lie on the removed piece
  // go with it (strictly inside: an end of the piece is a crossing, not theirs)
  const cc = getPoint(doc, C)
  const inPiece = new Set<EntityId>()
  if (cc) {
    const width = span.end.t - span.start.t
    for (const q of pinnedOnlyTo(doc, circ.id)) {
      const pq = getPoint(doc, q)
      if (!pq) continue
      const a = ((Math.atan2(pq.y - cc.y, pq.x - cc.x) - span.start.t) % TAU + TAU) % TAU
      if (a > 1e-9 && a < width - 1e-9) inPiece.add(q)
    }
  }
  const x0 = endPoint(doc, tr, span.start, span.ref, cons)   // a reused end's pointOnCircle goes here
  const x1 = endPoint(doc, tr, span.end, span.ref, cons)
  if (x0 === x1) return { ok: false, droppedRules: tr.count(), ends: [] }
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
      if (inPiece.has(q)) { tr.excuse(c.id); continue }          // goes with the removed piece
      kept.push({ id: c.id, kind: 'equalDist', refs: [C, q, C, x1] })
    } else if (c.kind === 'concentric') {
      const target = concentricCentre(doc, c, circ.id, C, shareWith)
      if (target) { shareWith = target; tr.excuse(c.id) }       // kept by sharing the centre
    } else if (c.kind === 'offsetRadius') {
      const refs = reaimOffsetRadiusCircle(c.refs, circ.id, C, x1)
      if (refs) { kept.push({ id: c.id, kind: 'offsetRadius', refs, value: c.value }); tr.excuse(c.id) }
    }
    // every other circle rule (tangent, equal radius, radius…) is dropped and counted
  }
  doc.constraints = kept
  doc.entities = doc.entities.filter(e => e.id !== circ.id)
  cleanOrphans(doc, inPiece)
  if (shareWith && shareWith !== C) mergePoints(doc, C, shareWith)   // the arc takes that circle's centre
  return { ok: true, droppedRules: tr.count(), ends: [x0, x1] }
}

// points whose only tie to the drawing is a pointOnCircle onto circle `circId`:
// no entity uses them and no other rule names them (fixed points never count)
function pinnedOnlyTo(doc: SketchDoc, circId: EntityId): Set<EntityId> {
  const out = new Set<EntityId>()
  for (const c of doc.constraints) {
    if (c.kind !== 'pointOnCircle' || c.refs[1] !== circId) continue
    const q = c.refs[0]!
    const p = getPoint(doc, q)
    if (!p || p.fixed || isPointReferenced(doc, q)) continue
    const others = doc.constraints.some(k => k.refs.includes(q) && !(k.kind === 'pointOnCircle' && k.refs[1] === circId))
    if (!others) out.add(q)
  }
  return out
}

// an offsetRadius whose circle-id operand is `circId` (the source circle just
// trimmed into a path arc on the same centre C, one new end S): the operand
// becomes the point-pair form [C, S] in its place. null when circId isn't one
// of the (at most two) operands, or sits where a pair, not a solo id, belongs.
function reaimOffsetRadiusCircle(refs: EntityId[], circId: EntityId, C: EntityId, S: EntityId): EntityId[] | null {
  const idx = refs.indexOf(circId)
  if (idx < 0) return null
  if (refs.length === 2) return idx === 0 ? [C, S, refs[1]!] : [refs[0]!, C, S]
  if (refs.length === 3) return idx === 0 ? [C, S, refs[1]!, refs[2]!] : idx === 2 ? [refs[0]!, refs[1]!, C, S] : null
  return null
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
 *  sits on a line's or segment's own end counts as that end. Afterwards, where
 *  the removed piece's ends are now the ends of exactly two open paths, those
 *  join into one (and close when their ends meet) — see joinAtTrimEnds. */
export function removeSpan(doc: SketchDoc, span: Span): TrimResult {
  const pathsBefore = new Set(doc.entities.filter(e => e.kind === 'path').map(e => e.id))
  const res = removePiece(doc, span)
  if (res.ok) joinAtTrimEnds(doc, res.ends, pathsBefore)
  return { ok: res.ok, droppedRules: res.droppedRules }
}

function removePiece(doc: SketchDoc, span: Span): Removed {
  if (span.ref.kind === 'circle') return removeCircleSpan(doc, span as Span & { ref: { kind: 'circle' } })
  const s = normaliseSpan(doc, span)
  if (!s) return NOT_REMOVED
  if ((s.start.cutter || s.end.cutter) && dist(s.start.point, s.end.point) <= drawingTol(doc)) return NOT_REMOVED   // zero-length piece
  if (s.ref.kind === 'line') return removeLineSpan(doc, s as Span & { ref: { kind: 'line' } })
  return removeSegSpan(doc, s as Span & { ref: { kind: 'seg' } })
}

// Trim auto-join. Trim leaves each remaining piece its own open path, even
// where two now end at the same point (a flower's petals, trimmed, are a ring
// of open arcs the Frame can't fill). At each of the trim's own ends — and
// nowhere else in the drawing — two open paths ending there become one
// (joinOpenEnds), and a path whose two ends have met closes (collapsePath).
// A join at one end can let the other end join too (a lens closes), so this
// repeats until nothing more joins. Only open paths join: openEndPair refuses
// line-tool line entities (rules name those by id, so they are never turned
// into paths), circles, closed paths, a point used as a centre or handle, a
// three-way meeting and a guide meeting a drawn piece. Nothing moves and no
// rule is removed (a join only folds one path's anchors into the other's).
// Of the two paths, one that existed before this trim keeps its id; when both
// did, the first in the drawing (the older one) keeps it.
function joinAtTrimEnds(doc: SketchDoc, ends: EntityId[], keepIds: Set<EntityId>): void {
  const at = [...new Set(ends)]
  for (let joined = true; joined;) {
    joined = false
    for (const x of at) {
      if (!getPoint(doc, x)) continue
      const id = joinOpenEnds(doc, x, keepIds)
      if (!id) continue
      joined = true
      const path = getEntity(doc, id)
      const loose: EntityId[] = []
      if (path?.kind === 'path') collapsePath(doc, path, loose)
      cleanOrphans(doc, loose)
    }
  }
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
    followPair(doc, p1, p2, { kind: 'cut', x })
    splitSeeds(doc, p1, p2, null, t, x)   // pen stage 7: a fill's seed stays on its half
    line.p2 = x
    const L2 = addLine(doc, x, p2, cons ? { construction: true } : {})
    copyLineDirection(doc, line.id, L2)
    return x
  }
  const path = getEntity(doc, ref.pathId)
  if (!path || path.kind !== 'path') return null
  const [a, b] = segEnds(path, ref.segIndex)
  const x = addPoint(doc, at.x, at.y, path.construction ? { construction: true } : {})
  followPair(doc, a, b, { kind: 'cut', x })
  const seg = path.segments[ref.segIndex]!
  // pen stage 7: a fill's seed stays on its half (a cubic never gets here:
  // curveGeom returns null for it, so cutAt has already refused)
  splitSeeds(doc, a, b, seg.kind === 'arc' ? seg.center : null, t, x)
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
  // pen stage 7: how much of the merged piece the first half was (by turn for
  // arcs, by length for lines) — a fill's seed on either half moves onto it
  const gIn = curveGeom(doc, { kind: 'seg', pathId, segIndex: inSeg })
  const gOut = curveGeom(doc, { kind: 'seg', pathId, segIndex: outSeg })
  const partOf = (g: typeof gIn) => (!g ? 0 : g.kind === 'line' ? dist(g.a!, g.b!) : Math.abs(g.sweepAngle ?? 0))
  const share = partOf(gIn) / Math.max(1e-12, partOf(gIn) + partOf(gOut))
  joinSeeds(doc, a, q, b, sIn.kind === 'arc' ? sIn.center : null, sOut.kind === 'arc' ? sOut.center : null, share)
  const loose: EntityId[] = [q]
  const touched = new Set<EntityId>([
    ...followPair(doc, a, q, { kind: 'grow', from: q, to: b }),
    ...followPair(doc, q, b, { kind: 'grow', from: q, to: a }),
  ])
  let C2: EntityId | null = null
  let C: EntityId | null = null
  if (sIn.kind === 'arc' && sOut.kind === 'arc') {
    C = sIn.center; C2 = sOut.center
    removeArcInvariant(doc, C, a, q)
    removeArcInvariant(doc, C2, q, b)
  }
  // pair k = (anchor k, segment k); dropping pair `anchorIndex` makes pair inSeg run a→b
  path.anchors.splice(anchorIndex, 1)
  path.segments.splice(outSeg, 1)
  if (C && C2) {
    touched.add(addConstraint(doc, 'equalDist', [C, a, C, b]))
    // arc operands [C|C2, q] (radius pins, arc Equal, tangent rules) re-aim:
    // C2 → C when C2 is about to go; q → a when q is about to go, or when the
    // operand is on the merged arc's centre and q is no longer an anchor of an
    // arc there. Arc invariants (of any arc still drawn) are never touched.
    const invariants = arcInvariantIds(doc)
    const now = arcAnchorPairs(doc)
    const qGoes = !isPointReferenced(doc, q) && !getPoint(doc, q)?.fixed
    const c2Goes = C2 !== C && !isPointReferenced(doc, C2) && !getPoint(doc, C2)?.fixed
    for (const c of doc.constraints) {
      if (invariants.has(c.id)) continue
      const refs = [...c.refs]
      for (const [i, j] of operandSlots(doc, c)) {
        const centre: EntityId = refs[i]!
        if (centre !== C && centre !== C2) continue
        const into: EntityId = c2Goes && centre === C2 ? C : centre
        refs[i] = into
        if (refs[j] === q && (qGoes || (into === C && !now.has(`${C}|${q}`)))) refs[j] = a
      }
      if (refs.some((r, i) => r !== c.refs[i])) { c.refs = refs; touched.add(c.id) }
    }
    if (C2 !== C) loose.push(C2)
  }
  // among the rules this dissolve rewrote: redundant ones (a pin onto its own end, a
  // repeat of another rule) go uncounted; any other rule made meaningless is a real drop
  const others = new Set(doc.constraints.filter(c => !touched.has(c.id)).map(sameKey))
  const remove = new Set<EntityId>()
  for (const c of doc.constraints) {
    if (!touched.has(c.id)) continue
    const key = sameKey(c)
    const redundant = others.has(key) || ((c.kind === 'collinear' || c.kind === 'equalDist') && isTrivial(doc, c))
    if (redundant) { remove.add(c.id); tr.excuse(c.id); continue }
    if (isTrivial(doc, c)) { remove.add(c.id); continue }
    others.add(key)
  }
  removeRules(doc, remove)
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
    case 'tangentLineArc': {
      if (r[0] === r[1]) return true
      const ops = operandCentres(doc, c)
      return ops.some(o => o.degenerate || o.c === r[0] || o.c === r[1])
    }
    case 'tangentArcs': {
      const ops = operandCentres(doc, c)
      return ops.some(o => o.degenerate) || (ops.length === 2 && ops[0]!.c === ops[1]!.c)
    }
    case 'offsetLine':
      return r[0] === r[1] || r[2] === r[0] || r[2] === r[1]
    case 'offsetRadius': {
      const ops: string[] = []
      for (let i = 0; i < r.length;) {
        if (getEntity(doc, r[i]!)?.kind === 'circle') { ops.push(r[i]!); i += 1; continue }
        if (r[i] === r[i + 1]) return true            // a pair collapsed to one point
        ops.push(`${r[i]},${r[i + 1]}`); i += 2
      }
      return ops.length === 2 && ops[0] === ops[1]
    }
    case 'translatedFrom':
      return r[0] === r[1] || r[2] === r[3]
    default:
      return false
  }
}

// the centre each round operand of a tangent rule names (a circle id → its
// centre); `degenerate` when a [C, S] pair became one point
function operandCentres(doc: SketchDoc, c: SketchConstraint): { c: EntityId; degenerate: boolean }[] {
  const r = c.refs
  let i = c.kind === 'tangentLineArc' ? 2 : 0
  const out: { c: EntityId; degenerate: boolean }[] = []
  while (i < r.length) {
    const e = getEntity(doc, r[i]!)
    if (e?.kind === 'circle') { out.push({ c: e.center, degenerate: false }); i += 1 }
    else { out.push({ c: r[i]!, degenerate: r[i] === r[i + 1] }); i += 2 }
  }
  return out
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
  // the paths that used `into` before the merge (a join keeps one of their ids)
  const hadInto = new Set(doc.entities.filter(e => e.kind === 'path' && e.anchors.includes(into)).map(e => e.id))
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
  // pen stage 7: a fill's seed names the merged point. A merge that collapses
  // the seed's own piece (its two ends merged) leaves the seed on no piece:
  // a live fill is re-picked by the settle (reconcileFills finds its area by
  // the edges it shares); a sleeping one has no area to find and is dropped.
  renameSeedPoints(doc, from, into)
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

  const joinedId = joinOpenEnds(doc, into, hadInto)
  if (joinedId) touched.add(joinedId)

  const loose: EntityId[] = []
  for (const e of [...doc.entities]) {
    if (!touched.has(e.id)) continue
    if (e.kind === 'line' && e.p1 === e.p2) deleteEntity(doc, e.id, { keepGuideEnds: true })
    else if (e.kind === 'path') collapsePath(doc, e, loose)
  }
  cleanOrphans(doc, loose, into)
  return true
}

/** The same path drawn the other way round: anchors and segments reversed, each
 *  arc's sweep flipped (the arc invariant equalDist [C,a,C,b] reads either way),
 *  each cubic's handles swapped. The drawing does not change. */
export function reversePath(path: PathEntity): void {
  if (path.closed) return
  path.anchors = [...path.anchors].reverse()
  path.segments = [...path.segments].reverse().map(s => {
    if (s.kind === 'arc') return { ...s, sweep: s.sweep === 1 ? 0 : 1 }
    if (s.kind === 'cubic') return { ...s, h1: s.h2, h2: s.h1 }
    return s
  })
}

/** The two open paths point `x` would join if it is an END of exactly two
 *  different open paths (of the same construction kind) and nothing else uses
 *  it — as [first, second], or null. */
export function openEndPair(doc: SketchDoc, x: EntityId): [PathEntity, PathEntity] | null {
  const ends: PathEntity[] = []
  for (const e of doc.entities) {
    if (e.kind === 'line') { if (e.p1 === x || e.p2 === x) return null; continue }
    if (e.kind === 'circle') { if (e.center === x) return null; continue }
    if (e.kind !== 'path') continue
    const n = e.anchors.length
    const uses = e.anchors.filter(a => a === x).length
    const other = e.segments.some(s => (s.kind === 'arc' && s.center === x) || (s.kind === 'cubic' && (s.h1 === x || s.h2 === x)))
    if (other) return null
    if (!uses) continue
    if (e.closed || uses !== 1 || (e.anchors[0] !== x && e.anchors[n - 1] !== x)) return null
    ends.push(e)
  }
  if (ends.length !== 2) return null
  const [p, q] = ends as [PathEntity, PathEntity]
  if (!!p.construction !== !!q.construction) return null
  return [p, q]
}

// Two open paths meeting end to end at `x` (openEndPair) become one: the one
// that used `x` before the merge keeps its id (`keepIds`), the other is folded
// in (reversed as needed) and removed. Rules naming the removed path go with it.
// If the joined path starts and ends on one point it closes (collapsePath).
// Returns the kept path's id, or null when nothing was joined.
function joinOpenEnds(doc: SketchDoc, x: EntityId, keepIds: Set<EntityId>): EntityId | null {
  const pair = openEndPair(doc, x)
  if (!pair) return null
  let [p, q] = pair
  if (!keepIds.has(p.id) && keepIds.has(q.id)) [p, q] = [q, p]
  if (p.anchors[p.anchors.length - 1] !== x) reversePath(p)   // p ends at x
  if (q.anchors[0] !== x) reversePath(q)                        // q starts at x
  p.anchors = [...p.anchors, ...q.anchors.slice(1)]
  p.segments = [...p.segments, ...q.segments]
  // rules naming q's own id go with it (dropPathEntity); the pen makes none today
  dropPathEntity(doc, q)
  return p.id
}

// drop segments whose two anchors are now the same point; an open path whose ends met closes
function collapsePath(doc: SketchDoc, path: PathEntity, loose: EntityId[]): void {
  // an open path of ONE arc whose two ends became one point X: the arc has
  // closed on itself — it becomes a circle on the same centre, with X kept on
  // it (the arc's own equalDist invariant went trivial and is dropped)
  const only = path.segments[0]
  if (!path.closed && path.anchors.length === 2 && path.anchors[0] === path.anchors[1]
      && path.segments.length === 1 && only?.kind === 'arc') {
    const x = path.anchors[0]!
    const px = getPoint(doc, x), pc = getPoint(doc, only.center)
    if (px && pc) {
      removeArcInvariant(doc, only.center, x, x)
      const circle = addCircle(doc, only.center, dist(px, pc), path.construction ? { construction: true } : {})
      addConstraint(doc, 'pointOnCircle', [x, circle])
      dropPathEntity(doc, path)
      return
    }
  }
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

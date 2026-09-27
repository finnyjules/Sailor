// app/composables/pen/penRules.ts
// Which constraint verbs the current selection offers, and how a verb's
// selection maps onto the constraint's point refs. Pure functions of
// (doc, selection, segments) — moved verbatim out of pages/dev/sketch-draw.vue,
// where they read the page's refs directly.
import type { SketchDoc, EntityId, ConstraintKind } from '~/lib/sketch/model'
import type { CurveRef } from '~/lib/sketch/crossings'
import { pieceOf, tangentRuleFor, type RuleSpec } from '~/lib/sketch/tangency'

// `tip`: the button's id in the rules row (its hover card, penTips.ts) when the
// rule kind alone would name the wrong card — "On curve" is written as a
// collinear or equalDist rule, which the row otherwise shows as other verbs
// `tangent`: the button runs the pen's applyTangent (the rule kind is worked
// out from the two pieces — the joint form when they meet), not apply(kind)
export interface RuleOption { kind: ConstraintKind; label: string; value?: boolean; tip?: string; tangent?: boolean }
export interface SegRef { pathId: EntityId; segIndex: number }

function selKinds(doc: SketchDoc, selection: EntityId[]): string[] {
  return selection.map(id => doc.entities.find(e => e.id === id)?.kind ?? '?')
}

// interior line-line corner of a path at anchor `pointId`: the previous and
// next anchors along the path, when both segments meeting at it are straight
// lines (an arc has no fixed direction at the joint, so any corner touching
// one is excluded). Open path: only a true interior anchor qualifies (not the
// first/last, which have just one adjacent segment). Closed path: any anchor
// qualifies, wrapping around. Returns the first path entity where this holds,
// or null if `pointId` isn't such a corner on any path.
export function pathCornerInfo(doc: SketchDoc, pointId: EntityId): { prev: EntityId; corner: EntityId; next: EntityId } | null {
  for (const e of doc.entities) {
    if (e.kind !== 'path') continue
    const n = e.anchors.length
    for (let i = 0; i < n; i++) {
      if (e.anchors[i] !== pointId) continue
      if (!e.closed && (i === 0 || i === n - 1)) continue
      const prevSeg = e.segments[(i - 1 + n) % n]
      const nextSeg = e.segments[i]
      if (!prevSeg || !nextSeg) continue
      if (prevSeg.kind !== 'line' || nextSeg.kind !== 'line') continue
      return { prev: e.anchors[(i - 1 + n) % n]!, corner: pointId, next: e.anchors[(i + 1) % n]! }
    }
  }
  return null
}

// which verbs apply to the current selection (order = display order)
export function availableConstraints(doc: SketchDoc, selection: EntityId[], segments: SegRef[]): RuleOption[] {
  const ids = selection
  const kinds = selKinds(doc, selection)
  const out: RuleOption[] = []
  const count = (k: string) => kinds.filter(x => x === k).length
  // one point + one Option-clicked segment (the only pairing where the two
  // selections are kept together — see usePen pick/pickSegment): pin the
  // point onto that piece, or to the middle of a straight one
  if (ids.length && segments.length) {
    // one line or circle + one segment: Tangent
    if (ids.length === 1 && segments.length === 1 && (kinds[0] === 'line' || kinds[0] === 'circle')) {
      const t = tangentOption(doc, ids, segments)
      if (t) out.push(t)
      return out
    }
    if (ids.length !== 1 || kinds[0] !== 'point' || segments.length !== 1) return out
    const s = segments[0]!
    const path = doc.entities.find(e => e.id === s.pathId) as any
    const seg = path?.kind === 'path' ? path.segments[s.segIndex] : null
    // the point is one of this piece's own ends or its centre: pinning it
    // onto (or to the middle of) itself would collapse the piece
    if (ownsSegment(doc, ids[0]!, s)) return out
    if (seg?.kind === 'line') out.push({ kind: 'collinear', label: 'On curve', tip: 'onCurve' }, { kind: 'midpoint', label: 'Midpoint' })
    else if (seg?.kind === 'arc') out.push({ kind: 'equalDist', label: 'On curve', tip: 'onCurve' })
    return out
  }
  if (ids.length === 2 && count('point') === 2) {
    out.push({ kind: 'coincident', label: 'Coincident' }, { kind: 'distance', label: 'Distance…', value: true })
  }
  if (ids.length === 2 && count('circle') === 2) {
    out.push({ kind: 'concentric', label: 'Concentric' }, { kind: 'tangentCircleCircle', label: 'Tangent' }, { kind: 'equalRadius', label: 'Equal' })
  }
  if (ids.length === 2 && count('line') === 1 && count('circle') === 1) {
    out.push({ kind: 'tangentLineCircle', label: 'Tangent' })
  }
  if (ids.length === 2 && count('point') === 1 && count('line') === 1) {
    out.push({ kind: 'pointOnLine', label: 'Point on line' }, { kind: 'midpoint', label: 'Midpoint' })
  }
  if (ids.length === 2 && count('point') === 1 && count('circle') === 1) {
    out.push({ kind: 'pointOnCircle', label: 'Point on circle' })
  }
  if (ids.length === 1 && count('line') === 1) {
    out.push({ kind: 'horizontal', label: 'Horizontal' }, { kind: 'vertical', label: 'Vertical' })
  }
  if (ids.length === 1 && count('circle') === 1) {
    out.push({ kind: 'radius', label: 'Radius…', value: true })
  }
  if (ids.length === 2 && count('line') === 2) {
    out.push({ kind: 'perpendicular', label: 'Perpendicular' }, { kind: 'parallel', label: 'Parallel' }, { kind: 'equalDist', label: 'Equal' })
  }
  if (ids.length === 1 && count('point') === 1 && pathCornerInfo(doc, ids[0]!)) {
    out.push({ kind: 'perpendicular', label: 'Right angle' })
  }
  // segment verbs — only offered while entity selection is empty (mutually
  // exclusive with the gates above by construction, but gated explicitly too)
  // and only for LINE segments (v1 scope — see segmentAnchorPair/isLineSegment).
  if (!ids.length && segments.length === 1) {
    const s = segments[0]!
    if (isLineSegment(doc, s)) out.push({ kind: 'horizontal', label: 'Horizontal' }, { kind: 'vertical', label: 'Vertical' })
  }
  if (!ids.length && segments.length === 2) {
    const [s1, s2] = segments as [SegRef, SegRef]
    if (isLineSegment(doc, s1) && isLineSegment(doc, s2)) {
      out.push({ kind: 'perpendicular', label: 'Perpendicular' }, { kind: 'parallel', label: 'Parallel' }, { kind: 'equalDist', label: 'Equal' })
    } else {
      const t = tangentOption(doc, [], segments)
      if (t) out.push(t)
      if (isArcSegment(doc, s1) && isArcSegment(doc, s2)) out.push({ kind: 'equalDist', label: 'Equal', tip: 'equalArcs' })
    }
  }
  // rules that need exact geometry (arcs, lines, circles) do nothing on a
  // Bézier curve — hide them rather than offer a dead button (spec 2b)
  if (touchesCurve(doc, selection, segments)) return out.filter(r => !EXACT_GEOMETRY_RULES.includes(r.kind))
  return out
}

const EXACT_GEOMETRY_RULES: ConstraintKind[] = ['tangentLineCircle', 'tangentCircleCircle', 'radius', 'concentric', 'equalRadius', 'tangentLineArc', 'tangentArcs']

// a selected segment is a cubic, or a selected path contains one
function touchesCurve(doc: SketchDoc, selection: EntityId[], segments: SegRef[]): boolean {
  for (const s of segments) {
    const path = doc.entities.find(e => e.id === s.pathId) as any
    if (path?.kind === 'path' && path.segments[s.segIndex]?.kind === 'cubic') return true
  }
  for (const id of selection) {
    const e = doc.entities.find(x => x.id === id) as any
    if (e?.kind === 'path' && e.segments.some((seg: any) => seg.kind === 'cubic')) return true
  }
  return false
}

// a segment's own two anchor ids, [anchors[i], anchors[(i+1)%n]] — the same
// pair the residual reads for a line (see horizontal/vertical/perpendicular/
// parallel/equalDist in residuals.ts). null if the path or index no longer
// resolves (e.g. a stale selectedSegments entry after an undo/delete).
export function segmentAnchorPair(doc: SketchDoc, pathId: EntityId, segIndex: number): [EntityId, EntityId] | null {
  const path = doc.entities.find(e => e.id === pathId) as any
  if (!path || path.kind !== 'path') return null
  const n = path.anchors.length
  const a = path.anchors[segIndex]
  const b = path.anchors[(segIndex + 1) % n]
  if (!a || !b) return null
  return [a, b]
}
// v1 scope: segment verbs (H/V/perpendicular/parallel/equal) only apply to
// straight LINE segments — an arc has no single direction to pin flat or
// compare, so it's excluded from every segment-verb gate rather than papering
// over it with the chord direction.
export function isLineSegment(doc: SketchDoc, seg: SegRef): boolean {
  const path = doc.entities.find(e => e.id === seg.pathId) as any
  return !!path && path.kind === 'path' && path.segments[seg.segIndex]?.kind === 'line'
}

export function isArcSegment(doc: SketchDoc, seg: SegRef): boolean {
  const path = doc.entities.find(e => e.id === seg.pathId) as any
  return !!path && path.kind === 'path' && path.segments[seg.segIndex]?.kind === 'arc'
}

// the selection as tangent pieces: line and circle entities, then path
// segments. Empty when anything else (a point, a whole path) is selected.
function selectedCurveRefs(doc: SketchDoc, selection: EntityId[], segments: SegRef[]): CurveRef[] {
  const out: CurveRef[] = []
  for (const id of selection) {
    const e = doc.entities.find(x => x.id === id)
    if (e?.kind === 'line') out.push({ kind: 'line', id })
    else if (e?.kind === 'circle') out.push({ kind: 'circle', id })
    else return []
  }
  for (const s of segments) out.push({ kind: 'seg', pathId: s.pathId, segIndex: s.segIndex })
  return out
}

/** The tangent rule for exactly two selected pieces, at least one of them a
 *  path segment (two whole entities keep their own Tangent verbs). */
export function tangentRuleForSelection(doc: SketchDoc, selection: EntityId[], segments: SegRef[]): RuleSpec | null {
  if (!segments.length) return null
  const refs = selectedCurveRefs(doc, selection, segments)
  if (refs.length !== 2) return null
  const p = pieceOf(doc, refs[0]!), q = pieceOf(doc, refs[1]!)
  return p && q ? tangentRuleFor(doc, p, q) : null
}

function tangentOption(doc: SketchDoc, selection: EntityId[], segments: SegRef[]): RuleOption | null {
  const rule = tangentRuleForSelection(doc, selection, segments)
  return rule ? { kind: rule.kind, label: 'Tangent', tip: 'tangent', tangent: true } : null
}
// map 1 or 2 selected segments to the constraint's point refs — the segment
// analogue of orderRefs, but simpler: there's exactly one ref shape per arity
// (H/V take a segment's own 2-point pair directly; perpendicular/parallel/
// equalDist take the 4-point [a1,b1,a2,b2] form two lines already use above).
// Guard: all involved segments MUST be line segments (v1 scope — arc segments
// are excluded from every segment-verb constraint).
export function segmentConstraintRefs(doc: SketchDoc, kind: ConstraintKind, segs: SegRef[]): EntityId[] | null {
  // two arc segments: Equal = the same radius, equalDist [C1, A1, C2, A2]
  if (kind === 'equalDist' && segs.length === 2 && segs.every(s => isArcSegment(doc, s))) {
    const pair = segs.map(s => {
      const path = doc.entities.find(e => e.id === s.pathId) as any
      return { c: path.segments[s.segIndex].center as EntityId, a: path.anchors[s.segIndex] as EntityId }
    })
    return [pair[0]!.c, pair[0]!.a, pair[1]!.c, pair[1]!.a]
  }
  // all other segment verbs are line-only
  if (!segs.every(seg => isLineSegment(doc, seg))) return null

  if (segs.length === 1 && (kind === 'horizontal' || kind === 'vertical')) {
    return segmentAnchorPair(doc, segs[0]!.pathId, segs[0]!.segIndex)
  }
  if (segs.length === 2 && (kind === 'perpendicular' || kind === 'parallel' || kind === 'equalDist')) {
    const p1 = segmentAnchorPair(doc, segs[0]!.pathId, segs[0]!.segIndex)
    const p2 = segmentAnchorPair(doc, segs[1]!.pathId, segs[1]!.segIndex)
    if (!p1 || !p2) return null
    return [p1[0], p1[1], p2[0], p2[1]]
  }
  return null
}

// one point `p` + one path segment: the rule's refs — On curve is
// collinear [A, B, p] on a line segment or equalDist [C, p, C, A] on an arc
// (centre C, start A); Midpoint is midpoint [p, A, B] on a line segment.
// null for any other kind/segment pairing, or a segment that no longer resolves.
export function pointSegmentRefs(doc: SketchDoc, kind: ConstraintKind, p: EntityId, seg: SegRef): EntityId[] | null {
  if (ownsSegment(doc, p, seg)) return null
  const path = doc.entities.find(e => e.id === seg.pathId) as any
  const s = path?.kind === 'path' ? path.segments[seg.segIndex] : null
  const ends = segmentAnchorPair(doc, seg.pathId, seg.segIndex)
  if (!s || !ends) return null
  const [a, b] = ends
  if (s.kind === 'line' && kind === 'collinear') return [a, b, p]
  if (s.kind === 'line' && kind === 'midpoint') return [p, a, b]
  if (s.kind === 'arc' && kind === 'equalDist') return [s.center, p, s.center, a]
  return null
}

// `p` is one of the segment's two anchors, or its arc centre
function ownsSegment(doc: SketchDoc, p: EntityId, seg: SegRef): boolean {
  const ends = segmentAnchorPair(doc, seg.pathId, seg.segIndex)
  if (ends && ends.includes(p)) return true
  const path = doc.entities.find(e => e.id === seg.pathId) as any
  const s = path?.kind === 'path' ? path.segments[seg.segIndex] : null
  return s?.kind === 'arc' && s.center === p
}

// refs order per kind (matches residuals.ts contract)
export function orderRefs(doc: SketchDoc, kind: ConstraintKind, ids: EntityId[]): EntityId[] {
  const ent = (id: EntityId) => doc.entities.find(e => e.id === id)!
  if (kind === 'perpendicular' || kind === 'parallel') {
    // both refs are two LINE entity ids (from the two-lines-selected gate in
    // availableConstraints) — the residual wants 4 POINT refs: each line's
    // anchors, [L1.p1, L1.p2, L2.p1, L2.p2]. Fall back to the raw ids
    // (shouldn't happen given the gate) if either isn't actually a line.
    if (ids.length === 2) {
      const l1 = ent(ids[0]!), l2 = ent(ids[1]!)
      if (l1.kind === 'line' && l2.kind === 'line') return [l1.p1, l1.p2, l2.p1, l2.p2]
    }
    // single selected point that's a line-line path corner (the "Right angle"
    // gate above) — refs are [prev, corner, corner, next] so the shared
    // residual reads it as two segment directions meeting at `corner`.
    if (kind === 'perpendicular' && ids.length === 1) {
      const corner = pathCornerInfo(doc, ids[0]!)
      if (corner) return [corner.prev, corner.corner, corner.corner, corner.next]
    }
    return ids.slice()
  }
  if (kind === 'tangentLineCircle' || kind === 'pointOnLine') {
    // [line|point-then-line]: for tangentLineCircle → [line, circle]; for pointOnLine → [point, line]
    if (kind === 'tangentLineCircle') return ids.slice().sort(a => (ent(a).kind === 'line' ? -1 : 1))
    return ids.slice().sort(a => (ent(a).kind === 'point' ? -1 : 1))
  }
  if (kind === 'pointOnCircle') return ids.slice().sort(a => (ent(a).kind === 'point' ? -1 : 1))
  if (kind === 'midpoint') {
    // 1 point + 1 line selected (the Midpoint gate above) — residual wants
    // [P, lineA, lineB]: the point, then the line's own two anchor ids.
    if (ids.length === 2) {
      const pt = ids.find(id => ent(id).kind === 'point')
      const ln = ids.find(id => ent(id).kind === 'line')
      if (pt && ln) {
        const l = ent(ln) as any
        return [pt, l.p1, l.p2]
      }
    }
    return ids.slice()
  }
  if (kind === 'equalDist' && ids.length === 2) {
    // two LINE entity ids (from the two-lines-selected gate) — the residual
    // wants 4 POINT refs: each line's anchors, [L1.p1, L1.p2, L2.p1, L2.p2].
    const l1 = ent(ids[0]!), l2 = ent(ids[1]!)
    if (l1.kind === 'line' && l2.kind === 'line') return [l1.p1, l1.p2, l2.p1, l2.p2]
    return ids.slice()
  }
  return ids.slice()
}

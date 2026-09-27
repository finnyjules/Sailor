import type { SketchDoc, EntityId, ConstraintKind, LineEntity, CircleEntity, PathEntity, SegmentSpec, SketchFill } from './model'
import { getEntity, getPoint } from './model'
import { freshId } from './ids'
import { fillsWithin, freshFillId, mapSeed, fillAreas, moveAreas, fillCopiedAreas, type FillArea } from './fills'
import { radialAngles, linearFactors, rotateAbout, shiftBy, alongPlacements, type Placement, type Spacing } from './repeatModes'

export function addPoint(doc: SketchDoc, x: number, y: number, opts: { fixed?: boolean; construction?: boolean } = {}): EntityId {
  const id = freshId(doc, 'p')
  doc.entities.push({ id, kind: 'point', x, y, ...(opts.fixed ? { fixed: true } : {}), ...(opts.construction ? { construction: true } : {}) })
  return id
}

export function addLine(doc: SketchDoc, p1: EntityId, p2: EntityId, opts: { construction?: boolean } = {}): EntityId {
  const id = freshId(doc, 'l')
  doc.entities.push({ id, kind: 'line', p1, p2, ...(opts.construction ? { construction: true } : {}) })
  return id
}

export function addCircle(doc: SketchDoc, center: EntityId, r: number, opts: { construction?: boolean } = {}): EntityId {
  const id = freshId(doc, 'c')
  doc.entities.push({ id, kind: 'circle', center, r, ...(opts.construction ? { construction: true } : {}) })
  return id
}

export function addConstraint(doc: SketchDoc, kind: ConstraintKind, refs: EntityId[], value?: number): EntityId {
  const id = freshId(doc, 'k')
  doc.constraints.push({ id, kind, refs: [...refs], ...(value != null ? { value } : {}) })
  return id
}

export function removeConstraint(doc: SketchDoc, id: EntityId): void {
  doc.constraints = doc.constraints.filter(c => c.id !== id)
}

// true if a path references the given point as an anchor, an arc-segment center, or a cubic handle
function pathReferencesPoint(p: PathEntity, pid: EntityId): boolean {
  if (p.anchors.includes(pid)) return true
  for (const s of p.segments) {
    if (s.kind === 'arc' && s.center === pid) return true
    if (s.kind === 'cubic' && (s.h1 === pid || s.h2 === pid)) return true
  }
  return false
}

// every point id a path references (anchors + arc centers + cubic handles), deduped
function pathMemberPoints(p: PathEntity): EntityId[] {
  const out = new Set<EntityId>()
  for (const a of p.anchors) out.add(a)
  for (const s of p.segments) {
    if (s.kind === 'arc') out.add(s.center)
    else if (s.kind === 'cubic') { if (s.h1) out.add(s.h1); if (s.h2) out.add(s.h2) }
  }
  return [...out]
}

// true if a path references the given point as an anchor or an arc-segment center
// (i.e. structurally — losing it must cascade); a cubic h1/h2 reference does not count
function pathReferencesAsAnchorOrArcCenter(p: PathEntity, pid: EntityId): boolean {
  if (p.anchors.includes(pid)) return true
  for (const s of p.segments) {
    if (s.kind === 'arc' && s.center === pid) return true
  }
  return false
}

// is this point still referenced by any entity currently in the doc?
export function isPointReferenced(doc: SketchDoc, pid: EntityId): boolean {
  for (const e of doc.entities) {
    if (e.kind === 'line' && (e.p1 === pid || e.p2 === pid)) return true
    if (e.kind === 'circle' && e.center === pid) return true
    if (e.kind === 'path' && pathReferencesPoint(e, pid)) return true
  }
  return false
}

function refsEqual(a: EntityId[], b: EntityId[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

// is there still a line entity or path line segment running between a and b?
function spansLine(doc: SketchDoc, a: EntityId, b: EntityId): boolean {
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

/** The length rules that belong to a rounded or chamfered corner's side
 *  (a, b) = (far, T): every `distance` or segment `equalDist` naming the far
 *  end and the corner's virtual sharp X, found through the sharp's own tie
 *  `collinear [far, T, X]`. When the side goes (trim, delete) they go too —
 *  left behind they would tie `far` to a hidden guide dot (re-review Minor 1). */
export function sharpSideLengthRules(doc: SketchDoc, a: EntityId, b: EntityId): Set<EntityId> {
  const out = new Set<EntityId>()
  const sharps: [EntityId, EntityId][] = []   // [far, X]
  for (const c of doc.constraints) {
    if (c.kind !== 'collinear' || c.refs.length !== 3) continue
    const [f, t, x] = c.refs as [EntityId, EntityId, EntityId]
    if (!((f === a && t === b) || (f === b && t === a))) continue
    if (getPoint(doc, x)?.construction) sharps.push([f, x])
  }
  if (!sharps.length) return out
  const is = (p: EntityId | undefined, q: EntityId | undefined) => sharps.some(([f, x]) => (p === f && q === x) || (p === x && q === f))
  const centres = new Set<EntityId>()
  for (const e of doc.entities) if (e.kind === 'path') for (const sg of e.segments) if (sg.kind === 'arc') centres.add(sg.center)
  for (const c of doc.constraints) {
    const r = c.refs
    if (c.kind === 'distance' && r.length === 2 && is(r[0], r[1])) out.add(c.id)
    else if (c.kind === 'equalDist' && r.length === 4 && !(r[0] === r[2] && centres.has(r[0]!)) && (is(r[0], r[1]) || is(r[2], r[3]))) out.add(c.id)
  }
  return out
}

const REPEAT_KINDS = new Set<ConstraintKind>(['rotatedFrom', 'mirroredFrom', 'translatedFrom'])

// Guide points tied by rules to `seeds` (and through them to further guide
// points): the virtual sharps a round or chamfer leaves. A point a Repeat
// rule names (a radial centre, a linear guide end) is never one.
function tiedGuides(doc: SketchDoc, seeds: readonly EntityId[]): Set<EntityId> {
  const repeat = new Set<EntityId>()
  for (const c of doc.constraints) if (REPEAT_KINDS.has(c.kind)) for (const r of c.refs) repeat.add(r)
  const out = new Set<EntityId>()
  const reach = new Set(seeds)
  for (let grew = true; grew;) {
    grew = false
    for (const c of doc.constraints) {
      if (!c.refs.some(r => reach.has(r))) continue
      for (const r of c.refs) {
        if (reach.has(r) || repeat.has(r)) continue
        const p = getPoint(doc, r)
        if (!p?.construction || p.fixed) continue
        out.add(r); reach.add(r); grew = true
      }
    }
  }
  return out
}

// After a delete (final review I4): the guide points `cands` that no piece
// uses and no rule ties to anything but each other go, with those ties.
function dropLooseGuides(doc: SketchDoc, cands: ReadonlySet<EntityId>): void {
  const loose = new Set([...cands].filter(id => !!getPoint(doc, id) && !isPointReferenced(doc, id)))
  for (let shrank = true; shrank;) {
    shrank = false
    for (const id of loose) {
      if (doc.constraints.every(c => !c.refs.includes(id) || c.refs.every(r => loose.has(r)))) continue
      loose.delete(id); shrank = true
    }
  }
  if (!loose.size) return
  doc.constraints = doc.constraints.filter(c => !c.refs.some(r => loose.has(r)))
  doc.entities = doc.entities.filter(e => !loose.has(e.id))
}

// the linear guide lines (construction lines between a translatedFrom rule's
// `from` and `to`) no translatedFrom names any more go, with their free ends —
// deleting every linear copy (or their source) takes the dashed guide too
function dropUnusedLinearGuides(doc: SketchDoc, pairs: ReadonlyArray<readonly [EntityId, EntityId]>): void {
  for (const [f, t] of pairs) {
    if (doc.constraints.some(c => c.kind === 'translatedFrom' && c.refs[2] === f && c.refs[3] === t)) continue
    const g = doc.entities.find(e => e.kind === 'line' && e.construction && ((e.p1 === f && e.p2 === t) || (e.p1 === t && e.p2 === f)))
    if (g) deleteEntity(doc, g.id)
  }
}

// Delete an entity and everything that structurally depends on it.
/** `keepGuideEnds`: a guide line's ends stay even when nothing else uses them
 *  (mergePoints dropping a line squeezed to one point must not take the point). */
export function deleteEntity(doc: SketchDoc, id: EntityId, opts: { keepGuideEnds?: boolean } = {}): void {
  const e = getEntity(doc, id)
  if (!e) return
  const linearPairs = [...new Map(doc.constraints.filter(c => c.kind === 'translatedFrom' && c.refs.length === 4)
    .map(c => [`${c.refs[2]}|${c.refs[3]}`, [c.refs[2]!, c.refs[3]!] as const])).values()]
  // entities that reference this one and must go too (only points have dependents)
  const dependents: EntityId[] = []
  if (e.kind === 'point') {
    for (const other of doc.entities) {
      if (other.kind === 'line' && (other.p1 === id || other.p2 === id)) dependents.push(other.id)
      else if (other.kind === 'circle' && other.center === id) dependents.push(other.id)
      else if (other.kind === 'path') {
        if (pathReferencesAsAnchorOrArcCenter(other, id)) {
          dependents.push(other.id)
        } else if (pathReferencesPoint(other, id)) {
          // referenced only as a cubic h1/h2 handle — demote to a cusp instead of
          // cascading the whole path; the collinear rule (if any) dies below via
          // the dangling-refs filter since it references this point's id
          for (const s of other.segments) {
            if (s.kind !== 'cubic') continue
            if (s.h1 === id) s.h1 = null
            if (s.h2 === id) s.h2 = null
          }
        }
      }
    }
  }
  // capture path-specific info before the entity is removed
  let arcEqualDistRefs: EntityId[][] = []
  let memberPoints: EntityId[] = []
  let guides = new Set<EntityId>()
  if (e.kind === 'path') {
    memberPoints = pathMemberPoints(e)
    guides = tiedGuides(doc, memberPoints)
    e.segments.forEach((s, i) => {
      if (s.kind === 'arc') {
        const a = e.anchors[i]!
        const b = e.anchors[(i + 1) % e.anchors.length]!
        arcEqualDistRefs.push([s.center, a, s.center, b])
      }
    })
  }
  // a straight side of a rounded / chamfered corner: its lengths on the sharp
  // go with the last piece between its ends (checked once it is gone)
  const sides: [EntityId, EntityId][] = []
  if (e.kind === 'line') sides.push([e.p1, e.p2])
  else if (e.kind === 'path') e.segments.forEach((s, i) => { if (s.kind === 'line') sides.push([e.anchors[i]!, e.anchors[(i + 1) % e.anchors.length]!]) })
  const sideLengths = sides.map(([a, b]) => ({ a, b, ids: sharpSideLengthRules(doc, a, b) })).filter(x => x.ids.size)
  // remove this entity
  doc.entities = doc.entities.filter(x => x.id !== id)
  // drop constraints that reference the removed entity
  doc.constraints = doc.constraints.filter(c => !c.refs.includes(id))
  for (const { a, b, ids } of sideLengths) {
    if (!spansLine(doc, a, b)) doc.constraints = doc.constraints.filter(c => !ids.has(c.id))
  }
  if (e.kind === 'line' && !spansLine(doc, e.p1, e.p2)) {
    // a tangent or offset line names its ends, not its id: it goes with the last piece between them
    doc.constraints = doc.constraints.filter(c => !((c.kind === 'tangentLineArc' || c.kind === 'offsetLine') &&
      ((c.refs[0] === e.p1 && c.refs[1] === e.p2) || (c.refs[0] === e.p2 && c.refs[1] === e.p1))))
  }
  if (e.kind === 'line' && e.construction && !opts.keepGuideEnds) {
    // a guide line's own guide ends go with it when nothing else uses them — a
    // rule tying only its two ends (a Clean up axis's Vertical / Horizontal)
    // goes too; an end another piece or rule still uses stays
    const ends = new Set([e.p1, e.p2])
    const onlyEnds = (c: { refs: EntityId[] }) => c.refs.every(r => ends.has(r))
    for (const pid of ends) {
      const p = getPoint(doc, pid)
      if (!p || !p.construction || p.fixed || isPointReferenced(doc, pid)) continue
      if (doc.constraints.some(c => c.refs.includes(pid) && !onlyEnds(c))) continue
      doc.constraints = doc.constraints.filter(c => !(c.refs.includes(pid) && onlyEnds(c)))
      deleteEntity(doc, pid)
    }
  }
  if (e.kind === 'path') {
    // drop this path's auto equalDist rules (their refs don't include the path's own id)
    doc.constraints = doc.constraints.filter(c => !(c.kind === 'equalDist' && arcEqualDistRefs.some(refs => refsEqual(refs, c.refs))))
    // tangent / offset lines that named one of its straight pieces go with the last piece between those ends
    e.segments.forEach((s, i) => {
      if (s.kind !== 'line') return
      const a = e.anchors[i]!, b = e.anchors[(i + 1) % e.anchors.length]!
      if (spansLine(doc, a, b)) return
      doc.constraints = doc.constraints.filter(c => !((c.kind === 'tangentLineArc' || c.kind === 'offsetLine') &&
        ((c.refs[0] === a && c.refs[1] === b) || (c.refs[0] === b && c.refs[1] === a))))
    })
    // orphan-clean: points this path exclusively owned, now unreferenced and not fixed
    for (const pid of memberPoints) {
      const p = getPoint(doc, pid)
      if (!p || p.fixed) continue
      if (!isPointReferenced(doc, pid)) deleteEntity(doc, pid)
    }
    dropLooseGuides(doc, guides)
  }
  // recurse into dependents
  for (const depId of dependents) deleteEntity(doc, depId)
  if (linearPairs.length) dropUnusedLinearGuides(doc, linearPairs)
}

export function addPath(doc: SketchDoc, anchors: EntityId[], segments: SegmentSpec[], closed = false, opts: { construction?: boolean } = {}): EntityId {
  const need = closed ? anchors.length : anchors.length - 1
  if (anchors.length < 2 || segments.length !== need) return ''
  const id = freshId(doc, 'P')
  doc.entities.push({ id, kind: 'path', anchors: [...anchors], segments: segments.map(s => ({ ...s })), closed, ...(opts.construction ? { construction: true } : {}) })
  // arcs stay true circular arcs: both ends equidistant from the center
  segments.forEach((s, i) => {
    if (s.kind === 'arc') {
      const a = anchors[i]!
      const b = anchors[(i + 1) % anchors.length]!
      addConstraint(doc, 'equalDist', [s.center, a, s.center, b])
    }
  })
  return id
}

// point ids referenced by an entity (itself if a point), with no existence filtering
function rawPointRefs(doc: SketchDoc, ids: EntityId[]): EntityId[] {
  const out = new Set<EntityId>()
  for (const id of ids) {
    const e = getEntity(doc, id)
    if (!e) continue
    if (e.kind === 'point') out.add(e.id)
    else if (e.kind === 'line') { out.add(e.p1); out.add(e.p2) }
    else if (e.kind === 'circle') out.add(e.center)
    else if (e.kind === 'path') {
      for (const a of e.anchors) out.add(a)
      for (const s of e.segments) {
        if (s.kind === 'arc') out.add(s.center)
        else if (s.kind === 'cubic') { if (s.h1) out.add(s.h1); if (s.h2) out.add(s.h2) }
      }
    }
  }
  return [...out]
}

// all point ids referenced by an entity closure (itself if a point); skips ids that don't resolve to a point
export function pointClosure(doc: SketchDoc, ids: EntityId[]): EntityId[] {
  return rawPointRefs(doc, ids).filter(pid => !!getPoint(doc, pid))
}

// copy the selected non-point entities with point ids remapped; returns created ids.
// `ents` (pen stage 7): records each copied circle's new id, for its fills
function copyStructure(doc: SketchDoc, ids: EntityId[], map: Map<EntityId, EntityId>, flipSweep: boolean, ents?: Map<EntityId, EntityId>): EntityId[] {
  const created: EntityId[] = []
  for (const id of ids) {
    const e = getEntity(doc, id)
    if (!e || e.kind === 'point') continue
    if (e.kind === 'line') created.push(addLine(doc, map.get(e.p1)!, map.get(e.p2)!, e.construction ? { construction: true } : {}))
    else if (e.kind === 'circle') { const nc = addCircle(doc, map.get(e.center)!, e.r, e.construction ? { construction: true } : {}); ents?.set(e.id, nc); created.push(nc) }
    else if (e.kind === 'path') {
      const segs: SegmentSpec[] = e.segments.map(s =>
        s.kind === 'arc' ? { kind: 'arc', center: map.get(s.center)!, sweep: (flipSweep ? (1 - s.sweep) as 0 | 1 : s.sweep) }
        : s.kind === 'cubic' ? { kind: 'cubic', h1: s.h1 ? map.get(s.h1)! : null, h2: s.h2 ? map.get(s.h2)! : null }
        : { kind: 'line' })
      // addPath would re-add equalDist for arcs; constraints are copied separately below,
      // so push the raw path entity instead:
      const pid = freshId(doc, 'P')
      doc.entities.push({ id: pid, kind: 'path', anchors: e.anchors.map(a => map.get(a)!), segments: segs, closed: e.closed, ...(e.construction ? { construction: true } : {}) })
      created.push(pid)
    }
  }
  return created
}

// pen stage 7: a source id's copy (points by `map`, circles by `ents`)
const copiedId = (map: Map<EntityId, EntityId>, ents: Map<EntityId, EntityId>) => (id: EntityId) => map.get(id) ?? ents.get(id) ?? id

// pen stage 7: the fills a copy carries, re-seeded onto it
function copyFills(doc: SketchDoc, fills: SketchFill[], map: Map<EntityId, EntityId>, ents: Map<EntityId, EntityId>, how: { mirror?: number; turn?: number }): void {
  if (!fills.length) return
  const m = copiedId(map, ents)
  for (const f of fills) {
    const list = doc.fills ?? (doc.fills = [])
    list.push({ id: freshFillId(doc), seed: mapSeed(f.seed, m, how) })
  }
}

// constraints fully inside the closure get copied with mapped refs
function copyClosureConstraints(doc: SketchDoc, map: Map<EntityId, EntityId>, mirrored = false): void {
  const source = new Set(map.keys())
  for (const c of [...doc.constraints]) {
    if (c.refs.length > 0 && c.refs.every(r => source.has(r))) {
      // a mirror copy's left is the original's right (Ruling 19)
      const value = mirrored && c.kind === 'offsetLine' && c.value != null ? -c.value : c.value
      addConstraint(doc, c.kind, c.refs.map(r => map.get(r)!), value)
    }
  }
}

/** The copy loop shared by radial, linear and along-a-path Repeat (pen
 *  stage 8, fix round 1): for each placement, every point of the closure `pts`
 *  is made by `makePoint` at its placed position (returning the source id
 *  itself shares that point, e.g. a radial centre), then the pieces, the inner
 *  rules and the carried fills are copied, and the copied filled areas moved
 *  by the same placement. The caller has already checked that `pts` resolve. */
function placeCopies(
  doc: SketchDoc, ids: EntityId[], pts: EntityId[], placements: readonly Placement[],
  makePoint: (pid: EntityId, q: { x: number; y: number }, k: number) => EntityId,
  how: (k: number) => { turn?: number } = () => ({}),
): EntityId[][] {
  // pen stage 7: the source's fills whose whole area this copies (read before any copy exists)
  const carried = fillsWithin(doc, new Set([...pts, ...ids]), ids.flatMap(id => getEntity(doc, id) ?? []))
  const srcAreas = fillAreas(doc, carried, p => p)
  const areas: FillArea[] = []
  const all: EntityId[][] = []
  placements.forEach((place, k) => {
    const map = new Map<EntityId, EntityId>()
    const created: EntityId[] = []
    for (const pid of pts) {
      const nid = makePoint(pid, place(getPoint(doc, pid)!), k)
      map.set(pid, nid)
      if (nid !== pid) created.push(nid)
    }
    const ents = new Map<EntityId, EntityId>()
    created.push(...copyStructure(doc, ids, map, false, ents))
    copyClosureConstraints(doc, map)
    const seedHow = how(k)
    copyFills(doc, carried, map, ents, seedHow)
    areas.push(...moveAreas(srcAreas, place, sd => mapSeed(sd, copiedId(map, ents), seedHow)))
    all.push(created)
  })
  // copies landing over their neighbours are cut into several areas: fill
  // every one inside a copied filled area
  fillCopiedAreas(doc, areas)
  return all
}

/** Radial repeat: copies k = 1…count−1 turned about `center` by
 *  radialAngles(count, sweep) (pen stage 8, Ruling 13 — the default sweep is
 *  the full turn, exactly as before), each point tied by rotatedFrom. */
export function repeatEntities(doc: SketchDoc, ids: EntityId[], center: EntityId, count: number, sweep = 360): EntityId[][] {
  const angles = radialAngles(count, sweep)
  if (!angles.length) return []
  const ce = getPoint(doc, center)
  if (!ce) return []
  // check the full closure resolves before creating anything
  const pts = rawPointRefs(doc, ids)
  if (!pts.every(pid => !!getPoint(doc, pid))) return []
  return placeCopies(doc, ids, pts, angles.map(angle => rotateAbout(ce, angle)), (pid, q, k) => {
    // the rotation center, if itself part of the closure, is shared across copies
    if (pid === center) return pid
    const nid = addPoint(doc, q.x, q.y)
    addConstraint(doc, 'rotatedFrom', [nid, pid, center], angles[k])
    return nid
  }, k => ({ turn: angles[k]! * Math.PI / 180 }))
}

/** Linear repeat (pen stage 8, Ruling 14): copies k = 1…count−1 at
 *  orig + f·(to − from), f = k (Step) or k/(count−1) (Span), each point tied
 *  by translatedFrom [copy, orig, from, to] value f. [] when nothing can be made. */
export function translateEntities(doc: SketchDoc, ids: EntityId[], from: EntityId, to: EntityId, count: number, spacing: Spacing): EntityId[][] {
  const factors = linearFactors(count, spacing)
  const F = getPoint(doc, from), T = getPoint(doc, to)
  if (!factors.length || !F || !T || from === to) return []
  const pts = rawPointRefs(doc, ids)
  if (!pts.every(pid => !!getPoint(doc, pid)) || pts.includes(from) || pts.includes(to)) return []
  const vec = { x: T.x - F.x, y: T.y - F.y }
  return placeCopies(doc, ids, pts, factors.map(f => shiftBy(vec, f)), (pid, q, k) => {
    const nid = addPoint(doc, q.x, q.y)
    addConstraint(doc, 'translatedFrom', [nid, pid, from, to], factors[k])
    return nid
  })
}

/** Along a path (pen stage 8, Ruling 15): count − 1 copies moved so the
 *  selection's drawn centre lands on points spread evenly along `along`
 *  (alongPlacements); not tied to the original. [] for a Bézier path, a path
 *  being repeated, a bad count. */
export function copyAlongPath(doc: SketchDoc, ids: EntityId[], along: EntityId, count: number): EntityId[][] {
  const placements = alongPlacements(doc, ids, along, count)
  if (!placements) return []
  const pts = rawPointRefs(doc, ids)
  if (!pts.every(pid => !!getPoint(doc, pid))) return []
  return placeCopies(doc, ids, pts, placements, (pid, q) =>
    addPoint(doc, q.x, q.y, getPoint(doc, pid)!.fixed ? { fixed: true } : {}))
}

export function addSmoothHandles(doc: SketchDoc, anchor: EntityId, hx: number, hy: number): { hOut: EntityId; hIn: EntityId } {
  const a = getPoint(doc, anchor)!
  const hOut = addPoint(doc, hx, hy, { construction: true })
  const hIn = addPoint(doc, 2 * a.x - hx, 2 * a.y - hy, { construction: true })
  addConstraint(doc, 'collinear', [hIn, anchor, hOut])
  return { hOut, hIn }
}

export function setAnchorSmooth(doc: SketchDoc, pathId: EntityId, anchorIndex: number): boolean {
  const p = getEntity(doc, pathId)
  if (!p || p.kind !== 'path') return false
  const n = p.anchors.length
  const segCount = p.closed ? n : n - 1
  const inSeg = p.closed ? (anchorIndex - 1 + segCount) % segCount : anchorIndex - 1
  const outSeg = anchorIndex
  if (inSeg < 0 || inSeg >= segCount || outSeg >= segCount) return false  // endpoint of an open path
  const anchor = getPoint(doc, p.anchors[anchorIndex]!)
  if (!anchor) return false

  const third = (fromId: EntityId, toId: EntityId) => {
    const f = getPoint(doc, fromId)!, t = getPoint(doc, toId)!
    return { x: f.x + (t.x - f.x) / 3, y: f.y + (t.y - f.y) / 3 }
  }
  const upgrade = (si: number): void => {
    const s = p.segments[si]!
    if (s.kind !== 'cubic') p.segments[si] = { kind: 'cubic', h1: null, h2: null }
  }
  upgrade(inSeg); upgrade(outSeg)
  const sIn = p.segments[inSeg]! as { kind: 'cubic'; h1: EntityId | null; h2: EntityId | null }
  const sOut = p.segments[outSeg]! as { kind: 'cubic'; h1: EntityId | null; h2: EntityId | null }

  if (!sIn.h2) {
    const prev = p.anchors[inSeg]!  // start anchor of the incoming segment
    const pos = third(p.anchors[anchorIndex]!, prev)
    sIn.h2 = addPoint(doc, pos.x, pos.y, { construction: true })
  }
  if (!sOut.h1) {
    const next = p.anchors[(anchorIndex + 1) % n]!
    const pos = third(p.anchors[anchorIndex]!, next)
    sOut.h1 = addPoint(doc, pos.x, pos.y, { construction: true })
  }
  const already = doc.constraints.some(c => c.kind === 'collinear' && c.refs[1] === p.anchors[anchorIndex])
  if (!already) addConstraint(doc, 'collinear', [sIn.h2, p.anchors[anchorIndex]!, sOut.h1])
  return true
}

export function mirrorEntities(doc: SketchDoc, ids: EntityId[], axisLine: EntityId): EntityId[] {
  const ax = getEntity(doc, axisLine)
  if (!ax || ax.kind !== 'line') return []
  const a = getPoint(doc, ax.p1); const b = getPoint(doc, ax.p2)
  if (!a || !b) return []
  const dirx = b.x - a.x, diry = b.y - a.y
  const L = Math.hypot(dirx, diry)
  if (L < 1e-12) return []
  const nx = -diry / L, ny = dirx / L
  // check the full closure resolves before creating anything
  const pts = rawPointRefs(doc, ids)
  if (!pts.every(pid => !!getPoint(doc, pid))) return []
  // pen stage 7: the source's fills whose whole area this copies (read before any copy exists)
  const carried = fillsWithin(doc, new Set([...pts, ...ids]), ids.flatMap(id => getEntity(doc, id) ?? []))
  const srcAreas = fillAreas(doc, carried, p => p)
  const map = new Map<EntityId, EntityId>()
  const created: EntityId[] = []
  for (const pid of pts) {
    const p = getPoint(doc, pid)!
    const s = (p.x - a.x) * nx + (p.y - a.y) * ny
    const nid = addPoint(doc, p.x - 2 * s * nx, p.y - 2 * s * ny)
    map.set(pid, nid)
    created.push(nid)
    addConstraint(doc, 'mirroredFrom', [nid, pid, axisLine])
  }
  const ents = new Map<EntityId, EntityId>()
  created.push(...copyStructure(doc, ids, map, true, ents))
  copyClosureConstraints(doc, map, true)
  copyFills(doc, carried, map, ents, { mirror: Math.atan2(diry, dirx) })
  fillCopiedAreas(doc, moveAreas(srcAreas, p => { const s = (p.x - a.x) * nx + (p.y - a.y) * ny; return { x: p.x - 2 * s * nx, y: p.y - 2 * s * ny } }, sd => mapSeed(sd, copiedId(map, ents), { mirror: Math.atan2(diry, dirx) })))
  return created
}

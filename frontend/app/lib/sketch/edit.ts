import type { SketchDoc, EntityId, ConstraintKind, LineEntity, CircleEntity, PathEntity, SegmentSpec } from './model'
import { getEntity, getPoint } from './model'
import { freshId } from './ids'

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

// Delete an entity and everything that structurally depends on it.
export function deleteEntity(doc: SketchDoc, id: EntityId): void {
  const e = getEntity(doc, id)
  if (!e) return
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
  if (e.kind === 'path') {
    memberPoints = pathMemberPoints(e)
    e.segments.forEach((s, i) => {
      if (s.kind === 'arc') {
        const a = e.anchors[i]!
        const b = e.anchors[(i + 1) % e.anchors.length]!
        arcEqualDistRefs.push([s.center, a, s.center, b])
      }
    })
  }
  // remove this entity
  doc.entities = doc.entities.filter(x => x.id !== id)
  // drop constraints that reference the removed entity
  doc.constraints = doc.constraints.filter(c => !c.refs.includes(id))
  if (e.kind === 'line' && !spansLine(doc, e.p1, e.p2)) {
    // a tangent line names its ends, not its id: it goes with the last piece between them
    doc.constraints = doc.constraints.filter(c => !(c.kind === 'tangentLineArc' &&
      ((c.refs[0] === e.p1 && c.refs[1] === e.p2) || (c.refs[0] === e.p2 && c.refs[1] === e.p1))))
  }
  if (e.kind === 'line' && e.construction) {
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
    // orphan-clean: points this path exclusively owned, now unreferenced and not fixed
    for (const pid of memberPoints) {
      const p = getPoint(doc, pid)
      if (!p || p.fixed) continue
      if (!isPointReferenced(doc, pid)) deleteEntity(doc, pid)
    }
  }
  // recurse into dependents
  for (const depId of dependents) deleteEntity(doc, depId)
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

// copy the selected non-point entities with point ids remapped; returns created ids
function copyStructure(doc: SketchDoc, ids: EntityId[], map: Map<EntityId, EntityId>, flipSweep: boolean): EntityId[] {
  const created: EntityId[] = []
  for (const id of ids) {
    const e = getEntity(doc, id)
    if (!e || e.kind === 'point') continue
    if (e.kind === 'line') created.push(addLine(doc, map.get(e.p1)!, map.get(e.p2)!, e.construction ? { construction: true } : {}))
    else if (e.kind === 'circle') created.push(addCircle(doc, map.get(e.center)!, e.r, e.construction ? { construction: true } : {}))
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

// constraints fully inside the closure get copied with mapped refs
function copyClosureConstraints(doc: SketchDoc, map: Map<EntityId, EntityId>): void {
  const source = new Set(map.keys())
  for (const c of [...doc.constraints]) {
    if (c.refs.length > 0 && c.refs.every(r => source.has(r))) {
      addConstraint(doc, c.kind, c.refs.map(r => map.get(r)!), c.value)
    }
  }
}

export function repeatEntities(doc: SketchDoc, ids: EntityId[], center: EntityId, count: number): EntityId[][] {
  count = Math.round(count)
  if (count < 2 || count > 64) return []
  const ce = getPoint(doc, center)
  if (!ce) return []
  // check the full closure resolves before creating anything
  const pts = rawPointRefs(doc, ids)
  if (!pts.every(pid => !!getPoint(doc, pid))) return []
  const all: EntityId[][] = []
  for (let k = 1; k < count; k++) {
    const angle = k * (360 / count)
    const rad = angle * Math.PI / 180
    const co = Math.cos(rad), si = Math.sin(rad)
    const map = new Map<EntityId, EntityId>()
    const created: EntityId[] = []
    for (const pid of pts) {
      // the rotation center, if itself part of the closure, is shared across copies
      if (pid === center) { map.set(pid, pid); continue }
      const p = getPoint(doc, pid)!
      const dx = p.x - ce.x, dy = p.y - ce.y
      const nid = addPoint(doc, ce.x + co * dx - si * dy, ce.y + si * dx + co * dy)
      map.set(pid, nid)
      created.push(nid)
      addConstraint(doc, 'rotatedFrom', [nid, pid, center], angle)
    }
    created.push(...copyStructure(doc, ids, map, false))
    copyClosureConstraints(doc, map)
    all.push(created)
  }
  return all
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
  created.push(...copyStructure(doc, ids, map, true))
  copyClosureConstraints(doc, map)
  return created
}

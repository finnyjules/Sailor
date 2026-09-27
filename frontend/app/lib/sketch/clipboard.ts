// app/lib/sketch/clipboard.ts
// Pen stage 6, Copy / Paste inside the pen: the selected pieces with their
// points and the rules among them go out as a drawing of their own
// (extractPieces), and come back in with fresh ids, moved, and every ref
// re-pointed (insertPieces) — so a pasted rule never ties back to the
// original, and stage-3 editing handles pasted pieces like any others. Pure.
import type { SketchDoc, SketchEntity, EntityId, PathEntity } from './model'
import { getEntity } from './model'
import type { Vec2 } from './geom'
import { pointClosure, addConstraint } from './edit'
import { freshId } from './ids'
import { segCount, type SegPick } from './pieces'

function copyEntity(e: SketchEntity): SketchEntity {
  if (e.kind === 'path') return { ...e, anchors: [...e.anchors], segments: e.segments.map(s => ({ ...s })) }
  return { ...e }
}

/** The selection as a drawing of its own (Ruling 9). */
export function extractPieces(doc: SketchDoc, ids: readonly EntityId[], segs: readonly SegPick[]): SketchDoc {
  const keep = new Set<EntityId>(pointClosure(doc, [...ids]))
  for (const id of ids) {
    const e = getEntity(doc, id)
    if (e && e.kind !== 'point') keep.add(id)
  }
  const segPaths: PathEntity[] = []
  for (const s of segs) {
    const p = getEntity(doc, s.pathId)
    if (!p || p.kind !== 'path' || keep.has(p.id) || s.segIndex < 0 || s.segIndex >= segCount(p)) continue
    const seg = p.segments[s.segIndex]!
    const a = p.anchors[s.segIndex]!, b = p.anchors[(s.segIndex + 1) % p.anchors.length]!
    keep.add(a); keep.add(b)
    if (seg.kind === 'arc') keep.add(seg.center)
    if (seg.kind === 'cubic') { if (seg.h1) keep.add(seg.h1); if (seg.h2) keep.add(seg.h2) }
    segPaths.push({ id: `${p.id}~${s.segIndex}`, kind: 'path', anchors: [a, b], segments: [{ ...seg }], closed: false, ...(p.construction ? { construction: true } : {}) })
  }
  const out: SketchDoc = { entities: [], constraints: [] }
  for (const e of doc.entities) if (keep.has(e.id)) out.entities.push(copyEntity(e))
  out.entities.push(...segPaths)
  const have = new Set(out.entities.map(e => e.id))
  for (const c of doc.constraints) {
    if (c.refs.length && c.refs.every(r => have.has(r))) out.constraints.push({ ...c, refs: [...c.refs] })
  }
  return out
}

const PREFIX: Record<SketchEntity['kind'], string> = { point: 'p', line: 'l', circle: 'c', path: 'P' }

/** Adds the copy with fresh ids, moved by `offset`; every ref re-pointed. */
export function insertPieces(doc: SketchDoc, clip: SketchDoc, offset: Vec2): { created: EntityId[]; top: EntityId[] } {
  const map = new Map<EntityId, EntityId>()
  const added: SketchEntity[] = []
  // ids first (each pushed at once, so freshId never hands out one twice) …
  for (const e of clip.entities) {
    const copy = copyEntity(e)
    copy.id = freshId(doc, PREFIX[e.kind])
    map.set(e.id, copy.id)
    doc.entities.push(copy)
    added.push(copy)
  }
  // … then every ref, whatever order the copy's entities came in
  const m = (x: EntityId) => map.get(x) ?? x
  for (const e of added) {
    if (e.kind === 'point') { e.x += offset.x; e.y += offset.y }
    else if (e.kind === 'line') { e.p1 = m(e.p1); e.p2 = m(e.p2) }
    else if (e.kind === 'circle') e.center = m(e.center)
    else {
      e.anchors = e.anchors.map(m)
      e.segments = e.segments.map(s =>
        s.kind === 'arc' ? { ...s, center: m(s.center) }
        : s.kind === 'cubic' ? { ...s, h1: s.h1 ? m(s.h1) : null, h2: s.h2 ? m(s.h2) : null }
        : { ...s })
    }
  }
  for (const c of clip.constraints) addConstraint(doc, c.kind, c.refs.map(m), c.value)
  const used = new Set<EntityId>()
  for (const e of added) {
    if (e.kind === 'line') { used.add(e.p1); used.add(e.p2) }
    else if (e.kind === 'circle') used.add(e.center)
    else if (e.kind === 'path') {
      for (const a of e.anchors) used.add(a)
      for (const s of e.segments) {
        if (s.kind === 'arc') used.add(s.center)
        else if (s.kind === 'cubic') { if (s.h1) used.add(s.h1); if (s.h2) used.add(s.h2) }
      }
    }
  }
  return {
    created: added.map(e => e.id),
    top: added.filter(e => e.kind !== 'point' || !used.has(e.id)).map(e => e.id),
  }
}

/** The middle of the copy's bounding box (circles by their full extent). */
export function piecesCentre(clip: SketchDoc): Vec2 {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const grow = (x: number, y: number, r = 0) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r) }
  const pts = new Map(clip.entities.filter(e => e.kind === 'point').map(e => [e.id, e as { x: number; y: number }]))
  for (const p of pts.values()) grow(p.x, p.y)
  for (const e of clip.entities) {
    if (e.kind === 'circle') { const c = pts.get(e.center); if (c) grow(c.x, c.y, e.r) }
  }
  return Number.isFinite(x0) ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } : { x: 0, y: 0 }
}

/** A circle or a closed path — what an open-only pen can't take. */
export function hasClosedPieces(clip: SketchDoc): boolean {
  return clip.entities.some(e => e.kind === 'circle' || (e.kind === 'path' && e.closed))
}

/** The copy resized about its middle by `factor`, and turned upside down
 *  (about the same middle) when `flipY` — how a copy keeps its on-screen size
 *  and look in a pen that draws in other units, or with y the other way up.
 *  Lengths held by rules (distance, radius) scale with it; an upside-down
 *  copy runs its arcs and its Repeat turns the other way. A new drawing. */
export function scalePieces(clip: SketchDoc, factor: number, flipY = false): SketchDoc {
  const ctr = piecesCentre(clip)
  const fy = flipY ? -factor : factor
  const entities = clip.entities.map(e => {
    const c = copyEntity(e)
    if (c.kind === 'point') { c.x = ctr.x + (c.x - ctr.x) * factor; c.y = ctr.y + (c.y - ctr.y) * fy }
    else if (c.kind === 'circle') c.r *= factor
    else if (c.kind === 'path' && flipY) c.segments = c.segments.map(s => (s.kind === 'arc' ? { ...s, sweep: s.sweep === 1 ? 0 : 1 } : s))
    return c
  })
  const constraints = clip.constraints.map(k => {
    const c = { ...k, refs: [...k.refs] }
    if (c.value != null && (c.kind === 'distance' || c.kind === 'radius')) c.value *= factor
    else if (c.value != null && flipY && c.kind === 'rotatedFrom') c.value = -c.value
    return c
  })
  return { entities, constraints }
}

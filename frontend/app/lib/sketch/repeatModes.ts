// app/lib/sketch/repeatModes.ts
// Pen stage 8, Repeat's modes: where the copies go (radial angles, linear
// factors, points along a path) as placements shared by the real copies
// (edit.ts) and the panel's preview — which draws the source pieces moved,
// never building a copy (Global Constraints: speed). Pure; imports nothing
// from edit.ts (edit.ts imports this).
import type { SketchDoc, EntityId, SketchEntity, PointEntity } from './model'
import { getEntity, getPoint } from './model'
import type { Vec2 } from './geom'
import { sketchPathData } from './sketchPath'

export type Placement = (p: Vec2) => Vec2
export type Spacing = 'step' | 'span'
const TAU = Math.PI * 2
const MAX = 64

const count2 = (count: number) => { const n = Math.round(count); return n >= 2 && n <= MAX ? n : 0 }

/** Copy k's angle in degrees, k = 1…count−1 (Ruling 13). */
export function radialAngles(count: number, sweep = 360): number[] {
  const n = count2(count)
  if (!n || !(sweep > 0)) return []
  // the full turn keeps today's arithmetic exactly: k · (360 / count)
  const step = sweep >= 360 - 1e-9 ? 360 / n : sweep / (n - 1)
  return Array.from({ length: n - 1 }, (_, i) => (i + 1) * step)
}
/** Copy k's factor on the guide, k = 1…count−1 (Ruling 14). */
export function linearFactors(count: number, spacing: Spacing): number[] {
  const n = count2(count)
  return n ? Array.from({ length: n - 1 }, (_, i) => (spacing === 'step' ? i + 1 : (i + 1) / (n - 1))) : []
}
/** Turn about c by `deg` — the arithmetic repeatEntities' copies use. */
export function rotateAbout(c: Vec2, deg: number): Placement {
  const r = deg * Math.PI / 180, co = Math.cos(r), si = Math.sin(r)
  return p => { const dx = p.x - c.x, dy = p.y - c.y; return { x: c.x + co * dx - si * dy, y: c.y + si * dx + co * dy } }
}
/** Move by k·v — the arithmetic translateEntities' copies use. */
export function shiftBy(v: Vec2, k: number): Placement {
  return p => ({ x: p.x + k * v.x, y: p.y + k * v.y })
}

// every point id the ids stand for (edit.ts rawPointRefs, kept here so this
// module never imports edit.ts); same order as rawPointRefs
function closure(doc: SketchDoc, ids: readonly EntityId[]): EntityId[] {
  const out = new Set<EntityId>()
  for (const id of ids) {
    const e = getEntity(doc, id)
    if (!e) continue
    if (e.kind === 'point') out.add(e.id)
    else if (e.kind === 'line') { out.add(e.p1); out.add(e.p2) }
    else if (e.kind === 'circle') out.add(e.center)
    else {
      for (const a of e.anchors) out.add(a)
      for (const s of e.segments) {
        if (s.kind === 'arc') out.add(s.center)
        else if (s.kind === 'cubic') { if (s.h1) out.add(s.h1); if (s.h2) out.add(s.h2) }
      }
    }
  }
  return [...out].filter(id => !!getPoint(doc, id))
}

/** The middle of the box round the selection's points (a circle by its full extent). */
export function selectionCentre(doc: SketchDoc, ids: readonly EntityId[]): Vec2 | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const grow = (x: number, y: number, r = 0) => { x0 = Math.min(x0, x - r); y0 = Math.min(y0, y - r); x1 = Math.max(x1, x + r); y1 = Math.max(y1, y + r) }
  for (const id of closure(doc, ids)) { const p = getPoint(doc, id)!; grow(p.x, p.y) }
  for (const id of ids) {
    const e = getEntity(doc, id)
    if (e?.kind === 'circle') { const c = getPoint(doc, e.center); if (c) grow(c.x, c.y, e.r) }
  }
  return Number.isFinite(x0) ? { x: (x0 + x1) / 2, y: (y0 + y1) / 2 } : null
}

export interface PathWalk { length: number; closed: boolean; at(s: number): Vec2 }
type Leg = { kind: 'line'; a: Vec2; b: Vec2; len: number } | { kind: 'arc'; c: Vec2; r: number; a0: number; sweep: number; len: number }

/** A path, a line or a circle walked by length (a circle from angle 0,
 *  counter-clockwise). Null for a Bézier piece, a missing id or no length. */
export function pathWalk(doc: SketchDoc, id: EntityId): PathWalk | null {
  const e = getEntity(doc, id)
  const P = (pid: EntityId): Vec2 | null => { const p = getPoint(doc, pid); return p ? { x: p.x, y: p.y } : null }
  const legs: Leg[] = []
  let closed = false
  if (e?.kind === 'line') {
    const a = P(e.p1), b = P(e.p2)
    if (!a || !b) return null
    legs.push({ kind: 'line', a, b, len: Math.hypot(b.x - a.x, b.y - a.y) })
  } else if (e?.kind === 'circle') {
    const c = P(e.center)
    if (!c) return null
    legs.push({ kind: 'arc', c, r: e.r, a0: 0, sweep: TAU, len: TAU * e.r })
    closed = true
  } else if (e?.kind === 'path') {
    closed = e.closed
    const n = e.anchors.length, count = e.closed ? n : n - 1
    for (let i = 0; i < count; i++) {
      const s = e.segments[i], a = P(e.anchors[i]!), b = P(e.anchors[(i + 1) % n]!)
      if (!s || !a || !b || s.kind === 'cubic') return null
      if (s.kind === 'line') { legs.push({ kind: 'line', a, b, len: Math.hypot(b.x - a.x, b.y - a.y) }); continue }
      const c = P(s.center)
      if (!c) return null
      const r = Math.hypot(a.x - c.x, a.y - c.y)
      const a0 = Math.atan2(a.y - c.y, a.x - c.x), a1 = Math.atan2(b.y - c.y, b.x - c.x)
      const ccw = (((a1 - a0) % TAU) + TAU) % TAU
      const sweep = s.sweep === 1 ? ccw : -(TAU - ccw)
      legs.push({ kind: 'arc', c, r, a0, sweep, len: r * Math.abs(sweep) })
    }
  } else return null
  const length = legs.reduce((t, l) => t + l.len, 0)
  if (!(length > 1e-12)) return null
  return {
    length, closed,
    at(s: number): Vec2 {
      let u = closed ? (((s % length) + length) % length) : Math.max(0, Math.min(length, s))
      for (const l of legs) {
        if (u <= l.len || l === legs[legs.length - 1]) {
          const f = l.len > 0 ? Math.min(1, u / l.len) : 0
          if (l.kind === 'line') return { x: l.a.x + f * (l.b.x - l.a.x), y: l.a.y + f * (l.b.y - l.a.y) }
          const ang = l.a0 + f * l.sweep
          return { x: l.c.x + l.r * Math.cos(ang), y: l.c.y + l.r * Math.sin(ang) }
        }
        u -= l.len
      }
      return { x: 0, y: 0 }
    },
  }
}

/** Where copies 1…count−1 land along `along` (Ruling 15); null when it can't be followed. */
export function alongPoints(doc: SketchDoc, along: EntityId, count: number): Vec2[] | null {
  const n = count2(count), w = pathWalk(doc, along)
  if (!n || !w) return null
  const step = w.closed ? w.length / n : w.length / (n - 1)
  return Array.from({ length: n - 1 }, (_, i) => w.at((i + 1) * step))
}

export function radialPlacements(c: Vec2, count: number, sweep = 360): Placement[] {
  return radialAngles(count, sweep).map(deg => rotateAbout(c, deg))
}
export function linearPlacements(vec: Vec2, count: number, spacing: Spacing): Placement[] {
  return linearFactors(count, spacing).map(k => shiftBy(vec, k))
}
export function alongPlacements(doc: SketchDoc, ids: readonly EntityId[], along: EntityId, count: number): Placement[] | null {
  if (ids.includes(along)) return null
  const at = alongPoints(doc, along, count), c = selectionCentre(doc, ids)
  if (!at || !c) return null
  return at.map(q => shiftBy({ x: q.x - c.x, y: q.y - c.y }, 1))
}

/** The selection's pieces drawn moved by each placement, as one outline —
 *  the Repeat preview (Ruling 17). Builds a small drawing of the selection
 *  alone and moves its points; never copies into `doc`. */
export function copiesPreviewD(doc: SketchDoc, ids: readonly EntityId[], placements: readonly Placement[]): string {
  const pts = closure(doc, ids).map(id => getPoint(doc, id)!) as PointEntity[]
  const pieces = ids.map(id => getEntity(doc, id)).filter((e): e is SketchEntity => !!e && e.kind !== 'point')
  const parts: string[] = []
  for (const move of placements) {
    const moved: SketchEntity[] = pts.map(p => ({ ...p, ...move(p) }))
    const d = sketchPathData({ entities: [...moved, ...pieces], constraints: [] })
    if (d) parts.push(d)
  }
  return parts.join(' ')
}

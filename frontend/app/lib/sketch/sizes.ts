// app/lib/sketch/sizes.ts
// Pen stage 6, the Properties panel's sizes (Ruling 13): which piece the
// selection is (a point, a line, an arc, a circle), what is measured for it,
// angles as seen on screen, where an arc's end goes for a typed sweep, the
// rules the radius lock stands for (an arc's distance pin between its centre
// and start — the chip's own —, a circle's radius rule), and the quick check
// a typed size runs on a copy first (checkSizeEdit). Pure.
import type { SketchDoc, SketchConstraint, EntityId } from './model'
import { getEntity, getPoint } from './model'
import type { Vec2 } from './geom'
import { invertView, type ViewMatrix } from './view'
import { curveGeom } from './crossings'
import { segCount, type PieceRef, type SegPick } from './pieces'
import { componentOf, windowOf, windowOfPart, solveWindow, reachesBeyond, lineCollapsed, type Baseline } from './cleanup/guards'
import { freeSlots } from './cleanup/rank'

export const SIZE_REFUSED = 'That size can’t be kept with these rules'

export type SizeTarget =
  | { kind: 'point'; id: EntityId }
  | { kind: 'line'; a: EntityId; b: EntityId; piece: PieceRef }
  | { kind: 'arc'; pathId: EntityId; segIndex: number; c: EntityId; s: EntityId; e: EntityId }
  | { kind: 'circle'; id: EntityId; c: EntityId }

/** `fixed`: a point that is fixed, or a line whose two ends are (its sizes
 *  can't change); `endFixed`: an arc whose end is fixed (its sweep and length
 *  can't change). */
export interface Sizes { x?: number; y?: number; length?: number; angle?: number; radius?: number; sweep?: number; locked?: boolean; fixed?: boolean; endFixed?: boolean }

export function sizeTargetFor(doc: SketchDoc, sel: readonly EntityId[], segs: readonly SegPick[]): SizeTarget | null {
  let seg: SegPick | null = null
  if (!sel.length && segs.length === 1) seg = segs[0]!
  else if (sel.length === 1 && !segs.length) {
    const e = getEntity(doc, sel[0]!)
    if (!e) return null
    if (e.kind === 'point') return { kind: 'point', id: e.id }
    if (e.kind === 'line') return { kind: 'line', a: e.p1, b: e.p2, piece: { kind: 'line', id: e.id } }
    if (e.kind === 'circle') return { kind: 'circle', id: e.id, c: e.center }
    if (segCount(e) === 1) seg = { pathId: e.id, segIndex: 0 }
  }
  if (!seg) return null
  const p = getEntity(doc, seg.pathId)
  if (!p || p.kind !== 'path') return null
  const s = p.segments[seg.segIndex]
  const a = p.anchors[seg.segIndex], b = p.anchors[(seg.segIndex + 1) % p.anchors.length]
  if (!s || !a || !b) return null
  if (s.kind === 'line') return { kind: 'line', a, b, piece: { kind: 'seg', ...seg } }
  if (s.kind === 'arc') return { kind: 'arc', pathId: seg.pathId, segIndex: seg.segIndex, c: s.center, s: a, e: b }
  return null
}

/** 0° pointing right on screen, counter-clockwise positive, in (−180, 180]. */
export function screenAngleDeg(view: ViewMatrix, d: Vec2): number {
  const sx = view.a * d.x + view.c * d.y, sy = view.b * d.x + view.d * d.y
  let a = Math.atan2(-sy, sx) * 180 / Math.PI
  if (a <= -180) a += 360
  return a
}
/** The unit drawing direction that reads as `deg` on screen. */
export function drawingDirForScreenAngle(view: ViewMatrix, deg: number): Vec2 | null {
  const inv = invertView(view)
  if (!inv) return null
  const r = deg * Math.PI / 180
  const sx = Math.cos(r), sy = -Math.sin(r)
  const x = inv.a * sx + inv.c * sy, y = inv.b * sx + inv.d * sy
  const n = Math.hypot(x, y)
  return n > 1e-12 ? { x: x / n, y: y / n } : null
}
/** The end of an arc from `s` round `c`, `deg` degrees in direction `dir` (+1 counter-clockwise in drawing units). */
export function arcEndForSweep(c: Vec2, s: Vec2, dir: 1 | -1, deg: number): Vec2 {
  const r = Math.hypot(s.x - c.x, s.y - c.y)
  const a = Math.atan2(s.y - c.y, s.x - c.x) + dir * deg * Math.PI / 180
  return { x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }
}
export function radiusPinOf(doc: SketchDoc, c: EntityId, s: EntityId): SketchConstraint | undefined {
  return doc.constraints.find(k => k.kind === 'distance' && ((k.refs[0] === c && k.refs[1] === s) || (k.refs[0] === s && k.refs[1] === c)))
}
export function circleRadiusRuleOf(doc: SketchDoc, id: EntityId): SketchConstraint | undefined {
  return doc.constraints.find(k => k.kind === 'radius' && k.refs[0] === id)
}

export function measureSizes(doc: SketchDoc, t: SizeTarget, view: ViewMatrix): Sizes {
  if (t.kind === 'point') {
    const p = getPoint(doc, t.id)
    return p ? { x: p.x, y: p.y, fixed: !!p.fixed } : {}
  }
  if (t.kind === 'line') {
    const a = getPoint(doc, t.a), b = getPoint(doc, t.b)
    if (!a || !b) return {}
    return { length: Math.hypot(b.x - a.x, b.y - a.y), angle: screenAngleDeg(view, { x: b.x - a.x, y: b.y - a.y }), fixed: !!a.fixed && !!b.fixed }
  }
  if (t.kind === 'arc') {
    const g = curveGeom(doc, { kind: 'seg', pathId: t.pathId, segIndex: t.segIndex })
    if (!g || g.kind !== 'arc') return {}
    const sweep = Math.abs(g.sweepAngle!)
    return { radius: g.r!, length: g.r! * sweep, sweep: sweep * 180 / Math.PI, locked: !!radiusPinOf(doc, t.c, t.s), endFixed: !!getPoint(doc, t.e)?.fixed }
  }
  const e = getEntity(doc, t.id)
  return e?.kind === 'circle' ? { radius: e.r, locked: !!circleRadiusRuleOf(doc, t.id) } : {}
}

// --- the check a typed size runs first (pen stage 6; the stage-5 lesson) ---
/** A window step widens once, like ruleCheck's trial solve: the stage-5
 *  window round the edit first; when it can't settle, the whole connected
 *  part if it has at most PART_SLOTS free scalars, else a wider window of
 *  WIDE_HOPS hops. The solver is dense — a failing solve over a 150-piece
 *  part takes seconds — so a big drawing is never solved whole here. */
const WIDE_HOPS = 4
const PART_SLOTS = 60

export type SizeCheck = 'ok' | 'refuse' | 'unsure'
export interface SizeCheckInput {
  /** a fresh copy of the drawing with the typed edit made (the dragged point
   *  moved to its target, any temporary rule added, a rule's value changed) —
   *  called once per step, as a solve changes its copy */
  fresh: () => SketchDoc
  /** the points / pieces / circles the edit touches (the window's seeds) */
  seeds: readonly EntityId[]
  /** points held where they are (the dragged point) */
  held: ReadonlySet<EntityId>
  /** drawing units per screen px — a straight piece squeezed under 2 px is a collapse */
  unitsPerPx: number
  /** the typed piece's own ends — its own length is what was typed */
  own?: readonly [EntityId, EntityId]
  /** points a drag must not move for the typed size to be kept (a line's
   *  other end, an arc's centre and start): the solve may meet every rule by
   *  moving them — the rules win, the typed size is lost */
  stay?: readonly EntityId[]
}

/** How far (screen px) a point that must stay may drift and the typed size
 *  still count as kept — the solver settles to a residual, not exactly. */
export const STAY_PX = 0.5

/** Whether every `stay` point of `after` is within `tol` of where it is in `before`. */
export function stayed(before: SketchDoc, after: SketchDoc, stay: readonly EntityId[], tol: number): boolean {
  for (const id of stay) {
    const A = getPoint(before, id), B = getPoint(after, id)
    if (A && B && Math.hypot(A.x - B.x, A.y - B.y) > tol) return false
  }
  return true
}

// every line and straight path piece with its drawn length (lineCollapsed's
// baseline), leaving out the typed piece itself
function straightsOf(doc: SketchDoc, own?: readonly [EntityId, EntityId]): Baseline['straights'] {
  const at = new Map<EntityId, Vec2>()
  for (const e of doc.entities) if (e.kind === 'point') at.set(e.id, e)
  const out: Baseline['straights'] = []
  const isOwn = (a: EntityId, b: EntityId) => !!own && ((own[0] === a && own[1] === b) || (own[0] === b && own[1] === a))
  const push = (a: EntityId, b: EntityId) => {
    const A = at.get(a), B = at.get(b)
    if (A && B && a !== b && !isOwn(a, b)) out.push({ a, b, len: Math.hypot(A.x - B.x, A.y - B.y) })
  }
  for (const e of doc.entities) {
    if (e.kind === 'line') push(e.p1, e.p2)
    else if (e.kind === 'path') {
      const n = segCount(e)
      for (let i = 0; i < n; i++) if (e.segments[i]?.kind === 'line') push(e.anchors[i]!, e.anchors[(i + 1) % e.anchors.length]!)
    }
  }
  return out
}

/** Can the typed size be kept? A trial solve of the window round the edit
 *  (cleanup/guards windowOf / solveWindow, everything outside held), widening
 *  once. "ok" when a step settles with the `stay` points where they were and
 *  no straight piece squeezed under 2 px;
 *  "refuse" only when certain — a step whose window holds the edit's whole
 *  connected part fails or squeezes a piece; else "unsure" (the caller applies
 *  it through its normal solve and rolls back only if that fails — never a
 *  refusal on a guess). The drawing is never changed. */
export function checkSizeEdit(doc: SketchDoc, input: SizeCheckInput): SizeCheck {
  const base: Baseline = {
    unitsPerPx: input.unitsPerPx, pos: new Map(), cap: new Map(), radius: new Map(), arcs: [],
    straights: straightsOf(doc, input.own),
  }
  const seeds = [...input.seeds]
  let certain = false, whole = false
  const settled = (win: (t: SketchDoc) => Set<EntityId>): boolean => {
    const trial = input.fresh()
    const part = componentOf(trial, seeds)
    const w = win(trial)
    for (const h of input.held) w.add(h)   // a held point is solved as held, not left out
    whole = !reachesBeyond(part, w)
    if (solveWindow(trial, w, input.held)
      && stayed(doc, trial, input.stay ?? [], STAY_PX * input.unitsPerPx)
      && !(input.unitsPerPx > 0 && lineCollapsed(trial, base, id => id))) return true
    if (whole) certain = true
    return false
  }
  if (settled(t => windowOf(t, seeds))) return 'ok'
  if (!whole) {
    const ok = settled(t => {
      const part = componentOf(t, seeds)
      return freeSlots(part, new Set()).length <= PART_SLOTS ? windowOfPart(part) : windowOf(t, seeds, WIDE_HOPS)
    })
    if (ok) return 'ok'
  }
  return certain ? 'refuse' : 'unsure'
}

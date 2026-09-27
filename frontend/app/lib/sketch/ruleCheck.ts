// app/lib/sketch/ruleCheck.ts
// Pen stage 6: can this rule be added? Four verdicts:
//   "ok"       — it can be added.
//   "already"  — Already true: an equivalent rule is there, or (full check
//                only) the rule holds now AND the others imply it — its
//                Jacobian rows lie in the span of rules wholly inside the
//                window round it, and that is still so at a second, nudged
//                and re-settled configuration (a first-order test alone
//                greys out a rule that locks a point sliding past a tangent).
//                Callers grey it out.
//   "conflict" — Conflicts with another rule, and only when that is certain:
//                a merge of two fixed points apart; a trial solve that fails
//                on a region holding the rule's whole connected part (nothing
//                outside it could have helped); or a trial solve over such a
//                region that settled but collapsed a line, arc or circle.
//                A whole-part solve that fails to converge within the
//                solver's iteration cap is treated as a conflict — a strong
//                sign, not a proof. Callers grey it out.
//   "unsure"   — no window small enough to solve quickly could settle it, and
//                its part is too big to solve whole (the solver is dense: a
//                150-piece part takes seconds). Never refuse on a guess
//                (controller ruling): callers treat "unsure" as ALLOWED — the
//                pick goes through the pen's normal apply, as the rules row
//                does.
// Coincident is checked as the merge it is.
//
// Two checks (controller ruling C1 — the menus must open fast):
//   quickRuleCheck — for the menu, the wheel and Properties' + list: no solve.
//     "already" only for an exact equivalent rule; "conflict" only for a
//     merge of two fixed points apart; everything else "ok".
//   checkRule — on demand (a rule picked or hovered): the same, plus a trial
//     solve of the stage-5 window round the rule (cleanup/guards windowOf /
//     solveWindow, everything outside held), widening once — to the rule's
//     connected part when it is small, else a wider window — when the window
//     can't converge or its answer collapses a piece. Never a big drawing.
// Pure: the drawing is never changed (every trial runs on a copy).
import type { SketchDoc, SketchConstraint, SketchEntity, EntityId } from './model'
import { cloneDoc } from './clone'
import { constraintResiduals } from './residuals'
import { equivalentRuleKey, type RuleSpec } from './tangency'
import { mergePoints } from './trim'
import { componentOf, windowOf, windowOfPart, solveWindow, reachesBeyond, lineCollapsed, type Baseline } from './cleanup/guards'
import { RowBasis, freeSlots, rowsFor } from './cleanup/rank'

export type MergeSpec = { merge: [EntityId, EntityId] }   // [keep, gone]
export type RuleCheck = 'ok' | 'already' | 'conflict' | 'unsure'
export interface RuleCheckOptions {
  /** drawing units per screen px — when given, a straight piece squeezed
   *  under 2 px (Clean up's lineCollapsed guard) is a collapse too */
  unitsPerPx?: number
}

/** How many hops round the rule its rank is taken over (a little wider than
 *  the solve window, so more of the rules round it sit wholly inside). */
const RANK_HOPS = 3

type Pt = { x: number; y: number }
function pointMap(doc: SketchDoc): Map<EntityId, Pt> {
  const pt = new Map<EntityId, Pt>()
  for (const e of doc.entities) if (e.kind === 'point') pt.set(e.id, e)
  return pt
}

// every line, straight piece, arc radius and circle radius, by a stable key
// (entities by id, path pieces by their points),
// with its two ends (a piece whose ends became one point — a merge — is left
// out: it went, it didn't collapse)
interface Size { a: EntityId; b: EntityId; len: number; straight: boolean }
function sizes(doc: SketchDoc): Map<string, Size> {
  const pt = pointMap(doc)
  const d = (a: EntityId, b: EntityId) => { const A = pt.get(a), B = pt.get(b); return A && B ? Math.hypot(A.x - B.x, A.y - B.y) : NaN }
  const out = new Map<string, Size>()
  for (const e of doc.entities) {
    if (e.kind === 'line') { if (e.p1 !== e.p2) out.set(e.id, { a: e.p1, b: e.p2, len: d(e.p1, e.p2), straight: true }) }
    else if (e.kind === 'circle') out.set(e.id, { a: e.center, b: e.center, len: e.r, straight: false })
    else if (e.kind === 'path') {
      const n = e.anchors.length
      const count = e.closed ? n : n - 1
      for (let i = 0; i < count; i++) {
        const s = e.segments[i]
        const a = e.anchors[i]!, b = e.anchors[(i + 1) % n]!
        if (a === b) continue
        // keyed by the piece's own points, not its index (a merge or a
        // removal renumbers a path's pieces)
        const ends = a < b ? `${a},${b}` : `${b},${a}`
        if (s?.kind === 'line') out.set(`line:${ends}`, { a, b, len: d(a, b), straight: true })
        else if (s?.kind === 'arc') out.set(`arc:${s.center}:${ends}`, { a: s.center, b: a, len: d(s.center, a), straight: false })
      }
    }
  }
  return out
}

// a piece over 1e-9 that ends under 1/1000 of what it was; with a scale, also
// a straight piece squeezed under 2 px (lineCollapsed)
function collapsed(before: Map<string, Size>, after: SketchDoc, opts: RuleCheckOptions): boolean {
  const a = sizes(after)
  for (const [k, s0] of before) {
    const s1 = a.get(k)
    if (Number.isFinite(s0.len) && s0.len > 1e-9 && s1 != null && Number.isFinite(s1.len) && s1.len < s0.len * 1e-3) return true
  }
  if (opts.unitsPerPx && opts.unitsPerPx > 0) {
    const straights = [...before.values()].filter(s => s.straight && Number.isFinite(s.len)).map(s => ({ a: s.a, b: s.b, len: s.len }))
    const base: Baseline = { unitsPerPx: opts.unitsPerPx, pos: new Map(), cap: new Map(), radius: new Map(), arcs: [], straights }
    if (lineCollapsed(after, base, id => id)) return true
  }
  return false
}

function span(doc: SketchDoc): number {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of doc.entities) if (e.kind === 'point') { x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x); y1 = Math.max(y1, e.y) }
  return Number.isFinite(x0) ? Math.hypot(x1 - x0, y1 - y0) : 0
}
function asRule(spec: RuleSpec): SketchConstraint {
  return { id: '__check', kind: spec.kind, refs: [...spec.refs], ...(spec.value != null ? { value: spec.value } : {}) }
}
function isThere(doc: SketchDoc, spec: RuleSpec): boolean {
  const key = equivalentRuleKey(doc, spec)
  return doc.constraints.some(c => equivalentRuleKey(doc, c) === key)
}
// the points an id stands for (as cleanup/guards reads them): a point, a
// line's ends, a circle's centre and its radius (the circle id), a path's
// anchors, arc centres and handles
function pointsOf(map: ReadonlyMap<EntityId, SketchEntity>, id: EntityId): EntityId[] {
  const e = map.get(id)
  if (!e) return [id]
  if (e.kind === 'point') return [e.id]
  if (e.kind === 'line') return [e.p1, e.p2]
  if (e.kind === 'circle') return [e.center, e.id]
  const out = [...e.anchors]
  for (const s of e.segments) {
    if (s.kind === 'arc') out.push(s.center)
    else if (s.kind === 'cubic') { if (s.h1) out.push(s.h1); if (s.h2) out.push(s.h2) }
  }
  return out
}
// the rule's rows raise the rank of the rules that sit wholly inside the
// window `win` (every scalar they read is a window scalar or a fixed point).
// Those rows are zero outside the window, so a rule they span is spanned in
// the whole drawing — "adds nothing" is certain. A rule reaching past the
// window's edge is left out: counting it with its far end held could hide
// freedom the rule would still take (then this says "adds", i.e. "ok").
function addsRank(doc: SketchDoc, rule: SketchConstraint, win: ReadonlySet<EntityId>): boolean {
  const slots = freeSlots({ entities: doc.entities.filter(e => win.has(e.id)), constraints: [] }, new Set())
  if (!slots.length) return false
  const map = new Map(doc.entities.map(e => [e.id, e]))
  const inside = (c: SketchConstraint) => c.refs.every(r => pointsOf(map, r).every(p => {
    if (win.has(p)) return true
    const q = map.get(p)
    return q?.kind === 'point' && !!q.fixed
  }))
  const basis = new RowBasis(slots.length)
  for (const row of rowsFor(doc, slots, doc.constraints.filter(inside))) basis.add(row)
  let adds = false
  for (const row of rowsFor(doc, slots, [rule])) if (basis.add(row)) adds = true
  return adds
}
// the rule holds as the drawing stands
function holdsNow(doc: SketchDoc, rule: SketchConstraint): boolean {
  const r = constraintResiduals({ entities: doc.entities, constraints: [rule] })
  const tol = 1e-7 * Math.max(1, span(doc))
  return r.every(x => Number.isFinite(x) && Math.abs(x) <= tol)
}
function fixedApart(doc: SketchDoc, a: EntityId, b: EntityId): boolean {
  const pa = doc.entities.find(e => e.id === a), pb = doc.entities.find(e => e.id === b)
  if (pa?.kind !== 'point' || pb?.kind !== 'point') return true   // not two points: a merge can't be made
  return !!pa.fixed && !!pb.fixed && Math.hypot(pa.x - pb.x, pa.y - pb.y) > 1e-9 * Math.max(1, span(doc))
}

/** The menus' check (C1): no solve. "already" only for an exact equivalent
 *  rule; "conflict" only for a merge of two fixed points apart; otherwise
 *  "ok" (checkRule, on demand, tells an implied rule or a conflict). */
export function quickRuleCheck(doc: SketchDoc, spec: RuleSpec | MergeSpec): RuleCheck {
  if ('merge' in spec) {
    const [keep, gone] = spec.merge
    if (keep === gone) return 'already'
    return fixedApart(doc, keep, gone) ? 'conflict' : 'ok'
  }
  return isThere(doc, spec) ? 'already' : 'ok'
}

/** How far the second configuration nudges each free scalar of the window,
 *  as a share of the window's size. */
const NUDGE_FRAC = 0.03

// a deterministic stream in [-1, 1) (a fixed-seed LCG — the same drawing
// always gets the same nudge)
function seeded(seed = 0x2f6b1d): () => number {
  let x = seed >>> 0
  return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 2 ** 31 - 1 }
}

// the rule, holding now and adding no rank at this configuration, is implied:
// confirm it at a second one — nudge the window's free points and radii by a
// small seeded step, re-settle with the existing rules only (a window solve
// on a copy), and require the rule still holds and still adds no rank there
function impliedAtSecondConfig(doc: SketchDoc, rule: SketchConstraint, win: ReadonlySet<EntityId>): boolean {
  const trial = cloneDoc(doc)
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const e of trial.entities) if (e.kind === 'point' && win.has(e.id)) { x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x); y1 = Math.max(y1, e.y) }
  const size = Number.isFinite(x0) ? Math.max(Math.hypot(x1 - x0, y1 - y0), 1e-6) : 1
  const step = NUDGE_FRAC * size, rnd = seeded()
  for (const e of trial.entities) {
    if (!win.has(e.id)) continue
    if (e.kind === 'point' && !e.fixed) { e.x += step * rnd(); e.y += step * rnd() }
    else if (e.kind === 'circle') e.r = Math.max(e.r * (1 + NUDGE_FRAC * rnd()), 1e-9)
  }
  if (!solveWindow(trial, win, new Set())) return false
  return holdsNow(trial, rule) && !addsRank(trial, rule, win)
}

/** The trial solve widens once: the stage-5 window (WINDOW_HOPS) first;
 *  when it can't settle the rule, the whole connected part if that has at
 *  most PART_SLOTS free scalars, else a wider window of WIDE_HOPS hops. The
 *  solver is dense and a failing solve runs all its iterations — a 150-piece
 *  part (~300 scalars) takes seconds, far too slow for a hover (C1) — so a
 *  big part that neither window can settle is "unsure", not a conflict. */
const WIDE_HOPS = 4
const PART_SLOTS = 60

// a trial solve round `seeds`; `fresh` builds a new trial copy for each step.
// "ok" when a step settles with nothing collapsed; "conflict" only when a
// step whose window holds the seeds' whole connected part fails or settles
// with a piece collapsed (a collapse in a partial window may be the held edge
// forcing it); else "unsure".
function trialSolve(fresh: () => SketchDoc, seeds: EntityId[], before: Map<string, Size>, opts: RuleCheckOptions): 'ok' | 'conflict' | 'unsure' {
  let certain = false
  let whole = false
  const settled = (win: (t: SketchDoc) => Set<EntityId>): boolean => {
    const trial = fresh()
    const part = componentOf(trial, seeds)
    const w = win(trial)
    whole = !reachesBeyond(part, w)
    if (solveWindow(trial, w, new Set()) && !collapsed(before, trial, opts)) return true
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
  return certain ? 'conflict' : 'unsure'
}

/** The full check, on demand (a rule picked or hovered — C1). An equivalent
 *  rule there, or one that holds now and adds nothing — here and at a
 *  nudged second configuration (impliedAtSecondConfig) → "already"; a merge refused (two fixed points apart) → "conflict"; else
 *  the trial solve's verdict (trialSolve): "ok", a certain "conflict", or
 *  "unsure" (callers allow it). A rule that settles is "ok" even when its
 *  rows add no rank — the solve found a drawing where every rule holds. */
export function checkRule(doc: SketchDoc, spec: RuleSpec | MergeSpec, opts: RuleCheckOptions = {}): RuleCheck {
  const before = sizes(doc)
  if ('merge' in spec) {
    const [keep, gone] = spec.merge
    if (keep === gone) return 'already'
    if (fixedApart(doc, keep, gone)) return 'conflict'
    const merged = cloneDoc(doc)
    if (!mergePoints(merged, gone, keep)) return 'conflict'
    return trialSolve(() => cloneDoc(merged), [keep], before, opts)
  }
  if (isThere(doc, spec)) return 'already'
  const rule = asRule(spec)
  if (holdsNow(doc, rule)) {
    const win = windowOf(doc, spec.refs, RANK_HOPS)
    if (!addsRank(doc, rule, win) && impliedAtSecondConfig(doc, rule, win)) return 'already'
  }
  return trialSolve(() => { const t = cloneDoc(doc); t.constraints.push({ ...rule, refs: [...rule.refs] }); return t }, spec.refs, before, opts)
}

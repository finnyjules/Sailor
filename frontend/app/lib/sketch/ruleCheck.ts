// app/lib/sketch/ruleCheck.ts
// Pen stage 6: can this rule be added?
//   "already"  — the same rule is there, or the others already imply it (its
//                Jacobian rows add no rank round the rule, and it holds now);
//   "conflict" — it would move what it can't, the trial solve fails, or a
//                line, arc or circle collapses;
//   otherwise "ok". Coincident is checked as the merge it is.
//
// Two checks (controller ruling C1 — the menus must open fast):
//   quickRuleCheck — for the menu, the wheel and Properties' + list: no solve.
//     Already true by an equivalent rule, or by "holds now and adds no rank";
//     a merge of two fixed points apart conflicts; everything else is "ok".
//   checkRule — on demand (a rule picked or hovered): the same, plus a trial
//     solve of the stage-5 window round the rule (cleanup/guards windowOf /
//     solveWindow, everything outside held), widening once — to the rule's
//     connected part when it is small, else a wider window — when the window
//     can't converge or its answer collapses a piece. Never a big drawing.
// The rank is taken over the window's free scalars (points outside held) — a
// rule independent there is independent in the whole drawing; one dependent
// there is, near enough, implied by what is round it.
// Pure: the drawing is never changed (every trial runs on a copy).
import type { SketchDoc, SketchConstraint, EntityId } from './model'
import { cloneDoc } from './clone'
import { constraintResiduals } from './residuals'
import { equivalentRuleKey, type RuleSpec } from './tangency'
import { mergePoints } from './trim'
import { componentOf, windowOf, windowOfPart, solveWindow, lineCollapsed, type Baseline } from './cleanup/guards'
import { GUARD } from './cleanup/types'
import { RowBasis, freeSlots, rowsFor } from './cleanup/rank'

export type MergeSpec = { merge: [EntityId, EntityId] }   // [keep, gone]
export type RuleCheck = 'ok' | 'already' | 'conflict'
export interface RuleCheckOptions {
  /** drawing units per screen px — when given, a straight piece squeezed
   *  under 2 px (Clean up's lineCollapsed guard) is a collapse too */
  unitsPerPx?: number
}

/** How many hops round the rule its rank is taken over (a little wider than
 *  the solve window, so what the window's edge holds weighs less). */
const RANK_HOPS = 3

type Pt = { x: number; y: number }
function pointMap(doc: SketchDoc): Map<EntityId, Pt> {
  const pt = new Map<EntityId, Pt>()
  for (const e of doc.entities) if (e.kind === 'point') pt.set(e.id, e)
  return pt
}

// every line, straight piece, arc radius and circle radius, by a stable key,
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
        if (s?.kind === 'line') out.set(`${e.id}:${i}`, { a, b, len: d(a, b), straight: true })
        else if (s?.kind === 'arc') out.set(`${e.id}:${i}`, { a: s.center, b: a, len: d(s.center, a), straight: false })
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
function maxMove(before: SketchDoc, after: SketchDoc): number {
  const was = pointMap(before)
  let m = 0
  for (const e of after.entities) {
    if (e.kind !== 'point') continue
    const p = was.get(e.id)
    if (p) m = Math.max(m, Math.hypot(e.x - p.x, e.y - p.y))
  }
  return m
}

function asRule(spec: RuleSpec): SketchConstraint {
  return { id: '__check', kind: spec.kind, refs: [...spec.refs], ...(spec.value != null ? { value: spec.value } : {}) }
}
function isThere(doc: SketchDoc, spec: RuleSpec): boolean {
  const key = equivalentRuleKey(doc, spec)
  return doc.constraints.some(c => equivalentRuleKey(doc, c) === key)
}
// the rule's rows raise the rank of the rows already there, over the free
// scalars of the window round it (everything outside the window held)
function addsRank(doc: SketchDoc, rule: SketchConstraint, win: ReadonlySet<EntityId>): boolean {
  const slots = freeSlots({ entities: doc.entities.filter(e => win.has(e.id)), constraints: [] }, new Set())
  if (!slots.length) return false
  const basis = new RowBasis(slots.length)
  for (const row of rowsFor(doc, slots, doc.constraints)) basis.add(row)
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

/** The menus' check (C1): no solve. "already" when an equivalent rule is
 *  there, or it holds now and adds no rank round it; "conflict" only for a
 *  merge of two fixed points apart; otherwise "ok" (checkRule, on demand,
 *  tells a conflict). */
export function quickRuleCheck(doc: SketchDoc, spec: RuleSpec | MergeSpec): RuleCheck {
  if ('merge' in spec) {
    const [keep, gone] = spec.merge
    if (keep === gone) return 'already'
    return fixedApart(doc, keep, gone) ? 'conflict' : 'ok'
  }
  if (isThere(doc, spec)) return 'already'
  const rule = asRule(spec)
  if (holdsNow(doc, rule) && !addsRank(doc, rule, windowOf(doc, spec.refs, RANK_HOPS))) return 'already'
  return 'ok'
}

/** The trial solve widens once: the stage-5 window (WINDOW_HOPS) first;
 *  when it can't settle the rule, the whole connected part if that has at
 *  most PART_SLOTS free scalars, else a wider window of WIDE_HOPS hops. The
 *  solver is dense and a failing solve runs all its iterations — a 150-piece
 *  part (~300 scalars) takes seconds, far too slow for a hover (C1) — so a
 *  big part that neither window can settle is called a conflict. */
const WIDE_HOPS = 4
const PART_SLOTS = 60

// a trial solve round `seeds`, widening as above when the window can't
// converge or collapses a piece; `fresh` builds a new trial copy for each
// step. The solved copy, or null.
function trialSolve(fresh: () => SketchDoc, seeds: EntityId[], before: Map<string, Size>, opts: RuleCheckOptions): SketchDoc | null {
  const settled = (win: (t: SketchDoc) => Set<EntityId>): SketchDoc | null => {
    const trial = fresh()
    return solveWindow(trial, win(trial), new Set()) && !collapsed(before, trial, opts) ? trial : null
  }
  return settled(t => windowOf(t, seeds))
    ?? settled(t => {
      const part = componentOf(t, seeds)
      return freeSlots(part, new Set()).length <= PART_SLOTS ? windowOfPart(part) : windowOf(t, seeds, WIDE_HOPS)
    })
}

/** The full check, on demand (a rule picked or hovered — C1): an equivalent
 *  rule there → "already"; a merge refused (two fixed points apart) →
 *  "conflict"; else a trial solve round the rule (the window, then a small
 *  connected part or a wider window) that fails or collapses a piece →
 *  "conflict"; a rule that adds rank → "ok"; one that doesn't → "already" when the trial moved
 *  nothing (over 1e-5 of the drawing's size), else "conflict". */
export function checkRule(doc: SketchDoc, spec: RuleSpec | MergeSpec, opts: RuleCheckOptions = {}): RuleCheck {
  const before = sizes(doc)
  if ('merge' in spec) {
    const [keep, gone] = spec.merge
    if (keep === gone) return 'already'
    if (fixedApart(doc, keep, gone)) return 'conflict'
    const merged = cloneDoc(doc)
    if (!mergePoints(merged, gone, keep)) return 'conflict'
    return trialSolve(() => cloneDoc(merged), [keep], before, opts) ? 'ok' : 'conflict'
  }
  if (isThere(doc, spec)) return 'already'
  const rule = asRule(spec)
  const solved = trialSolve(() => { const t = cloneDoc(doc); t.constraints.push({ ...rule, refs: [...rule.refs] }); return t }, spec.refs, before, opts)
  if (!solved) return 'conflict'
  if (addsRank(doc, rule, windowOf(doc, spec.refs, RANK_HOPS))) return 'ok'
  return maxMove(doc, solved) <= 1e-5 * Math.max(1, span(doc)) ? 'already' : 'conflict'
}

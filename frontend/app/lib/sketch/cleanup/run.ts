// app/lib/sketch/cleanup/run.ts
// Clean up's staged greedy solve (spec "How it decides"): joins, then
// directions, then placement, then sizes, then nudges — each pass re-reads
// the drawing the passes before it left, tries its candidates best first,
// and keeps a candidate only when the held solve converges, it adds
// something, and the guards pass. Always from the drawing it is given, so
// the same switches give the same answer.
import type { SketchDoc, EntityId } from '../model'
import { getPoint } from '../model'
import { cloneDoc } from '../clone'
import { addConstraint, removeConstraint } from '../edit'
import { mergePoints } from '../trim'
import { constraintResiduals } from '../residuals'
import { equivalentRuleKey, type RuleSpec } from '../tangency'
import { meanPoint } from './cluster'
import { buildContext, heldForScope, copyPoints, type CleanupContext, type ContextEnv } from './context'
import { RowBasis, freeSlots, rowsFor } from './rank'
import { solveHeld, componentOf, baselineOf, movedTooFar, arcBroken, type Baseline } from './guards'
import { detectJoins, detectOnCurve, detectTangents } from './detect-topology'
import { detectHV, detectParallelPerp } from './detect-directions'
import { detectConcentric, detectMirrorPairs, detectEqualLengths, detectEqualRadii, detectEvenSpacing, detectRound } from './detect-shape'
import { STRENGTH_FACTOR, GUARD, type Candidate, type CleanupOptions, type CleanupResult, type CleanupFix } from './types'

type Pass = ((ctx: CleanupContext) => Candidate[])[]
/** The spec's stages in order — joins, directions, placement, sizes, nudges —
 *  split into passes. */
export const PASSES: Pass[] = [
  [detectJoins], [detectOnCurve, detectTangents],                   // joins
  [detectHV], [detectParallelPerp],                                 // directions
  [detectConcentric], [detectMirrorPairs],                          // placement
  [detectEqualLengths, detectEqualRadii, detectEvenSpacing],        // sizes
  [detectRound],                                                    // nudges
]

interface Env { held: ReadonlySet<EntityId>; base: Baseline; alias: Map<EntityId, EntityId>; guides: Map<string, EntityId>; openOnly: boolean }

const closedCount = (doc: SketchDoc) => doc.entities.filter(e => e.kind === 'path' && e.closed).length
function resolveIn(alias: ReadonlyMap<EntityId, EntityId>, id: EntityId): EntityId {
  let x = id
  for (let k = 0; alias.has(x) && k < 10000; k++) x = alias.get(x)!
  return x
}
const residualNorm = (doc: SketchDoc) => Math.sqrt(constraintResiduals(doc).reduce((s, r) => s + r * r, 0))

// Applies one candidate to `work` in place. False = refused (the caller puts
// `work`, the merge map and the guide map back).
function tryApply(work: SketchDoc, cand: Candidate, env: Env): boolean {
  const resolve = (id: EntityId) => resolveIn(env.alias, id)
  const seeds: EntityId[] = []
  let changed = false
  if (cand.merges) {
    const ids = [...new Set(cand.merges.points.map(resolve))]
    if (ids.length < 2) return false
    const pinned = ids.filter(id => { const p = getPoint(work, id); return !p || !!p.fixed || env.held.has(id) })
    if (pinned.length > 1) return false
    const into = pinned[0] ?? ids[0]!
    if (!pinned.length) { const p = getPoint(work, into)!; p.x = cand.merges.at.x; p.y = cand.merges.at.y }
    const closed = closedCount(work)
    for (const from of ids) {
      if (from === into) continue
      if (!mergePoints(work, from, into)) return false
      env.alias.set(from, into)
    }
    if (env.openOnly && closedCount(work) > closed) return false
    seeds.push(into)
    changed = true
  }
  const before = new Set(work.entities.map(e => e.id))
  const rules: RuleSpec[] = (cand.rules ?? []).map(r => ({ ...r, refs: r.refs.map(resolve) }))
  if (cand.prepare) rules.push(...cand.prepare(work, env.guides))
  const created = new Set(work.entities.filter(e => !before.has(e.id)).map(e => e.id))
  if (rules.length) {
    const part = componentOf(work, [...rules.flatMap(r => r.refs), ...created])
    const slots = freeSlots(part, env.held)
    const basis = new RowBasis(slots.length)
    for (const row of rowsFor(work, slots, part.constraints)) basis.add(row)
    const rank0 = basis.rank
    const keys = new Set(work.constraints.map(c => equivalentRuleKey(work, c)))
    const added: EntityId[] = []
    for (const r of rules) {
      const key = equivalentRuleKey(work, r)
      if (keys.has(key)) continue
      let independent = false
      for (const row of rowsFor(work, slots, [{ id: '__cleanup', ...r }])) if (basis.add(row)) independent = true
      if (!independent && !r.refs.some(id => created.has(id))) continue
      added.push(addConstraint(work, r.kind, r.refs, r.value))
      keys.add(key)
      seeds.push(...r.refs)
    }
    let gain = basis.rank - rank0
    if (created.size) {
      // freedom that only places the new guide points is not a change to the drawing
      const cols = slots.map((s, i) => (created.has(s.id) ? i : -1)).filter(i => i >= 0)
      const guide = new RowBasis(cols.length)
      for (const row of rowsFor(work, slots, work.constraints.filter(c => added.includes(c.id)))) guide.add(cols.map(i => row[i]!))
      gain -= guide.rank
    }
    if (gain > 0) changed = true
  }
  let temp: EntityId | null = null
  if (cand.nudge) {
    const n = cand.nudge
    temp = 'circle' in n
      ? addConstraint(work, 'radius', [resolve(n.circle)], n.value)
      : addConstraint(work, 'distance', n.refs.map(resolve), n.value)
    seeds.push(...('circle' in n ? [resolve(n.circle)] : n.refs.map(resolve)))
    changed = true
  }
  if (!changed) return false
  if (!solveHeld(componentOf(work, seeds), env.held)) return false
  if (temp) removeConstraint(work, temp)
  return !movedTooFar(work, env.base) && !arcBroken(work, env.base, resolve)
}

export function runCleanup(input: SketchDoc, o: CleanupOptions): CleanupResult {
  const off = o.off ?? new Set<string>()
  let work = cloneDoc(input)
  const held = heldForScope(work, o.scope)
  const env0: ContextEnv = { held, copies: copyPoints(work), s: STRENGTH_FACTOR[o.strength], unitsPerPx: o.unitsPerPx, openOnly: !!o.openOnly }
  if (buildContext(work, env0).pieces.length > GUARD.MAX_PIECES) return { doc: cloneDoc(input), fixes: [], refused: 'tooBig' }
  const base = baselineOf(work, o.unitsPerPx)
  if (residualNorm(work) >= 1e-3 && !solveHeld(work, held)) return { doc: cloneDoc(input), fixes: [], refused: 'conflict' }
  const alias = new Map<EntityId, EntityId>()
  let guides = new Map<string, EntityId>()
  const tried: { cand: Candidate; on: boolean }[] = []
  for (const pass of PASSES) {
    const ctx = buildContext(work, env0)
    const cands = pass.flatMap(detect => detect(ctx)).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const seen = new Set<string>()
    for (const cand of cands) {
      if (seen.has(cand.id)) continue
      seen.add(cand.id)
      if (off.has(cand.id)) { tried.push({ cand, on: false }); continue }
      const snap = cloneDoc(work), snapAlias = new Map(alias), snapGuides = new Map(guides)
      if (tryApply(work, cand, { held, base, alias, guides, openOnly: !!o.openOnly })) { tried.push({ cand, on: true }); continue }
      work = snap
      alias.clear()
      for (const [k, v] of snapAlias) alias.set(k, v)
      guides = snapGuides
    }
  }
  const fixes: CleanupFix[] = []
  for (const { cand, on } of tried) {
    const at = cand.anchor.map(id => getPoint(work, resolveIn(alias, id))).filter((p): p is NonNullable<typeof p> => !!p)
    if (at.length) fixes.push({ id: cand.id, kind: cand.kind, label: cand.label, on, at: meanPoint(at) })
  }
  return { doc: work, fixes }
}

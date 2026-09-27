// app/lib/sketch/cleanup/run.ts
// Clean up's staged greedy solve (spec "How it decides"): joins, then
// directions, then placement, then sizes, then nudges — each pass re-reads
// the drawing the passes before it left, tries its candidates best first,
// and keeps a candidate only when the held solve converges, it adds
// something, and the guards pass. Always from the drawing it is given, so
// the same switches give the same answer — unless the time budget runs out
// (`budgetMs`, 800 ms by default): the run then stops, keeps what it
// accepted and says `stopped`, and where it stopped depends on the machine's
// speed. The pen memoises each answer per strength + switches for the
// session, so one session still shows one answer per setting.
import type { SketchDoc, EntityId } from '../model'
import type { Vec2 } from '../geom'
import { getPoint } from '../model'
import { cloneDoc } from '../clone'
import { addConstraint, removeConstraint } from '../edit'
import { mergePoints } from '../trim'
import { constraintResiduals } from '../residuals'
import { equivalentRuleKey, type RuleSpec } from '../tangency'
import { meanPoint } from './cluster'
import { buildContext, heldForScope, copyPoints, type CleanupContext, type ContextEnv } from './context'
import { RowBasis, freeSlots, rowsFor } from './rank'
import { solveWindow, windowOf, windowOfPart, reachesBeyond, componentOf, baselineOf, movedTooFar, arcBroken, lineCollapsed, type Baseline } from './guards'
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
// the drawing with only the rules of the parts a scope touches (all of it with no scope)
function scopeRules(doc: SketchDoc, scope: CleanupOptions['scope']): SketchDoc {
  if (!scope) return doc
  const seeds = [...scope.entities, ...scope.segments.map(x => x.pathId)]
  if (!seeds.some(id => doc.entities.some(e => e.id === id))) return doc
  return { entities: doc.entities, constraints: componentOf(doc, seeds).constraints }
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
  const guarded = () => !movedTooFar(work, env.base) && !arcBroken(work, env.base, resolve) && !lineCollapsed(work, env.base, resolve, created)
  // a small window round the fix first; the whole connected part only when the
  // window can't settle it or settles it badly (a piece squeezed to nothing to
  // meet a rule whose other end is held). **Ruling (final review):** never for
  // a nudge — a rounded size the window can't take is dropped (solving a big
  // part for it cost ~80 s on a grid of mirrored shapes).
  const was = snapshotShape(work)
  const win = windowOf(work, seeds)
  let ok = solveWindow(work, win, env.held) && guarded()
  if (!ok && !cand.nudge) {
    const part = componentOf(work, seeds)
    if (reachesBeyond(part, win)) {        // else the window was the whole part: same answer
      restoreShape(work, was)
      // the whole part moves; anything a size rule reaches in another part is held
      ok = solveWindow(work, windowOfPart(part), env.held) && guarded()
    }
  }
  if (temp) removeConstraint(work, temp)
  return ok
}

// where every point and circle radius is, to put back after a window solve that didn't do
function snapshotShape(doc: SketchDoc): Map<EntityId, number[]> {
  const out = new Map<EntityId, number[]>()
  for (const e of doc.entities) {
    if (e.kind === 'point') out.set(e.id, [e.x, e.y])
    else if (e.kind === 'circle') out.set(e.id, [e.r])
  }
  return out
}
function restoreShape(doc: SketchDoc, was: ReadonlyMap<EntityId, number[]>): void {
  for (const e of doc.entities) {
    const v = was.get(e.id)
    if (!v) continue
    if (e.kind === 'point') { e.x = v[0]!; e.y = v[1]! } else if (e.kind === 'circle') e.r = v[0]!
  }
}

export function runCleanup(input: SketchDoc, o: CleanupOptions): CleanupResult {
  const off = o.off ?? new Set<string>()
  let work = cloneDoc(input)
  const held = heldForScope(work, o.scope)
  const env0: ContextEnv = { held, copies: copyPoints(work), s: STRENGTH_FACTOR[o.strength], unitsPerPx: o.unitsPerPx, openOnly: !!o.openOnly }
  if (buildContext(work, env0).pieces.length > GUARD.MAX_PIECES) return { doc: cloneDoc(input), fixes: [], refused: 'tooBig' }
  const base = baselineOf(work, o.unitsPerPx)
  // Ruling 19: rules that don't hold before Clean up starts → nothing is safe
  // to change (re-solving them here would fold that movement into Apply)
  // — the rules of the part the scope touches (the whole drawing with no scope)
  if (residualNorm(scopeRules(work, o.scope)) >= 1e-3) return { doc: cloneDoc(input), fixes: [], refused: 'conflict' }
  const now = o.now ?? (() => performance.now())
  const budget = o.budgetMs ?? GUARD.BUDGET_MS
  const t0 = now()
  let stopped = false
  const alias = new Map<EntityId, EntityId>()
  let guides = new Map<string, EntityId>()
  const tried: { cand: Candidate; on: boolean; spot: Vec2 | null }[] = []
  // the mean of a candidate's anchor points in `doc` (ids resolved through merges), if any are left
  const spotIn = (doc: SketchDoc, cand: Candidate): Vec2 | null => {
    const at = cand.anchor.map(id => getPoint(doc, resolveIn(alias, id))).filter((p): p is NonNullable<typeof p> => !!p)
    return at.length ? meanPoint(at) : null
  }
  for (const pass of PASSES) {
    // after a budget stop the later passes are still looked at, but only to
    // list the fixes switched off in them — so their badges don't vanish
    if (stopped && !off.size) break
    const ctx = buildContext(work, env0)
    const cands = pass.flatMap(detect => detect(ctx)).sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const seen = new Set<string>()
    for (const cand of cands) {
      if (seen.has(cand.id)) continue
      seen.add(cand.id)
      const spot = spotIn(work, cand)
      if (off.has(cand.id)) { tried.push({ cand, on: false, spot }); continue }
      if (stopped || now() - t0 > budget) { stopped = true; continue }
      const snap = cloneDoc(work), snapAlias = new Map(alias), snapGuides = new Map(guides)
      if (tryApply(work, cand, { held, base, alias, guides, openOnly: !!o.openOnly })) { tried.push({ cand, on: true, spot }); continue }
      work = snap
      alias.clear()
      for (const [k, v] of snapAlias) alias.set(k, v)
      guides = snapGuides
    }
  }
  const fixes: CleanupFix[] = []
  for (const { cand, on, spot } of tried) {
    // where its points are now; where they were when it was tried if a later fix took them all away
    const at = spotIn(work, cand) ?? spot
    if (at) fixes.push({ id: cand.id, kind: cand.kind, label: cand.label, on, at })
  }
  return stopped ? { doc: work, fixes, stopped } : { doc: work, fixes }
}

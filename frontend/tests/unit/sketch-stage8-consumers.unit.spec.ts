// tests/unit/sketch-stage8-consumers.unit.spec.ts
// Pen stage 8: every consumer of the rules knows offsetLine / offsetRadius /
// translatedFrom — trim, Cut, Dissolve, merging points, delete, Mirror copies,
// Copy / Paste / resize, Clean up (joining, copy points, no fights), the rule
// checks — so none is ever left dangling, pulling the drawing invisibly.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addCircle, addConstraint, deleteEntity, mirrorEntities } from '~/lib/sketch/edit'
import { cutAt, removeSpan, dissolveAt, mergePoints } from '~/lib/sketch/trim'
import { spanAt } from '~/lib/sketch/crossings'
import { extractPieces, insertPieces, scalePieces } from '~/lib/sketch/clipboard'
import { joinsParts } from '~/lib/sketch/cleanup/guards'
import { copyPoints } from '~/lib/sketch/cleanup/context'
import { runCleanup } from '~/lib/sketch/cleanup'
import { checkRule, quickRuleCheck } from '~/lib/sketch/ruleCheck'
import { constraintResiduals } from '~/lib/sketch/residuals'
import { solve } from '~/lib/sketch/solve'

const doc = (): SketchDoc => ({ entities: [], constraints: [] })
const rules = (d: SketchDoc, kind: string) => d.constraints.filter(c => c.kind === kind)
/** every rule's refs resolve to something in the drawing */
function noDangling(d: SketchDoc) {
  const ids = new Set(d.entities.map(e => e.id))
  for (const c of d.constraints) for (const r of c.refs) expect(ids.has(r), `${c.kind} ${c.id} → ${r}`).toBe(true)
}
/** a source path line A→B (one piece) and an offset copy's two ends P, Q at +1 */
function offsetPair() {
  const d = doc()
  const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0)
  const src = addPath(d, [a, b], [{ kind: 'line' }])
  const p = addPoint(d, 0, 1), q = addPoint(d, 10, 1)
  const cp = addPath(d, [p, q], [{ kind: 'line' }])
  const k1 = addConstraint(d, 'offsetLine', [a, b, p], 1), k2 = addConstraint(d, 'offsetLine', [a, b, q], 1)
  return { d, a, b, p, q, src, cp, k1, k2 }
}

describe('trim, Cut, Dissolve, merging points', () => {
  it('Cut: each offsetLine goes to the half of its source nearest its offset point', () => {
    const { d, src, p, q } = offsetPair()
    expect(cutAt(d, { kind: 'seg', pathId: src, segIndex: 0 }, 0.5)).not.toBeNull()
    const P = (id: EntityId) => d.entities.find(e => e.id === id) as any
    for (const c of rules(d, 'offsetLine')) {
      const [a, b, pt] = c.refs.map(P)
      const midX = (a.x + b.x) / 2
      expect(Math.abs(midX - pt.x)).toBeLessThan(3)   // the near half (the whole line's middle is 5 away)
    }
    expect(constraintResiduals(d).every(v => Math.abs(v) < 1e-9)).toBe(true)
    noDangling(d)
    void p; void q
  })
  it('Trim away a source side whose ends stay: its offsetLines go (counted), none names a gone piece', () => {
    const d = doc()
    const [a, b, c, e] = [[0, 0], [10, 0], [10, 10], [0, 10]].map(([x, y]) => addPoint(d, x!, y!))
    const sq = addPath(d, [a!, b!, c!, e!], [{ kind: 'line' }, { kind: 'line' }, { kind: 'line' }, { kind: 'line' }], true)
    const p = addPoint(d, 0, -1), q = addPoint(d, 10, -1)
    addPath(d, [p, q], [{ kind: 'line' }])
    addConstraint(d, 'offsetLine', [a!, b!, p], -1); addConstraint(d, 'offsetLine', [a!, b!, q], -1)
    const r = removeSpan(d, spanAt(d, { kind: 'seg', pathId: sq, segIndex: 0 }, 0.5)!)
    expect(r.ok).toBe(true)
    expect(d.entities.some(x => x.id === a) && d.entities.some(x => x.id === b)).toBe(true)
    expect(rules(d, 'offsetLine')).toHaveLength(0)
    expect(r.droppedRules).toBe(2)
    noDangling(d)
  })
  it('Dissolve two collinear source pieces: the rules follow onto the one piece', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), m = addPoint(d, 5, 0), b = addPoint(d, 10, 0)
    const path = addPath(d, [a, m, b], [{ kind: 'line' }, { kind: 'line' }])
    const p = addPoint(d, 2, 1)
    addConstraint(d, 'offsetLine', [a, m, p], 1)
    expect(dissolveAt(d, path, 1, 1e-6, 0.5).ok).toBe(true)
    expect(rules(d, 'offsetLine').map(c => c.refs)).toEqual([[a, b, p]])
  })
  it('merging points drops what became meaningless', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 4, 0), p = addPoint(d, 1, 1), f = addPoint(d, 0, 3), t = addPoint(d, 1, 3), cp = addPoint(d, 2, 2)
    addLine(d, a, b)
    addConstraint(d, 'offsetLine', [a, b, p], 1)
    addConstraint(d, 'translatedFrom', [cp, p, f, t], 1)
    mergePoints(d, t, f)                 // from = to
    expect(rules(d, 'translatedFrom')).toHaveLength(0)
    mergePoints(d, p, a)                 // P onto its own line's end
    expect(rules(d, 'offsetLine')).toHaveLength(0)
  })
  it('an offsetRadius pair follows its arc when the arc is cut', () => {
    const d = doc()
    const c = addPoint(d, 0, 0), s = addPoint(d, 3, 0), e = addPoint(d, -3, 0), t = addPoint(d, 2, 0), u = addPoint(d, -2, 0)
    const arc = addPath(d, [s, e], [{ kind: 'arc', center: c, sweep: 1 }])
    addPath(d, [t, u], [{ kind: 'arc', center: c, sweep: 1 }])
    addConstraint(d, 'offsetRadius', [c, s, c, t], -1)
    expect(cutAt(d, { kind: 'seg', pathId: arc, segIndex: 0 }, 0.5)).not.toBeNull()
    expect(rules(d, 'offsetRadius')).toHaveLength(1)
    expect(constraintResiduals(d).every(v => Math.abs(v) < 1e-9)).toBe(true)
    noDangling(d)
  })
})

describe('delete, Mirror, Copy / Paste, resize', () => {
  it('deleting the source line drops its offsetLines', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0), p = addPoint(d, 0, 1)
    const l = addLine(d, a, b)
    addPath(d, [p, addPoint(d, 10, 1)], [{ kind: 'line' }])
    addConstraint(d, 'offsetLine', [a, b, p], 1)
    deleteEntity(d, l)
    expect(rules(d, 'offsetLine')).toHaveLength(0)
    noDangling(d)
  })
  it('a Mirror copy of an offset pair keeps the copy on the mirrored side', () => {
    const { d, src, cp } = offsetPair()
    const ax1 = addPoint(d, -5, -5), ax2 = addPoint(d, -5, 5)
    const axis = addLine(d, ax1, ax2, { construction: true })
    mirrorEntities(d, [src, cp], axis)
    expect(constraintResiduals(d).every(v => Math.abs(v) < 1e-9)).toBe(true)
    expect(rules(d, 'offsetLine').filter(c => c.value === -1)).toHaveLength(2)
  })
  it('Copy / Paste re-points every ref; resize scales, upside down flips the side', () => {
    const { d, src, cp } = offsetPair()
    const clip = extractPieces(d, [src, cp], [])
    expect(rules(clip, 'offsetLine')).toHaveLength(2)
    const big = scalePieces(clip, 2)
    expect(rules(big, 'offsetLine').map(c => c.value)).toEqual([2, 2])
    const flipped = scalePieces(clip, 1, true)
    expect(rules(flipped, 'offsetLine').map(c => c.value)).toEqual([-1, -1])
    expect(constraintResiduals(flipped).every(v => Math.abs(v) < 1e-9)).toBe(true)
    const before = new Set(d.entities.map(e => e.id))
    insertPieces(d, clip, { x: 0, y: 5 })
    const pasted = d.constraints.filter(c => c.kind === 'offsetLine' && c.refs.every(r => !before.has(r)))
    expect(pasted).toHaveLength(2)
    noDangling(d)
  })
})

describe('Clean up and the rule checks', () => {
  it('the three kinds join parts; offset points and linear copies are copies', () => {
    const { d, p, q } = offsetPair()
    const f = addPoint(d, 0, 5), t = addPoint(d, 3, 5), o = addPoint(d, 20, 20), c = addPoint(d, 23, 20)
    addConstraint(d, 'translatedFrom', [c, o, f, t], 1)
    for (const k of d.constraints) expect(joinsParts(k)).toBe(true)
    const copies = copyPoints(d)
    expect([...copies].sort()).toEqual([c, p, q].sort())
  })
  it('Clean up proposes nothing between a source and its offset copy', () => {
    const { d } = offsetPair()
    const r = runCleanup(d, { unitsPerPx: 0.05, strength: 'strong', scope: null, off: new Set(), budgetMs: 1e9 })
    expect(r.fixes.filter(f => f.kind === 'parallel' || f.kind === 'equalLength')).toHaveLength(0)
  })
  it('Parallel between a source and its offset copy is already true', () => {
    const { d, a, b, p, q } = offsetPair()
    const spec = { kind: 'parallel' as const, refs: [a, b, p, q] }
    expect(quickRuleCheck(d, spec)).toBe('ok')           // no equivalent rule written: the cheap check allows it
    expect(checkRule(d, spec)).toBe('already')           // the full check finds it implied
  })
})

// Fix round 1 (review-t2-verdict.md):
// Important — trimming an end of the offset copy itself must re-aim that end's
// offsetLine (Q → the new end), not drop it: the copy is still the same offset
// line, just shorter. Minor — the new deleteEntity path-segment branch needs its
// own test, and trimming a SOURCE circle named as a plain circle id in an
// offsetRadius must re-aim that operand onto the arc it becomes, not drop it.
describe('Fix round 1: trimming the copy itself, and the new consumer branches', () => {
  it('trimming the offset copy’s own end re-aims its offsetLine; the copy stays parallel when the source turns', () => {
    const { d, a, b, cp } = offsetPair()
    ;(d.entities.find(e => e.id === a) as { fixed?: boolean }).fixed = true
    // a cutter crossing the copy (P(0,1)–Q(10,1)) at x=7
    const c1 = addPoint(d, 7, -5), c2 = addPoint(d, 7, 5)
    addLine(d, c1, c2)
    const span = spanAt(d, { kind: 'seg', pathId: cp, segIndex: 0 }, 0.95)   // near Q's end (t≈1)
    expect(span).not.toBeNull()
    const r = removeSpan(d, span!)
    expect(r.ok).toBe(true)
    expect(r.droppedRules).toBe(0)                       // re-aimed, not dropped
    expect(rules(d, 'offsetLine')).toHaveLength(2)        // both ends still tied
    // turn the source line: the copy stays parallel at distance 1
    expect(solve(d, { drag: { point: b, x: 0, y: 4 } }).converged).toBe(true)
    expect(constraintResiduals(d).every(v => Math.abs(v) < 1e-4)).toBe(true)   // solve's own tolerance (default 1e-6 on the norm)
    noDangling(d)
  })
  it('deleting a path source keeps its offsetLine while another piece still spans the same two points, drops it once none does', () => {
    const d = doc()
    const a = addPoint(d, 0, 0), b = addPoint(d, 10, 0), p = addPoint(d, 0, 1)
    const path = addPath(d, [a, b], [{ kind: 'line' }])
    const spare = addLine(d, a, b)   // a second entity spans the same two points
    addPath(d, [p, addPoint(d, 10, 1)], [{ kind: 'line' }])
    addConstraint(d, 'offsetLine', [a, b, p], 1)
    deleteEntity(d, path)
    expect(rules(d, 'offsetLine')).toHaveLength(1)       // the spare line a–b still spans it
    deleteEntity(d, spare)
    expect(rules(d, 'offsetLine')).toHaveLength(0)       // nothing spans a–b any more
    noDangling(d)
  })
  it('trimming a SOURCE circle into an arc re-aims an offsetRadius that named it as a plain circle', () => {
    const d = doc()
    const C = addPoint(d, 0, 0)
    const circ = addCircle(d, C, 5)
    const cc = addPoint(d, 20, 0), ct = addPoint(d, 23, 0)   // an unrelated copy operand [C, T]
    addConstraint(d, 'offsetRadius', [circ, cc, ct], -1)
    addLine(d, addPoint(d, 0, -10), addPoint(d, 0, 10))       // crosses the circle at (0,±5)
    const res = removeSpan(d, spanAt(d, { kind: 'circle', id: circ }, 0)!)   // right half removed
    expect(res.ok).toBe(true)
    expect(res.droppedRules).toBe(0)                          // re-aimed, not dropped
    const k = rules(d, 'offsetRadius')[0]!
    expect(k.refs[0]).toBe(C)                                 // the circle id is gone, replaced by [C, x1]
    expect(k.refs[2]).toBe(cc); expect(k.refs[3]).toBe(ct)     // the other operand is untouched
    noDangling(d)
  })
})

// Fix round 2 (re-review): the round-1 re-aim only checked c.refs[2] === ev.from,
// so trimming an UNRELATED line that merely shares the offset copy's end point (a
// T-junction) silently re-pointed the offsetLine at a point on that other line.
// Fixed by requiring the trimmed pair's OTHER end to carry the sibling offsetLine
// on the same source (Ruling 10: both ends of a straight offset are pinned).
describe('Fix round 2: an unrelated line sharing the copy’s end point must not steal its offsetLine', () => {
  it('trimming a T-junction line at the offset copy’s end leaves the offsetLine alone', () => {
    const { d, a, b, p, q } = offsetPair()
    const rr = addPoint(d, 0, 6)
    const l = addLine(d, p, rr)         // an unrelated line L = (P, R) sharing the copy's end P
    // a cutter crossing L near its P end
    const c1 = addPoint(d, -5, 2), c2 = addPoint(d, 5, 2)
    addLine(d, c1, c2)
    const span = spanAt(d, { kind: 'line', id: l }, 0.15)   // the piece nearest P
    expect(span).not.toBeNull()
    const r = removeSpan(d, span!)
    expect(r.ok).toBe(true)
    expect(r.droppedRules).toBe(0)
    // both offsetLines still name the original ends, untouched by L's trim
    expect(rules(d, 'offsetLine').map(c => c.refs)).toEqual([[a, b, p], [a, b, q]])
    noDangling(d)
  })
})

// tests/unit/sketch-stage8-consumers.unit.spec.ts
// Pen stage 8: every consumer of the rules knows offsetLine / offsetRadius /
// translatedFrom — trim, Cut, Dissolve, merging points, delete, Mirror copies,
// Copy / Paste / resize, Clean up (joining, copy points, no fights), the rule
// checks — so none is ever left dangling, pulling the drawing invisibly.
import { describe, it, expect } from 'vitest'
import type { SketchDoc, EntityId } from '~/lib/sketch/model'
import { addPoint, addLine, addPath, addConstraint, deleteEntity, mirrorEntities } from '~/lib/sketch/edit'
import { cutAt, removeSpan, dissolveAt, mergePoints } from '~/lib/sketch/trim'
import { spanAt } from '~/lib/sketch/crossings'
import { extractPieces, insertPieces, scalePieces } from '~/lib/sketch/clipboard'
import { joinsParts } from '~/lib/sketch/cleanup/guards'
import { copyPoints } from '~/lib/sketch/cleanup/context'
import { runCleanup } from '~/lib/sketch/cleanup'
import { checkRule, quickRuleCheck } from '~/lib/sketch/ruleCheck'
import { constraintResiduals } from '~/lib/sketch/residuals'

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

// morph rides the F3 sibling rail (like boolean) but its blend engine (app/lib/vector/morph.ts)
// is PURE + SYNCHRONOUS — no paper.js, no DOM — so the default node env is right here and there
// is no warm to wait on. These tests drive the maths THROUGH `applyGeometry` (the real dispatch
// + cache path) with a stubbed `resolveSibling`, exactly as the boolean spec does.
import { describe, it, expect } from 'vitest'
import { applyGeometry, type ResolvedSibling } from '~/lib/compositor/geometryEffects'
import { flatten, type Pt2 } from '~/lib/vector/pathOps'

// Two concentric squares that SHARE a command skeleton (M L L L Z), so blendPath takes its
// exact branch and lerps vertex-for-vertex: self is 100×100 (area 10000), the sibling is 50×50
// (area 2500). A halfway blend is therefore a 75×75 square (area 5625) — strictly between.
const SELF = 'M0 0 L100 0 L100 100 L0 100 Z'
const SIB = 'M0 0 L50 0 L50 50 L0 50 Z'
const W = 100

// Absolute area over all subpaths (shoelace magnitude), robust to paper/morph output formatting.
function absArea(d: string): number {
  let total = 0
  for (const sub of flatten(d)) {
    let a = 0
    const pts = sub.pts
    for (let i = 0, n = pts.length; i < n; i++) {
      const p = pts[i]!, q = pts[(i + 1) % n]!
      a += p.x * q.y - q.x * p.y
    }
    total += Math.abs(a) / 2
  }
  return total
}
const hasPointNear = (d: string, q: Pt2, tol = 1) =>
  flatten(d).some(s => s.pts.some(p => Math.hypot(p.x - q.x, p.y - q.y) <= tol))

const resolver = (d: string): ((key: string) => ResolvedSibling | null) =>
  (key: string) => (key === 'l:sib' ? { d, W, subKey: `l:sib#${d}` } : null)

// ── byte-identity: no morph effect leaves the outline exactly as HEAD ─────────────
describe('geometryEffects morph: byte-identity', () => {
  it('an empty stack is reference-identity (a morph resolver changes nothing)', () => {
    expect(applyGeometry(SELF, [], { W, resolveSibling: resolver(SIB) })).toBe(SELF)
  })
  it('a non-morph stack is unaffected by supplying a morph resolver', () => {
    const eff = [{ type: 'round_corners', radius: 0, visible: true }]
    // round_corners radius 0 is identity, so the whole stack returns self unchanged.
    expect(applyGeometry(SELF, eff, { W, resolveSibling: resolver(SIB) })).toBe(SELF)
  })
  it('a morph effect with NO ref is a no-op — self d unchanged', () => {
    const out = applyGeometry(SELF, [{ type: 'morph', amount: 0.5, visible: true }], { W, resolveSibling: resolver(SIB) })
    expect(out).toBe(SELF)
  })
})

// ── the blend maths through applyGeometry ─────────────────────────────────────────
describe('geometryEffects morph: blend toward the sibling', () => {
  it('amount 0 short-circuits to self d (byte-identical, no resample drift)', () => {
    const out = applyGeometry(SELF, [{ type: 'morph', amount: 0, refLayerId: 'l:sib', visible: true }], { W, resolveSibling: resolver(SIB) })
    expect(out).toBe(SELF)
  })
  it('a negligible amount (≤ epsilon) also short-circuits to self d', () => {
    const out = applyGeometry(SELF, [{ type: 'morph', amount: 1e-5, refLayerId: 'l:sib', visible: true }], { W, resolveSibling: resolver(SIB) })
    expect(out).toBe(SELF)
  })
  it('amount 1 becomes the sibling shape (area 2500, a vertex at the sibling corner)', () => {
    const out = applyGeometry(SELF, [{ type: 'morph', amount: 1, refLayerId: 'l:sib', visible: true }], { W, resolveSibling: resolver(SIB) })
    expect(absArea(out)).toBeCloseTo(2500, 0)
    expect(hasPointNear(out, { x: 50, y: 50 })).toBe(true)
  })
  it('amount 0.5 is strictly between the two shapes (area 5625, a vertex halfway)', () => {
    const out = applyGeometry(SELF, [{ type: 'morph', amount: 0.5, refLayerId: 'l:sib', visible: true }], { W, resolveSibling: resolver(SIB) })
    const area = absArea(out)
    expect(area).toBeGreaterThan(2500)
    expect(area).toBeLessThan(10000)
    expect(area).toBeCloseTo(5625, 0)
    expect(hasPointNear(out, { x: 75, y: 75 })).toBe(true)
  })
  it('a dangling ref (resolver returns null) is a no-op — self d unchanged', () => {
    const out = applyGeometry(SELF, [{ type: 'morph', amount: 0.5, refLayerId: 'l:missing', visible: true }], { W, resolveSibling: resolver(SIB) })
    expect(out).toBe(SELF)
  })
  it('no resolver at all is a no-op — self d unchanged', () => {
    const out = applyGeometry(SELF, [{ type: 'morph', amount: 0.5, refLayerId: 'l:sib', visible: true }], { W })
    expect(out).toBe(SELF)
  })
  it('an invisible morph effect is filtered out entirely (identity)', () => {
    const out = applyGeometry(SELF, [{ type: 'morph', amount: 0.5, refLayerId: 'l:sib', visible: false }], { W, resolveSibling: resolver(SIB) })
    expect(out).toBe(SELF)
  })
})

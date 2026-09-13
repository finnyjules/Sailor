// Default (node) environment on purpose: paper.js runs headless in node (it resolves its own
// canvas backend), whereas happy-dom's partial <canvas> makes paper's `setup` throw and the
// scope never warms. `applyGeometry` and `booleanGeometry` are DOM-free, so node is right here.
import { describe, it, expect, beforeAll } from 'vitest'
import { pathBoolean, isPaperWarm, warmPaperBoolean, booleanOpOf, BOOLEAN_OPS } from '~/lib/compositor/booleanGeometry'
import { applyGeometry, type ResolvedSibling } from '~/lib/compositor/geometryEffects'
import { flatten, type Pt2 } from '~/lib/vector/pathOps'

// Two 100×100 squares overlapping in a 50×50 region.
const A = 'M0 0 L100 0 L100 100 L0 100 Z'
const B = 'M50 50 L150 50 L150 150 L50 150 Z'
const W = 100

// Even-odd ray cast over EVERY subpath of a `d` — the honest "is this point in the boolean
// region" test for these disjoint-subpath results (unite is one subpath; subtract/intersect
// are single shapes; exclude is two disjoint L-shapes). Robust to paper's relative-command,
// comma-separated output because it goes through the same `flatten` the render path uses.
function inside(d: string, p: Pt2): boolean {
  let crossings = 0
  for (const sub of flatten(d)) {
    const pts = sub.pts
    for (let i = 0, n = pts.length; i < n; i++) {
      const a = pts[i]!, b = pts[(i + 1) % n]!
      if ((a.y > p.y) !== (b.y > p.y)) {
        const t = (p.y - a.y) / (b.y - a.y)
        if (p.x < a.x + t * (b.x - a.x)) crossings++
      }
    }
  }
  return crossings % 2 === 1
}
// Absolute area over all subpaths (shoelace, summed as magnitudes) — for disjoint pieces this
// is the true combined area regardless of per-subpath winding.
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

const ONLY_A: Pt2 = { x: 25, y: 25 }    // in A, not B
const ONLY_B: Pt2 = { x: 125, y: 125 }  // in B, not A
const OVERLAP: Pt2 = { x: 75, y: 75 }   // in both
const OUTSIDE: Pt2 = { x: 200, y: 200 } // in neither

// ── Byte-identity FIRST: a non-boolean stack must never load paper ───────────────
// This block runs before any warm, so `isPaperWarm()` proves paper stays cold when no boolean
// effect is present — the byte-identity headline (no boolean ⇒ paper NOT loaded).
describe('booleanGeometry: no boolean effect never loads paper', () => {
  it('paper is cold at import time', () => {
    expect(isPaperWarm()).toBe(false)
  })
  it('a non-boolean applyGeometry leaves paper cold and is identity for an empty stack', () => {
    // round_corners only — a geometry effect that does NOT touch paper.
    const out = applyGeometry(A, [{ type: 'round_corners', radius: 0.05, visible: true }], { W })
    expect(typeof out).toBe('string')
    expect(isPaperWarm()).toBe(false) // never warmed by a non-boolean path
    // Empty stack is reference-identity, and passing a resolveSibling changes nothing.
    const stub = () => null
    expect(applyGeometry(A, [], { W, resolveSibling: stub })).toBe(A)
  })
  it('a boolean effect with NO ref is a no-op and still does not need paper', () => {
    const out = applyGeometry(A, [{ type: 'boolean', op: 'unite', visible: true }], { W })
    expect(out).toBe(A) // no refLayerId → applyBoolean returns d before touching paper
    expect(isPaperWarm()).toBe(false)
  })
})

// ── The paper maths (warm the scope, then run sync) ──────────────────────────────
describe('booleanGeometry: pathBoolean maths', () => {
  beforeAll(async () => {
    await warmPaperBoolean()
  })

  it('warms a detached scope', () => {
    expect(isPaperWarm()).toBe(true)
  })

  it('unite covers both squares, including only-A, only-B and the overlap', () => {
    const d = pathBoolean(A, B, 'unite')
    expect(inside(d, ONLY_A)).toBe(true)
    expect(inside(d, ONLY_B)).toBe(true)
    expect(inside(d, OVERLAP)).toBe(true)
    expect(inside(d, OUTSIDE)).toBe(false)
    // 2·10000 − 2500 overlap = 17500.
    expect(absArea(d)).toBeCloseTo(17500, 0)
  })

  it('intersect keeps only the 50×50 overlap', () => {
    const d = pathBoolean(A, B, 'intersect')
    expect(inside(d, OVERLAP)).toBe(true)
    expect(inside(d, ONLY_A)).toBe(false)
    expect(inside(d, ONLY_B)).toBe(false)
    expect(absArea(d)).toBeCloseTo(2500, 0)
  })

  it('subtract removes B from A (overlap gone, only-A kept)', () => {
    const d = pathBoolean(A, B, 'subtract')
    expect(inside(d, ONLY_A)).toBe(true)
    expect(inside(d, OVERLAP)).toBe(false)
    expect(inside(d, ONLY_B)).toBe(false)
    expect(absArea(d)).toBeCloseTo(7500, 0)
  })

  it('exclude keeps both non-overlapping parts, drops the overlap', () => {
    const d = pathBoolean(A, B, 'exclude')
    expect(inside(d, ONLY_A)).toBe(true)
    expect(inside(d, ONLY_B)).toBe(true)
    expect(inside(d, OVERLAP)).toBe(false)
    expect(absArea(d)).toBeCloseTo(15000, 0) // 17500 − 2500 overlap counted once
  })

  it('an empty sibling is a no-op (returns self unchanged)', () => {
    expect(pathBoolean(A, '', 'unite')).toBe(A)
    expect(pathBoolean('', B, 'unite')).toBe('')
  })

  it('booleanOpOf coerces junk to unite and passes valid ops through', () => {
    expect(booleanOpOf('subtract')).toBe('subtract')
    expect(booleanOpOf('nonsense')).toBe('unite')
    expect(booleanOpOf(undefined)).toBe('unite')
    expect([...BOOLEAN_OPS]).toEqual(['unite', 'subtract', 'intersect', 'exclude'])
  })
})

// ── applyGeometry integration through a stubbed resolveSibling ────────────────────
describe('booleanGeometry: applyGeometry integration', () => {
  beforeAll(async () => {
    await warmPaperBoolean()
  })

  const resolver = (d: string): ((key: string) => ResolvedSibling | null) =>
    (key: string) => (key === 'l:sib' ? { d, W, subKey: `l:sib#${d}` } : null)

  it('a boolean effect with a live sibling returns the combined outline', () => {
    const out = applyGeometry(
      A,
      [{ type: 'boolean', op: 'subtract', refLayerId: 'l:sib', visible: true }],
      { W, resolveSibling: resolver(B) },
    )
    expect(inside(out, ONLY_A)).toBe(true)
    expect(inside(out, OVERLAP)).toBe(false)
    expect(absArea(out)).toBeCloseTo(7500, 0)
  })

  it('a dangling ref (resolver returns null) is a no-op — self d unchanged', () => {
    const out = applyGeometry(
      A,
      [{ type: 'boolean', op: 'subtract', refLayerId: 'l:missing', visible: true }],
      { W, resolveSibling: resolver(B) }, // resolver only knows l:sib
    )
    expect(out).toBe(A)
  })

  it('an invisible boolean effect is filtered out entirely (identity)', () => {
    const out = applyGeometry(
      A,
      [{ type: 'boolean', op: 'subtract', refLayerId: 'l:sib', visible: false }],
      { W, resolveSibling: resolver(B) },
    )
    expect(out).toBe(A)
  })

  it('unite via applyGeometry grows the outline to cover the sibling', () => {
    const out = applyGeometry(
      A,
      [{ type: 'boolean', op: 'unite', refLayerId: 'l:sib', visible: true }],
      { W, resolveSibling: resolver(B) },
    )
    expect(inside(out, ONLY_B)).toBe(true)
    expect(absArea(out)).toBeCloseTo(17500, 0)
  })
})

// Default (node) environment on purpose: the shatter clip runs through paper.js, which warms
// headless in node (happy-dom's partial <canvas> makes paper's `setup` throw). `applyGeometry`,
// `voronoi.ts` and `booleanGeometry` are all DOM-free, so node is right here — same rationale as
// compositor-boolean-geometry.unit.spec.ts.
import { describe, it, expect, beforeAll } from 'vitest'
import { applyGeometry } from '~/lib/compositor/geometryEffects'
import { voronoiCells, type VRect } from '~/lib/compositor/voronoi'
import { isPaperWarm, warmPaperBoolean } from '~/lib/compositor/booleanGeometry'
import { flatten, type Pt2 } from '~/lib/vector/pathOps'

const W = 100
// 100×100 square, area 10000. Two byte-DIFFERENT strings for the SAME shape — used to defeat
// the applyGeometry LRU cache and prove the computation itself is deterministic (both flatten to
// the identical four points, so every downstream step must produce byte-equal output).
const SQUARE_A = 'M0 0 L100 0 L100 100 L0 100 Z'
const SQUARE_B = 'M 0 0  L 100 0  L 100 100  L 0 100  Z'
// An L-shape (concave) to prove the paper clip handles a non-convex outline.
const L_SHAPE = 'M0 0 L100 0 L100 40 L40 40 L40 100 L0 100 Z'

const shatter = (over: Record<string, unknown> = {}) =>
  ({ type: 'shatter', cells: 12, gap: 0, seed: 1, visible: true, ...over })

// Absolute area over all subpaths (shoelace magnitudes) — disjoint pieces sum to the true area.
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
const fragmentCount = (d: string): number => flatten(d).length

// ── voronoi.ts (pure, no paper): half-plane cells ────────────────────────────────
describe('voronoi: half-plane cells', () => {
  const RECT: VRect = { x0: 0, y0: 0, x1: 100, y1: 100 }

  it('a single seed owns the whole rectangle', () => {
    const cells = voronoiCells([{ x: 50, y: 50 }], RECT)
    expect(cells).toHaveLength(1)
    expect(cells[0]).not.toBeNull()
    // Area of the whole rect.
    expect(absArea(`M${cells[0]!.map(p => `${p.x} ${p.y}`).join(' L')} Z`)).toBeCloseTo(10000, 0)
  })

  it('two seeds split the rectangle in half along their bisector', () => {
    const cells = voronoiCells([{ x: 25, y: 50 }, { x: 75, y: 50 }], RECT)
    expect(cells).toHaveLength(2)
    // Each cell is half the rect (the bisector is the vertical line x=50).
    for (const c of cells) {
      expect(c).not.toBeNull()
      expect(absArea(`M${c!.map(p => `${p.x} ${p.y}`).join(' L')} Z`)).toBeCloseTo(5000, 0)
    }
  })

  it('cells partition the rectangle: their areas sum to the whole', () => {
    const pts: Pt2[] = [{ x: 20, y: 20 }, { x: 80, y: 30 }, { x: 50, y: 70 }, { x: 30, y: 85 }]
    const cells = voronoiCells(pts, RECT)
    const sum = cells.reduce((a, c) => a + (c ? absArea(`M${c.map(p => `${p.x} ${p.y}`).join(' L')} Z`) : 0), 0)
    expect(sum).toBeCloseTo(10000, 0)
  })

  it('a coincident seed yields no bisector (both cells still tile, one may vanish)', () => {
    const cells = voronoiCells([{ x: 50, y: 50 }, { x: 50, y: 50 }], RECT)
    // Neither clips the other (nx=ny=0 → skipped), so both are the whole rect — never throws.
    for (const c of cells) expect(c === null || c.length >= 3).toBe(true)
  })

  it('is deterministic — identical output on repeat', () => {
    const pts: Pt2[] = [{ x: 10, y: 10 }, { x: 90, y: 20 }, { x: 40, y: 80 }]
    expect(voronoiCells(pts, RECT)).toEqual(voronoiCells(pts, RECT))
  })
})

// ── cold pass-through FIRST (before any warm) ─────────────────────────────────────
// Runs before the beforeAll warm below, so paper is provably cold here.
describe('shatter: cold paper is a pass-through', () => {
  it('paper is cold at import time', () => {
    expect(isPaperWarm()).toBe(false)
  })
  it('a shatter with paper not yet warm returns the outline unchanged (byte-identical)', () => {
    const out = applyGeometry(SQUARE_A, [shatter()], { W })
    expect(out).toBe(SQUARE_A) // one-frame pass-through; the warm is kicked in the background
  })
  it('cells ≤ 0 is a pass-through regardless of warm', () => {
    expect(applyGeometry(SQUARE_A, [shatter({ cells: 0 })], { W })).toBe(SQUARE_A)
  })
  it('an invisible shatter is filtered out entirely (identity)', () => {
    expect(applyGeometry(SQUARE_A, [shatter({ visible: false })], { W })).toBe(SQUARE_A)
  })
})

// ── the real fragmentation (warm the scope, then run sync) ────────────────────────
describe('shatter: applyGeometry fragmentation', () => {
  beforeAll(async () => {
    await warmPaperBoolean()
  })

  it('warms the paper scope', () => {
    expect(isPaperWarm()).toBe(true)
  })

  it('once warm, the same shatter now fragments the shape (no longer the input string)', () => {
    const out = applyGeometry(SQUARE_A, [shatter()], { W })
    // The swarm cache fold flips false→true, so the cold pass-through frame is NOT served.
    expect(out).not.toBe(SQUARE_A)
    expect(fragmentCount(out)).toBeGreaterThan(1)
  })

  it('cells N → at most N fragments, and most survive on a square (bbox == shape)', () => {
    const out = applyGeometry(SQUARE_A, [shatter({ cells: 12 })], { W })
    const count = fragmentCount(out)
    expect(count).toBeLessThanOrEqual(12)
    expect(count).toBeGreaterThanOrEqual(10)
  })

  it('gap 0 → the cells TILE the shape (total area ≈ shape area)', () => {
    const out = applyGeometry(SQUARE_A, [shatter({ gap: 0 })], { W })
    // Voronoi cells clipped to the shape partition it; disjoint, so their areas sum to 10000.
    expect(absArea(out)).toBeCloseTo(10000, -1) // within ~5 px² of the full square
    expect(absArea(out)).toBeLessThanOrEqual(10000.01)
  })

  it('gap > 0 → gaps remove material: total fragment area is well below the shape area', () => {
    const solid = absArea(applyGeometry(SQUARE_A, [shatter({ gap: 0 })], { W }))
    const gapped = absArea(applyGeometry(SQUARE_A, [shatter({ gap: 0.02 })], { W }))
    expect(gapped).toBeLessThan(solid)
    expect(gapped).toBeGreaterThan(0) // but not everything — the shape is still visible
    expect(gapped).toBeLessThan(solid * 0.9)
  })

  it('is DETERMINISTIC: two byte-different strings for the same shape shatter identically', () => {
    // Different cache keys (the `d` strings differ), so both genuinely recompute — proving the
    // pipeline (seeded scatter → voronoi → paper clip → inward offset) is deterministic, not just
    // cache-stable. No Math.random anywhere in the path.
    const a = applyGeometry(SQUARE_A, [shatter({ seed: 7 })], { W })
    const b = applyGeometry(SQUARE_B, [shatter({ seed: 7 })], { W })
    expect(a).toBe(b)
  })

  it('a different seed produces a different fragmentation', () => {
    const s1 = applyGeometry(SQUARE_A, [shatter({ seed: 1 })], { W })
    const s2 = applyGeometry(SQUARE_A, [shatter({ seed: 2 })], { W })
    expect(s1).not.toBe(s2)
  })

  it('clips to a CONCAVE (L-shaped) outline — fragments stay inside the shape', () => {
    const out = applyGeometry(L_SHAPE, [shatter({ gap: 0 })], { W })
    // The L covers 10000 − 3600 (the missing 60×60 top-right corner) = 6400.
    expect(absArea(out)).toBeCloseTo(6400, -1)
    // No fragment point strays into the removed corner (x>40 AND y>40).
    for (const sub of flatten(out)) for (const p of sub.pts) {
      expect(p.x <= 40.5 || p.y <= 40.5).toBe(true)
    }
  })

  it('cells ≤ 0 stays a pass-through even when warm', () => {
    expect(applyGeometry(SQUARE_A, [shatter({ cells: 0 })], { W })).toBe(SQUARE_A)
  })
})

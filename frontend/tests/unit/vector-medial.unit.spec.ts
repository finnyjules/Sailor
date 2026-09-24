import { describe, expect, it } from 'vitest'
import { evalGlyph, pairGlyphs, pinGlyph, type P } from '~/lib/vector/medial'

const square = (x0: number, y0: number, s: number): P[] => [[x0, y0], [x0 + s, y0], [x0 + s, y0 + s], [x0, y0 + s]]
// A hole must wind the other way.
const hole = (x0: number, y0: number, s: number): P[] => square(x0, y0, s).reverse()

describe('medial pinning', () => {
  it('rebuilds every sample exactly at rest and finds a pole for each', () => {
    const g = pinGlyph([square(0, 0, 100), hole(30, 30, 40)], { h: 2 })
    expect(g.restError).toBeLessThan(1e-9)
    expect(g.orphans).toBe(0)
    expect(g.contours.map(c => c.hole)).toEqual([false, true])
    for (const c of g.contours) for (const p of c.pts) { expect(Number.isFinite(p[0])).toBe(true) }
  })
})

describe('medial morph', () => {
  const A = pinGlyph([square(0, 0, 100)], { h: 2 })
  const B = pinGlyph([square(200, 0, 100), hole(230, 30, 40)], { h: 2 })
  const pairs = pairGlyphs(A, B)

  it('pairs outer with outer and leaves the extra hole unmatched', () => {
    expect(pairs.filter(p => p.a && p.b)).toHaveLength(1)
    expect(pairs.filter(p => !p.a && p.b)).toHaveLength(1)
  })

  it('is exactly A at t = 0 and exactly B at t = 1', () => {
    for (const mode of ['linear', 'medial'] as const) {
      const at0 = evalGlyph(pairs, 0, mode)
      const at1 = evalGlyph(pairs, 1, mode)
      const m = pairs.findIndex(p => p.a && p.b)
      const pr = pairs[m]!
      pr.path.forEach(([i, j], k) => {
        expect(Math.hypot(at0[m]![k]![0] - pr.a!.pts[i]![0], at0[m]![k]![1] - pr.a!.pts[i]![1])).toBeLessThan(1e-6)
        expect(Math.hypot(at1[m]![k]![0] - pr.b!.pts[j]![0], at1[m]![k]![1] - pr.b!.pts[j]![1])).toBeLessThan(1e-6)
      })
    }
  })

  it('keeps a hole only B has shut in the first half and inside its carrier', () => {
    const u = pairs.findIndex(p => !p.a && p.b)
    const early = evalGlyph(pairs, 0.25, 'medial')[u]!
    const xs = early.map(p => p[0]), ys = early.map(p => p[1])
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1e-6)   // still a point before halfway
    const outer = evalGlyph(pairs, 0.25, 'medial')[pairs.findIndex(p => p.a && p.b)]!
    const ox = outer.map(p => p[0])
    expect(xs[0]!).toBeGreaterThanOrEqual(Math.min(...ox) - 1e-6)   // rides with the moving outer
    expect(xs[0]!).toBeLessThanOrEqual(Math.max(...ox) + 1e-6)
    const late = evalGlyph(pairs, 0.9, 'medial')[u]!
    const lx = late.map(p => p[0])
    expect(Math.max(...lx) - Math.min(...lx)).toBeGreaterThan(10)   // open again near the end
  })

  it('never produces NaN mid-way', () => {
    for (const t of [0.1, 0.5, 0.77]) for (const ring of evalGlyph(pairs, t, 'medial')) for (const p of ring) {
      expect(Number.isFinite(p[0]) && Number.isFinite(p[1])).toBe(true)
    }
  })
})

import { describe, it, expect } from 'vitest'
import { squareToQuad, applyHomography, type Quad } from '~/lib/compositor/warp'

const at = (q: Quad, u: number, v: number) => applyHomography(squareToQuad(q), u, v)

describe('squareToQuad + applyHomography', () => {
  it('identity quad maps (u,v) → (u,v)', () => {
    const q: Quad = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }]
    for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.3, 0.7], [0.5, 0.5]]) {
      const p = at(q, u!, v!)
      expect(p.x).toBeCloseTo(u!, 6)
      expect(p.y).toBeCloseTo(v!, 6)
    }
  })

  it('the 4 corners map exactly onto the quad (affine rect)', () => {
    const q: Quad = [{ x: 10, y: 20 }, { x: 110, y: 20 }, { x: 110, y: 70 }, { x: 10, y: 70 }]
    expect(at(q, 0, 0)).toMatchObject({ x: expect.closeTo(10), y: expect.closeTo(20) })
    expect(at(q, 1, 0)).toMatchObject({ x: expect.closeTo(110), y: expect.closeTo(20) })
    expect(at(q, 1, 1)).toMatchObject({ x: expect.closeTo(110), y: expect.closeTo(70) })
    expect(at(q, 0, 1)).toMatchObject({ x: expect.closeTo(10), y: expect.closeTo(70) })
    // affine rect → centre is the geometric centre
    const c = at(q, 0.5, 0.5)
    expect(c.x).toBeCloseTo(60); expect(c.y).toBeCloseTo(45)
  })

  it('a trapezoid is a real PROJECTIVE map (corners exact, centre foreshortened)', () => {
    // top edge narrow [20..80] at y=0, bottom edge wide [0..100] at y=100
    const q: Quad = [{ x: 20, y: 0 }, { x: 80, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]
    expect(at(q, 0, 0)).toMatchObject({ x: expect.closeTo(20), y: expect.closeTo(0) })
    expect(at(q, 1, 0)).toMatchObject({ x: expect.closeTo(80), y: expect.closeTo(0) })
    expect(at(q, 1, 1)).toMatchObject({ x: expect.closeTo(100), y: expect.closeTo(100) })
    expect(at(q, 0, 1)).toMatchObject({ x: expect.closeTo(0), y: expect.closeTo(100) })
    const c = at(q, 0.5, 0.5)
    expect(c.x).toBeCloseTo(50, 4)               // symmetric → x stays centred
    expect(Math.abs(c.y - 50)).toBeGreaterThan(1) // ≠ 50 ⇒ projective foreshortening, not affine
    expect(c.y).toBeGreaterThan(0)
    expect(c.y).toBeLessThan(100)
  })
})

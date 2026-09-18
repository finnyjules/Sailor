import { describe, it, expect } from 'vitest'
import { parseShapePolygon } from '~/lib/spacetype/pile/shapeCollider'

describe('parseShapePolygon', () => {
  it('parses a square outline to 4 corners, centred and y-up', () => {
    const poly = parseShapePolygon('M0 0 L10 0 L10 10 L0 10 Z', [0, 0, 10, 10], 10, 10)!
    expect(poly).not.toBeNull()
    expect(poly.length).toBe(4)
    // centred on the ink-box centre → coordinates average to ~0
    const cx = poly.reduce((s, p) => s + p.x, 0) / poly.length
    const cy = poly.reduce((s, p) => s + p.y, 0) / poly.length
    expect(cx).toBeCloseTo(0, 6)
    expect(cy).toBeCloseTo(0, 6)
    // spans the plane (±5 in each axis)
    expect(Math.max(...poly.map(p => Math.abs(p.x)))).toBeCloseTo(5, 6)
    expect(Math.max(...poly.map(p => Math.abs(p.y)))).toBeCloseTo(5, 6)
  })

  it('y is flipped: the SVG top edge (y=0) maps to the largest world-up Y', () => {
    const poly = parseShapePolygon('M0 0 L10 0 L10 10 L0 10 Z', [0, 0, 10, 10], 10, 10)!
    const top = poly[0]! // was SVG (0,0), the top-left
    expect(top.y).toBeGreaterThan(0) // top of the shape is +Y in world space
  })

  it('subdivides a curve into multiple points', () => {
    const poly = parseShapePolygon('M0 0 L10 0 C10 5 5 10 0 10 Z', [0, 0, 10, 10], 10, 10, 8)!
    expect(poly.length).toBeGreaterThan(4) // the C contributed several flattened points
  })

  it('keeps the LARGEST subpath (ignores a small hole/mark)', () => {
    // big 10×10 square + a tiny 1×1 square; the big one wins
    const poly = parseShapePolygon('M0 0 L10 0 L10 10 L0 10 Z M0 0 L1 0 L1 1 L0 1 Z', [0, 0, 10, 10], 10, 10)!
    expect(poly.length).toBe(4)
    expect(Math.max(...poly.map(p => Math.abs(p.x)))).toBeCloseTo(5, 6)
  })

  it('returns null for unusable input', () => {
    expect(parseShapePolygon('', [0, 0, 10, 10], 10, 10)).toBeNull()
    expect(parseShapePolygon('M0 0 L10 0 Z', [0, 0, 10, 10], 10, 10)).toBeNull() // <3 points
    expect(parseShapePolygon('M0 0 L10 0 L10 10 Z', [0, 0, 0, 0], 10, 10)).toBeNull() // degenerate box
  })
})

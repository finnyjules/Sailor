import { describe, it, expect } from 'vitest'
import { offsetPolyline, shapePlacements, shapeStrokeGuide } from '~/lib/compositor/strokeShapes'
import { guideFromPolyline } from '~/lib/compositor/textPath'

describe('offsetPolyline', () => {
  it('returns the points unchanged at distance 0', () => {
    const sq = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]
    expect(offsetPolyline(sq, true, 0)).toEqual(sq)
  })

  it('grows a closed square outward by the distance at every corner', () => {
    const sq = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]
    const out = offsetPolyline(sq, true, 0.5)
    // A square offset outward by 0.5 is the square of half-extent 1.5. Corners are mitred,
    // so each vertex moves along its diagonal to exactly (±1.5, ±1.5).
    for (const p of out) {
      expect(Math.abs(p.x)).toBeCloseTo(1.5, 6)
      expect(Math.abs(p.y)).toBeCloseTo(1.5, 6)
    }
  })

  it('shrinks on a negative distance', () => {
    const sq = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]
    for (const p of offsetPolyline(sq, true, -0.25)) {
      expect(Math.abs(p.x)).toBeCloseTo(0.75, 6)
      expect(Math.abs(p.y)).toBeCloseTo(0.75, 6)
    }
  })

  it('keeps winding-independence — a reversed square still grows outward', () => {
    const cw = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]
    const ccw = [...cw].reverse()
    const a = offsetPolyline(cw, true, 0.5)
    const b = offsetPolyline(ccw, true, 0.5)
    const extent = (ps: { x: number; y: number }[]) => Math.max(...ps.map(p => Math.abs(p.x)))
    expect(extent(a)).toBeCloseTo(1.5, 6)
    expect(extent(b)).toBeCloseTo(1.5, 6)
  })

  it('offsets an OPEN polyline along its segment normals without closing it', () => {
    const line = [{ x: 0, y: 0 }, { x: 2, y: 0 }]
    const out = offsetPolyline(line, false, 1)
    expect(out).toHaveLength(2)
    expect(out.every(p => Math.abs(p.y) === 1)).toBe(true)
  })

  it('drops degenerate input rather than emitting NaN', () => {
    expect(offsetPolyline([{ x: 0, y: 0 }], true, 1)).toEqual([])
    expect(offsetPolyline([{ x: 0, y: 0 }, { x: 0, y: 0 }], true, 1)).toEqual([])
  })
})

describe('shapePlacements', () => {
  it('spreads marks evenly and closes without an overlap at the seam', () => {
    // A closed square of side 2 → perimeter 8. Spacing 1 → exactly 8 marks.
    const g = guideFromPolyline([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }], true)!
    const marks = shapePlacements(g, 1)
    expect(marks).toHaveLength(8)
    const first = marks[0]!, last = marks[7]!
    expect(Math.hypot(first.x - last.x, first.y - last.y)).toBeGreaterThan(0.5)
  })

  it('rounds the count so an indivisible spacing has no seam gap', () => {
    const g = guideFromPolyline([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }], true)!
    // perimeter 8, spacing 0.7 → round(11.43) = 11 marks, actual step 8/11.
    const marks = shapePlacements(g, 0.7)
    expect(marks).toHaveLength(11)
  })

  it('returns nothing for a non-positive or absurdly small spacing', () => {
    const g = guideFromPolyline([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }], true)!
    expect(shapePlacements(g, 0)).toEqual([])
    expect(shapePlacements(g, -1)).toEqual([])
    // A spacing that would ask for more than the cap yields the cap, not a hang.
    expect(shapePlacements(g, 1e-6).length).toBeLessThanOrEqual(2000)
  })

  it('carries the tangent angle so a mark can turn with the edge', () => {
    const g = guideFromPolyline([{ x: -1, y: 0 }, { x: 1, y: 0 }], false)!
    const [m] = shapePlacements(g, 1)
    expect(m!.angle).toBeCloseTo(0, 6)
  })
})

describe('shapeStrokeGuide', () => {
  it('builds a closed guide from a path string at a distance', () => {
    const g = shapeStrokeGuide('M -1 -1 L 1 -1 L 1 1 L -1 1 Z', 0)!
    expect(g).toBeTruthy()
    expect(g.closed).toBe(true)
    expect(g.length).toBeCloseTo(8, 3)
    const grown = shapeStrokeGuide('M -1 -1 L 1 -1 L 1 1 L -1 1 Z', 0.5)!
    expect(grown.length).toBeCloseTo(12, 3)   // side 3 → perimeter 12
  })

  it('is null for an empty or unparseable path rather than throwing', () => {
    expect(shapeStrokeGuide('', 0)).toBeNull()
    expect(shapeStrokeGuide('not a path', 0)).toBeNull()
  })
})

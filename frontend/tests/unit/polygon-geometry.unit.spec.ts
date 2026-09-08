import { describe, it, expect } from 'vitest'
import {
  polygonVertices, starVertices, roundedPolygonPath, polygonPathData, starPathData,
  roundedRectPathData, ellipsePathData,
} from '~/lib/compositor/polygonGeometry'
import { flattenPath } from '~/lib/compositor/pathFlatten'

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps

describe('polygonVertices', () => {
  it('returns `sides` vertices, first at top', () => {
    const v = polygonVertices(4, 2, 2) // rx=ry=1
    expect(v).toHaveLength(4)
    expect(near(v[0].x, 0)).toBe(true)
    expect(near(v[0].y, -1)).toBe(true)   // top
  })
  it('a 4-gon is a diamond on the axes', () => {
    const v = polygonVertices(4, 2, 2)
    expect(near(v[1].x, 1) && near(v[1].y, 0)).toBe(true)   // right
    expect(near(v[2].x, 0) && near(v[2].y, 1)).toBe(true)   // bottom
    expect(near(v[3].x, -1) && near(v[3].y, 0)).toBe(true)  // left
  })
  it('respects the (w/2,h/2) ellipse radii', () => {
    const v = polygonVertices(4, 4, 2) // rx=2, ry=1
    expect(near(v[1].x, 2)).toBe(true)
    expect(near(v[2].y, 1)).toBe(true)
  })
  it('clamps sides below 3 up to 3', () => {
    expect(polygonVertices(2, 2, 2)).toHaveLength(3)
    expect(polygonVertices(4.6, 2, 2)).toHaveLength(5) // rounds
  })
})

describe('starVertices', () => {
  it('returns 2*points vertices, alternating outer/inner radii', () => {
    const v = starVertices(5, 0.5, 2, 2) // outer r=1, inner r=0.5
    expect(v).toHaveLength(10)
    expect(near(Math.hypot(v[0].x, v[0].y), 1)).toBe(true)    // outer
    expect(near(Math.hypot(v[1].x, v[1].y), 0.5)).toBe(true)  // inner
    expect(near(v[0].x, 0) && near(v[0].y, -1)).toBe(true)    // first outer at top
  })
  it('clamps innerRatio into (0.01, 0.99) and points to >=3', () => {
    expect(starVertices(2, 5, 2, 2)).toHaveLength(6) // points clamped to 3 -> 6 verts
    const v = starVertices(4, 5, 2, 2) // innerRatio clamped to 0.99
    expect(Math.hypot(v[1].x, v[1].y)).toBeLessThanOrEqual(0.99 + 1e-9)
  })
})

describe('roundedPolygonPath', () => {
  it('cornerRadius 0 yields a straight M/L/Z path (no arcs)', () => {
    const d = roundedPolygonPath(polygonVertices(4, 2, 2), 0)
    expect(d.startsWith('M ')).toBe(true)
    expect(d.includes('L ')).toBe(true)
    expect(d.trim().endsWith('Z')).toBe(true)
    expect(d.includes('Q')).toBe(false)
  })
  it('cornerRadius > 0 introduces quadratic arcs', () => {
    const d = roundedPolygonPath(polygonVertices(4, 2, 2), 0.5)
    expect(d.includes('Q')).toBe(true)
    expect(d.trim().endsWith('Z')).toBe(true)
  })
  it('returns empty for < 3 vertices', () => {
    expect(roundedPolygonPath([{ x: 0, y: 0 }, { x: 1, y: 1 }], 0.5)).toBe('')
  })
})

describe('polygonPathData / starPathData', () => {
  it('produce non-empty paths for valid sizes', () => {
    expect(polygonPathData(6, 0.24, 0.24, 0).length).toBeGreaterThan(0)
    expect(starPathData(5, 0.5, 0.24, 0.24, 0.2).length).toBeGreaterThan(0)
  })
  it('return empty string when w or h is ~0', () => {
    expect(polygonPathData(6, 0, 0.24, 0)).toBe('')
    expect(starPathData(5, 0.5, 0.24, 0, 0)).toBe('')
  })
})

/**
 * PATH DATA FOR THE TWO KINDS THAT HAD NONE (shapes stroke, Task 6).
 *
 * A shapes stroke marches library marks along the layer's outline, and it needs that
 * outline as a PATH STRING to flatten. Polygon and star already had one; rect and ellipse
 * were only ever drawn as canvas primitives (`ctx.roundRect`, `ctx.ellipse`).
 *
 * These two helpers must agree EXACTLY with what the painter draws — a path string that is
 * a few pixels off puts every mark a few pixels off the real edge, and nothing in the app
 * would say so. Agreement is asserted two ways: analytically here (every flattened point
 * is on the true boundary, to a tolerance far tighter than a pixel), and against the actual
 * canvas primitive in `tests/compositor-multi-stroke.spec.ts`, which fills
 * `new Path2D(roundedRectPathData(...))` and `ctx.roundRect(...)` on two canvases and
 * compares the rasters.
 */
describe('roundedRectPathData', () => {
  it('emits a plain four-line rect when every radius is zero', () => {
    const d = roundedRectPathData(-10, -5, 20, 10, 0, 0, 0, 0)
    expect(d).toBe('M -10 -5 L 10 -5 L 10 5 L -10 5 Z')
    expect(d.includes('A')).toBe(false)
  })

  it('starts at the top edge offset by the top-left radius, and runs L A × 4 clockwise', () => {
    const d = roundedRectPathData(-10, -5, 20, 10, 2, 2, 2, 2)
    expect(d.startsWith('M -8 -5')).toBe(true)          // x + tl, y
    // Command letters in order: the top-left corner's arc is the LAST one, closing the ring.
    expect(d.replace(/[^MLAZ]/g, '')).toBe('MLALALALAZ')
    // Sweep flag 1 on every arc: clockwise on a y-down canvas, the direction
    // `ctx.roundRect` itself traces.
    expect(d.match(/A [^A]*?0 0 1 /g)).toHaveLength(4)
    expect(d.trim().endsWith('Z')).toBe(true)
  })

  it('omits the arc for a corner whose radius is zero, so a mixed rect keeps square corners', () => {
    const d = roundedRectPathData(0, 0, 20, 10, 4, 0, 0, 0)
    expect(d.replace(/[^MLAZ]/g, '')).toBe('MLLLLAZ')
  })

  it('traces the TRUE rounded rect — every flattened point is exactly `r` from the inner box', () => {
    const x = -30, y = -20, w = 60, h = 40, r = 8
    const d = roundedRectPathData(x, y, w, h, r, r, r, r)
    const subs = flattenPath(d, { tolerance: 0.001 })
    expect(subs).toHaveLength(1)
    expect(subs[0]!.closed).toBe(true)
    // A rounded rect is the inner box grown by a disc of radius r, so the distance from any
    // boundary point to its nearest inner-box point is exactly r.
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
    for (const p of subs[0]!.pts) {
      const qx = clamp(p.x, x + r, x + w - r)
      const qy = clamp(p.y, y + r, y + h - r)
      expect(Math.hypot(p.x - qx, p.y - qy)).toBeCloseTo(r, 2)
    }
  })

  it('clamps a radius past half the shorter side, exactly as `cornerRadii` does', () => {
    // 40 tall, so the largest meaningful radius is 20. Asking for 100 must not fold the
    // path inside out; the result is the stadium, whose flattened extent still fits the box.
    const d = roundedRectPathData(-30, -20, 60, 40, 100, 100, 100, 100)
    const pts = flattenPath(d, { tolerance: 0.01 })[0]!.pts
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(-30.01)
      expect(p.x).toBeLessThanOrEqual(30.01)
      expect(p.y).toBeGreaterThanOrEqual(-20.01)
      expect(p.y).toBeLessThanOrEqual(20.01)
    }
    // …and it really is a stadium: the flat top spans w - 2*20 = 20 units.
    const top = pts.filter(p => Math.abs(p.y + 20) < 1e-6)
    expect(Math.max(...top.map(p => p.x)) - Math.min(...top.map(p => p.x))).toBeCloseTo(20, 3)
  })

  it('returns an empty string for a degenerate size rather than a broken path', () => {
    expect(roundedRectPathData(0, 0, 0, 10, 0, 0, 0, 0)).toBe('')
    expect(roundedRectPathData(0, 0, 10, 0, 0, 0, 0, 0)).toBe('')
  })
})

describe('ellipsePathData', () => {
  it('is two arcs from the right-hand vertex, closed', () => {
    const d = ellipsePathData(10, 6)
    expect(d.startsWith('M 10 0')).toBe(true)
    expect(d.replace(/[^MAZ]/g, '')).toBe('MAAZ')
    expect(d.trim().endsWith('Z')).toBe(true)
  })

  it('every flattened point lies on the ellipse', () => {
    const rx = 24, ry = 9
    const subs = flattenPath(ellipsePathData(rx, ry), { tolerance: 0.001 })
    expect(subs).toHaveLength(1)
    expect(subs[0]!.closed).toBe(true)
    // Stated as a DISTANCE, not as a unitless ratio, so the number means something: the
    // radial deviation, times the smaller radius, is the error in path units. `pathFlatten`
    // approximates an `A` by cubics exact to 1e-4 and then chords those to `tolerance`, so
    // a few thousandths of a unit is the floor here — still two orders of magnitude below
    // a pixel at any size a rect or ellipse is drawn at.
    for (const p of subs[0]!.pts) {
      const dev = Math.abs(Math.hypot(p.x / rx, p.y / ry) - 1) * Math.min(rx, ry)
      expect(dev).toBeLessThan(0.01)
    }
  })

  it('sweeps CLOCKWISE — down the right side first, the direction `ctx.ellipse` traces', () => {
    // `ctx.ellipse(0,0,rx,ry,0,0,2π)` with the default anticlockwise=false walks
    // (rx·cos t, ry·sin t) for increasing t, i.e. (rx,0) → (0,ry) → (-rx,0). A path that
    // swept the other way would still LOOK identical filled, and would send every
    // marching mark round the shape backwards.
    const pts = flattenPath(ellipsePathData(10, 10), { tolerance: 0.001 })[0]!.pts
    const quarter = pts[Math.floor(pts.length / 8)]!
    expect(quarter.y).toBeGreaterThan(0)
  })

  it('returns an empty string for a non-positive radius', () => {
    expect(ellipsePathData(0, 5)).toBe('')
    expect(ellipsePathData(5, -1)).toBe('')
  })
})

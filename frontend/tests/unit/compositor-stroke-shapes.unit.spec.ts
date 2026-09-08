import { describe, it, expect } from 'vitest'
import {
  offsetPolyline, shapePlacements, shapeStrokeGuide, shapeStrokeGuideFit,
  pathOutlineFlattenTolerance,
} from '~/lib/compositor/strokeShapes'
import { polygonPathData } from '~/lib/compositor/polygonGeometry'
import { guideFromPolyline } from '~/lib/compositor/textPath'
import { DEFAULT_FLATTEN_TOLERANCE } from '~/lib/compositor/pathFlatten'

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

  it('caps the miter at a needle-thin spike instead of shooting off to infinity', () => {
    // prev → cur → next nearly doubles back on itself at `cur` (cos of the two segment
    // normals ≈ -0.9999995), which is exactly the sharp-corner case the Math.min(10, …)
    // miter cap exists for: the bisector direction is still well defined (not the fully
    // degenerate len<1e-9 case, which needs an EXACT reversal), but the raw miter length
    // 1/sqrt((1+cos)/2) would be ~2000× the offset distance without a cap.
    const prev = { x: 0, y: 0 }
    const cur = { x: 1, y: 0 }
    const next = { x: 0.001, y: 0.001 }
    const [outPrev, outCur, outNext] = offsetPolyline([prev, cur, next], false, 1)
    expect(outPrev).toBeDefined()
    expect(outNext).toBeDefined()
    expect(Number.isFinite(outCur!.x)).toBe(true)
    expect(Number.isFinite(outCur!.y)).toBe(true)
    // Capped scale is exactly 10, so the spike vertex sits ~10 units (10 × distance 1)
    // from its original position — not the ~2000 units an uncapped miter would demand.
    const dist = Math.hypot(outCur!.x - cur.x, outCur!.y - cur.y)
    expect(dist).toBeCloseTo(10, 3)
  })

  // Task: wavy/zigzag strokes. `offsetPolyline` widened to take an optional wobble — the
  // full wobble maths lives in compositor-stroke-wobble.unit.spec.ts; this just guards that
  // the widened signature leaves every EXISTING call site's result untouched.
  it('an absent, undefined or null wobble argument does not change a single existing result', () => {
    const sq = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }]
    const noArg = offsetPolyline(sq, true, 0.5)
    expect(offsetPolyline(sq, true, 0.5, undefined)).toEqual(noArg)
    expect(offsetPolyline(sq, true, 0.5, null)).toEqual(noArg)
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
    // perimeter 8, spacing 0.7 → round(11.43) = 11 marks. The count alone proves nothing:
    // a buggy implementation that steps by the raw 0.7 (instead of rescaling to 8/11) would
    // also emit 11 marks — just with a 1.0-unit gap at the seam instead of a uniform ~0.727.
    // So measure ARC LENGTH, not a count and not chord distance (a chord that cuts a corner
    // of this square reads short even when the underlying arc-length step is uniform).
    const marks = shapePlacements(g, 0.7)
    expect(marks).toHaveLength(11)
    const step = g.length / marks.length // the uniform arc-length step a gapless closure requires
    for (let i = 0; i < marks.length; i++) {
      const expected = g.at(i * step)
      expect(marks[i]!.x).toBeCloseTo(expected.x, 9)
      expect(marks[i]!.y).toBeCloseTo(expected.y, 9)
    }
    // The seam: one more step past the last mark must land exactly back on the first —
    // proof there is neither a gap nor an overlap at the wrap.
    const wrapped = g.at(marks.length * step)
    expect(wrapped.x).toBeCloseTo(marks[0]!.x, 9)
    expect(wrapped.y).toBeCloseTo(marks[0]!.y, 9)
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

  it('on an OPEN guide, steps by the raw spacing and lets the last mark fall short', () => {
    // Length 5, spacing 2 — does not divide evenly. An open guide has no seam to
    // protect, so (unlike the closed case above) the step is exactly the requested
    // spacing, not length/count: count = floor(5/2)+1 = 3 marks at s = 0, 2, 4,
    // stopping a full unit short of the far end (s = 5) rather than being stretched
    // to reach it. (guideFromPolyline recenters coordinates on the bounding box, so
    // this compares against g.at(...) rather than assuming absolute coordinates.)
    const g = guideFromPolyline([{ x: 0, y: 0 }, { x: 5, y: 0 }], false)!
    expect(g.length).toBeCloseTo(5, 9)
    const marks = shapePlacements(g, 2)
    expect(marks).toHaveLength(3)
    for (let i = 0; i < marks.length; i++) {
      const expected = g.at(i * 2)
      expect(marks[i]!.x).toBeCloseTo(expected.x, 9)
      expect(marks[i]!.y).toBeCloseTo(expected.y, 9)
    }
    // Consecutive marks are exactly `spacing` apart...
    expect(Math.hypot(marks[1]!.x - marks[0]!.x, marks[1]!.y - marks[0]!.y)).toBeCloseTo(2, 9)
    expect(Math.hypot(marks[2]!.x - marks[1]!.x, marks[2]!.y - marks[1]!.y)).toBeCloseTo(2, 9)
    // ...and the last mark falls short of the guide's far end (s = length) by the
    // remainder (1), rather than the far end being reached exactly or the step
    // being stretched to fit it.
    const farEnd = g.at(g.length)
    const shortfall = Math.hypot(farEnd.x - marks[2]!.x, farEnd.y - marks[2]!.y)
    expect(shortfall).toBeCloseTo(1, 9)
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

/**
 * WHERE THE GUIDE SITS (Task 6).
 *
 * `guideFromPolyline` re-centres its input on the polyline's own bounding-box midpoint —
 * it is shared with type-on-a-path, whose callers want exactly that, and a `PathLayer`'s
 * `d` is already bbox-centred so the shift is zero for one. It is NOT zero for a shape
 * whose outline is not bbox-centred, and `polygonPathData` produces exactly such an
 * outline for any odd-symmetry polygon or star: a pentagon of radius 1 spans y ∈ [-1,
 * 0.809], so its bbox midpoint is 0.0955 ABOVE the origin the painter draws it around.
 *
 * Measured before this was written: a pentagon's guide reported its topmost mark at
 * y = -0.9045 while the painter draws the apex at y = -1. Every mark would have marched
 * round a ring floating ~4px off the real edge on a default-sized layer, with nothing in
 * the app to say so. `shapeStrokeGuideFit` hands back the centre that was removed so the
 * painter can put it straight back.
 */
describe('shapeStrokeGuideFit', () => {
  it('reports the centre `guideFromPolyline` removed, so marks land back on the drawn edge', () => {
    // A pentagon's outline, exactly as `polygonPathData(5, 2, 2, 0)` writes it.
    const d = polygonPathData(5, 2, 2, 0)
    const fit = shapeStrokeGuideFit(d, 0, 0.001)!
    expect(fit).toBeTruthy()
    expect(fit.cx).toBeCloseTo(0, 3)
    expect(fit.cy).toBeCloseTo(-0.0955, 3)

    // The claim that matters: guide point + centre = a point on the DRAWN outline. The
    // apex is at (0, -1) and the two base corners at y = +0.809.
    const marks = shapePlacements(fit.guide, fit.guide.length / 60)
    const ys = marks.map(m => m.y + fit.cy)
    expect(Math.min(...ys)).toBeCloseTo(-1, 2)
    expect(Math.max(...ys)).toBeCloseTo(0.809, 2)
    // …and without the correction it is wrong by exactly the centre, which is what makes
    // this an assertion rather than a restatement.
    expect(Math.min(...marks.map(m => m.y))).toBeCloseTo(-1 - fit.cy, 2)
  })

  it('is a no-op centre for an already-centred outline, so a rect/ellipse is untouched', () => {
    const fit = shapeStrokeGuideFit('M -1 -1 L 1 -1 L 1 1 L -1 1 Z', 0.5)!
    expect(fit.cx).toBeCloseTo(0, 9)
    expect(fit.cy).toBeCloseTo(0, 9)
  })

  it('carries the same guide `shapeStrokeGuide` returns, so the two cannot drift', () => {
    const d = polygonPathData(5, 2, 2, 0)
    const a = shapeStrokeGuideFit(d, 0.2, 0.001)!
    const b = shapeStrokeGuide(d, 0.2, 0.001)!
    expect(a.guide.length).toBeCloseTo(b.length, 9)
    expect(a.guide.closed).toBe(b.closed)
    expect(a.guide.at(1.3)).toEqual(b.at(1.3))
  })

  it('is null on the same inputs `shapeStrokeGuide` refuses', () => {
    expect(shapeStrokeGuideFit('', 0)).toBeNull()
    expect(shapeStrokeGuideFit('not a path', 0)).toBeNull()
  })
})

/**
 * FINDING 2 (Task 6 review) — the flatten tolerance for a shapes stroke on a PATH layer
 * must account for the layer's `scale`, not just its (fixed at 1) `widthScale`.
 *
 * A path layer's `d` is flattened in its own LOCAL units, but drawn under a ctx already
 * scaled by `layer.scale * W` (see `drawPath`). `DEFAULT_FLATTEN_TOLERANCE` targets
 * `DEFAULT_FLATTEN_TOLERANCE * W` canvas PIXELS (pathFlatten.ts's own header). So the
 * tolerance handed to the flattener — which works in `d`'s local units — must be divided
 * by however many device pixels one local unit renders as (`pixelPerUnit`), or a scaled
 * path gets the wrong on-canvas chord accuracy: at `scale: 3` on a 1200-wide frame the old
 * `DEFAULT_FLATTEN_TOLERANCE * 1` (unit was always 1 for a path) let the chord error grow
 * to `0.0015 * 3 * 1200` = 5.4 px, not the ~1.8 px the old comment claimed.
 */
describe('pathOutlineFlattenTolerance', () => {
  it('is unchanged for a rect/ellipse outline (already in pixels, pixelPerUnit 1)', () => {
    const W = 1200
    expect(pathOutlineFlattenTolerance(1, W)).toBeCloseTo(DEFAULT_FLATTEN_TOLERANCE * W, 10)
  })

  it('gives a path layer the SAME on-canvas chord accuracy at scale 1 and scale 3', () => {
    const W = 1200
    const tolAtScale1 = pathOutlineFlattenTolerance(1 * W, W)
    const tolAtScale3 = pathOutlineFlattenTolerance(3 * W, W)
    // At scale 1 this is unchanged from the old (unscaled) behaviour.
    expect(tolAtScale1).toBeCloseTo(DEFAULT_FLATTEN_TOLERANCE, 12)
    // At scale 3 the LOCAL-unit tolerance must shrink by 3× so the on-canvas pixel error
    // — local tolerance × pixelPerUnit — comes out the same at both scales.
    expect(tolAtScale3).toBeCloseTo(DEFAULT_FLATTEN_TOLERANCE / 3, 12)
    expect(tolAtScale1 * (1 * W)).toBeCloseTo(tolAtScale3 * (3 * W), 6)
  })

  it('reproduces, then fixes, the exact 5.4 px the brief measured (not the claimed 1.8 px)', () => {
    const W = 1200
    const scale = 3
    // The OLD formula: `DEFAULT_FLATTEN_TOLERANCE * o.unit`, with `o.unit` fixed at 1 for
    // a path regardless of `scale` — i.e. it never divided by pixelPerUnit at all.
    const oldToleranceInLocalUnits = DEFAULT_FLATTEN_TOLERANCE * 1
    const oldPixelError = oldToleranceInLocalUnits * (scale * W)
    expect(oldPixelError).toBeCloseTo(5.4, 6)

    const fixedTolerance = pathOutlineFlattenTolerance(scale * W, W)
    const fixedPixelError = fixedTolerance * (scale * W)
    expect(fixedPixelError).toBeCloseTo(DEFAULT_FLATTEN_TOLERANCE * W, 6)   // back to ~1.8 px
  })
})

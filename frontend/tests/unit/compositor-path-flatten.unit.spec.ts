import { describe, it, expect } from 'vitest'
import {
  flattenPath,
  longestSubpath,
  DEFAULT_FLATTEN_TOLERANCE,
  type FlatPoint,
  type FlatSubpath,
} from '../../app/lib/compositor/pathFlatten'
import { fitShapePath } from '../../app/lib/shapes/geometry'
import { SHAPES, shapeById } from '../../app/lib/shapes/catalog'

// ── helpers ─────────────────────────────────────────────────────────────────

/** Every coordinate the module can ever emit must be a finite number. This runs
 *  over the output of nearly every case below, malformed input included. */
function expectFinite(subs: FlatSubpath[]): void {
  for (const s of subs) {
    for (const p of s.pts) {
      expect(Number.isFinite(p.x), `x=${p.x}`).toBe(true)
      expect(Number.isFinite(p.y), `y=${p.y}`).toBe(true)
    }
  }
}

const flat = (d: string, tol?: number): FlatSubpath[] => {
  const subs = flattenPath(d, tol === undefined ? undefined : { tolerance: tol })
  expectFinite(subs)
  return subs
}

const polylineLength = (sub: FlatSubpath): number => {
  let acc = 0
  for (let i = 1; i < sub.pts.length; i++) {
    const a = sub.pts[i - 1] as FlatPoint
    const b = sub.pts[i] as FlatPoint
    acc += Math.hypot(b.x - a.x, b.y - a.y)
  }
  if (sub.closed && sub.pts.length > 1) {
    const a = sub.pts[sub.pts.length - 1] as FlatPoint
    const b = sub.pts[0] as FlatPoint
    acc += Math.hypot(b.x - a.x, b.y - a.y)
  }
  return acc
}

const extent = (subs: FlatSubpath[]): { w: number; h: number } => {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const s of subs) for (const p of s.pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { w: maxX - minX, h: maxY - minY }
}

// ── lines ───────────────────────────────────────────────────────────────────

describe('flattenPath — lines', () => {
  it('a straight segment is exactly its two endpoints', () => {
    const subs = flat('M0,0 L10,0')
    expect(subs).toHaveLength(1)
    expect(subs[0]!.pts).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }])
    expect(subs[0]!.closed).toBe(false)
  })

  it('drops consecutive duplicate points and subpaths with no direction', () => {
    expect(flat('M5,5 L5,5 L5,5')).toEqual([])
    expect(flat('M0,0')).toEqual([])
    expect(flat('M0,0 L0,0 L1,0')[0]!.pts).toEqual([{ x: 0, y: 0 }, { x: 1, y: 0 }])
  })

  it('accepts comma, whitespace and leading/trailing space alike', () => {
    const want = [{ x: 0, y: 0 }, { x: 1, y: 2 }]
    expect(flat('M0,0L1,2')[0]!.pts).toEqual(want)
    expect(flat('  M 0 0 L 1 2  ')[0]!.pts).toEqual(want)
    expect(flat('\n M0 , 0\tL1\n2\r\n')[0]!.pts).toEqual(want)
  })

  it('reads scientific notation and bare-dot numbers', () => {
    expect(flat('M0,0 L1e1,2E1')[0]!.pts[1]).toEqual({ x: 10, y: 20 })
    expect(flat('M0,0L.5.5')[0]!.pts[1]).toEqual({ x: 0.5, y: 0.5 })
    expect(flat('M0,0 L-1.5e-1,+2.')[0]!.pts[1]).toEqual({ x: -0.15, y: 2 })
  })
})

// ── curves ──────────────────────────────────────────────────────────────────

/** The canonical cubic quarter circle: (1,0) → (0,1) about the origin. */
const K = 0.5522847498307936
const QUARTER = `M1,0 C1,${K} ${K},1 0,1`

describe('flattenPath — adaptive subdivision', () => {
  it('a cubic quarter circle stays within tolerance of the true arc', () => {
    const tol = DEFAULT_FLATTEN_TOLERANCE
    const sub = flat(QUARTER)[0]!
    expect(sub.pts.length).toBeGreaterThan(4)
    expect(sub.pts.length).toBeLessThan(200)          // adaptive, not brute force

    // Every emitted point lies ON the Bézier, so its distance from the centre
    // shows only the cubic's own ~2.7e-4 error against a real circle.
    for (const p of sub.pts) {
      expect(Math.abs(Math.hypot(p.x, p.y) - 1)).toBeLessThan(4e-4)
    }
    // The chords BETWEEN those points are what the polyline actually draws, and
    // their midpoints are where a chord is furthest from the arc. That distance
    // is the flatness the tolerance promises.
    for (let i = 1; i < sub.pts.length; i++) {
      const a = sub.pts[i - 1] as FlatPoint
      const b = sub.pts[i] as FlatPoint
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      expect(1 - Math.hypot(mx, my)).toBeLessThanOrEqual(tol)
    }
    // Endpoints are exact, not sampled.
    expect(sub.pts[0]).toEqual({ x: 1, y: 0 })
    expect(sub.pts[sub.pts.length - 1]).toEqual({ x: 0, y: 1 })
  })

  it('a tighter tolerance really does subdivide further', () => {
    const coarse = flat(QUARTER, 0.02)[0]!.pts.length
    const fine = flat(QUARTER, 0.00002)[0]!.pts.length
    expect(fine).toBeGreaterThan(coarse * 2)
  })

  it('a collinear cubic collapses to its chord', () => {
    expect(flat('M0,0 C1,0 2,0 3,0')[0]!.pts).toEqual([{ x: 0, y: 0 }, { x: 3, y: 0 }])
  })

  it('cannot hang on a pathological curve', () => {
    // A degenerate cusp: coincident endpoints with the controls flung a million
    // units apart. The recursion cap is the only thing that ends this.
    expectFinite(flat('M0,0 C1e6,1e6 -1e6,-1e6 0,0'))

    // 4000 cusped curves in one `d`. Deliberately NOT a wall-clock assertion —
    // this checkout runs several sessions at once and a timing bar would flake.
    // The honest invariant is that the OUTPUT is bounded: the point budget caps
    // it at 60 000 whatever the input asks for, so the work is bounded too.
    const big = flat('M0,0' + ' C5,-5 -5,5 1,0'.repeat(4000))
    let n = 0
    for (const s of big) n += s.pts.length
    // The budget is checked before a chord is emitted, so a few endpoints can
    // land just past it. What matters is that there is a ceiling at all.
    expect(n).toBeGreaterThan(1000)
    expect(n).toBeLessThan(61000)
  }, 30000)
})

// ── S / T reflection ────────────────────────────────────────────────────────

describe('flattenPath — smooth-curve reflection', () => {
  it('S after a cubic reflects the previous second control point', () => {
    // C ends at (30,10) with c2 = (20,10) ⇒ reflected c1 = (40,10).
    const smooth = flat('M0,0 C10,0 20,10 30,10 S50,20 60,20')
    const spelt = flat('M0,0 C10,0 20,10 30,10 C40,10 50,20 60,20')
    expect(smooth).toEqual(spelt)
  })

  it('S after a NON-cubic uses the current point, not a stale control point', () => {
    // THE classic bug: carrying (20,10) across the lineto would put c1 at
    // (60,10) instead of (40,10) and bow the curve the wrong way.
    const smooth = flat('M0,0 C10,0 20,10 30,10 L40,10 S50,20 60,20')
    const correct = flat('M0,0 C10,0 20,10 30,10 L40,10 C40,10 50,20 60,20')
    const buggy = flat('M0,0 C10,0 20,10 30,10 L40,10 C60,10 50,20 60,20')
    expect(smooth).toEqual(correct)
    expect(smooth).not.toEqual(buggy)
  })

  it('S as the first curve of a subpath uses the current point', () => {
    expect(flat('M0,0 S10,10 20,0')).toEqual(flat('M0,0 C0,0 10,10 20,0'))
  })

  it('S chains: the second S reflects the first S', () => {
    expect(flat('M0,0 C0,10 10,10 10,0 S20,-10 20,0 S30,10 30,0'))
      .toEqual(flat('M0,0 C0,10 10,10 10,0 C10,-10 20,-10 20,0 C20,10 30,10 30,0'))
  })

  it('T after a quadratic reflects, and after anything else does not', () => {
    // Q ends at (20,10) with control (10,0) ⇒ reflected control (30,20).
    expect(flat('M0,0 Q10,0 20,10 T40,10')).toEqual(flat('M0,0 Q10,0 20,10 Q30,20 40,10'))
    expect(flat('M0,0 L10,0 T20,10')).toEqual(flat('M0,0 L10,0 Q10,0 20,10'))
    // A cubic must NOT feed the quadratic reflection, nor the other way round.
    expect(flat('M0,0 C0,10 10,10 10,0 T20,0')).toEqual(flat('M0,0 C0,10 10,10 10,0 Q10,0 20,0'))
    expect(flat('M0,0 Q0,10 10,0 S20,10 20,0')).toEqual(flat('M0,0 Q0,10 10,0 C10,0 20,10 20,0'))
  })

  it('Z resets the reflection — an S after a close starts fresh', () => {
    expect(flat('M0,0 C0,10 10,10 10,0 Z S20,10 20,0'))
      .toEqual(flat('M0,0 C0,10 10,10 10,0 Z C0,0 20,10 20,0'))
  })
})

// ── implicit repeats and relative commands ──────────────────────────────────

describe('flattenPath — implicit repeats', () => {
  it('extra pairs after M are LINETOs, not more movetos', () => {
    const subs = flat('M1,2 3,4 5,6')
    expect(subs).toHaveLength(1)                       // one subpath, not three
    expect(subs[0]!.pts).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }])
  })

  it('extra pairs after a relative m are RELATIVE linetos', () => {
    expect(flat('m1,2 3,4 5,6')[0]!.pts).toEqual([{ x: 1, y: 2 }, { x: 4, y: 6 }, { x: 9, y: 12 }])
  })

  it('L with three coordinate sets is three linetos', () => {
    expect(flat('M0,0 L1,2 3,4 5,6')[0]!.pts)
      .toEqual([{ x: 0, y: 0 }, { x: 1, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }])
  })

  it('C repeats, and each repeat feeds the next S reflection', () => {
    expect(flat('M0,0 C0,5 5,5 5,0 5,-5 10,-5 10,0'))
      .toEqual(flat('M0,0 C0,5 5,5 5,0 C5,-5 10,-5 10,0'))
  })
})

describe('flattenPath — relative commands', () => {
  it('a relative path matches its absolute twin, point for point', () => {
    // Exactly the alphabet paper.js writes into a saved PathLayer: absolute M,
    // then relative c / l / h / v and z.
    expect(flat('M10,10 c1,2 3,4 5,6 h3 v-2 l-1,-1 z'))
      .toEqual(flat('M10,10 C11,12 13,14 15,16 H18 V14 L17,13 Z'))
  })

  it('relative quadratics, smooth curves and arcs match too', () => {
    expect(flat('M4,4 q2,0 2,2 t0,4')).toEqual(flat('M4,4 Q6,4 6,6 T6,10'))
    expect(flat('M0,0 c0,2 2,4 4,4 s4,-2 4,-4')).toEqual(flat('M0,0 C0,2 2,4 4,4 S8,2 8,0'))
    expect(flat('M1,1 a5,5 0 0 1 10,0')).toEqual(flat('M1,1 A5,5 0 0 1 11,1'))
  })

  it('a relative m after a close is relative to the closed subpath start', () => {
    const subs = flat('M10,10 h5 z m0,5 h5')
    expect(subs).toHaveLength(2)
    expect(subs[1]!.pts).toEqual([{ x: 10, y: 15 }, { x: 15, y: 15 }])
  })
})

// ── subpaths and closing ────────────────────────────────────────────────────

describe('flattenPath — subpaths', () => {
  it('Z marks the subpath closed without repeating the start point', () => {
    const sub = flat('M0,0 L10,0 L10,10 Z')[0]!
    expect(sub.closed).toBe(true)
    expect(sub.pts).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
  })

  it('a path that walks back to its own start before Z does not carry a duplicate', () => {
    const sub = flat('M0,0 L10,0 L10,10 L0,0 Z')[0]!
    expect(sub.closed).toBe(true)
    expect(sub.pts).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
  })

  it('a drawing command after Z opens a new subpath at the closed one start', () => {
    const subs = flat('M0,0 L10,0 Z L0,10')
    expect(subs).toHaveLength(2)
    expect(subs[0]!.closed).toBe(true)
    expect(subs[1]!.pts).toEqual([{ x: 0, y: 0 }, { x: 0, y: 10 }])
    expect(subs[1]!.closed).toBe(false)
  })

  it('one d yields several subpaths, in declaration order', () => {
    const subs = flat('M0,0 L1,0 Z M5,5 L6,5 L6,6 Z M9,9 L10,9')
    expect(subs).toHaveLength(3)
    expect(subs.map(s => s.pts.length)).toEqual([2, 3, 2])
    expect(subs.map(s => s.closed)).toEqual([true, true, false])
    expect(subs[1]!.pts[0]).toEqual({ x: 5, y: 5 })
  })
})

describe('longestSubpath', () => {
  it('picks by ARC LENGTH, not by point count', () => {
    // A long straight run of 2 points against a short squiggle of many.
    const d = 'M0,0 L100,0 M0,50 C0.5,51 -0.5,52 0.5,53'
    const subs = flat(d)
    expect(subs[0]!.pts.length).toBe(2)
    expect(subs[1]!.pts.length).toBeGreaterThan(10)     // the squiggle wins on count
    expect(polylineLength(subs[1]!)).toBeLessThan(polylineLength(subs[0]!))

    const best = longestSubpath(d)
    expect(best).not.toBeNull()
    expect(best!.pts).toEqual(subs[0]!.pts)
  })

  it('counts a closed subpath closing chord', () => {
    // Open: 0→10 then 10→0 vertically = 20. Closed triangle: 10 + 10 + 14.14.
    const best = longestSubpath('M0,0 L10,0 L10,10 Z M50,0 L50,20')
    expect(best!.closed).toBe(true)
  })

  it('is null when nothing flattens', () => {
    expect(longestSubpath('')).toBeNull()
    expect(longestSubpath('nonsense')).toBeNull()
    expect(longestSubpath('M4,4')).toBeNull()
  })
})

// ── arcs ────────────────────────────────────────────────────────────────────

describe('flattenPath — elliptical arcs', () => {
  it('a semicircular arc stays on its circle', () => {
    const sub = flat('M0,0 A5 5 0 0 1 10,0')[0]!
    for (const p of sub.pts) {
      expect(Math.abs(Math.hypot(p.x - 5, p.y) - 5)).toBeLessThan(5 * 3e-4)
    }
    expect(sub.pts[0]).toEqual({ x: 0, y: 0 })
    expect(sub.pts[sub.pts.length - 1]).toEqual({ x: 10, y: 0 })   // endpoint exact
    // sweep = 1 sweeps in the positive-angle direction of SVG's y-DOWN frame,
    // which from the leftmost point of a circle runs over the TOP — so y goes
    // negative. Cross-checked against paper.js, which reports bounds y −5..0 for
    // this exact `d`.
    expect(Math.min(...sub.pts.map(p => p.y))).toBeCloseTo(-5, 2)
    expect(Math.max(...sub.pts.map(p => p.y))).toBeCloseTo(0, 2)
    // Half of 2πr, r = 5.
    expect(polylineLength(sub)).toBeCloseTo(Math.PI * 5, 2)
  })

  it('the sweep and large-arc flags pick different arcs', () => {
    const up = flat('M0,0 A5 5 0 0 1 10,0')[0]!
    const down = flat('M0,0 A5 5 0 0 0 10,0')[0]!
    expect(Math.min(...up.pts.map(p => p.y))).toBeCloseTo(-5, 2)
    expect(Math.max(...down.pts.map(p => p.y))).toBeCloseTo(5, 2)
    // r = 10 across a chord of 10 is a 60° arc (10.47) the short way and a 300°
    // one (52.36) the long way. paper.js agrees on both.
    const small = flat('M0,0 A10 10 0 0 1 10,0')[0]!
    const large = flat('M0,0 A10 10 0 1 1 10,0')[0]!
    expect(polylineLength(small)).toBeCloseTo(10.472, 1)
    expect(polylineLength(large)).toBeCloseTo(52.360, 1)
  })

  it('reads the compact flag form, where flags carry no separators', () => {
    // `0110 0` is laf=0, sf=1, x=10, y=0 — legal SVG that a plain number scan
    // would read as the single number 110.
    expect(flat('M0,0a5 5 0 0110 0')).toEqual(flat('M0,0 a5 5 0 0 1 10 0'))
  })

  it('degenerates safely: zero radius, zero-length, and out-of-range radii', () => {
    expect(flat('M0,0 A0 0 0 0 1 10,0')[0]!.pts).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }])
    expect(flat('M0,0 A5 5 0 0 1 0,0')).toEqual([])          // no movement at all
    // Radii too small to reach: the spec says scale them up until they just do,
    // which makes this a half circle of radius 5.
    const grown = flat('M0,0 A1 1 0 0 1 10,0')[0]!
    for (const p of grown.pts) expect(Math.abs(Math.hypot(p.x - 5, p.y) - 5)).toBeLessThan(0.01)
    // Negative radii take their absolute value.
    expect(flat('M0,0 A-5 -5 0 0 1 10,0')).toEqual(flat('M0,0 A5 5 0 0 1 10,0'))
  })

  it('honours the x-axis rotation on a genuine ellipse', () => {
    const rotated = flat('M0,0 A10 4 90 0 1 8,0')[0]!
    const plain = flat('M0,0 A10 4 0 0 1 8,0')[0]!
    expect(rotated.pts).not.toEqual(plain.pts)
    expectFinite([rotated, plain])
  })
})

// ── junk ────────────────────────────────────────────────────────────────────

describe('flattenPath — malformed input never throws and never yields NaN', () => {
  const junk = [
    '', '   ', 'Z', 'zzz', 'nonsense', 'M', 'M0', 'M,',
    'M0,0 L10', 'M0,0 L10,0 L10', 'M0,0 C1,1 2,2',
    '1,2 L3,4', 'M0,0 X 5 5 L3,3', 'M0,0 Q1,1 2,2 ? 9 9',
    'M0,0 L1e999,5 L2,2', 'M0,0 LNaN,5', 'M0,0 L.,.', 'M0,0 L5e,5',
    'M0,0 A 5 5 0 9 9 10,0', 'M0,0 A5', 'M0,0 h5e', '--', '.....',
    'M0,0h1v1h-1v-1zzzz', 'M0,0' + 'l1,1'.repeat(500),
  ]

  it.each(junk)('survives %j', (d) => {
    let subs: FlatSubpath[] = []
    expect(() => { subs = flattenPath(d) }).not.toThrow()
    expectFinite(subs)
    for (const s of subs) expect(s.pts.length).toBeGreaterThanOrEqual(2)
  })

  it('keeps whatever parsed cleanly before the problem', () => {
    // The second L is short, so it and everything after it is dropped — but the
    // first one survives.
    expect(flat('M0,0 L10,0 L10')[0]!.pts).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }])
    // An unknown letter poisons only its own arguments.
    expect(flat('M0,0 X 5 5 L3,3')[0]!.pts).toEqual([{ x: 0, y: 0 }, { x: 3, y: 3 }])
    // A leading coordinate with no command is ignored.
    expect(flat('1,2 M0,0 L3,4')[0]!.pts).toEqual([{ x: 0, y: 0 }, { x: 3, y: 4 }])
  })

  it('ignores a non-string or absent d', () => {
    expect(flattenPath(undefined as unknown as string)).toEqual([])
    expect(flattenPath(null as unknown as string)).toEqual([])
    expect(flattenPath(42 as unknown as string)).toEqual([])
  })

  it('falls back to the default for a nonsense tolerance', () => {
    const want = flat(QUARTER)
    for (const bad of [0, -1, NaN, Infinity, 'x' as unknown as number]) {
      expect(flattenPath(QUARTER, { tolerance: bad })).toEqual(want)
    }
  })
})

// ── the real data ───────────────────────────────────────────────────────────

describe('flattenPath — the shape library, which is what it will actually see', () => {
  it('every shape flattens to a polyline whose extent is its reported bbox', () => {
    // `fitShapePath` fits the manifest ink box to `size` and centres it on the
    // origin — exactly the geometry a Compositor path layer stores. So the
    // flattened extent must reproduce the w/h it reports.
    //
    // The manifest's own box comes from sampling cubics at 16 fixed steps
    // (scripts/shapeLibrary.mjs), so it sits a hair INSIDE the true bounds while
    // adaptive subdivision lands a hair outside. 4.5e-4 of a unit-wide shape is
    // the worst disagreement across all 100; the bar below is an order up.
    let worst = 0
    let worstId = ''
    for (const shape of SHAPES) {
      const g = fitShapePath(shape, 1)
      const subs = flattenPath(g.d)
      expectFinite(subs)
      expect(subs.length, shape.id).toBeGreaterThan(0)
      const e = extent(subs)
      const err = Math.max(Math.abs(e.w - g.w), Math.abs(e.h - g.h))
      if (err > worst) { worst = err; worstId = shape.id }
    }
    expect(worst, `worst shape: ${worstId}`).toBeLessThan(5e-3)
  })

  it('a curved shape (heart) round-trips at a render-sized scale', () => {
    const shape = shapeById('heart')!
    const g = fitShapePath(shape, 400)
    const subs = flattenPath(g.d, { tolerance: 0.25 })
    expectFinite(subs)
    const e = extent(subs)
    expect(e.w).toBeCloseTo(g.w, 0)
    expect(e.h).toBeCloseTo(g.h, 0)
    // Centred on the origin, so the extent straddles it.
    const xs = subs.flatMap(s => s.pts.map(p => p.x))
    expect(Math.min(...xs)).toBeCloseTo(-g.w / 2, 0)
    expect(Math.max(...xs)).toBeCloseTo(g.w / 2, 0)
  })

  it('a shape outline comes back as one closed subpath', () => {
    const g = fitShapePath(shapeById('circle')!, 1)
    const best = longestSubpath(g.d)
    expect(best).not.toBeNull()
    expect(best!.closed).toBe(true)
    // A circle of diameter 1 has circumference π.
    expect(polylineLength(best!)).toBeCloseTo(Math.PI, 2)
  })

  it('longestSubpath finds the outline of a shape with interior detail', () => {
    const g = fitShapePath(shapeById('diagram-venn')!, 1)
    const subs = flattenPath(g.d)
    expect(subs.length).toBeGreaterThan(1)
    const best = longestSubpath(g.d)!
    for (const s of subs) expect(polylineLength(s)).toBeLessThanOrEqual(polylineLength(best) + 1e-12)
  })
})

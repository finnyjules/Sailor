import { describe, it, expect } from 'vitest'
import { arrange } from '~/lib/geoshape/arrange'
import { DEFAULT_CONFIG } from '~/lib/geoshape/config'

describe('geoshape arrange', () => {
  it('radial places `count` clones on a circle of `radius`', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'radial', count: 6, radius: 100, rotateStep: 0, scaleStart: 1, scaleEnd: 1 })
    expect(p).toHaveLength(6)
    for (const c of p) expect(Math.hypot(c.x, c.y)).toBeCloseTo(100, 1)
  })
  it('scaleStart→scaleEnd interpolates across clones', () => {
    const p = arrange({ ...DEFAULT_CONFIG, count: 5, scaleStart: 1, scaleEnd: 2 })
    expect(p[0]!.scale).toBeCloseTo(1, 3)
    expect(p[4]!.scale).toBeCloseTo(2, 3)
  })
  it('rotateStep accumulates linearly', () => {
    const p = arrange({ ...DEFAULT_CONFIG, count: 4, rotateBase: 10, rotateStep: 5 })
    expect(p[0]!.rotate).toBeCloseTo(10, 3)
    expect(p[3]!.rotate).toBeCloseTo(25, 3)
  })
  it('grid places cols*rows clones', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'grid', gridCols: 3, gridRows: 2 })
    expect(p).toHaveLength(6)
  })
  it('radial angle is correct (catches a radians mixup)', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'radial', count: 4, radius: 100, spin: 0, angleStep: 90, evenAngle: false })
    const expectedAngleDeg = [0, 90]
    for (const [i, deg] of expectedAngleDeg.entries()) {
      const rad = deg * Math.PI / 180
      expect(p[i]!.x).toBeCloseTo(100 * Math.cos(rad), 1)
      expect(p[i]!.y).toBeCloseTo(100 * Math.sin(rad), 1)
    }
  })
  it('count:1 returns a single finite placement (no NaN scale)', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'radial', count: 1, scaleStart: 1, scaleEnd: 2 })
    expect(p).toHaveLength(1)
    expect(Number.isFinite(p[0]!.scale)).toBe(true)
    expect(p[0]!.scale).toBeCloseTo(1, 3)
  })
  it('evenAngle (default) spreads any count evenly around the ring — no collapse at count>6', () => {
    // count 7: the bug was clone 6 landing at i*60=360==0, on top of clone 0.
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'radial', count: 7, radius: 100, spin: 0, evenAngle: true })
    expect(p).toHaveLength(7)
    // every clone sits at a DISTINCT angle 360/7 apart → no two coincide
    const angleOf = (c: { x: number; y: number }) => ((Math.atan2(c.y, c.x) * 180 / Math.PI) + 360) % 360
    const gap = angleOf(p[1]!) - angleOf(p[0]!)
    expect(gap).toBeCloseTo(360 / 7, 1)
    // clone 6 (the one that used to collapse onto clone 0) is NOT at clone 0's position
    expect(Math.hypot(p[6]!.x - p[0]!.x, p[6]!.y - p[0]!.y)).toBeGreaterThan(1)
  })
  it('evenAngle:false uses the raw angleStep', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'radial', count: 4, radius: 100, spin: 0, angleStep: 30, evenAngle: false })
    // clone 1 at 30° (raw step), not 90° (even 360/4)
    expect(p[1]!.x).toBeCloseTo(100 * Math.cos(30 * Math.PI / 180), 1)
    expect(p[1]!.y).toBeCloseTo(100 * Math.sin(30 * Math.PI / 180), 1)
  })
})

describe('geoshape arrange — stagger', () => {
  // A 4x2 grid, spacing 0 so the stagger offset is the ONLY thing moving clones:
  // clone i has column i%4, row floor(i/4). Base x/y are 0 (centered, spacing 0),
  // so placement x/y == the stagger offset alone — easy to assert exactly.
  const grid = (over: Partial<typeof DEFAULT_CONFIG>) =>
    arrange({ ...DEFAULT_CONFIG, layout: 'grid', gridCols: 4, gridRows: 2, spacing: 0, rotateStep: 0, ...over })

  it('off (default) leaves the grid unstaggered', () => {
    const p = grid({ stagger: 'off', stepX: 50, stepY: 50 })
    for (const c of p) { expect(c.x).toBeCloseTo(0, 6); expect(c.y).toBeCloseTo(0, 6) }
  })

  it('incremental by column cascades Y progressively down the columns', () => {
    const p = grid({ stagger: 'incremental', stepX: 0, stepY: 60, stepAxis: 'column' })
    // columns 0..3 in row 0 → y = 0,60,120,180
    expect(p.slice(0, 4).map((c) => c.y)).toEqual([0, 60, 120, 180])
    // row 1 repeats the same column pattern (stagger is column-driven).
    expect(p.slice(4, 8).map((c) => c.y)).toEqual([0, 60, 120, 180])
  })

  it('alternate by column pushes every OTHER column, by a fixed amount', () => {
    const p = grid({ stagger: 'alternate', stepX: 0, stepY: 60, stepAxis: 'column' })
    expect(p.slice(0, 4).map((c) => c.y)).toEqual([0, 60, 0, 60])
  })

  it('step X and Y shift together (diagonal shear)', () => {
    const p = grid({ stagger: 'incremental', stepX: 10, stepY: 20, stepAxis: 'column' })
    expect(p[2]!.x).toBeCloseTo(20, 6) // col 2 → 2*10
    expect(p[2]!.y).toBeCloseTo(40, 6) // col 2 → 2*20
  })

  it('step by ROW staggers rows instead of columns (brick)', () => {
    const p = grid({ stagger: 'alternate', stepX: 80, stepY: 0, stepAxis: 'row' })
    // row 0 (clones 0..3) unshifted; row 1 (clones 4..7) shifted by 80 in X.
    expect(p.slice(0, 4).every((c) => c.x === 0)).toBe(true)
    expect(p.slice(4, 8).every((c) => c.x === 80)).toBe(true)
  })

  it('linear staggers by clone position (row axis irrelevant)', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'linear', count: 4, spacing: 0, rotateStep: 0, stagger: 'alternate', stepX: 0, stepY: 40 })
    expect(p.map((c) => c.y)).toEqual([0, 40, 0, 40])
  })

  it('config defaults keep stagger off and steps at zero', () => {
    expect(DEFAULT_CONFIG.stagger).toBe('off')
    expect(DEFAULT_CONFIG.stepX).toBe(0)
    expect(DEFAULT_CONFIG.stepY).toBe(0)
    expect(DEFAULT_CONFIG.stepAxis).toBe('column')
  })
})

describe('geoshape arrange — blend', () => {
  it('blend: x/y run from A (0,0) to B (blendX, blendY) and carry a 0..1 blend fraction', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'blend', count: 5, blendX: 100, blendY: -40, blendEase: 'linear' })
    expect(p).toHaveLength(5)
    expect(p.map(c => c.x)).toEqual([0, 25, 50, 75, 100])
    expect(p.map(c => c.y)).toEqual([0, -10, -20, -30, -40])
    expect(p.map(c => c.blend)).toEqual([0, 0.25, 0.5, 0.75, 1])
  })

  it('blend: easeIn is monotone and front-loaded; count 1 is a single placement at blend 0', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'blend', count: 6, blendX: 100, blendEase: 'easeIn' })
    const xs = p.map(c => c.x)
    for (let i = 1; i < xs.length; i++) expect(xs[i]!).toBeGreaterThan(xs[i - 1]!)
    expect(xs[1]!).toBeLessThan(20) // linear would be 20
    const one = arrange({ ...DEFAULT_CONFIG, layout: 'blend', count: 1, blendX: 100 })
    expect(one).toEqual([{ x: 0, y: 0, scale: 1, rotate: 0, skew: 0, blend: 0 }])
  })

  it('blend: the existing scale/rotate ramps still apply and radius/spacing are ignored', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'blend', count: 3, scaleStart: 1, scaleEnd: 2, rotateStep: 10, radius: 500, spacing: 500 })
    expect(p.map(c => c.scale)).toEqual([1, 1.5, 2])
    expect(p.map(c => c.rotate)).toEqual([0, 10, 20])
    expect(p.map(c => c.x)).toEqual([0, 0, 0])
  })

  it('non-blend layouts carry no blend fraction', () => {
    const p = arrange({ ...DEFAULT_CONFIG, layout: 'linear', count: 3 })
    for (const c of p) expect(c.blend).toBeUndefined()
  })
})

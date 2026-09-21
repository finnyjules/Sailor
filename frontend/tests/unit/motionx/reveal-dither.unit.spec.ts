import { describe, it, expect } from 'vitest'
import {
  revealParams, bayer8, driftCells, cellShown, dotRadius, dotShown, cellRange, buildHiddenMask,
  DOT_PITCH_CELLS, type MotionReveal,
} from '~/lib/motionx/reveal'

const GRID = { cols: 125, rows: 70 }   // a 16:9 frame at cell = 8‰
const R = (over: Partial<MotionReveal> = {}): MotionReveal =>
  ({ ...revealParams({ style: 'dissolve' }), amount: 0.5, elapsed: 0, ...over })
const shownCount = (r: MotionReveal) => {
  let n = 0
  for (let y = 0; y < GRID.rows; y++) for (let x = 0; x < GRID.cols; x++) if (cellShown(r, x, y, GRID)) n++
  return n
}

describe('revealParams', () => {
  it('defaults', () => {
    expect(revealParams(undefined)).toEqual({ style: 'pixels', out: false, cell: 0.024, drift: 6, angle: 0, softness: 0.35, chars: 1 })
  })
  it('converts stored units: thousandths → fraction, degrees → radians, dir → out', () => {
    const p = revealParams({ dir: 'out', style: 'wipe', cell: 20, drift: 0, angle: 90, softness: 0 })
    expect(p.out).toBe(true); expect(p.style).toBe('wipe'); expect(p.cell).toBeCloseTo(0.02, 9)
    expect(p.drift).toBe(0); expect(p.angle).toBeCloseTo(Math.PI / 2, 9); expect(p.softness).toBe(0)
    expect(p.chars).toBe(1)
  })
  it('bad values fall back to the default, out-of-range values clamp', () => {
    const p = revealParams({ style: 'plaid', cell: NaN, drift: 'fast', angle: Infinity, softness: null, dir: 7 })
    expect(p).toEqual(revealParams({}))
    expect(revealParams({ cell: 0 }).cell).toBeCloseTo(0.001, 9)
    expect(revealParams({ cell: 999 }).cell).toBeCloseTo(0.04, 9)
    expect(revealParams({ drift: -3 }).drift).toBe(0)
    expect(revealParams({ softness: 4 }).softness).toBe(1)
  })
})

describe('bayer8', () => {
  it('64 distinct thresholds strictly inside (0, 1), tiling every 8 cells, negative indices included', () => {
    const seen = new Set<number>()
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) seen.add(bayer8(x, y))
    expect(seen.size).toBe(64)
    expect(Math.min(...seen)).toBeGreaterThan(0); expect(Math.max(...seen)).toBeLessThan(1)
    expect(bayer8(-1, -3)).toBe(bayer8(7, 5)); expect(bayer8(19, 8)).toBe(bayer8(3, 0))
  })
})

describe('dissolve', () => {
  it('amount 0 shows nothing, amount 1 everything, 0.5 exactly half', () => {
    expect(shownCount(R({ amount: 0 }))).toBe(0)
    expect(shownCount(R({ amount: 1 }))).toBe(GRID.cols * GRID.rows)
    const tile = { cols: 8, rows: 8 }
    let n = 0
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (cellShown(R({ amount: 0.5 }), x, y, tile)) n++
    expect(n).toBe(32)
  })
  it('with no drift a shown cell never turns off as the amount rises', () => {
    const still = (a: number) => R({ amount: a, drift: 0, elapsed: 3 })
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      let on = false
      for (let a = 0; a <= 1.0001; a += 0.02) {
        const s = cellShown(still(a), x, y, GRID)
        if (on) expect(s, `${x},${y} @ ${a}`).toBe(true)
        on = s
      }
    }
  })
  it('drift moves the pattern in whole cells along the angle, and is still at drift 0', () => {
    expect(driftCells(R({ elapsed: 1, drift: 6, angle: 0 }))).toEqual({ dx: 6, dy: 0 })
    expect(driftCells(R({ elapsed: 0.5, drift: 6, angle: Math.PI / 2 }))).toEqual({ dx: 0, dy: 3 })
    expect(driftCells(R({ elapsed: 9, drift: 0 }))).toEqual({ dx: 0, dy: 0 })
    const a = R({ elapsed: 0 }), b = R({ elapsed: 0.5 })
    let differs = false
    for (let x = 0; x < 16 && !differs; x++) if (cellShown(a, x, 0, GRID) !== cellShown(b, x, 0, GRID)) differs = true
    expect(differs).toBe(true)
    expect(cellShown(a, 5, 5, GRID)).toBe(cellShown(R({ elapsed: 0.5 }), 5 + 3, 5, GRID))
  })
  it('amounts past the ends are clamped (a spring overshoots)', () => {
    expect(shownCount(R({ amount: 1.2 }))).toBe(GRID.cols * GRID.rows)
    expect(shownCount(R({ amount: -0.3 }))).toBe(0)
  })
})

describe('wipe', () => {
  const W = (over: Partial<MotionReveal> = {}) => R({ style: 'wipe', drift: 0, ...over })
  it('amount 0 shows nothing and amount 1 everything, at four angles, in and out', () => {
    for (const deg of [0, 90, 180, 270]) for (const out of [false, true]) {
      const angle = (deg * Math.PI) / 180
      expect(shownCount(W({ amount: 0, angle, out }))).toBe(0)
      expect(shownCount(W({ amount: 1, angle, out }))).toBe(GRID.cols * GRID.rows)
    }
  })
  it('IN at angle 0: everything behind the band shows, everything ahead of it is hidden', () => {
    const r = W({ amount: 0.5, softness: 0.2 })
    // band spans s ∈ (front − soft, front) = (0.4, 0.6) with front = amount × (1 + soft)
    for (let y = 0; y < GRID.rows; y += 7) {
      for (let x = 0; x < GRID.cols; x++) {
        const s = (x + 0.5) / GRID.cols
        if (s < 0.39) expect(cellShown(r, x, y, GRID), `behind ${x}`).toBe(true)
        if (s > 0.61) expect(cellShown(r, x, y, GRID), `ahead ${x}`).toBe(false)
      }
    }
  })
  it('OUT keeps sweeping the same way: the empty side grows from the START side', () => {
    const r = W({ amount: 0.5, softness: 0, out: true })
    expect(cellShown(r, 2, 10, GRID)).toBe(false)               // start side already gone
    expect(cellShown(r, GRID.cols - 3, 10, GRID)).toBe(true)     // far side still there
  })
  it('softness 0 is a hard edge and never divides by zero', () => {
    const r = W({ amount: 0.5, softness: 0 })
    for (let x = 0; x < GRID.cols; x++) {
      const v = cellShown(r, x, 3, GRID)
      expect(v).toBe((x + 0.5) / GRID.cols < 0.5)
    }
  })
  it('never turns a shown cell off as the amount rises (no drift)', () => {
    for (let x = 0; x < GRID.cols; x += 3) {
      let on = false
      for (let a = 0; a <= 1.0001; a += 0.02) {
        const s = cellShown(W({ amount: a }), x, 11, GRID)
        if (on) expect(s).toBe(true)
        on = s
      }
    }
  })
})

describe('dots', () => {
  it('radius grows from 0 and closes every gap before amount 1', () => {
    expect(dotRadius(0)).toBe(0)
    expect(dotRadius(0.95)).toBeGreaterThanOrEqual(Math.SQRT1_2)   // ≥ half a diagonal, in pitches
    expect(dotRadius(0.5)).toBeGreaterThan(dotRadius(0.25))
  })
  it('a point at a dot centre shows first, the corner between four dots shows last', () => {
    const pitch = revealParams({ style: 'dissolve' }).cell * DOT_PITCH_CELLS
    const d = (a: number) => R({ style: 'dots', amount: a, drift: 0 })
    expect(dotShown(d(0.05), pitch / 2, pitch / 2)).toBe(true)
    expect(dotShown(d(0.05), 0, 0)).toBe(false)
    expect(dotShown(d(0.96), 0, 0)).toBe(true)
  })
  it('the grid drifts smoothly with elapsed time', () => {
    const pitch = revealParams({ style: 'dissolve' }).cell * DOT_PITCH_CELLS
    const moving = R({ style: 'dots', amount: 0.05, drift: 6, elapsed: 0.01 })
    expect(dotShown(moving, pitch / 2 + 0.01 * 6 * revealParams({ style: 'dissolve' }).cell, pitch / 2)).toBe(true)
  })
})

describe('cellRange + buildHiddenMask', () => {
  const ID = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }
  it('an untransformed canvas the size of the frame covers exactly the frame grid', () => {
    expect(cellRange(ID, 1000, 560, 1000, 560, 0.008)).toEqual({ c0: 0, r0: 0, cols: 125, rows: 70 })
  })
  it('a canvas showing pasteboard around the frame extends the range to negative cells', () => {
    // frame drawn at 0.5× and offset (100, 50): inverse = scale 2, translate (−200, −100)
    const inv = { a: 2, b: 0, c: 0, d: 2, e: -200, f: -100 }
    const r = cellRange(inv, 700, 400, 1000, 560, 0.008)
    expect(r.c0).toBeLessThan(0); expect(r.r0).toBeLessThan(0)
    expect((r.c0 + r.cols) * 8).toBeGreaterThanOrEqual(1200)   // covers x = 1200 frame px
  })
  it('an absurd range is cut back to the frame rather than allocating millions of cells', () => {
    const huge = { a: 400, b: 0, c: 0, d: 400, e: 0, f: 0 }
    const r = cellRange(huge, 4000, 4000, 1000, 560, 0.001)
    expect(r.cols * r.rows).toBeLessThanOrEqual(1_000_000)
  })
  it('the mask is RGBA with alpha 255 exactly where the cell is hidden, addressed from the range origin', () => {
    const r = R({ amount: 0.5 })
    const range = { c0: -2, r0: -1, cols: 6, rows: 4 }
    const px = buildHiddenMask(r, range, GRID)
    expect(px.length).toBe(6 * 4 * 4)
    for (let j = 0; j < 4; j++) for (let i = 0; i < 6; i++) {
      const hidden = !cellShown(r, i - 2, j - 1, GRID)
      expect(px[(j * 6 + i) * 4 + 3]).toBe(hidden ? 255 : 0)
    }
  })
  it('identical inputs give identical bytes', () => {
    const range = { c0: 0, r0: 0, cols: 40, rows: 20 }
    expect(buildHiddenMask(R({ elapsed: 1.23 }), range, GRID)).toEqual(buildHiddenMask(R({ elapsed: 1.23 }), range, GRID))
  })
})

// Review follow-ups: the "every style" claims, checked for every style.
describe('the ends and the clamps, for EVERY style', () => {
  const pitch = revealParams({ style: 'dissolve' }).cell * DOT_PITCH_CELLS
  const points = [[0, 0], [pitch / 2, pitch / 2], [pitch * 0.9, pitch * 0.1], [0.31, 0.17]] as const
  it('dots: amount 0 shows nothing and amount 1 everything, including past the ends', () => {
    for (const amount of [0, -0.4]) for (const [u, v] of points) expect(dotShown(R({ style: 'dots', amount }), u, v)).toBe(false)
    for (const amount of [1, 1.3]) for (const [u, v] of points) expect(dotShown(R({ style: 'dots', amount }), u, v)).toBe(true)
  })
  it('wipe: amounts past the ends are clamped, in and out', () => {
    for (const out of [false, true]) {
      expect(shownCount(R({ style: 'wipe', amount: 1.25, out }))).toBe(GRID.cols * GRID.rows)
      expect(shownCount(R({ style: 'wipe', amount: -0.2, out }))).toBe(0)
    }
  })
  it('wipe OUT: a shown cell never turns off as the amount rises (no drift)', () => {
    for (let x = 0; x < GRID.cols; x += 3) {
      let on = false
      for (let a = 0; a <= 1.0001; a += 0.02) {
        const s = cellShown(R({ style: 'wipe', drift: 0, out: true, amount: a }), x, 11, GRID)
        if (on) expect(s, `${x} @ ${a}`).toBe(true)
        on = s
      }
    }
  })
  it('dots: a shown point never turns off as the amount rises (no drift)', () => {
    for (const [u, v] of points) {
      let on = false
      for (let a = 0; a <= 1.0001; a += 0.02) {
        const s = dotShown(R({ style: 'dots', drift: 0, amount: a }), u, v)
        if (on) expect(s).toBe(true)
        on = s
      }
    }
  })
  it('a non-finite amount or elapsed hides (dissolve, wipe) or holds still — it never throws or shows garbage', () => {
    for (const style of ['dissolve', 'wipe'] as const) expect(shownCount(R({ style, amount: NaN }))).toBe(0)
    expect(dotShown(R({ style: 'dots', amount: NaN }), 0.1, 0.1)).toBe(false)
    expect(driftCells(R({ elapsed: NaN }))).toEqual({ dx: 0, dy: 0 })
    expect(() => shownCount(R({ elapsed: NaN }))).not.toThrow()
  })
  it('cellRange falls back to the frame grid on a non-finite transform', () => {
    const frame = { c0: 0, r0: 0, cols: 125, rows: 70 }
    expect(cellRange({ a: NaN, b: 0, c: 0, d: 1, e: 0, f: 0 }, 1000, 560, 1000, 560, 0.008)).toEqual(frame)
    expect(cellRange({ a: 1, b: 0, c: 0, d: 1, e: Infinity, f: 0 }, 1000, 560, 1000, 560, 0.008)).toEqual(frame)
  })
})

describe('cellTest — the per-frame form the mask builder uses', () => {
  it('agrees with cellShown for every cell, every style, in and out, drifting, on and off the frame', async () => {
    const { cellTest } = await import('~/lib/motionx/reveal')
    for (const style of ['dissolve', 'wipe'] as const) for (const out of [false, true]) for (const angle of [0, 0.7, Math.PI, 4.1]) {
      for (const softness of [0, 0.35]) for (const amount of [-0.1, 0, 0.17, 0.5, 0.93, 1, 1.2]) {
        const r = R({ style, out, angle, softness, amount, elapsed: 0.83 })
        const test = cellTest(r, GRID)
        for (let y = -3; y < GRID.rows + 3; y += 5) for (let x = -3; x < GRID.cols + 3; x += 4) {
          expect(test(x, y), `${style} ${out} ${angle} ${softness} ${amount} @${x},${y}`).toBe(cellShown(r, x, y, GRID))
        }
      }
    }
  })
})

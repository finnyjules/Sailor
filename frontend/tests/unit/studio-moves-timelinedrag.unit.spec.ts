// frontend/tests/unit/studio-moves-timelinedrag.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { bandRect, moveBand, resizeBand, snapSeconds } from '~/lib/studio/moves/timelineDrag'

describe('snapSeconds', () => {
  it('snaps to the nearest target within eps', () => {
    expect(snapSeconds(1.03, [0, 1, 2])).toBe(1)
    expect(snapSeconds(0.97, [0, 1, 2])).toBe(1)
  })

  it('passes through unchanged when nothing is within eps', () => {
    expect(snapSeconds(1.5, [0, 1, 2])).toBe(1.5)
  })

  it('picks the closer of two targets both within eps', () => {
    // eps defaults to 0.08 — 1.03 is 0.03 from 1 and 0.97 from 2, so 1 wins.
    expect(snapSeconds(1.03, [0, 1, 1.1])).toBeCloseTo(1, 9)
  })

  it('respects a custom eps', () => {
    expect(snapSeconds(1.2, [1], 0.5)).toBe(1)
    expect(snapSeconds(1.2, [1], 0.1)).toBe(1.2)
  })
})

describe('moveBand', () => {
  it('shifts at by deltaSec', () => {
    expect(moveBand(1, 0.5, 4)).toBeCloseTo(1.5, 9)
  })

  it('clamps to 0 at the low end', () => {
    expect(moveBand(0.2, -1, 4)).toBe(0)
  })

  it('clamps to clip at the high end', () => {
    expect(moveBand(3.5, 2, 4)).toBe(4)
  })
})

describe('resizeBand', () => {
  it('right edge grows duration', () => {
    const r = resizeBand({ at: 1, duration: 1 }, 'right', 0.5, 4)
    expect(r).toEqual({ at: 1, duration: 1.5 })
  })

  it('right edge floors duration at 0.05', () => {
    const r = resizeBand({ at: 1, duration: 0.2 }, 'right', -1, 4)
    expect(r.at).toBe(1)
    expect(r.duration).toBeCloseTo(0.05, 9)
  })

  it('right edge caps duration at clip - at', () => {
    const r = resizeBand({ at: 3, duration: 0.5 }, 'right', 5, 4)
    expect(r.at).toBe(3)
    expect(r.duration).toBeCloseTo(1, 9) // clip(4) - at(3)
  })

  it('left edge shifts at and shrinks duration, keeping the right edge fixed', () => {
    const r = resizeBand({ at: 1, duration: 1 }, 'left', 0.5, 4)
    expect(r.at).toBeCloseTo(1.5, 9)
    expect(r.duration).toBeCloseTo(0.5, 9) // right edge stays at 2
  })

  it('left edge grows duration when dragged backward', () => {
    const r = resizeBand({ at: 1, duration: 1 }, 'left', -0.5, 4)
    expect(r.at).toBeCloseTo(0.5, 9)
    expect(r.duration).toBeCloseTo(1.5, 9)
  })

  it('left edge floors duration at 0.05 (at clamps short of the right edge)', () => {
    const r = resizeBand({ at: 1, duration: 1 }, 'left', 2, 4)
    expect(r.at).toBeCloseTo(1.95, 9) // rightEdge(2) - MIN(0.05)
    expect(r.duration).toBeCloseTo(0.05, 9)
  })

  it('left edge clamps at at 0', () => {
    const r = resizeBand({ at: 0.2, duration: 1 }, 'left', -1, 4)
    expect(r.at).toBe(0)
    expect(r.duration).toBeCloseTo(1.2, 9)
  })
})

describe('bandRect', () => {
  it('maps a transition band into a wider view', () => {
    // band [1,2] in view [0,4] -> left 25%, width 25%
    const r = bandRect({ at: 1, duration: 1, loop: false }, { start: 0, end: 4 }, 4)
    expect(r.leftPct).toBeCloseTo(25, 9)
    expect(r.widthPct).toBeCloseTo(25, 9)
  })

  it('maps a transition band into a zoomed-in view', () => {
    // band [1,2] in view [1,3] -> left 0%, width 50%
    const r = bandRect({ at: 1, duration: 1, loop: false }, { start: 1, end: 3 }, 4)
    expect(r.leftPct).toBeCloseTo(0, 9)
    expect(r.widthPct).toBeCloseTo(50, 9)
  })

  it('extends a loop band to the clip end', () => {
    // loop band starting at 1, clip 4, view [0,4] -> left 25%, width to 100% (75%)
    const r = bandRect({ at: 1, duration: 1, loop: true }, { start: 0, end: 4 }, 4)
    expect(r.leftPct).toBeCloseTo(25, 9)
    expect(r.widthPct).toBeCloseTo(75, 9)
  })

  it('clamps a band that runs off the left of the view', () => {
    const r = bandRect({ at: -1, duration: 2, loop: false }, { start: 0, end: 4 }, 4)
    expect(r.leftPct).toBe(0)
    expect(r.widthPct).toBeCloseTo(25, 9) // window [-1,1] -> visible [0,1] of a 4s view
  })

  it('clamps a band that runs off the right of the view', () => {
    const r = bandRect({ at: 3.5, duration: 2, loop: false }, { start: 0, end: 4 }, 4)
    expect(r.leftPct).toBeCloseTo(87.5, 9)
    expect(r.widthPct).toBeCloseTo(12.5, 9)
  })
})

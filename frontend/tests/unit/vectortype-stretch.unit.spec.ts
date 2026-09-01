/**
 * Vector Type — smart stretch engine (flex profiles + remaps).
 *
 * Pure geometry: plain arrays of numbers in and out, no canvas, no network.
 * The load-bearing invariants are the same ones the outline tests pin for
 * variable axes — command count never changes as the stretch parameter moves,
 * and the remap is monotone — because the motion system animates through
 * these outlines and relies on point-for-point correspondence.
 */
import { describe, expect, it } from 'vitest'
import type { PathCommand, VtBBox } from '~/lib/vectortype/outline'
import { analyzeFlex, buildRemap, remapValue, stretchCommands } from '~/lib/vectortype/stretch'

/** Closed axis-aligned rectangle as outline commands (font-unit space, y-up). */
function rect(x0: number, y0: number, x1: number, y1: number): PathCommand[] {
  return [
    { command: 'moveTo', args: [x0, y0] },
    { command: 'lineTo', args: [x1, y0] },
    { command: 'lineTo', args: [x1, y1] },
    { command: 'lineTo', args: [x0, y1] },
    { command: 'closePath', args: [] },
  ]
}

function bboxOf(...rects: Array<[number, number, number, number]>): VtBBox {
  return {
    minX: Math.min(...rects.map(r => r[0])),
    minY: Math.min(...rects.map(r => r[1])),
    maxX: Math.max(...rects.map(r => r[2])),
    maxY: Math.max(...rects.map(r => r[3])),
  }
}

describe('analyzeFlex', () => {
  it('marks a vertical stem rigid in X and flexible in Y', () => {
    // A tall thin stem: 100 wide, 700 tall.
    const cmds = rect(0, 0, 100, 700)
    const { x, y } = analyzeFlex(cmds, bboxOf([0, 0, 100, 700]), { bins: 16 })
    // Every X bin the stem covers holds near-vertical ink -> flex ~ 0.
    // (The stem's top/bottom edges are horizontal ink in those same bins, but
    // flex is the MIN over the slice, so the vertical sides win.)
    for (const f of x.flex) expect(f).toBeLessThan(0.05)
    // Y bins in the stem's interior see only vertical ink -> flex ~ 1;
    // only the bins holding the horizontal caps are pinned.
    const interior = Array.from(y.flex).slice(2, -2)
    for (const f of interior) expect(f).toBeGreaterThan(0.95)
    expect(y.flex[0]).toBeLessThan(0.05)
    expect(y.flex[y.flex.length - 1]).toBeLessThan(0.05)
  })

  it('leaves empty slices fully flexible', () => {
    // Two stems with a gap between them (an H without its crossbar).
    const left = rect(0, 0, 100, 700)
    const right = rect(500, 0, 600, 700)
    const { x } = analyzeFlex([...left, ...right], bboxOf([0, 0, 600, 700]), { bins: 24 })
    // Bins over the gap (x in ~[100, 500]) carry no ink -> flex 1 exactly.
    const gapStart = Math.ceil((100 - x.start) / x.binSize) + 1
    const gapEnd = Math.floor((500 - x.start) / x.binSize) - 1
    for (let i = gapStart; i < gapEnd; i++) expect(x.flex[i]).toBe(1)
  })

  it('k = 0 makes every inked slice fully flexible (uniform-scaling mode)', () => {
    const cmds = rect(0, 0, 100, 700)
    const { x, y } = analyzeFlex(cmds, bboxOf([0, 0, 100, 700]), { bins: 16, k: 0 })
    for (const f of x.flex) expect(f).toBe(1)
    for (const f of y.flex) expect(f).toBe(1)
  })

  it('gives diagonals partial flex', () => {
    // A 45-degree bar: |tangent . x-hat| = cos(45) ~ 0.707, squared ~ 0.5.
    const cmds: PathCommand[] = [
      { command: 'moveTo', args: [0, 0] },
      { command: 'lineTo', args: [700, 700] },
      { command: 'lineTo', args: [760, 700] },
      { command: 'lineTo', args: [60, 0] },
      { command: 'closePath', args: [] },
    ]
    const { x } = analyzeFlex(cmds, bboxOf([0, 0, 760, 700]), { bins: 16, k: 2 })
    const mid = x.flex[8]!
    expect(mid).toBeGreaterThan(0.3)
    expect(mid).toBeLessThan(0.7)
  })
})

describe('buildRemap / remapValue', () => {
  const uniform: import('~/lib/vectortype/stretch').FlexProfile = {
    start: 0, binSize: 10, flex: new Float64Array(10).fill(1),
  }

  it('scales a fully flexible profile uniformly', () => {
    const m = buildRemap(uniform, 2)
    expect(remapValue(m, 0)).toBeCloseTo(0, 6)
    expect(remapValue(m, 50)).toBeCloseTo(100, 6)
    expect(remapValue(m, 100)).toBeCloseTo(200, 6)
  })

  it('holds rigid bins and grows flexible ones', () => {
    const flex = new Float64Array(10).fill(1)
    flex[4] = 0; flex[5] = 0            // rigid core at [40, 60]
    const m = buildRemap({ start: 0, binSize: 10, flex }, 1.5)
    // Total width 100 -> 150; the rigid 20 stays 20.
    expect(remapValue(m, 60) - remapValue(m, 40)).toBeCloseTo(20, 6)
    expect(remapValue(m, 100) - remapValue(m, 0)).toBeCloseTo(150, 6)
  })

  it('is monotone even under heavy condensing', () => {
    const flex = new Float64Array(10).fill(0)
    flex[2] = 1; flex[7] = 1
    const m = buildRemap({ start: 0, binSize: 10, flex }, 0.5)
    let prev = -Infinity
    for (let v = 0; v <= 100; v += 1) {
      const r = remapValue(m, v)
      expect(r).toBeGreaterThanOrEqual(prev)
      prev = r
    }
    // Clamps stop total collapse.
    expect(remapValue(m, 100) - remapValue(m, 0)).toBeGreaterThan(25)
  })

  it('honours a fixed point (baseline anchor)', () => {
    const flex = new Float64Array(10).fill(1)
    // Profile spans [-30, 70] like a glyph with a descender below baseline 0.
    const m = buildRemap({ start: -30, binSize: 10, flex }, 2, 0)
    expect(remapValue(m, 0)).toBeCloseTo(0, 6)
    expect(remapValue(m, 70)).toBeCloseTo(140, 6)   // grows up
    expect(remapValue(m, -30)).toBeCloseTo(-60, 6)  // descender grows down
  })

  it('an all-rigid profile leaves geometry untouched', () => {
    const flex = new Float64Array(10).fill(0)
    const m = buildRemap({ start: 0, binSize: 10, flex }, 2)
    expect(remapValue(m, 0)).toBeCloseTo(0, 6)
    expect(remapValue(m, 100)).toBeCloseTo(100, 6)
  })
})

describe('stretchCommands', () => {
  it('never changes the command count and keeps closePath args empty', () => {
    const cmds: PathCommand[] = [
      { command: 'moveTo', args: [0, 0] },
      { command: 'bezierCurveTo', args: [10, 80, 90, 80, 100, 0] },
      { command: 'quadraticCurveTo', args: [50, -40, 0, 0] },
      { command: 'closePath', args: [] },
    ]
    const flex = analyzeFlex(cmds, { minX: 0, minY: -40, maxX: 100, maxY: 80 })
    for (const [s, sy] of [[0.5, 1], [1, 1], [1.8, 1], [1, 2.2], [2.4, 0.6]] as const) {
      const out = stretchCommands(cmds, flex, s, sy)
      expect(out.map(c => c.command)).toEqual(cmds.map(c => c.command))
      expect(out.map(c => c.args.length)).toEqual(cmds.map(c => c.args.length))
    }
  })
})

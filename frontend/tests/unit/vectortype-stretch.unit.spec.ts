/**
 * Vector Type — smart stretch engine (flex profiles + remaps).
 *
 * Pure geometry: plain arrays of numbers in and out, no canvas, no network.
 * The load-bearing invariants are the same ones the outline tests pin for
 * variable axes — command count never changes as the stretch parameter moves,
 * and the remap is monotone — because the motion system animates through
 * these outlines and relies on point-for-point correspondence.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { normaliseAxes } from '~/lib/vectortype/font'
import type { VtFont } from '~/lib/vectortype/font'
import { textOutlines } from '~/lib/vectortype/outline'
import type { PathCommand, TextOutlines, VtBBox } from '~/lib/vectortype/outline'
import { analyzeFlex, buildRemap, glyphFlexFor, planStretch, remapValue, solveAxis, stretchCommands, stretchOutlines, weightCompensation } from '~/lib/vectortype/stretch'

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

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))

function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return { id: 'inter-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}

const font = loadFixtureFont()

/** Ink intervals where the horizontal line y = yLine crosses the glyph,
 *  measured on the flattened outline via sorted crossings. Assumes the chosen
 *  scanline meets the glyph an even number of times and winding does not
 *  overlap (true for the stems and rings used below) — a measuring stick for
 *  tests, not a general rasteriser. */
function inkRunsAtY(commands: readonly PathCommand[], yLine: number): Array<[number, number]> {
  const xs: number[] = []
  // Flatten exactly like the engine: reuse its resolution by sampling curves
  // at 32 steps — finer than analysis so measurement error stays below
  // assertion tolerance.
  let px = 0, py = 0, sx = 0, sy = 0
  const seg = (x0: number, y0: number, x1: number, y1: number) => {
    if ((y0 <= yLine && y1 > yLine) || (y1 <= yLine && y0 > yLine)) {
      xs.push(x0 + ((yLine - y0) / (y1 - y0)) * (x1 - x0))
    }
  }
  const emit = (x1: number, y1: number) => { seg(px, py, x1, y1); px = x1; py = y1 }
  for (const c of commands) {
    const a = c.args
    if (c.command === 'moveTo') { px = a[0]!; py = a[1]!; sx = px; sy = py }
    else if (c.command === 'lineTo') emit(a[0]!, a[1]!)
    else if (c.command === 'quadraticCurveTo') {
      const [cx, cy, x, y] = a as [number, number, number, number]
      const x0 = px, y0 = py
      for (let i = 1; i <= 32; i++) {
        const t = i / 32, u = 1 - t
        emit(u * u * x0 + 2 * u * t * cx + t * t * x, u * u * y0 + 2 * u * t * cy + t * t * y)
      }
    } else if (c.command === 'bezierCurveTo') {
      const [c1x, c1y, c2x, c2y, x, y] = a as [number, number, number, number, number, number]
      const x0 = px, y0 = py
      for (let i = 1; i <= 32; i++) {
        const t = i / 32, u = 1 - t
        emit(
          u * u * u * x0 + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
          u * u * u * y0 + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
        )
      }
    } else if (c.command === 'closePath') emit(sx, sy)
  }
  xs.sort((a, b) => a - b)
  const runs: Array<[number, number]> = []
  for (let i = 0; i + 1 < xs.length; i += 2) runs.push([xs[i]!, xs[i + 1]!])
  return runs
}

/** Same measuring stick rotated: ink intervals along x = xLine. */
function inkRunsAtX(commands: readonly PathCommand[], xLine: number): Array<[number, number]> {
  const swapped = commands.map(c => ({
    command: c.command,
    args: c.args.map((v, i) => (i % 2 === 0 ? c.args[i + 1]! : c.args[i - 1]!)),
  }))
  return inkRunsAtY(swapped, xLine)
}

function glyphOf(o: TextOutlines, ch: string) {
  const g = o.glyphs.find(g => g.codePoints.includes(ch.codePointAt(0)!))
  if (!g) throw new Error(`fixture has no '${ch}'`)
  return g
}

describe('stretchOutlines (fixture font)', () => {
  const base = textOutlines(font, 'Sailor')

  it('keeps command count constant across a stretch sweep', () => {
    const count = (o: TextOutlines) => o.glyphs.reduce((n, g) => n + g.commands.length, 0)
    for (const [s, sy] of [[0.6, 1], [1, 1], [1.7, 1], [1, 1.8], [2.4, 2.4]] as const) {
      expect(count(stretchOutlines(base, s, sy))).toBe(count(base))
    }
  })

  it("preserves the stem width of 'l' at S = 2", () => {
    const g0 = glyphOf(base, 'l')
    const midY = (g0.bbox.minY + g0.bbox.maxY) / 2
    const w0 = inkRunsAtY(g0.commands, midY).map(([a, b]) => b - a)
    const g2 = glyphOf(stretchOutlines(base, 2, 1), 'l')
    const w2 = inkRunsAtY(g2.commands, midY).map(([a, b]) => b - a)
    expect(w2.length).toBe(w0.length)
    // 5%: bin quantisation moves stem edges by at most one 1/64 slice.
    expect(w2[0]!).toBeGreaterThan(w0[0]! * 0.95)
    expect(w2[0]!).toBeLessThan(w0[0]! * 1.05)
  })

  it("preserves the ring thickness of 'o' at S = 2 (sides) and SY = 2 (arches)", () => {
    const g0 = glyphOf(base, 'o')
    const midY = (g0.bbox.minY + g0.bbox.maxY) / 2
    const sides0 = inkRunsAtY(g0.commands, midY).map(([a, b]) => b - a)
    const gS = glyphOf(stretchOutlines(base, 2, 1), 'o')
    const sidesS = inkRunsAtY(gS.commands, midY).map(([a, b]) => b - a)
    expect(sidesS.length).toBe(2)
    // 15%: the ring's flanks are curved, so some tangent leakage is expected —
    // the point is beating naive scaling, which would give 100% growth.
    for (let i = 0; i < 2; i++) {
      expect(sidesS[i]!).toBeLessThan(sides0[i]! * 1.15)
    }
    const midX0 = (g0.bbox.minX + g0.bbox.maxX) / 2
    const arch0 = inkRunsAtX(g0.commands, midX0).map(([a, b]) => b - a)
    const gY = glyphOf(stretchOutlines(base, 1, 2), 'o')
    const midXY = (gY.bbox.minX + gY.bbox.maxX) / 2
    const archY = inkRunsAtX(gY.commands, midXY).map(([a, b]) => b - a)
    expect(archY.length).toBe(2)
    for (let i = 0; i < 2; i++) {
      expect(archY[i]!).toBeLessThan(arch0[i]! * 1.15)
    }
  })

  it('anchors the baseline: l sits on y = 0 at SY = 2, g grows its descender down', () => {
    const tall = stretchOutlines(base, 1, 2)
    const l0 = glyphOf(base, 'l'), l2 = glyphOf(tall, 'l')
    expect(Math.abs(l2.bbox.minY - l0.bbox.minY)).toBeLessThan(font.unitsPerEm * 0.01)
    expect(l2.bbox.maxY).toBeGreaterThan(l0.bbox.maxY * 1.5)
    const gBase = textOutlines(font, 'g')
    const gTall = stretchOutlines(gBase, 1, 2)
    expect(gTall.glyphs[0]!.bbox.minY).toBeLessThan(gBase.glyphs[0]!.bbox.minY * 1.2)
  })

  it('grows the run width at S = 1.5, but less than naive 1.5x', () => {
    const out = stretchOutlines(base, 1.5, 1)
    expect(out.width).toBeGreaterThan(base.width * 1.05)
    expect(out.width).toBeLessThanOrEqual(base.width * 1.5 + 1)
  })

  it('vertical stretch leaves advances alone', () => {
    const out = stretchOutlines(base, 1, 2.2)
    expect(out.width).toBeCloseTo(base.width, 3)
    out.glyphs.forEach((g, i) => expect(g.advance).toBeCloseTo(base.glyphs[i]!.advance, 3))
  })

  it('S = SY = 1 returns the outlines unchanged', () => {
    expect(stretchOutlines(base, 1, 1)).toBe(base)
  })
})

describe('cascade', () => {
  it('solveAxis finds the value hitting the target on a monotone function', () => {
    const measure = (v: number) => 100 + v * 2   // width grows with the axis
    expect(solveAxis(measure, 0, 100, 200)).toBeCloseTo(50, 1)
    // Target beyond reach clamps to the extreme.
    expect(solveAxis(measure, 0, 100, 1000)).toBe(100)
    expect(solveAxis(measure, 0, 100, 50)).toBe(0)
  })

  it('planStretch passes S through untouched when the font has no wdth axis', () => {
    const plan = planStretch(font, 'Sailor', {}, 1.8)
    expect(plan.residual).toBeCloseTo(1.8, 6)
    expect(plan.coords.wdth).toBeUndefined()
  })

  it('weightCompensation nudges wght up when extending, and is clamped', () => {
    const base = { wght: 400 }
    const wide = weightCompensation(font, base, 2, 1)
    expect(wide.wght!).toBeGreaterThan(400)
    const extreme = weightCompensation(font, base, 2.5, 2.5, 5)
    const wghtAxis = font.axes.find(a => a.tag === 'wght')!
    expect(extreme.wght!).toBeLessThanOrEqual(wghtAxis.max)
    // No wght axis -> untouched.
    const bare: VtFont = { ...font, axes: font.axes.filter(a => a.tag !== 'wght') }
    expect(weightCompensation(bare, base, 2, 1)).toEqual(base)
  })
})

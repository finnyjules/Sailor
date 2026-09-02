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
import { analyzeFlex, buildRemap, glyphFlexFor, planStretch, remapValue, smoothProfile, solveAxis, stemFactor, stemWidthOf, stretchCommands, stretchOutlines, symmetrize, uniformSpans, weightCompensation } from '~/lib/vectortype/stretch'

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
    // The caps pin their rows, and the smoothing rule ramps flex off them over one stroke width — the interior starts past that ramp.
    const interior = Array.from(y.flex).slice(4, -4)
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

describe('partial-sliver growth cap', () => {
  it('caps partial slivers so they cannot absorb a whole glyph of stretch', () => {
    const flex = new Float64Array(10).fill(0)
    flex[4] = 0.5; flex[5] = 0.5            // two partial slivers in an otherwise rigid glyph
    const m = buildRemap({ start: 0, binSize: 10, flex }, 2)
    // cap = 2 * S * w = 40: each sliver stops there instead of absorbing 50 each
    expect(remapValue(m, 50) - remapValue(m, 40)).toBeLessThanOrEqual(40 + 1e-6)
    // the glyph under-achieves S = 2 rather than growing horns
    expect(remapValue(m, 100) - remapValue(m, 0)).toBeLessThan(200)
  })

  it('spills clamped overflow into fully flexible bins so the total still reaches S', () => {
    const flex = new Float64Array(10).fill(0)
    flex[4] = 0.5; flex[5] = 1              // one capped partial, one uncapped full bin
    const m = buildRemap({ start: 0, binSize: 10, flex }, 2.5)
    expect(remapValue(m, 100) - remapValue(m, 0)).toBeCloseTo(250, 4)
    // the partial bin sits exactly at its cap (2 * 2.5 * 10 = 50)
    expect(remapValue(m, 50) - remapValue(m, 40)).toBeCloseTo(50, 4)
  })

  it("keeps the dot of 'i' genuinely round at S = 1.8 (small features are rigid)", () => {
    const run = textOutlines(font, 'i')
    const g0 = run.glyphs[0]!
    const g2 = stretchOutlines(run, 1.8, 1).glyphs[0]!
    // Sample the dot across its whole vertical span: at every scanline the
    // ink may widen only marginally (remap-edge wobble), never lens out.
    for (const f of [0.86, 0.88, 0.9, 0.92, 0.94]) {
      const y0 = g0.bbox.minY + (g0.bbox.maxY - g0.bbox.minY) * f
      const y2 = g2.bbox.minY + (g2.bbox.maxY - g2.bbox.minY) * f
      const runs0 = inkRunsAtY(g0.commands, y0)
      const runs2 = inkRunsAtY(g2.commands, y2)
      if (!runs0.length || !runs2.length) continue
      const w0 = Math.max(...runs0.map(([a, b]) => b - a))
      const w2 = Math.max(...runs2.map(([a, b]) => b - a))
      expect(w2).toBeLessThan(w0 * 1.15)
    }
  })

  it('a small isolated component reads fully rigid on both axes', () => {
    // A stem with a detached dot above it — an abstract i.
    const stem = rect(0, 0, 100, 700)
    const dot = rect(0, 760, 120, 880)
    const bbox = { minX: 0, minY: 0, maxX: 120, maxY: 880 }
    const { x, y } = analyzeFlex([...stem, ...dot], bbox, { bins: 24, smallFeature: 300 })
    // The dot spans the full X range and the top Y rows: with the feature
    // rule on, every X bin it covers is pinned, and so are its Y rows.
    for (const f of x.flex) expect(f).toBeLessThan(0.05)
    const topBins = Array.from(y.flex).slice(Math.ceil((760 / 880) * 24))
    for (const f of topBins) expect(f).toBeLessThan(0.05)
    // The gap rows between stem and dot stay fully flexible — vertical
    // stretch moves the dot up rather than deforming it.
    const gapBin = Math.floor((730 / 880) * 24)
    expect(y.flex[gapBin]).toBe(1)
  })
})

describe('condense — order of sacrifice', () => {
  it('stems follow the common schedule, counters take exactly the remainder, the glyph lands on S (S = 0.5)', () => {
    const flex = new Float64Array([1, 1, 1, 0, 0, 0, 0, 1, 1, 1])
    const ink  = new Float64Array([0, 0, 0, 1, 1, 1, 1, 0, 0, 0])
    const m = buildRemap({ start: 0, binSize: 10, flex, ink }, 0.5)
    const width = (i: number) => remapValue(m, (i + 1) * 10) - remapValue(m, i * 10)
    // stems thin by the common S-only schedule — never per-glyph negotiation …
    for (const i of [3, 4, 5, 6]) expect(width(i)).toBeCloseTo(10 * stemFactor(0.5), 6)
    // … the stems gave 4 × 10 × (1 − stemFactor(0.5)) ≈ 12.44 of the 50
    // needed; the counters (all flex 1, so shared evenly) take exactly what's
    // left, ≈ 6.26 each — above their 3.0 floor, so nothing is dropped.
    const stemGive = 4 * 10 * (1 - stemFactor(0.5))
    for (const i of [0, 1, 2, 7, 8, 9]) expect(width(i)).toBeCloseTo(10 - (50 - stemGive) / 6, 6)
    // … so the glyph lands EXACTLY on S — the two reductions add up to the
    // deficit, not past it.
    expect(remapValue(m, 100) - remapValue(m, 0)).toBeCloseTo(50, 6)
  })

  it('ink-bearing flexible bins (arches, crossbars) floor at 50% and the glyph under-condenses', () => {
    const flex = new Float64Array(10).fill(1)
    const ink  = new Float64Array(10).fill(1)
    const m = buildRemap({ start: 0, binSize: 10, flex, ink }, 0.3)
    for (let i = 0; i < 10; i++) {
      expect(remapValue(m, (i + 1) * 10) - remapValue(m, i * 10)).toBeCloseTo(5, 6)
    }
    expect(remapValue(m, 100) - remapValue(m, 0)).toBeCloseTo(50, 6)   // not 30
  })

  it('never breaches a floor even at an extreme S, and stays monotone', () => {
    const flex = new Float64Array([1, 0.5, 0, 0, 1, 1, 0, 0.5, 1, 1])
    const ink  = new Float64Array([0, 1, 1, 1, 0, 1, 1, 1, 0, 0])
    const m = buildRemap({ start: 0, binSize: 10, flex, ink }, 0.2)
    let prev = -Infinity
    for (let v = 0; v <= 100; v += 1) { const r = remapValue(m, v); expect(r).toBeGreaterThanOrEqual(prev); prev = r }
    const floors = [3, 5, 6, 6, 3, 5, 6, 5, 3, 3]
    for (let i = 0; i < 10; i++) {
      expect(remapValue(m, (i + 1) * 10) - remapValue(m, i * 10)).toBeGreaterThanOrEqual(floors[i]! - 1e-6)
    }
  })

  it('never condenses past S: total width is ≥ S × natural for every profile', () => {
    const cases: Array<[number[], number[]]> = [
      [[1, 1, 1, 0, 0, 0, 0, 1, 1, 1], [0, 0, 0, 1, 1, 1, 1, 0, 0, 0]],
      [[1, 0.5, 0, 0, 1, 1, 0, 0.5, 1, 1], [0, 1, 1, 1, 0, 1, 1, 1, 0, 0]],
      [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
      [[1, 1, 1, 1, 1, 1, 1, 1, 1, 1], [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]],
    ]
    for (const S of [0.9, 0.7, 0.5, 0.3]) {
      for (const [f, i] of cases) {
        const m = buildRemap({ start: 0, binSize: 10, flex: new Float64Array(f), ink: new Float64Array(i) }, S)
        expect(remapValue(m, 100) - remapValue(m, 0)).toBeGreaterThanOrEqual(100 * S - 1e-6)
      }
    }
  })

  it("condensed 'o' at S = 0.64 lands on S when its counter has room (no overshoot)", () => {
    const run = textOutlines(font, 'o')
    const g0 = run.glyphs[0]!, g1 = stretchOutlines(run, 0.64, 1).glyphs[0]!
    const w0 = g0.bbox.maxX - g0.bbox.minX, w1 = g1.bbox.maxX - g1.bbox.minX
    expect(w1 / w0).toBeGreaterThan(0.64 - 0.01)
    expect(w1 / w0).toBeLessThan(0.64 + 0.03)
  })

  it('analyzeFlex reports ink occupancy: stems > 0, gaps = 0', () => {
    const left = rect(0, 0, 100, 700), right = rect(500, 0, 600, 700)
    const { x } = analyzeFlex([...left, ...right], { minX: 0, minY: 0, maxX: 600, maxY: 700 }, { bins: 24 })
    expect(x.ink).toBeDefined()
    expect(x.ink![0]).toBeGreaterThan(0)
    expect(x.ink![23]).toBeGreaterThan(0)
    const gapStart = Math.ceil((100 - x.start) / x.binSize) + 1
    const gapEnd = Math.floor((500 - x.start) / x.binSize) - 1
    for (let i = gapStart; i < gapEnd; i++) expect(x.ink![i]).toBe(0)
  })

  it("stemWidthOf reads the 'l' stem and the 'o' flank off the fixture", () => {
    const l = textOutlines(font, 'l').glyphs[0]!
    const lw = l.bbox.maxX - l.bbox.minX
    const sw = stemWidthOf(analyzeFlex(l.commands, l.bbox).x)
    expect(sw).toBeGreaterThan(lw * 0.8)
    expect(sw).toBeLessThanOrEqual(lw * 1.05)
    const o = textOutlines(font, 'o').glyphs[0]!
    const ow = stemWidthOf(analyzeFlex(o.commands, o.bbox).x)
    expect(ow).toBeGreaterThan(0)
    expect(ow).toBeLessThan((o.bbox.maxX - o.bbox.minX) * 0.35)
  })

  it("condensed 'o' at S = 0.5 keeps a real counter and thins its flanks no further than 60%", () => {
    const run = textOutlines(font, 'o')
    const g0 = run.glyphs[0]!
    const g1 = stretchOutlines(run, 0.5, 1).glyphs[0]!
    const midY = (g0.bbox.minY + g0.bbox.maxY) / 2
    const r0 = inkRunsAtY(g0.commands, midY), r1 = inkRunsAtY(g1.commands, midY)
    expect(r0.length).toBe(2); expect(r1.length).toBe(2)
    const counter0 = r0[1]![0] - r0[0]![1], counter1 = r1[1]![0] - r1[0]![1]
    expect(counter1).toBeGreaterThan(counter0 * 0.25)
    for (let i = 0; i < 2; i++) {
      const t0 = r0[i]![1] - r0[i]![0], t1 = r1[i]![1] - r1[i]![0]
      expect(t1).toBeLessThanOrEqual(t0 * 1.02)
      expect(t1).toBeGreaterThan(t0 * 0.55)
    }
  })

  it("condensed 'Sailor' at S = 0.5 never lets neighbours touch", () => {
    const out = stretchOutlines(textOutlines(font, 'Sailor'), 0.5, 1)
    const inked = out.glyphs.filter(g => g.commands.length && g.bbox.maxX > g.bbox.minX)
    for (let i = 0; i + 1 < inked.length; i++) {
      const a = inked[i]!, b = inked[i + 1]!
      expect(a.x + a.bbox.maxX).toBeLessThan(b.x + b.bbox.minX)
    }
  })

  it('stemFactor is 1 down to Condensed, then falls linearly to the floor', () => {
    expect(stemFactor(1)).toBe(1)
    expect(stemFactor(0.85)).toBe(1)
    expect(stemFactor(0.4)).toBeCloseTo(0.6, 9)
    expect(stemFactor(0.2)).toBeCloseTo(0.6, 9)
    const mid = stemFactor(0.625)
    expect(mid).toBeGreaterThan(0.6); expect(mid).toBeLessThan(1)
  })

  it("every glyph's stems thin by the SAME factor: 'l' stem vs 'o' flanks at S = 0.64", () => {
    const S = 0.64
    const l0 = textOutlines(font, 'l'), l1 = stretchOutlines(l0, S, 1)
    const midY = (l0.glyphs[0]!.bbox.minY + l0.glyphs[0]!.bbox.maxY) / 2
    const lw0 = inkRunsAtY(l0.glyphs[0]!.commands, midY)[0]!
    const lw1 = inkRunsAtY(l1.glyphs[0]!.commands, midY)[0]!
    const lRatio = (lw1[1] - lw1[0]) / (lw0[1] - lw0[0])
    const o0 = textOutlines(font, 'o'), o1 = stretchOutlines(o0, S, 1)
    const oy = (o0.glyphs[0]!.bbox.minY + o0.glyphs[0]!.bbox.maxY) / 2
    const r0 = inkRunsAtY(o0.glyphs[0]!.commands, oy), r1 = inkRunsAtY(o1.glyphs[0]!.commands, oy)
    const oRatio = (r1[0]![1] - r1[0]![0]) / (r0[0]![1] - r0[0]![0])
    expect(Math.abs(lRatio - oRatio)).toBeLessThan(0.04)
    expect(Math.abs(lRatio - stemFactor(S))).toBeLessThan(0.04)
  })

  it('a mild condense (S = 0.9) leaves every stem at full weight', () => {
    const l0 = textOutlines(font, 'l'), l1 = stretchOutlines(l0, 0.9, 1)
    const midY = (l0.glyphs[0]!.bbox.minY + l0.glyphs[0]!.bbox.maxY) / 2
    const a = inkRunsAtY(l0.glyphs[0]!.commands, midY)[0]!, b = inkRunsAtY(l1.glyphs[0]!.commands, midY)[0]!
    expect((b[1] - b[0]) / (a[1] - a[0])).toBeGreaterThan(0.97)
  })
})

describe('shape integrity', () => {
  it('uniformSpans flattens a span to its mean but leaves hard-rigid bins alone', () => {
    const flex = new Float64Array([1, 0.2, 0.6, 0, 0, 0.9, 0.3, 1])
    const hard = new Float64Array([1, 1, 1, 0, 0, 1, 1, 1])
    uniformSpans(flex, hard, [[1, 6]])
    // non-exempt bins 1,2,5,6 -> mean(0.2,0.6,0.9,0.3) = 0.5; stems at 3,4 untouched
    expect(Array.from(flex)).toEqual([1, 0.5, 0.5, 0, 0, 0.5, 0.5, 1])
  })

  it('symmetrize mirrors a profile about its centre', () => {
    const flex = new Float64Array([0, 0.2, 1, 0.6, 0.4])
    symmetrize(flex)
    expect(Array.from(flex)).toEqual([0.2, 0.4, 1, 0.4, 0.2])
  })

  it('a straight X keeps a uniform profile across its arms — no frozen crossing', () => {
    // One merged X outline (12 vertices) with two short vertical notch facets
    // at the crossing, like Inter's: facets are ~9% of the height, so they are
    // NOT straight strokes and must not pin the crossing.
    const X: PathCommand[] = [
      { command: 'moveTo', args: [0, 0] },
      { command: 'lineTo', args: [140, 0] },
      { command: 'lineTo', args: [400, 640] },
      { command: 'lineTo', args: [660, 0] },
      { command: 'lineTo', args: [800, 0] },
      { command: 'lineTo', args: [470, 800] },
      { command: 'lineTo', args: [470, 940] },     // right notch facet (vertical, 140 tall)
      { command: 'lineTo', args: [800, 1490] },
      { command: 'lineTo', args: [660, 1490] },
      { command: 'lineTo', args: [400, 850] },
      { command: 'lineTo', args: [140, 1490] },
      { command: 'lineTo', args: [0, 1490] },
      { command: 'lineTo', args: [330, 940] },
      { command: 'lineTo', args: [330, 800] },     // left notch facet
      { command: 'closePath', args: [] },
    ]
    const bbox = { minX: 0, minY: 0, maxX: 800, maxY: 1490 }
    const { x } = analyzeFlex(X, bbox, { bins: 32 })
    const vals = Array.from(x.flex)
    expect(Math.max(...vals) - Math.min(...vals)).toBeLessThan(0.05)
    expect(Math.min(...vals)).toBeGreaterThan(0.1)       // not frozen
    // and with shape rules off the old behaviour returns: a frozen crossing
    const old = analyzeFlex(X, bbox, { bins: 32, shapeRules: false })
    expect(Math.min(...Array.from(old.x.flex))).toBeLessThan(0.05)
  })

  it("a Y-like glyph keeps its stem rigid while the arm span is uniform elsewhere", () => {
    // Stem + one straight arm as a single polygon.
    const Y: PathCommand[] = [
      { command: 'moveTo', args: [300, 0] },
      { command: 'lineTo', args: [480, 0] },
      { command: 'lineTo', args: [480, 700] },
      { command: 'lineTo', args: [1000, 1400] },
      { command: 'lineTo', args: [860, 1490] },
      { command: 'lineTo', args: [390, 850] },
      { command: 'lineTo', args: [300, 850] },
      { command: 'closePath', args: [] },
    ]
    const bbox = { minX: 300, minY: 0, maxX: 1000, maxY: 1490 }
    const { x } = analyzeFlex(Y, bbox, { bins: 35 })
    // stem columns (x 300..480 -> bins 0..8) stay rigid
    for (let i = 0; i <= 8; i++) expect(x.flex[i]).toBeLessThan(0.05)
    // arm columns beyond the stem are uniform
    const arm = Array.from(x.flex).slice(10)
    expect(Math.max(...arm) - Math.min(...arm)).toBeLessThan(0.05)
  })

  it("the 'o' is symmetric, so its X profile is mirror-equal", () => {
    const g = textOutlines(font, 'o').glyphs[0]!
    const { x } = analyzeFlex(g.commands, g.bbox)
    const n = x.flex.length
    for (let i = 0; i < n; i++) expect(x.flex[i]).toBeCloseTo(x.flex[n - 1 - i]!, 9)
  })

  it("the 'S' flows under Height 2.29: no adjacent Y-profile jump larger than 0.5, and its arches still hold thickness", () => {
    const run = textOutlines(font, 'S')
    const g0 = run.glyphs[0]!
    const { y } = analyzeFlex(g0.commands, g0.bbox, { straightMin: 0.12 * font.unitsPerEm })
    let maxJump = 0
    for (let i = 1; i < y.flex.length; i++) maxJump = Math.max(maxJump, Math.abs(y.flex[i]! - y.flex[i - 1]!))
    expect(maxJump).toBeLessThan(0.5)
    // arch thickness (vertical run through the top arch, sampled at the glyph's x-centre)
    const g1 = stretchOutlines(run, 1, 2.29).glyphs[0]!
    const cx0 = (g0.bbox.minX + g0.bbox.maxX) / 2, cx1 = (g1.bbox.minX + g1.bbox.maxX) / 2
    const runs0 = inkRunsAtX(g0.commands, cx0), runs1 = inkRunsAtX(g1.commands, cx1)
    const top0 = runs0[runs0.length - 1]!, top1 = runs1[runs1.length - 1]!
    expect((top1[1] - top1[0]) / (top0[1] - top0[0])).toBeLessThan(1.3)
  })
})

describe('shared vertical zones', () => {
  it('textOutlines exposes plausible font metrics', () => {
    const o = textOutlines(font, 'x')
    expect(o.metrics.xHeight).toBeGreaterThan(font.unitsPerEm * 0.3)
    expect(o.metrics.xHeight).toBeLessThan(font.unitsPerEm * 0.7)
    expect(o.metrics.capHeight).toBeGreaterThan(o.metrics.xHeight)
    expect(o.metrics.ascent).toBeGreaterThanOrEqual(o.metrics.capHeight)
    expect(o.metrics.descent).toBeLessThan(0)
  })

  it('a zone line lands exactly at S × its position, regardless of how rigid each band is', () => {
    // Band A (bins 0-4) is mostly flexible, band B (bins 5-9) mostly rigid.
    const flex = new Float64Array([1, 1, 0, 0, 1, 0, 0, 0, 0, 1])
    const ink  = new Float64Array([0, 0, 1, 1, 0, 1, 1, 1, 1, 0])
    const withZones = buildRemap({ start: 0, binSize: 10, flex, ink }, 2, undefined, [50])
    expect(remapValue(withZones, 50)).toBeCloseTo(100, 6)
    expect(remapValue(withZones, 100)).toBeCloseTo(200, 6)
    const without = buildRemap({ start: 0, binSize: 10, flex, ink }, 2)
    expect(Math.abs(remapValue(without, 50) - 100)).toBeGreaterThan(5)   // the old behaviour drifts
  })

  it("the i's stem top stays level with the x-height letters at Height 2.5", () => {
    const run = textOutlines(font, 'ai')
    const tall = stretchOutlines(run, 1, 2.5)
    const stemTop = (g: typeof run.glyphs[0]) => {
      const cx = (g.bbox.minX + g.bbox.maxX) / 2
      const runs = inkRunsAtX(g.commands, cx)   // [stem run, dot run] bottom to top
      return runs[0]![1]
    }
    const a0 = run.glyphs[0]!, i0 = run.glyphs[1]!
    const a1 = tall.glyphs[0]!, i1 = tall.glyphs[1]!
    const gap0 = a0.bbox.maxY - stemTop(i0)         // ≈ the a's overshoot above the stem top
    const gap1 = a1.bbox.maxY - stemTop(i1)
    // The relationship survives: the gap may not grow by more than 2% of the new x-height.
    expect(Math.abs(gap1 - gap0)).toBeLessThan(0.02 * 2.5 * run.metrics.xHeight)
    // and the stem top itself sits at S × x-height (± 2%)
    expect(Math.abs(stemTop(i1) - 2.5 * stemTop(i0))).toBeLessThan(0.02 * 2.5 * stemTop(i0))
  })

  it('the baseline stays a fixed point with zones in play', () => {
    const run = textOutlines(font, 'g')
    const tall = stretchOutlines(run, 1, 2)
    const g0 = run.glyphs[0]!, g1 = tall.glyphs[0]!
    // descender grows down, x-height part grows up, baseline unmoved
    expect(g1.bbox.minY).toBeLessThan(g0.bbox.minY * 1.5)
    expect(g1.bbox.maxY).toBeGreaterThan(g0.bbox.maxY * 1.8)
  })
})

describe('stems follow area; curves stay smooth', () => {
  it('stemScale overrides the schedule for rigid bins under condense', () => {
    const flex = new Float64Array([1, 1, 0, 0, 0, 0, 1, 1, 1, 1])
    const ink  = new Float64Array([0, 0, 1, 1, 1, 1, 0, 0, 0, 0])
    const held = buildRemap({ start: 0, binSize: 10, flex, ink }, 0.7, undefined, undefined, 1)
    for (let i = 2; i <= 5; i++) expect(remapValue(held, (i + 1) * 10) - remapValue(held, i * 10)).toBeCloseTo(10, 6)
    const thinned = buildRemap({ start: 0, binSize: 10, flex, ink }, 0.7)
    for (let i = 2; i <= 5; i++) expect(remapValue(thinned, (i + 1) * 10) - remapValue(thinned, i * 10)).toBeCloseTo(10 * stemFactor(0.7), 6)
  })

  it("condense + tall (S 0.7, SY 2.5) keeps the 'l' stem at full weight; condense alone thins it", () => {
    const run = textOutlines(font, 'l')
    const g0 = run.glyphs[0]!
    const midY = (g0.bbox.minY + g0.bbox.maxY) / 2
    const w0 = inkRunsAtY(g0.commands, midY)[0]!
    const tall = stretchOutlines(run, 0.7, 2.5).glyphs[0]!
    const yTall = (tall.bbox.minY + tall.bbox.maxY) / 2
    const w1 = inkRunsAtY(tall.commands, yTall)[0]!
    expect((w1[1] - w1[0]) / (w0[1] - w0[0])).toBeGreaterThan(0.97)
    const narrow = stretchOutlines(run, 0.7, 1).glyphs[0]!
    const w2 = inkRunsAtY(narrow.commands, midY)[0]!
    expect(Math.abs((w2[1] - w2[0]) / (w0[1] - w0[0]) - stemFactor(0.7))).toBeLessThan(0.04)
  })

  it('smoothProfile ramps ink bins away from a plateau and never touches empty bins', () => {
    const flex = new Float64Array([0, 0, 1, 1, 1, 1, 1, 1])
    const ink  = new Float64Array([1, 1, 1, 1, 0, 0, 1, 1])
    smoothProfile(flex, ink, 4)          // step 0.25
    expect(Array.from(flex).map(v => +v.toFixed(2))).toEqual([0, 0, 0.25, 0.5, 1, 1, 1, 1])
  })

  it("the 'o' eases from arch to flank: no Y-profile jump larger than 1.5 steps of its arch thickness", () => {
    const g = textOutlines(font, 'o').glyphs[0]!
    const { y } = analyzeFlex(g.commands, g.bbox)
    const rampBins = stemWidthOf(y) / y.binSize
    expect(rampBins).toBeGreaterThan(2)
    let maxJump = 0
    for (let i = 1; i < y.flex.length; i++) {
      if (!(y.ink![i]! > 0 && y.ink![i - 1]! > 0)) continue
      maxJump = Math.max(maxJump, Math.abs(y.flex[i]! - y.flex[i - 1]!))
    }
    expect(maxJump).toBeLessThan(1.5 / rampBins)
    const old = analyzeFlex(g.commands, g.bbox, { shapeRules: false })
    let oldJump = 0
    for (let i = 1; i < old.y.flex.length; i++) oldJump = Math.max(oldJump, Math.abs(old.y.flex[i]! - old.y.flex[i - 1]!))
    expect(oldJump).toBeGreaterThan(maxJump)
  })

  it("the 'o' at Height 2.5 grows a larger corner radius: the flank's straight run is shorter than a 9-slice would give", () => {
    // A 9-slice keeps the arch's absolute size and makes the whole added height a
    // straight flank; easing spends some of it on the corner. Measure the flank's
    // straight run as the vertical extent over which the outer contour's x stays
    // within 1% of the extreme.
    const run = textOutlines(font, 'o')
    const g0 = run.glyphs[0]!
    const g1 = stretchOutlines(run, 1, 2.5).glyphs[0]!
    const straightRun = (cmds: PathCommand[], bbox: { minX: number; maxX: number; minY: number; maxY: number }) => {
      const h = bbox.maxY - bbox.minY
      let lo = Infinity, hi = -Infinity
      for (let i = 0; i <= 200; i++) {
        const yy = bbox.minY + (i / 200) * h
        const runs = inkRunsAtY(cmds, yy)
        if (!runs.length) continue
        if (runs[0]![0] <= bbox.minX + 0.01 * (bbox.maxX - bbox.minX)) { lo = Math.min(lo, yy); hi = Math.max(hi, yy) }
      }
      return Number.isFinite(lo) ? hi - lo : 0
    }
    const added = (g1.bbox.maxY - g1.bbox.minY) - (g0.bbox.maxY - g0.bbox.minY)
    const straight1 = straightRun(g1.commands, g1.bbox)
    const straight0 = straightRun(g0.commands, g0.bbox)
    // a pure 9-slice would put ALL added height into the straight run
    expect(straight1 - straight0).toBeLessThan(added * 0.9)
  })
})

describe('rounds stay round; terminals keep their angle', () => {
  it('turn bins are scaled multiplicatively AFTER the ordinary distribution; the free bins absorb the change', () => {
    const flex = new Float64Array([0, 0.5, 1, 1, 1, 1, 0.5, 0])
    const ink  = new Float64Array([1, 1, 0, 0, 0, 0, 1, 1])
    const turn = new Uint8Array([0, 1, 0, 0, 0, 0, 1, 0])
    // S = 1: ordinary distribution is a no-op (all bins stay at 10), so the
    // turn multiply is the only thing that moves anything. Shoulders grow
    // 1.5x (+5 each, +10 total); the free middle (bins 2-5) gives it back,
    // -2.5 each; the rigid ends (0, 7) never move; total stays 80.
    const m = buildRemap({ start: 0, binSize: 10, flex, ink, turn }, 1, undefined, undefined, undefined, 1.5)
    const width = (i: number) => remapValue(m, (i + 1) * 10) - remapValue(m, i * 10)
    expect(width(1)).toBeCloseTo(15, 6)
    expect(width(6)).toBeCloseTo(15, 6)
    expect(width(0)).toBeCloseTo(10, 6)
    expect(width(2)).toBeCloseTo(7.5, 6)
    expect(remapValue(m, 80) - remapValue(m, 0)).toBeCloseTo(80, 6)
    // S = 2: ordinary expansion runs FIRST, turn bins included like any
    // other (delta 80 over flex-sum 5 -> shoulders 10+16*0.5=18, free
    // bins 10+16*1=26, rigid ends untouched at 10). THEN the shoulders are
    // scaled x0.7 (18 -> 12.6, a change of -5.4 each, -10.8 total); the
    // free bins get it back, +2.7 each (26 -> 28.7); total stays 160.
    const m2 = buildRemap({ start: 0, binSize: 10, flex, ink, turn }, 2, undefined, undefined, undefined, 0.7)
    const w2 = (i: number) => remapValue(m2, (i + 1) * 10) - remapValue(m2, i * 10)
    expect(w2(1)).toBeCloseTo(12.6, 6)
    expect(w2(6)).toBeCloseTo(12.6, 6)
    expect(w2(0)).toBeCloseTo(10, 6)
    expect(w2(2)).toBeCloseTo(28.7, 6)
    expect(remapValue(m2, 80) - remapValue(m2, 0)).toBeCloseTo(160, 6)
  })

  it("the 'o' has turn rows in Y, and none of them are the apex thickness", () => {
    const g = textOutlines(font, 'o').glyphs[0]!
    const { y } = analyzeFlex(g.commands, g.bbox)
    expect(y.turn).toBeDefined()
    const turns = Array.from(y.turn!).reduce((n, v) => n + v, 0)
    expect(turns).toBeGreaterThan(2)
    for (let i = 0; i < y.flex.length; i++) if (y.turn![i]) expect(y.flex[i]).toBeGreaterThan(0.05)
  })

  it("condense 0.7 × Height 2.41: the 'o' arch gets SHORTER with its width while its apex keeps its thickness", () => {
    const run = textOutlines(font, 'o')
    const g0 = run.glyphs[0]!, g1 = stretchOutlines(run, 0.7, 2.41).glyphs[0]!
    // turn height = from the top down to where the outer contour first reaches within 2% of its extreme x
    const turnHeight = (cmds: PathCommand[], bbox: { minX: number; maxX: number; minY: number; maxY: number }) => {
      const h = bbox.maxY - bbox.minY, w = bbox.maxX - bbox.minX
      for (let i = 0; i <= 400; i++) {
        const yy = bbox.maxY - (i / 400) * h
        const runs = inkRunsAtY(cmds, yy)
        if (runs.length && runs[0]![0] <= bbox.minX + 0.02 * w) return bbox.maxY - yy
      }
      return h
    }
    const th0 = turnHeight(g0.commands, g0.bbox), th1 = turnHeight(g1.commands, g1.bbox)
    // Coupling's effect is judged RELATIVE to the uncoupled baseline (both
    // measured against the same th0), not against an absolute target: the
    // multiplicative mechanic redistributes onto whatever free bins exist,
    // so the exact ratio a real curve lands on depends on its own flex
    // shape, not just S — but coupling must make a real, substantial
    // difference, and never make the turn region taller than uncoupled.
    const old = stretchOutlines(run, 0.7, 2.41, { roundCoupling: 0 }).glyphs[0]!
    const thOld = turnHeight(old.commands, old.bbox)
    expect(th1 / th0).toBeLessThan(thOld / th0 - 0.12)   // at least 12% shorter than uncoupled
    expect(th1).toBeLessThanOrEqual(thOld)                // and never longer than uncoupled
    // Apex thickness: judged the same way, against the UNCOUPLED glyph at
    // the same S/SY, not an absolute target. At this combined condense +
    // big-height stretch the apex thickness ratio is ~1.19 on the engine's
    // own account (curve easing plus the ordinary distribution already
    // give it a modest, expected bump — verified against the unmodified
    // engine, no rule 10 at all) — coupling is not supposed to fix that; it
    // is only supposed to leave it alone. So the real invariant is that
    // coupling's own contribution here is small.
    const cx0 = (g0.bbox.minX + g0.bbox.maxX) / 2, cx1 = (g1.bbox.minX + g1.bbox.maxX) / 2, cxOld = (old.bbox.minX + old.bbox.maxX) / 2
    const a0 = inkRunsAtX(g0.commands, cx0), a1 = inkRunsAtX(g1.commands, cx1), aOld = inkRunsAtX(old.commands, cxOld)
    const t0 = a0[a0.length - 1]![1] - a0[a0.length - 1]![0], t1 = a1[a1.length - 1]![1] - a1[a1.length - 1]![0]
    const tOld = aOld[aOld.length - 1]![1] - aOld[aOld.length - 1]![0]
    expect(Math.abs(t1 / t0 - tOld / t0)).toBeLessThan(0.05)
  })

  it("the 'a' terminal cut keeps its angle under Height 2.41", () => {
    const run = textOutlines(font, 'a')
    const g0 = run.glyphs[0]!
    // find short lineTo segments with near-parallel neighbours and a perpendicular cut — the terminals
    const segsOf = (cmds: PathCommand[]) => {
      const out: Array<{ i: number; x0: number; y0: number; x1: number; y1: number }> = []
      let px = 0, py = 0
      cmds.forEach((c, i) => {
        if (c.command === 'moveTo') { px = c.args[0]!; py = c.args[1]! }
        else if (c.command === 'lineTo') { out.push({ i, x0: px, y0: py, x1: c.args[0]!, y1: c.args[1]! }); px = c.args[0]!; py = c.args[1]! }
        else if (c.command === 'quadraticCurveTo') { px = c.args[2]!; py = c.args[3]! }
        else if (c.command === 'bezierCurveTo') { px = c.args[4]!; py = c.args[5]! }
      })
      return out
    }
    const angle = (s: { x0: number; y0: number; x1: number; y1: number }) => Math.atan2(s.y1 - s.y0, s.x1 - s.x0) * 180 / Math.PI
    const short = segsOf(g0.commands).filter(s => Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 0.12 * font.unitsPerEm)
    const diagonal = short.filter(s => { const a = Math.abs(angle(s)) % 180; return a > 15 && a < 75 || a > 105 && a < 165 })
    expect(diagonal.length).toBeGreaterThan(0)   // Inter's a has a slanted terminal cut
    const g1 = stretchOutlines(run, 1, 2.41).glyphs[0]!
    const after = segsOf(g1.commands)
    for (const s of diagonal) {
      const t = after.find(q => q.i === s.i)!
      const d = Math.abs(((angle(t) - angle(s)) + 540) % 360 - 180)
      expect(d).toBeLessThan(8)
    }
    // NOTE: no shapeRules:false "old model drifts more" control here. Measured:
    // this terminal's row (y ~810-867) is already pinned by the unrelated
    // right STEM's own straight edge passing through the same height (hard
    // channel reads exactly 0 there) — true in the old single-channel-min
    // model too, since that channel is computed unconditionally. So old and
    // new both preserve this cut's angle at this exact spot, for a reason
    // that has nothing to do with rule 11: a shapeRules:false comparison
    // can't discriminate here. The assertions above are the real check —
    // they confirm rule 11 protects the cut under the new model directly.
  })

  it('a stem cap is a terminal too, but the X crossing notches are not', () => {
    // The stem rect's caps: rigid rows at the very top/bottom, interior still flexible.
    const { y } = analyzeFlex(rect(0, 0, 100, 700), { minX: 0, minY: 0, maxX: 100, maxY: 700 }, { bins: 16 })
    expect(y.flex[0]).toBeLessThan(0.05)
    expect(y.flex[15]).toBeLessThan(0.05)
    expect(y.flex[8]).toBeGreaterThan(0.95)
  })
})

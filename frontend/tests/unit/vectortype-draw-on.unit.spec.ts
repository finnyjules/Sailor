/**
 * Vector Type — DRAW-ON: letters drawing themselves.
 *
 * The canonical vector-type animation, and the one that stays REAL EDITABLE
 * VECTOR: `stroke-dasharray` / `stroke-dashoffset` are genuine SVG attributes,
 * so the file a designer opens still describes the letterform and the reveal is
 * two numbers they can restyle, re-time or delete. A clip or a mask would give
 * them a permanently half-drawn letter.
 *
 * Six things are measured here, ordered by how easy each would be to fake:
 *
 *  1. **Arc length is correct against ANALYTICALLY KNOWN shapes**, not merely
 *     self-consistent. A straight line has its own length exactly; a QUADRATIC
 *     matches its closed-form integral (which is the branch that matters — this
 *     fixture is TrueType, so its `S` is 35 `quadraticCurveTo`s and 4 `lineTo`s
 *     and not one cubic); and a circle of radius `r` measures `2πr`, built once
 *     out of cubics and once out of quadratics so "handles both" is a number
 *     rather than a claim. Against a deliberately BROKEN control — chords only,
 *     which is what forgetting the curve interiors would produce — the circle
 *     comes out 0.64 % short, so the sampler is doing work.
 *  2. **The inversion places at EQUAL ARC LENGTH**, on a path whose two halves
 *     run at wildly different parametric speeds, against a naive
 *     per-segment-uniform control that does not.
 *  3. **The dash algebra draws exactly the first `L·p`** of a subpath, checked
 *     against an independent reimplementation of SVG's own dash rule rather than
 *     against the function that produced it.
 *  4. **The leaf is a real config leaf**: it round-trips, backfills to 1 (so
 *     every config written before draw-on renders identically), is offered to
 *     motion as `appearance.<id>.draw` on a stroke layer and on no other kind,
 *     and `applyMotion` really writes it.
 *  5. **CANVAS AND SVG AGREE EXACTLY** — the recorded `setLineDash` /
 *     `lineDashOffset` against the exported attributes, at five progress values,
 *     with a broken control (the same feature measured against the TOTAL length
 *     instead of the longest contour) that disagrees.
 *  6. **REAL PIXELS.** resvg rasterises the export: ink grows monotonically with
 *     progress, the drawn FRACTION tracks the progress value on a
 *     single-contour letter, `p = 0` paints nothing at all, and the ink XOR
 *     against a broken control (the draw removed) is 0.0000.
 *
 * Plus the load-bearing negative: `pathLength.ts` imports NOTHING, and paper.js
 * above all. A draw-on measures every glyph's outline every frame.
 *
 * NO NETWORK: the same eight-character Inter variable subset every other Vector
 * Type spec uses. NO DOM beyond a recording 2D context.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { Resvg } from '@resvg/resvg-js'
import { describe, expect, it, vi } from 'vitest'
import { shapesToSVG, type VectorCommand } from '~/lib/vector/svg'
import { normaliseAxes, type VtFont } from '~/lib/vectortype/font'
import {
  DEFAULT_CONFIG,
  LAYER_DEFAULTS,
  mergeConfig,
  vtLayer,
  type VectorTypeConfig,
  type VtAppearanceLayer,
  type VtMotionTrack,
  type VtMove,
} from '~/lib/vectortype/config'
import { visibleVtControls } from '~/lib/vectortype/controls'
import { animatableTargets, applyMotion } from '~/lib/vectortype/motion'
import { drawVectorType, vectorTypeFrame, vectorTypeSVG, vtPlacement } from '~/lib/vectortype/canvas'
import { placeOutlines } from '~/lib/vectortype/render'
import {
  VT_PATH_SAMPLES_MIN,
  buildPathTable,
  pathLength,
  pointAtPathLength,
  vtDrawOnDash,
} from '~/lib/vectortype/pathLength'

// Real rasters at 520×300, a dozen of them, do not fit the suite's 5 s default
// while the whole suite runs in parallel. Raised rather than the pictures made
// smaller: the metrics are pixel counts, and shrinking the frame would blunt
// exactly the thing being measured.
vi.setConfig({ testTimeout: 30_000 })

// ── fixtures ────────────────────────────────────────────────────────────────

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
function loadFixtureFont(): VtFont {
  const bytes = new Uint8Array(readFileSync(FIXTURE))
  const raw: any = (fontkit as any).create(bytes)
  return {
    id: 'inter-subset',
    axes: normaliseAxes(raw?.variationAxes),
    unitsPerEm: Number(raw?.unitsPerEm) || 1000,
    raw,
  }
}
const font = loadFixtureFont()
const BOX = { width: 520, height: 300 }
const BLACK = '#000000'

const paint = (a: string) => ({ ...DEFAULT_CONFIG.appearance[0]!.paint, type: 'solid' as const, a })
const cfg = (patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig =>
  mergeConfig({ ...DEFAULT_CONFIG, text: 'Sail', size: 100, ...patch })
const track = (o: Partial<VtMotionTrack> & { path: string; from: number; to: number }): VtMotionTrack =>
  ({ easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0, ...o })

/** One `kind: 'tracks'` move wrapping a single track — `ease: 'none'`/
 *  `play: once ×1` reproduce the old default `easing: 'linear'`/`loops: 1`
 *  (the `track()` default above). */
let drawOnTrackMoveSeq = 0
function trackMove(t: VtMotionTrack): VtMove {
  drawOnTrackMoveSeq += 1
  const { path, from, to, hold, cycleOffset, delay } = t
  return {
    id: `move-t${drawOnTrackMoveSeq}`,
    phase: 'loop',
    kind: 'tracks',
    presetId: 'custom',
    duration: 4,
    ease: { kind: 'named', name: 'none' },
    play: { mode: 'once', times: 1 },
    tracks: [{ path, from, to, hold, cycleOffset, delay }],
  }
}

/** A single STROKE layer, nothing under it — so every measured pixel is the
 *  stroke's and a fill cannot flatter an ink count. */
function strokeOnly(over: Partial<VtAppearanceLayer> = {}, patch: Partial<VectorTypeConfig> = {}): VectorTypeConfig {
  return cfg({
    appearance: [vtLayer({ id: 'Lstroke', kind: 'stroke', width: 6, paint: paint(BLACK), ...over })],
    ...patch,
  })
}

/** The PLACED command list per glyph — the same three calls both renderers make,
 *  so a length measured here is the length the renderers measure. */
function placedOf(c: VectorTypeConfig, t = 0): VectorCommand[][] {
  const frame = vectorTypeFrame(font, c, t)
  return placeOutlines(frame.outlines, vtPlacement(frame, BOX))
}

// ════════════════════════════════════════════════════════════════════════════
// 1. ARC LENGTH, against shapes whose length is known analytically
// ════════════════════════════════════════════════════════════════════════════

const cmd = (command: string, ...args: number[]): VectorCommand => ({ command, args } as VectorCommand)

/**
 * The closed-form arc length of a quadratic Bézier.
 *
 * `|B'(t)| = 2·|A + tB|` with `A = P1−P0`, `B = P2−2P1+P0`, so the length is
 * `2·∫₀¹ √(at² + bt + c) dt` with `a = |B|²`, `b = 2A·B`, `c = |A|²` — an
 * integral with an elementary antiderivative. This is the ORACLE, not a second
 * sampler: a sampler compared against a sampler proves only that two people made
 * the same assumption.
 */
function quadraticArcLength(p0: [number, number], p1: [number, number], p2: [number, number]): number {
  const ax = p1[0] - p0[0]
  const ay = p1[1] - p0[1]
  const bx = p2[0] - 2 * p1[0] + p0[0]
  const by = p2[1] - 2 * p1[1] + p0[1]
  const A = bx * bx + by * by
  const B = 2 * (ax * bx + ay * by)
  const C = ax * ax + ay * ay
  if (A < 1e-12) return 2 * Math.sqrt(C)
  const sA = Math.sqrt(A)
  const F = (t: number): number => {
    const q = Math.sqrt(A * t * t + B * t + C)
    return ((2 * A * t + B) * q) / (4 * A)
      + ((4 * A * C - B * B) / (8 * A * sA)) * Math.log(2 * sA * q + 2 * A * t + B)
  }
  return 2 * (F(1) - F(0))
}

/** A circle of radius `r` as `n` CUBIC arcs. `k = (4/3)·tan(θ/4)` is the
 *  standard handle length; at 16 segments the shape error is ~1e-8·r, far under
 *  the measurement's own 6.3e-6, so `2πr` really is the answer to compare to. */
function cubicCircle(r: number, n = 16): VectorCommand[] {
  const th = (Math.PI * 2) / n
  const k = (4 / 3) * Math.tan(th / 4)
  const out: VectorCommand[] = [cmd('moveTo', r, 0)]
  for (let i = 0; i < n; i++) {
    const a0 = i * th
    const a1 = (i + 1) * th
    const x0 = r * Math.cos(a0); const y0 = r * Math.sin(a0)
    const x1 = r * Math.cos(a1); const y1 = r * Math.sin(a1)
    out.push(cmd('bezierCurveTo',
      x0 - k * r * Math.sin(a0), y0 + k * r * Math.cos(a0),
      x1 + k * r * Math.sin(a1), y1 - k * r * Math.cos(a1),
      x1, y1))
  }
  out.push(cmd('closePath'))
  return out
}

/** The same circle as `n` QUADRATIC arcs — the branch a TrueType glyph is made
 *  of. The control point is where the two end tangents meet, at radius
 *  `r / cos(θ/2)`; at 64 segments the shape error is ~2e-8·r. */
function quadraticCircle(r: number, n = 64): VectorCommand[] {
  const th = (Math.PI * 2) / n
  const out: VectorCommand[] = [cmd('moveTo', r, 0)]
  const rc = r / Math.cos(th / 2)
  for (let i = 0; i < n; i++) {
    const am = (i + 0.5) * th
    const a1 = (i + 1) * th
    out.push(cmd('quadraticCurveTo',
      rc * Math.cos(am), rc * Math.sin(am),
      r * Math.cos(a1), r * Math.sin(a1)))
  }
  out.push(cmd('closePath'))
  return out
}

/** The BROKEN CONTROL: every curve replaced by its chord, i.e. what a length
 *  routine that never looked inside a Bézier would report. */
function chordOnlyLength(commands: readonly VectorCommand[]): number {
  let total = 0
  let px = 0; let py = 0; let sx = 0; let sy = 0
  for (const c of commands) {
    const a = c.args
    const step = (x: number, y: number) => { total += Math.hypot(x - px, y - py); px = x; py = y }
    switch (c.command) {
      case 'moveTo': px = a[0]!; py = a[1]!; sx = px; sy = py; break
      case 'lineTo': step(a[0]!, a[1]!); break
      case 'quadraticCurveTo': step(a[2]!, a[3]!); break
      case 'bezierCurveTo': step(a[4]!, a[5]!); break
      case 'closePath': step(sx, sy); break
    }
  }
  return total
}

describe('per-glyph path length — correct against KNOWN lengths, not just itself', () => {
  it('a straight line has its own length, EXACTLY', () => {
    expect(pathLength([cmd('moveTo', 0, 0), cmd('lineTo', 300, 0)]).total).toBe(300)
    // 3-4-5, so the answer is an integer and a floating-point slip would show.
    expect(pathLength([cmd('moveTo', 10, 10), cmd('lineTo', 310, 410)]).total).toBe(500)
    // A CURVE whose controls are collinear is a straight line, and the chord is
    // not an approximation of it — it is the answer. Exact, by the flatness
    // short-circuit.
    expect(pathLength([cmd('moveTo', 0, 0), cmd('bezierCurveTo', 100, 0, 200, 0, 300, 0)]).total).toBe(300)
    expect(pathLength([cmd('moveTo', 0, 0), cmd('quadraticCurveTo', 150, 0, 300, 0)]).total).toBe(300)
  })

  it('a QUADRATIC matches its CLOSED-FORM arc length — the TrueType branch', () => {
    const cases: Array<[[number, number], [number, number], [number, number]]> = [
      [[0, 0], [50, 200], [300, 0]],
      [[10, 40], [-60, 300], [220, 180]],
      [[0, 0], [400, 5], [800, 0]],
      [[0, 0], [0, 250], [180, 250]],
    ]
    const rows: string[] = []
    for (const [p0, p1, p2] of cases) {
      const measured = pathLength([cmd('moveTo', ...p0), cmd('quadraticCurveTo', ...p1, ...p2)]).total
      const exact = quadraticArcLength(p0, p1, p2)
      rows.push(`${exact.toFixed(6)} vs ${measured.toFixed(6)}  rel ${(Math.abs(measured - exact) / exact).toExponential(2)}`)
      expect(Math.abs(measured - exact) / exact).toBeLessThan(1e-5)
      // Under-measures, never over: a chord is always shorter than its arc.
      expect(measured).toBeLessThanOrEqual(exact * (1 + 1e-12))
    }
    expect(rows.length).toBe(4)
  })

  it('a circle of radius r measures 2πr — out of CUBICS and out of QUADRATICS', () => {
    for (const r of [100, 250]) {
      const exact = 2 * Math.PI * r
      const c = pathLength(cubicCircle(r)).total
      const q = pathLength(quadraticCircle(r)).total
      expect(Math.abs(c - exact) / exact, `cubic r=${r}`).toBeLessThan(1e-5)
      expect(Math.abs(q - exact) / exact, `quadratic r=${r}`).toBeLessThan(1e-5)
      // The two curve kinds agree with EACH OTHER to the same order, which is
      // what "handles both" means once both are correct.
      expect(Math.abs(c - q) / exact).toBeLessThan(2e-5)
    }
  })

  it('BROKEN CONTROL: chords only is measurably wrong, so the sampler does work', () => {
    const r = 100
    const exact = 2 * Math.PI * r
    const naive = chordOnlyLength(cubicCircle(r))
    // 16 chords of a circle: 16·2r·sin(θ/2) = 624.34, which is 0.64 % short.
    expect(naive).toBeLessThan(exact - 3)
    expect((exact - naive) / exact).toBeGreaterThan(0.005)
    // And the module is nowhere near that error.
    expect(Math.abs(pathLength(cubicCircle(r)).total - exact) / exact).toBeLessThan(1e-5)
  })

  it('measures SUBPATHS separately, and `longest` is not the total', () => {
    // Two concentric squares — an `o`, idealised. 4×100 and 4×50.
    const ring = (s: number): VectorCommand[] => [
      cmd('moveTo', 0, 0), cmd('lineTo', s, 0), cmd('lineTo', s, s), cmd('lineTo', 0, s), cmd('closePath'),
    ]
    const L = pathLength([...ring(100), ...ring(50)])
    expect(L.subpaths).toEqual([400, 200])
    expect(L.total).toBe(600)
    expect(L.longest).toBe(400)
  })

  it('a REAL GLYPH: `a` is two contours and `S` is one, and the numbers are the placed ones', () => {
    const placed = placedOf(strokeOnly())
    // 'S' 'a' 'i' 'l'
    expect(placed.length).toBe(4)
    const S = pathLength(placed[0])
    const a = pathLength(placed[1])
    const i = pathLength(placed[2])
    const l = pathLength(placed[3])
    expect(S.subpaths.length).toBe(1)
    expect(a.subpaths.length).toBe(2)
    expect(i.subpaths.length).toBe(2)
    expect(l.subpaths.length).toBe(1)
    // `longest` is strictly under the total exactly where there is more than one
    // contour, which is the whole reason the two are separate numbers.
    expect(S.longest).toBe(S.total)
    expect(a.longest).toBeLessThan(a.total)
    // 'l' is pure `lineTo`, so its length is exactly its polyline — the chord
    // control and the module agree to the bit.
    expect(l.total).toBe(chordOnlyLength(placed[3] as VectorCommand[]))
    // …and 'S' is 35 quadratics, so they must NOT.
    expect(S.total).toBeGreaterThan(chordOnlyLength(placed[0] as VectorCommand[]))
  })

  it('`pathLength` and `buildPathTable` agree to the BIT — one walker, not two', () => {
    for (const commands of [cubicCircle(137), quadraticCircle(83), ...placedOf(strokeOnly())]) {
      const flat = pathLength(commands)
      const table = buildPathTable(commands)
      expect(table.total).toBe(flat.total)
      expect(table.longest).toBe(flat.longest)
      expect(table.subpaths.map(s => s.length)).toEqual(flat.subpaths)
    }
  })

  it('the INVERSION lands where ANALYSIS says, where a per-segment walk does not', () => {
    // A circle of radius r, built from arcs of DELIBERATELY UNEQUAL angle: one of
    // 90° followed by twelve of 22.5°. Still a circle to ~1e-4 of r (a 90° cubic
    // arc's radial error is 2.7e-4·r and the small ones are far better), so the
    // point at arc length `s` has an analytic answer — polar angle `s / r` — and
    // the segments carry wildly different shares of it.
    const r = 100
    const angles = [90, ...Array.from({ length: 12 }, () => 22.5)].map(d => (d * Math.PI) / 180)
    const commands: VectorCommand[] = [cmd('moveTo', r, 0)]
    let a0 = 0
    for (const th of angles) {
      const a1 = a0 + th
      const k = (4 / 3) * Math.tan(th / 4)
      commands.push(cmd('bezierCurveTo',
        r * Math.cos(a0) - k * r * Math.sin(a0), r * Math.sin(a0) + k * r * Math.cos(a0),
        r * Math.cos(a1) + k * r * Math.sin(a1), r * Math.sin(a1) - k * r * Math.cos(a1),
        r * Math.cos(a1), r * Math.sin(a1)))
      a0 = a1
    }
    const table = buildPathTable(commands)
    // Still a circle: its measured length is 2πr to within the shape error of
    // that one 90° arc.
    expect(Math.abs(table.total - 2 * Math.PI * r) / (2 * Math.PI * r)).toBeLessThan(1e-3)

    const worst = { shipped: 0, naive: 0 }
    const SAMPLES = 24
    for (let i = 0; i <= SAMPLES; i++) {
      const s = (table.total * i) / SAMPLES
      const want = s / r
      const p = pointAtPathLength(table, s)
      // The radius is exact by construction, so an inversion that landed on the
      // wrong SEGMENT would still be on the circle — the ANGLE is what tells.
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(r, 0)
      const got = Math.atan2(p.y, p.x)
      const err = Math.abs(((got - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
      worst.shipped = Math.max(worst.shipped, err)

      // BROKEN CONTROL — the naive inversion: give each of the 13 segments an
      // EQUAL share of the parameter, which is what "walk the commands evenly"
      // means. Segment 0 covers a quarter of the circle on a thirteenth of the
      // walk, so it is hopeless there and fine nowhere.
      const f = i / SAMPLES
      const seg = Math.min(angles.length - 1, Math.floor(f * angles.length))
      const within = f * angles.length - seg
      let naiveAngle = 0
      for (let k = 0; k < seg; k++) naiveAngle += angles[k]!
      naiveAngle += within * angles[seg]!
      const nErr = Math.abs(((naiveAngle - want + Math.PI * 3) % (Math.PI * 2)) - Math.PI)
      worst.naive = Math.max(worst.naive, nErr)
    }
    // Radians. The shipped inversion is within a thousandth of a radian of the
    // analytic answer; the naive one is out by most of a radian.
    expect(worst.shipped).toBeLessThan(2e-3)
    expect(worst.naive).toBeGreaterThan(0.5)
  })

  it('degenerates without producing a NaN', () => {
    for (const commands of [[], [cmd('closePath')], [cmd('moveTo', 5, 5)], [cmd('lineTo', 1, 1)]]) {
      const L = pathLength(commands as VectorCommand[])
      expect(Number.isFinite(L.total)).toBe(true)
      expect(Number.isFinite(L.longest)).toBe(true)
      const p = pointAtPathLength(buildPathTable(commands as VectorCommand[]), 42)
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.angle)).toBe(true)
    }
    // A zero-extent curve contributes zero rather than a NaN from `atan2(0,0)`
    // or a division by a zero chord.
    expect(pathLength([cmd('moveTo', 7, 7), cmd('quadraticCurveTo', 7, 7, 7, 7)]).total).toBe(0)
    expect(VT_PATH_SAMPLES_MIN).toBeGreaterThan(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2. THE DASH ALGEBRA — checked against SVG's own rule, reimplemented
// ════════════════════════════════════════════════════════════════════════════

/**
 * How much of a subpath of length `sub` a dash pattern actually paints, from
 * SVG's / canvas's definition rather than from the function under test: the
 * pattern repeats with period `sum(dash)`, `offset` is the distance INTO it that
 * position 0 sits at, and the odd-indexed entries are gaps.
 */
function drawnLength(dash: readonly number[], offset: number, sub: number): number {
  const period = dash.reduce((a, b) => a + b, 0)
  if (!(period > 0)) return sub
  let drawn = 0
  const STEP = 1e-4
  // Integrated numerically rather than analytically, so this cannot share an
  // algebraic mistake with `vtDrawOnDash`.
  for (let s = STEP / 2; s < sub; s += STEP) {
    let phase = (s + offset) % period
    if (phase < 0) phase += period
    let on = true
    for (const d of dash) {
      if (phase < d) break
      phase -= d
      on = !on
    }
    if (on) drawn += STEP
  }
  return drawn
}

describe('the dash: exactly the first L·p of every contour', () => {
  it('emits NOTHING to dash at full draw — the identity value', () => {
    expect(vtDrawOnDash(100, 1)).toBeNull()
    expect(vtDrawOnDash(100, 1.5)).toBeNull()
    expect(vtDrawOnDash(100, Number.NaN)).toBeNull()
    expect(vtDrawOnDash(0, 0.5)).toBeNull()
    expect(vtDrawOnDash(Number.NaN, 0.5)).toBeNull()
  })

  it('is [L, L] with offset L·(1−p) — and p=0 is the whole subpath in the gap', () => {
    expect(vtDrawOnDash(200, 0)).toEqual({ dash: [200, 200], offset: 200 })
    expect(vtDrawOnDash(200, 0.25)).toEqual({ dash: [200, 200], offset: 150 })
    expect(vtDrawOnDash(200, 0.5)).toEqual({ dash: [200, 200], offset: 100 })
    // Clamped, not extrapolated: a negative progress is "not started".
    expect(vtDrawOnDash(200, -3)).toEqual({ dash: [200, 200], offset: 200 })
  })

  it('DRAWS L·p, measured by SVG\'s own dash rule', () => {
    const L = 200
    for (const p of [0, 0.1, 0.25, 0.5, 0.73, 0.99]) {
      const spec = vtDrawOnDash(L, p)!
      const drawn = drawnLength(spec.dash, spec.offset, L)
      expect(Math.abs(drawn - L * p), `p=${p}`).toBeLessThan(0.01)
    }
    // A SHORTER contour under the same pattern draws L·p of ITSELF too, until it
    // runs out — which is what makes a counter finish early rather than the
    // letter finishing early.
    const spec = vtDrawOnDash(L, 0.5)!
    expect(Math.abs(drawnLength(spec.dash, spec.offset, 120) - 100)).toBeLessThan(0.01)
    // …and at p = 1 − ε every contour is complete.
    const nearly = vtDrawOnDash(L, 0.999)!
    expect(Math.abs(drawnLength(nearly.dash, nearly.offset, 120) - 120)).toBeLessThan(0.01)
  })

  it('a second dash cannot start inside a subpath — the invariant `L` is chosen for', () => {
    // The property that makes ONE `stroke-dasharray` enough for a whole letter.
    // The period is `2L` and the dash covers `[0, L·p)`, so the next dash begins
    // at `L·p + L` — which is past `L`, and `L` is by definition the LONGEST
    // contour. So no contour of this glyph can reach it, for any `p`.
    const L = 100
    for (const p of [0, 0.2, 0.4, 0.6, 0.8, 0.999]) {
      const spec = vtDrawOnDash(L, p)!
      expect(spec.dash[0] + spec.dash[1]).toBe(2 * L)
      expect(spec.offset + L * p).toBeCloseTo(L, 9)
      for (const sub of [L, L * 0.9, L * 0.5, L * 0.31]) {
        // Exactly `min(L·p, sub)` — the dash, and never a second one.
        expect(drawnLength(spec.dash, spec.offset, sub), `p=${p} sub=${sub}`)
          .toBeCloseTo(Math.min(L * p, sub), 1)
      }
    }
    // And it IS a repeating pattern rather than a one-shot: past `L·p + L` the
    // second dash does appear, which is why `L` must be the longest contour and
    // not, say, the average.
    const spec = vtDrawOnDash(L, 0.4)!
    expect(drawnLength(spec.dash, spec.offset, 2 * L)).toBeGreaterThan(L * 0.4 + 10)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3. THE LEAF — a config parameter, so the animation is free
// ════════════════════════════════════════════════════════════════════════════

describe('`draw` is a real config leaf on the LAYER', () => {
  it('defaults to 1 and BACKFILLS to 1 from a blob that never had it', () => {
    expect(LAYER_DEFAULTS.draw).toBe(1)
    expect(vtLayer({ kind: 'stroke' }).draw).toBe(1)
    // A stack saved before draw-on existed — no `draw` anywhere.
    const legacy = mergeConfig({
      ...DEFAULT_CONFIG,
      appearance: [{ id: 'Lstroke', kind: 'stroke', width: 6, paint: BLACK } as any],
    })
    expect(legacy.appearance[0]!.draw).toBe(1)
  })

  it('round-trips and clamps', () => {
    const c = mergeConfig(strokeOnly({ draw: 0.42 }))
    expect(c.appearance[0]!.draw).toBeCloseTo(0.42, 10)
    expect(mergeConfig(strokeOnly({ draw: 7 as number })).appearance[0]!.draw).toBe(1)
    expect(mergeConfig(strokeOnly({ draw: -4 as number })).appearance[0]!.draw).toBe(0)
    expect(mergeConfig(strokeOnly({ draw: Number.NaN })).appearance[0]!.draw).toBe(1)
  })

  it('is DECLARED, and gated to a stroke layer — no dead control on a fill', () => {
    const keys = (c: VectorTypeConfig) => visibleVtControls(c).map(x => x.key)
    expect(keys(strokeOnly())).toContain('layer.draw')
    expect(keys(cfg({ appearance: [vtLayer({ id: 'Lf', kind: 'fill' })] }))).not.toContain('layer.draw')
    expect(keys(cfg({ appearance: [vtLayer({ id: 'Le', kind: 'extrude', depth: 4, solid: true })] })))
      .not.toContain('layer.draw')
    const spec = visibleVtControls(strokeOnly()).find(x => x.key === 'layer.draw')!
    expect(spec.kind).toBe('slider')
    expect([(spec as any).min, (spec as any).max, (spec as any).default]).toEqual([0, 1, 1])
  })

  it('is ANIMATABLE FOR FREE — one target per stroke layer, addressed by ID', () => {
    const two = cfg({
      appearance: [
        vtLayer({ id: 'Lunder', kind: 'stroke', width: 10, paint: paint('#ff0000') }),
        vtLayer({ id: 'Lover', kind: 'stroke', width: 3, paint: paint('#0000ff') }),
        vtLayer({ id: 'Lface', kind: 'fill', paint: paint('#00ff00') }),
      ],
    })
    const paths = animatableTargets(two).map(t => t.path)
    expect(paths).toContain('appearance.Lunder.draw')
    expect(paths).toContain('appearance.Lover.draw')
    // The FILL gets none — a `when` gate applied per layer, not per config.
    expect(paths).not.toContain('appearance.Lface.draw')
    const t = animatableTargets(two).find(x => x.path === 'appearance.Lover.draw')!
    expect([t.min, t.max]).toEqual([0, 1])
    expect(t.label).toContain('Draw on')
  })

  it('`applyMotion` really writes it — a 0 → 1 track over the clip', () => {
    const c = mergeConfig({
      ...strokeOnly(),
      motion: {
        ...DEFAULT_CONFIG.motion,
        duration: 4,
        moves: [trackMove(track({ path: 'appearance.Lstroke.draw', from: 0, to: 1 }))],
      },
    })
    const at = (t: number) => (applyMotion(c, t).appearance[0] as VtAppearanceLayer).draw
    expect([at(0), at(1), at(2), at(3), at(4)].map(v => Number(v.toFixed(4))))
      .toEqual([0, 0.25, 0.5, 0.75, 1])
    // The layer the user is holding is untouched: `applyMotion` clones.
    expect(c.appearance[0]!.draw).toBe(1)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4. THE EXPORT — real attributes, not a clip and not a mask
// ════════════════════════════════════════════════════════════════════════════

const svgAt = (c: VectorTypeConfig, t = 0): string =>
  vectorTypeSVG(font, c, t, { ...BOX, background: '#ffffff' }).svg

interface PathAttrs {
  dash: number[] | null
  offset: number | null
  stroke: string | null
  width: number | null
}

/** Every `<path>` in a document, with the four attributes this task is about. */
function paths(svg: string): PathAttrs[] {
  return [...svg.matchAll(/<path\b[^>]*\/>/g)].map((m) => {
    const el = m[0]
    const get = (name: string): string | null => {
      const r = new RegExp(`\\s${name}="([^"]*)"`).exec(el)
      return r ? (r[1] as string) : null
    }
    const da = get('stroke-dasharray')
    const off = get('stroke-dashoffset')
    const w = get('stroke-width')
    return {
      dash: da === null ? null : da.trim().split(/[\s,]+/).map(Number),
      offset: off === null ? null : Number(off),
      stroke: get('stroke'),
      width: w === null ? null : Number(w),
    }
  })
}

describe('the SVG carries a REAL dashed stroke', () => {
  it('writes `stroke-dasharray` and `stroke-dashoffset` on the glyph paths', () => {
    const svg = svgAt(strokeOnly({ draw: 0.4 }))
    const ps = paths(svg)
    expect(ps.length).toBe(4)
    const placed = placedOf(strokeOnly({ draw: 0.4 }))
    ps.forEach((p, i) => {
      const L = pathLength(placed[i]).longest
      expect(p.stroke).toBe(BLACK)
      expect(p.dash, `glyph ${i}`).not.toBeNull()
      // The dash IS the longest contour, twice — and the offset is 60 % of it.
      expect(p.dash![0]).toBeCloseTo(L, 2)
      expect(p.dash![1]).toBeCloseTo(L, 2)
      expect(p.offset).toBeCloseTo(L * 0.6, 2)
    })
    // The letters are NOT all the same length, so this is a per-glyph number
    // rather than one value written four times.
    expect(new Set(ps.map(p => p.dash![0])).size).toBe(4)
  })

  it('is a DASH, not a clip and not a mask', () => {
    const svg = svgAt(strokeOnly({ draw: 0.35 }))
    expect(svg).toContain('stroke-dasharray=')
    expect(svg).toContain('stroke-dashoffset=')
    // The two things a raster-thinking implementation would reach for. Neither
    // is introduced by the draw-on: the plain stroke export has none either, so
    // this is a difference of zero rather than an absence nobody checked.
    for (const forbidden of ['clipPath', 'clip-path', '<mask', 'mask=']) {
      expect(svg, forbidden).not.toContain(forbidden)
    }
    // And the geometry is still the LETTERFORM: same `d` data as the undashed
    // export, to the character.
    const plain = svgAt(strokeOnly())
    const dOf = (s: string) => [...s.matchAll(/<path\b[^>]*\sd="([^"]*)"/g)].map(m => m[1])
    expect(dOf(svg)).toEqual(dOf(plain))
  })

  it('draw = 1 exports BYTE-IDENTICALLY to a config that never had the field', () => {
    // The identity guarantee. A layer at full draw must not grow a `dasharray`
    // covering everything — that would change every existing export.
    const withField = svgAt(strokeOnly({ draw: 1 }))
    expect(withField).not.toContain('stroke-dasharray')
    expect(withField).not.toContain('stroke-dashoffset')
    const legacy = mergeConfig({
      ...DEFAULT_CONFIG,
      text: 'Sail',
      size: 100,
      appearance: [{ id: 'Lstroke', kind: 'stroke', width: 6, paint: BLACK } as any],
    })
    expect(withField).toBe(svgAt(legacy))
  })

  it('a FILL layer and a solid EXTRUDE never dash, whatever `draw` says', () => {
    for (const over of [
      { kind: 'fill' as const },
      { kind: 'extrude' as const, depth: 4, distance: 4, solid: true, width: 4, strokeColor: BLACK },
    ]) {
      const svg = svgAt(cfg({ appearance: [vtLayer({ id: 'L0', draw: 0.3, paint: paint(BLACK), ...over })] }))
      expect(svg, over.kind).not.toContain('stroke-dasharray')
    }
  })

  it('the SPINE drops an unusable dash rather than writing a solid stroke', () => {
    // `stroke-dasharray` is defined so that an invalid list, or one summing to
    // zero, renders SOLID — i.e. exactly the opposite of a reveal. So the writer
    // refuses those instead of passing them through.
    const one = (dash: number[] | null, dashOffset?: number) =>
      shapesToSVG([{ commands: [cmd('moveTo', 0, 0), cmd('lineTo', 10, 0)], stroke: BLACK, dash, dashOffset }],
        { viewBox: [0, 0, 10, 10] })
    expect(one([10, 10], 4)).toContain('stroke-dasharray="10 10"')
    expect(one([10, 10], 4)).toContain('stroke-dashoffset="4"')
    for (const bad of [[], [0, 0], [-1, 10], [Number.NaN, 5], null]) {
      expect(one(bad as number[] | null, 4), JSON.stringify(bad)).not.toContain('stroke-dasharray')
      expect(one(bad as number[] | null, 4), JSON.stringify(bad)).not.toContain('stroke-dashoffset')
    }
    // A zero-length dash beside a real gap is LEGAL and meaningful — the "not
    // started" end of a reveal — so it survives.
    expect(one([0, 10], 0)).toContain('stroke-dasharray="0 10"')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 5. CANVAS vs SVG — the same two numbers on both surfaces
// ════════════════════════════════════════════════════════════════════════════

class RecMatrix {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0
  inverse() { return new RecMatrix() }
  multiply() { return new RecMatrix() }
  translate() { return new RecMatrix() }
  scale() { return new RecMatrix() }
}

/** A recording 2D context that keeps the DASH STATE each op was drawn under.
 *  Counting strokes cannot tell a draw-on from a plain outline; the dash list
 *  and its offset are the whole question. */
class RecCtx {
  ops: Array<{ op: 'fill' | 'stroke'; dash: number[]; dashOffset: number; lineWidth: number }> = []
  canvas = { width: 1040, height: 600 }
  globalAlpha = 1
  globalCompositeOperation = 'source-over'
  filter = 'none'
  fillStyle: any = '#000'
  strokeStyle: any = '#000'
  lineWidth = 1
  lineJoin = 'miter'
  lineDashOffset = 0
  private lineDash: number[] = []
  private stack: Array<{ dash: number[]; offset: number }> = []
  save() { this.stack.push({ dash: [...this.lineDash], offset: this.lineDashOffset }) }
  restore() {
    // The dash list is part of the canvas DRAWING STATE, so a faithful recorder
    // has to restore it — otherwise a leak between glyphs would pass unnoticed
    // here and show up on screen.
    const s = this.stack.pop()
    if (s) { this.lineDash = s.dash; this.lineDashOffset = s.offset }
  }
  setLineDash(d: number[]) { this.lineDash = [...d] }
  getLineDash() { return [...this.lineDash] }
  beginPath() {}
  clip() {}
  rect() {}
  translate() {}
  rotate() {}
  scale() {}
  transform() {}
  setTransform() {}
  getTransform() { return new RecMatrix() }
  clearRect() {}
  fillRect() {}
  createLinearGradient() { return { addColorStop() {} } }
  createRadialGradient() { return { addColorStop() {} } }
  createPattern() { return null }
  fill() { this.push('fill') }
  stroke() { this.push('stroke') }
  measureText() { return { width: 0 } }
  private push(op: 'fill' | 'stroke') {
    this.ops.push({ op, dash: [...this.lineDash], dashOffset: this.lineDashOffset, lineWidth: this.lineWidth })
  }
}

class RecPath2D {
  __cmds: Array<{ command: string; args: number[] }> = []
  moveTo(...a: number[]) { this.__cmds.push({ command: 'moveTo', args: a }) }
  lineTo(...a: number[]) { this.__cmds.push({ command: 'lineTo', args: a }) }
  quadraticCurveTo(...a: number[]) { this.__cmds.push({ command: 'quadraticCurveTo', args: a }) }
  bezierCurveTo(...a: number[]) { this.__cmds.push({ command: 'bezierCurveTo', args: a }) }
  closePath() { this.__cmds.push({ command: 'closePath', args: [] }) }
  addPath(p: any) { if (p?.__cmds) this.__cmds.push(...p.__cmds) }
}
;(globalThis as any).Path2D = RecPath2D

function canvasDash(c: VectorTypeConfig, t = 0) {
  const ctx = new RecCtx()
  drawVectorType(ctx as unknown as CanvasRenderingContext2D, font, c, t, { ...BOX } as any)
  return ctx.ops.filter(o => o.op === 'stroke')
}

describe('canvas and SVG agree on the dash, exactly', () => {
  const PROGRESS = [0, 0.15, 0.4, 0.73, 0.99]

  it('same dash and same offset per glyph, at five progress values', () => {
    for (const p of PROGRESS) {
      const c = strokeOnly({ draw: p })
      const canvasOps = canvasDash(c)
      const svgOps = paths(svgAt(c))
      expect(canvasOps.length, `p=${p} stroke ops`).toBe(4)
      expect(svgOps.length).toBe(4)
      for (let i = 0; i < 4; i++) {
        const cv = canvasOps[i]!
        const sv = svgOps[i]!
        expect(sv.dash, `p=${p} glyph ${i}`).not.toBeNull()
        expect(cv.dash.length).toBe(2)
        // The SVG rounds to the document's own precision (3 places, the same the
        // path data gets), so the comparison is to that precision and not to the
        // bit. Three places of an output pixel is a five-hundredth of the
        // rasteriser's smallest step.
        expect(cv.dash[0]!).toBeCloseTo(sv.dash![0]!, 3)
        expect(cv.dash[1]!).toBeCloseTo(sv.dash![1]!, 3)
        // `stroke-dashoffset` is omitted when it is 0, which only happens at
        // full draw — never inside this loop.
        expect(cv.dashOffset).toBeCloseTo(sv.offset ?? 0, 3)
        expect(cv.lineWidth).toBeCloseTo(sv.width!, 6)
      }
    }
  })

  it('BROKEN CONTROL: measuring against the TOTAL instead of the longest disagrees', () => {
    // The plausible wrong choice. It is invisible on a one-contour letter and
    // wrong on every other, which is exactly why a per-glyph comparison is what
    // catches it.
    const c = strokeOnly({ draw: 0.4 })
    const placed = placedOf(c)
    const svgOps = paths(svgAt(c))
    const shipped: number[] = []
    const broken: number[] = []
    for (let i = 0; i < 4; i++) {
      const L = pathLength(placed[i])
      shipped.push(L.longest)
      broken.push(L.total)
      expect(svgOps[i]!.dash![0]!).toBeCloseTo(L.longest, 2)
    }
    // 'S' and 'l' are one contour, so the two agree there; 'a' and 'i' are two,
    // and there the broken control is a different number.
    expect(broken[0]).toBeCloseTo(shipped[0]!, 6)
    expect(broken[1]).toBeGreaterThan(shipped[1]! * 1.2)
    expect(broken[2]).toBeGreaterThan(shipped[2]! * 1.2)
  })

  it('the dash does not LEAK — an undashed layer above a dashed one is clean', () => {
    const c = cfg({
      appearance: [
        vtLayer({ id: 'Ldraw', kind: 'stroke', width: 8, draw: 0.3, paint: paint('#ff0000') }),
        vtLayer({ id: 'Lplain', kind: 'stroke', width: 2, paint: paint('#0000ff') }),
      ],
    })
    const ops = canvasDash(c)
    expect(ops.length).toBe(8)
    // Layer-major: the four dashed strokes first, then four clean ones.
    expect(ops.slice(0, 4).every(o => o.dash.length === 2 && o.dashOffset > 0)).toBe(true)
    expect(ops.slice(4).every(o => o.dash.length === 0 && o.dashOffset === 0)).toBe(true)
    const svgOps = paths(svgAt(c))
    expect(svgOps.slice(0, 4).every(p => p.dash !== null)).toBe(true)
    expect(svgOps.slice(4).every(p => p.dash === null)).toBe(true)
  })

  it('a MOTION TRACK moves the dash on both surfaces, together', () => {
    const c = mergeConfig({
      ...strokeOnly(),
      motion: {
        ...DEFAULT_CONFIG.motion,
        duration: 4,
        moves: [trackMove(track({ path: 'appearance.Lstroke.draw', from: 0, to: 1 }))],
      },
    })
    const offsets: number[] = []
    for (const t of [0, 1, 2, 3]) {
      const cv = canvasDash(c, t)[0]!
      const sv = paths(svgAt(c, t))[0]!
      expect(cv.dashOffset).toBeCloseTo(sv.offset ?? 0, 3)
      offsets.push(cv.dashOffset)
    }
    // Strictly shrinking: the reveal really is progressing over the clip.
    for (let i = 1; i < offsets.length; i++) expect(offsets[i]!).toBeLessThan(offsets[i - 1]!)
    // At the end of the clip there is no dash left at all.
    expect(canvasDash(c, 4)[0]!.dash).toEqual([])
    expect(paths(svgAt(c, 4))[0]!.dash).toBeNull()
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 6. REAL PIXELS — the ink really grows, and by the right amount
// ════════════════════════════════════════════════════════════════════════════

interface Ink { bits: Uint8Array; n: number }

function ink(svg: string): Ink {
  const img = new Resvg(svg, { fitTo: { mode: 'original' } }).render()
  const px = img.pixels
  const total = img.width * img.height
  const bits = new Uint8Array(total)
  let n = 0
  for (let i = 0; i < total; i++) {
    // Black stroke on white: anything dark is stroke ink.
    if (px[i * 4]! < 128 && px[i * 4 + 1]! < 128 && px[i * 4 + 2]! < 128) { bits[i] = 1; n++ }
  }
  return { bits, n }
}

/** Symmetric difference over union — the geometry metric a pixel COUNT is blind
 *  to. Two frames can have the same ink count and share none of it. */
function inkXor(a: Ink, b: Ink): number {
  let diff = 0
  let union = 0
  for (let i = 0; i < a.bits.length; i++) {
    const x = a.bits[i]!
    const y = b.bits[i]!
    if (x !== y) diff++
    if (x || y) union++
  }
  return union ? diff / union : 0
}

describe('the letters visibly draw themselves', () => {
  // ONE letter, ONE contour — so the drawn arc length is exactly `L·p` and the
  // ink count can be compared to `p` directly. 'S' is 35 quadratics and 4 lines,
  // so this is not the easy case, only the unambiguous one.
  const one = (draw: number) => strokeOnly({ draw, width: 8 }, { text: 'S' })

  it('p = 0 paints NOTHING, and p = 1 paints the whole stroke', () => {
    expect(ink(svgAt(one(0))).n).toBe(0)
    const full = ink(svgAt(one(1)))
    expect(full.n).toBeGreaterThan(2000)
    // …and the full draw is pixel-for-pixel the undashed stroke.
    expect(inkXor(full, ink(svgAt(strokeOnly({ width: 8 }, { text: 'S' }))))).toBe(0)
  })

  it('the DRAWN FRACTION tracks the progress value', () => {
    const full = ink(svgAt(one(1))).n
    const rows: Array<[number, number, number]> = []
    let prev = -1
    for (const p of [0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const n = ink(svgAt(one(p))).n
      rows.push([p, n, n / full])
      // Monotone: more progress is never less ink.
      expect(n, `p=${p}`).toBeGreaterThan(prev)
      prev = n
      // The stroke has constant width, so its area is proportional to the arc
      // length drawn — and it really is: the worst measured deviation across
      // these six frames is 0.0019 of the total. The 1 % here is headroom for
      // the round joins (which overlap where the contour turns sharply, so a
      // short run covers marginally more area per unit length) and the butt cap
      // at the growing end.
      expect(Math.abs(n / full - p), `p=${p} fraction`).toBeLessThan(0.01)
    }
    expect(rows.length).toBe(6)
  })

  it('BROKEN CONTROL: with the draw removed, every frame is the SAME frame', () => {
    // Without this, "the pixels differ between progress values" would not
    // distinguish the draw-on from the renderer being non-deterministic.
    const plain = strokeOnly({ width: 8 }, { text: 'S' })
    const a = ink(svgAt(plain))
    const b = ink(svgAt(plain))
    expect(inkXor(a, b)).toBe(0)
    // And the draw-on is nowhere near 0 against it.
    expect(inkXor(a, ink(svgAt(one(0.5))))).toBeGreaterThan(0.4)
  })

  it('the ink GROWS — each frame contains the one before it', () => {
    // Geometry, not a count: a reveal must ADD ink, never move it. A wrong
    // offset sign would keep the count rising while drawing from the other end,
    // and a count-only test would pass.
    const frames = [0.2, 0.4, 0.6, 0.8, 1].map(p => ink(svgAt(one(p))))
    for (let i = 1; i < frames.length; i++) {
      let lost = 0
      const prev = frames[i - 1]!
      const cur = frames[i]!
      for (let k = 0; k < prev.bits.length; k++) if (prev.bits[k] && !cur.bits[k]) lost++
      // A few hundredths of a percent is antialiasing at the growing end, where
      // the butt cap moves.
      expect(lost / prev.n, `frame ${i}`).toBeLessThan(0.02)
      expect(inkXor(prev, cur)).toBeGreaterThan(0.1)
    }
  })

  it('a WORD draws letter by letter under a STAGGER', () => {
    // The stagger is the studio's per-glyph CLOCK, and the draw-on is the one
    // layer leaf that is a per-glyph quantity — see `glyphStackLeaf`. Measured
    // before it was wired: all four letters reported the identical 0.4, because
    // the appearance stack is resolved once per frame and every glyph paints
    // under it.
    const staggered = (delay: number) => mergeConfig({
      ...strokeOnly({ width: 6 }),
      motion: {
        ...DEFAULT_CONFIG.motion,
        duration: 4,
        stagger: { ...DEFAULT_CONFIG.motion.stagger, delay, order: 'forward' as const },
        moves: [trackMove(track({ path: 'appearance.Lstroke.draw', from: 0, to: 1 }))],
      },
    })
    const fracOf = (svg: string) =>
      paths(svg).map(p => (p.dash === null ? 1 : 1 - (p.offset ?? 0) / p.dash[0]!))

    // Mid-clip, the FIRST letter is further along than the LAST — which is what
    // "one after another" is, expressed as four numbers.
    const frac = fracOf(svgAt(staggered(0.8), 1.6))
    expect(frac.length).toBe(4)
    expect(frac[0]!).toBeGreaterThan(0.35)
    expect(frac[3]!).toBeLessThan(0.05)
    for (let i = 1; i < 4; i++) expect(frac[i]!, `glyph ${i}`).toBeLessThanOrEqual(frac[i - 1]! + 1e-9)

    // BROKEN CONTROL — the same clip with the stagger switched off. Every letter
    // draws at the identical rate, which is the picture before this was wired and
    // is what makes the numbers above the stagger rather than glyph geometry.
    const flat = fracOf(svgAt(staggered(0), 1.6))
    expect(flat.every(f => Math.abs(f - 0.4) < 1e-3)).toBe(true)

    // The CANVAS staggers identically — one derivation, two surfaces.
    const cv = canvasDash(staggered(0.8), 1.6)
    expect(cv.length).toBe(4)
    cv.forEach((op, i) => {
      const svgFrac = frac[i]!
      const canvasFrac = op.dash.length ? 1 - op.dashOffset / op.dash[0]! : 1
      expect(canvasFrac).toBeCloseTo(svgFrac, 5)
    })
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 7. THE GUARANTEE — a draw frame cannot reach paper.js
// ════════════════════════════════════════════════════════════════════════════

describe('pathLength.ts is on the DRAW LOOP\'s side of the paper line', () => {
  it('imports NOTHING — paper.js above all', () => {
    // The same static check `curve.ts`'s spec makes, for the same reason and one
    // module along: a draw-on measures every glyph's outline every frame, so a
    // `paper` edge here would drag 300 kB of geometry library into the render
    // path. Stricter than a runtime trap, because it cannot be satisfied by a
    // code path that simply was not taken.
    const src = readFileSync(fileURLToPath(new URL('../../app/lib/vectortype/pathLength.ts', import.meta.url)), 'utf8')
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(code).not.toMatch(/^\s*import\s/m)
    expect(code).not.toMatch(/\brequire\s*\(/)
    for (const forbidden of ['paper', 'document', 'canvas', 'Path2D', 'DOMMatrix', 'fetch']) {
      expect(code, `mentions ${forbidden}`).not.toContain(forbidden)
    }
  })

  it('runs with every canvas and DOM global replaced by a trap', () => {
    const traps = ['document', 'window', 'DOMMatrix', 'CanvasRenderingContext2D', 'OffscreenCanvas', 'fetch'] as const
    const had = traps.map(k => [k, (globalThis as Record<string, unknown>)[k]] as const)
    for (const k of traps) {
      Object.defineProperty(globalThis, k, {
        configurable: true,
        get() { throw new Error(`pathLength.ts touched ${k}`) },
      })
    }
    try {
      const L = pathLength(quadraticCircle(60))
      expect(L.total).toBeGreaterThan(300)
      expect(vtDrawOnDash(L.longest, 0.3)!.offset).toBeCloseTo(L.longest * 0.7, 9)
      expect(pointAtPathLength(buildPathTable(cubicCircle(60)), 10).x).toBeLessThan(60)
    } finally {
      for (const [k, v] of had) {
        Object.defineProperty(globalThis, k, { configurable: true, writable: true, value: v })
      }
    }
  })
})

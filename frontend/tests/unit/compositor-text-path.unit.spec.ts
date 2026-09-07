/**
 * Frame — type on a path: the guide engine and the glyph walk.
 *
 * Plain numbers in, plain numbers out. The stub context measures a string by its
 * length, so every advance in here is a number the test can predict exactly; one
 * extra stub gives "AV" a real negative kern so prefix measurement has something
 * to prove.
 *
 * The load-bearing test is `naive control`. `utils/textOnPath.ts` maps
 * accumulated advance ÷ total length straight back to the curve parameter `t`,
 * which is only right on a constant-speed curve. That naive mapping is
 * reproduced here and run against the real guide on the SAME wave, so "the
 * inversion does work" is a measured difference rather than a claim — and the
 * even-spacing assertion says which of the two is the correct one.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  displayRun,
  guideFromSpec,
  measureRunPx,
  placeGlyphs,
  guideFromPathD,
  guideFromPolyline,
  type PathTextLayer,
  type TextPathSpec,
} from '~/lib/compositor/textPath'
import { evalCurve, type VtWaveCurve } from '~/lib/vectortype/curve'

// ── harness ─────────────────────────────────────────────────────────────────

const W = 100          // 1 local unit = 100px, so a dial of 3 is 300px
const CH = 10          // stub width per character

/** Width = 10px per char, so an n-char run measures 10n and every advance is 10. */
function stubCtx(measure: (s: string) => number = s => Array.from(s).length * CH): CanvasRenderingContext2D {
  return {
    measureText: (s: string) => ({ width: measure(s) }),
  } as unknown as CanvasRenderingContext2D
}

/** Same, but the pair "AV" measures 3px narrower than A + V — a real kern. */
const kernedCtx = () => stubCtx(s => {
  let w = Array.from(s).length * CH
  for (let i = 1; i < s.length; i++) if (s[i - 1] === 'A' && s[i] === 'V') w -= 3
  return w
})

function layer(p: Partial<PathTextLayer> = {}): PathTextLayer {
  return {
    id: 't1', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    text: 'ABCDE', fontFamily: 'Inter', fontWeight: 400, fontSize: 0.1,
    color: '#000', align: 'left', lineHeight: 1.2,
    strokeColor: '#000', strokeWidth: 0,
    ...p,
  } as PathTextLayer
}

const flat = (over: Partial<TextPathSpec> = {}): TextPathSpec =>
  ({ follow: 'curve', bend: 0, runLength: 3, ...over })

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

// ── guideFromSpec ───────────────────────────────────────────────────────────

describe('guideFromSpec', () => {
  it('builds a straight, origin-centred guide for a zero bend', () => {
    const g = guideFromSpec(flat(), W, 0)!
    expect(g).toBeTruthy()
    expect(g.closed).toBe(false)
    expect(g.length).toBeCloseTo(300, 6)
    // Centred on the origin: x runs -150..150 rather than 0..300, so bend 0 sits
    // exactly where flat centred text would.
    expect(g.at(0).x).toBeCloseTo(-150, 6)
    expect(g.at(300).x).toBeCloseTo(150, 6)
    expect(g.at(150).x).toBeCloseTo(0, 6)
    expect(g.at(150).y).toBeCloseTo(0, 6)
    expect(g.bounds().w).toBeCloseTo(300, 6)
    expect(g.bounds().h).toBe(1)             // a straight guide is 0 tall; floor is 1px
  })

  it('bend is length-preserving and closes into a ring at ±1', () => {
    const straight = guideFromSpec(flat({ bend: 0 }), W, 0)!
    const bowed = guideFromSpec(flat({ bend: 0.4 }), W, 0)!
    const ring = guideFromSpec(flat({ bend: 1 }), W, 0)!
    expect(bowed.length).toBeCloseTo(straight.length, 2)
    expect(ring.length).toBeCloseTo(straight.length, 2)
    expect(bowed.closed).toBe(false)
    expect(ring.closed).toBe(true)
    // A ring's ends meet.
    expect(dist(ring.at(0), ring.at(ring.length))).toBeLessThan(1)
    expect(bowed.bounds().h).toBeGreaterThan(1)   // it actually bows
  })

  it('falls back to the measured run when no runLength is given', () => {
    const g = guideFromSpec({ follow: 'curve', bend: 0 }, W, 250)!
    expect(g.length).toBeCloseTo(250, 6)
  })

  it('circle: radius is in local units, startAngle rotates the ring', () => {
    const g = guideFromSpec({ follow: 'circle', radius: 1 }, W, 0)!
    expect(g.closed).toBe(true)
    expect(g.length).toBeCloseTo(2 * Math.PI * 100, 0)
    // curve.ts starts at 12 o'clock: straight up in a y-down space.
    expect(g.at(0).x).toBeCloseTo(0, 6)
    expect(g.at(0).y).toBeCloseTo(-100, 6)
    // ...and runs clockwise: a quarter of the way round is 3 o'clock.
    expect(g.at(g.length / 4).x).toBeCloseTo(100, 1)
    expect(g.at(g.length / 4).y).toBeCloseTo(0, 1)

    const rot = guideFromSpec({ follow: 'circle', radius: 1, startAngle: 90 }, W, 0)!
    expect(rot.at(0).x).toBeCloseTo(100, 6)      // 90° clockwise from 12 = 3 o'clock
    expect(rot.at(0).y).toBeCloseTo(0, 6)
  })

  it('wave: amplitude scales by W and the arc is longer than the span', () => {
    const g = guideFromSpec({ follow: 'wave', runLength: 3, amplitude: 0.3, frequency: 2 }, W, 0)!
    expect(g.closed).toBe(false)
    expect(g.length).toBeGreaterThan(300)        // arc length > straight span
    expect(g.bounds().h).toBeCloseTo(60, 0)      // 2 × amplitude 0.3 × W
  })

  it('returns null (⇒ caller renders flat) for everything it cannot build', () => {
    expect(guideFromSpec(null, W, 100)).toBeNull()
    expect(guideFromSpec({ follow: 'nope' as never }, W, 100)).toBeNull()
    // Outline guides build now (see the 'outline guides' block); these are the
    // cases that still cannot produce geometry.
    expect(guideFromSpec({ follow: 'shape' }, W, 100)).toBeNull()                    // no shape
    expect(guideFromSpec({ follow: 'shape', shapeId: 'no-such-shape', size: 0.5 }, W, 100)).toBeNull()
    expect(guideFromSpec({ follow: 'shape', shapeId: 'circle' }, W, 100)).toBeNull() // no size
    expect(guideFromSpec({ follow: 'shape', shapeId: 'circle', size: 0 }, W, 100)).toBeNull()
    expect(guideFromSpec({ follow: 'custom' }, W, 100)).toBeNull()                   // no geometry
    expect(guideFromSpec({ follow: 'custom', d: 'not a path' }, W, 100)).toBeNull()
    expect(guideFromSpec({ follow: 'custom', d: 'M5 5' }, W, 100)).toBeNull()        // single point
    expect(guideFromSpec({ follow: 'circle' }, W, 100)).toBeNull()                   // no radius
    expect(guideFromSpec({ follow: 'circle', radius: 0 }, W, 100)).toBeNull()
    expect(guideFromSpec({ follow: 'circle', radius: Number.NaN }, W, 100)).toBeNull()
    expect(guideFromSpec({ follow: 'curve', bend: Number.NaN, runLength: 3 }, W, 100)).toBeNull()
    expect(guideFromSpec({ follow: 'curve', runLength: 3, start: Number.NaN }, W, 100)).toBeNull()
    expect(guideFromSpec({ follow: 'curve' }, W, 0)).toBeNull()                      // no length at all
    expect(guideFromSpec(flat(), 0, 100)).toBeNull()                                 // no scale
    expect(guideFromSpec(flat(), Number.NaN, 100)).toBeNull()
  })
})

// ── extrapolation and wrapping ──────────────────────────────────────────────

describe('Guide.at beyond the ends', () => {
  it('extrapolates in a straight line off an OPEN guide, both ways', () => {
    const g = guideFromSpec(flat({ bend: 0.5 }), W, 0)!
    const L = g.length
    for (const over of [10, 40, 120]) {
      const end = g.at(L)
      const past = g.at(L + over)
      // Keeps advancing — the whole point: no pile-up on the endpoint.
      expect(dist(end, past)).toBeCloseTo(over, 4)
      expect(past.angle).toBeCloseTo(end.angle, 6)
      const start = g.at(0)
      const before = g.at(-over)
      expect(dist(start, before)).toBeCloseTo(over, 4)
      expect(before.angle).toBeCloseTo(start.angle, 6)
    }
    // ...and backwards is the OTHER side: -10 and +L+10 are not the same point.
    expect(dist(g.at(-10), g.at(L + 10))).toBeGreaterThan(10)
  })

  it('wraps modulo length on a CLOSED guide', () => {
    const g = guideFromSpec({ follow: 'circle', radius: 1 }, W, 0)!
    const L = g.length
    expect(dist(g.at(L + 37), g.at(37))).toBeLessThan(1e-6)
    expect(dist(g.at(-37), g.at(L - 37))).toBeLessThan(1e-6)     // not a negative modulo
    expect(dist(g.at(3 * L + 5), g.at(5))).toBeLessThan(1e-6)
    // A closed guide never leaves its own radius, however far you walk.
    for (const s of [-1000, 0, 500, 5000]) {
      expect(Math.hypot(g.at(s).x, g.at(s).y)).toBeCloseTo(100, 3)
    }
  })

  it('overflowing glyphs keep marching instead of piling up', () => {
    // 20 chars × 10px = 200px of text on a 100px guide.
    const g = guideFromSpec(flat({ runLength: 1 }), W, 0)!
    const out = placeGlyphs(stubCtx(), layer({ text: 'A'.repeat(20) }), g, W, flat({ runLength: 1 }))
    expect(out).toHaveLength(20)
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.x).toBeGreaterThan(out[i - 1]!.x)
      expect(dist(out[i]!, out[i - 1]!)).toBeCloseTo(CH, 4)
    }
  })
})

// ── even spacing: the property the old widget fails ─────────────────────────

describe('even spacing', () => {
  it('equal advances land at equal ANGULAR steps on a circle', () => {
    const spec: TextPathSpec = { follow: 'circle', radius: 1 }
    const g = guideFromSpec(spec, W, 0)!
    const out = placeGlyphs(stubCtx(), layer({ text: 'ABCDEFGHIJ' }), g, W, spec)
    expect(out).toHaveLength(10)

    const angles = out.map(p => Math.atan2(p.y, p.x))
    const steps: number[] = []
    for (let i = 1; i < angles.length; i++) {
      let d = angles[i]! - angles[i - 1]!
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      steps.push(d)
    }
    for (const s of steps) expect(s).toBeCloseTo(steps[0]!, 6)
    // ...and the chord between consecutive glyphs is constant too.
    for (let i = 2; i < out.length; i++) {
      expect(dist(out[i]!, out[i - 1]!)).toBeCloseTo(dist(out[1]!, out[0]!), 6)
    }
    // Each glyph faces its own tangent, a quarter turn off its radius.
    for (const p of out) {
      const radial = Math.atan2(p.y, p.x)
      let d = p.angle - (radial + Math.PI / 2)
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      expect(Math.abs(d)).toBeLessThan(0.02)
    }
  })

  it('naive control: on a wave, distance÷length→t is NOT what we place', () => {
    // The exact curve guideFromSpec builds for this spec, so the naive mapping is
    // run against identical geometry and only the inversion differs.
    const spec: TextPathSpec = { follow: 'wave', runLength: 3, amplitude: 0.5, frequency: 2 }
    const curve: VtWaveCurve = { type: 'wave', length: 3 * W, amplitude: 0.5 * W, frequency: 2, phase: 0 }
    const g = guideFromSpec(spec, W, 0)!
    const L = g.length

    // Sampled finely (a chord is only a fair stand-in for arc length when the
    // step is small against the curve's tightest radius — here 2.3px against 11px).
    const N = 200
    const mine = Array.from({ length: N }, (_, i) => g.at((i / (N - 1)) * L))
    const naive = Array.from({ length: N }, (_, i) => evalCurve(curve, i / (N - 1)))

    // Both live in their own translation (the guide is origin-centred), so compare
    // displacements from the first sample — that cancels the offset entirely.
    const rel = (a: { x: number; y: number }[], i: number) => ({ x: a[i]!.x - a[0]!.x, y: a[i]!.y - a[0]!.y })
    let maxDiff = 0
    for (let i = 0; i < N; i++) maxDiff = Math.max(maxDiff, dist(rel(mine, i), rel(naive, i)))
    expect(maxDiff).toBeGreaterThan(1)        // they genuinely disagree

    const spread = (a: { x: number; y: number }[]) => {
      const gaps: number[] = []
      for (let i = 1; i < a.length; i++) gaps.push(dist(a[i]!, a[i - 1]!))
      return (Math.max(...gaps) - Math.min(...gaps)) / (gaps.reduce((s, v) => s + v, 0) / gaps.length)
    }
    // ...and OURS is the even one. (Chords under-measure arc slightly, hence 2%.)
    expect(spread(mine)).toBeLessThan(0.02)
    expect(spread(naive)).toBeGreaterThan(0.2)
  })

  it('the control agrees with us on a circle — proving it measures curve speed', () => {
    // A circle is the one constant-speed member, so the naive mapping is correct
    // there. If this drifted, the wave test above would be measuring the harness.
    const g = guideFromSpec({ follow: 'circle', radius: 1 }, W, 0)!
    const N = 8
    const pts = Array.from({ length: N }, (_, i) => g.at((i / N) * g.length))
    const gaps = pts.slice(1).map((p, i) => dist(p, pts[i]!))
    for (const gp of gaps) expect(gp).toBeCloseTo(gaps[0]!, 6)
  })
})

// ── advances, fit and align ─────────────────────────────────────────────────

describe('placeGlyphs advances', () => {
  it('measures cumulative prefixes, so kerning pairs survive', () => {
    const ctx = kernedCtx()
    const spec = flat()
    const g = guideFromSpec(spec, W, 0)!
    const out = placeGlyphs(ctx, layer({ text: 'AV' }), g, W, spec)
    expect(out.map(p => p.ch)).toEqual(['A', 'V'])
    // Isolated measurement would give 10 + 10; the PAIR measures 17.
    expect(ctx.measureText('A').width + ctx.measureText('V').width).toBe(20)
    expect(ctx.measureText('AV').width).toBe(17)
    expect(out[0]!.advance).toBeCloseTo(10, 6)
    expect(out[1]!.advance).toBeCloseTo(7, 6)
    expect(out[0]!.advance + out[1]!.advance).toBeCloseTo(ctx.measureText('AV').width, 6)
    // The run is therefore 17 wide, not 20: centres sit 8.5 either side of the middle.
    expect(measureRunPx(ctx, layer({ text: 'AV' }))).toBe(17)
  })

  it('fit:true fills the guide exactly, end to end', () => {
    const spec = flat({ fit: true })
    const g = guideFromSpec(spec, W, 0)!           // 300px, straight, x = s - 150
    const out = placeGlyphs(stubCtx(), layer({ text: 'ABCDE' }), g, W, spec)
    expect(out).toHaveLength(5)
    // delta = (300 - 50) / 4 = 62.5 added to every gap but the last.
    expect(out[0]!.advance).toBeCloseTo(72.5, 6)
    expect(out[4]!.advance).toBeCloseTo(10, 6)
    // First glyph's LEADING edge at 0, last glyph's TRAILING edge at length.
    const leading = (out[0]!.x + 150) - out[0]!.advance / 2
    const trailing = (out[4]!.x + 150) + out[4]!.advance / 2
    expect(leading).toBeCloseTo(0, 6)
    expect(trailing).toBeCloseTo(g.length, 6)
  })

  it('fit:true is additive tracking, not a scale — glyph advances stay measured', () => {
    // A scale factor would multiply the kerned pair; tracking adds to the gap.
    const spec = flat({ fit: true })
    const g = guideFromSpec(spec, W, 0)!
    const out = placeGlyphs(kernedCtx(), layer({ text: 'AVA' }), g, W, spec)
    const delta = (g.length - 27) / 2            // run "AVA" measures 10+7+10
    expect(out[0]!.advance).toBeCloseTo(10 + delta, 6)
    expect(out[1]!.advance).toBeCloseTo(7 + delta, 6)   // the kern is preserved under fit
    expect(out[2]!.advance).toBeCloseTo(10, 6)
  })

  it('fit:false leaves the run at its natural length', () => {
    const spec = flat({ fit: false })
    const g = guideFromSpec(spec, W, 0)!
    const out = placeGlyphs(stubCtx(), layer({ text: 'ABCDE', align: 'center' }), g, W, spec)
    for (const p of out) expect(p.advance).toBeCloseTo(CH, 6)
    const span = (out[4]!.x + out[4]!.advance / 2) - (out[0]!.x - out[0]!.advance / 2)
    expect(span).toBeCloseTo(50, 6)
    expect(span).toBeLessThan(g.length)
  })

  it('align maps onto the path: start / middle / end', () => {
    const spec = flat()
    const g = guideFromSpec(spec, W, 0)!     // x = s - 150, run = 50
    const at = (align: PathTextLayer['align']) =>
      placeGlyphs(stubCtx(), layer({ text: 'ABCDE', align }), g, W, spec)
    // leading edge of the run, in arc length
    const lead = (out: ReturnType<typeof at>) => out[0]!.x + 150 - out[0]!.advance / 2
    expect(lead(at('left'))).toBeCloseTo(0, 6)
    expect(lead(at('justify'))).toBeCloseTo(0, 6)      // no box on a path ⇒ same as left
    expect(lead(at('center'))).toBeCloseTo(125, 6)     // (300 - 50) / 2
    expect(lead(at('right'))).toBeCloseTo(250, 6)      // 300 - 50
  })

  it('start slides the whole run along the path', () => {
    const spec = flat({ start: 0.25 })
    const g = guideFromSpec(spec, W, 0)!
    const out = placeGlyphs(stubCtx(), layer({ text: 'ABCDE' }), g, W, spec)
    expect(out[0]!.x + 150 - 5).toBeCloseTo(75, 6)     // 0.25 × 300
  })

  it('shift offsets along the tangent normal — outward on a clockwise ring', () => {
    const base: TextPathSpec = { follow: 'circle', radius: 1 }
    const g = guideFromSpec(base, W, 0)!
    const plain = placeGlyphs(stubCtx(), layer({ text: 'A' }), g, W, base)
    const out = placeGlyphs(stubCtx(), layer({ text: 'A' }), g, W, { ...base, shift: 0.2 })
    const inward = placeGlyphs(stubCtx(), layer({ text: 'A' }), g, W, { ...base, shift: -0.2 })
    expect(Math.hypot(plain[0]!.x, plain[0]!.y)).toBeCloseTo(100, 3)
    expect(Math.hypot(out[0]!.x, out[0]!.y)).toBeCloseTo(120, 3)     // +0.2 × W outward
    expect(Math.hypot(inward[0]!.x, inward[0]!.y)).toBeCloseTo(80, 3)
    expect(out[0]!.angle).toBeCloseTo(plain[0]!.angle, 6)            // shift never rotates
  })
})

// ── side ────────────────────────────────────────────────────────────────────

describe('side: inside', () => {
  it('reverses the walk and turns every glyph a half turn', () => {
    const spec = flat()
    const g = guideFromSpec(spec, W, 0)!
    const outside = placeGlyphs(stubCtx(), layer({ text: 'ABCDE' }), g, W, spec)
    const insideOut = placeGlyphs(stubCtx(), layer({ text: 'ABCDE' }), g, W, { ...spec, side: 'inside' })

    expect(insideOut.map(p => p.ch)).toEqual(['A', 'B', 'C', 'D', 'E'])   // draw order is reading order
    // ...but they run the other way down the path, mirrored about its middle.
    for (let i = 0; i < 5; i++) expect(insideOut[i]!.x).toBeCloseTo(-outside[i]!.x, 6)
    for (let i = 1; i < 5; i++) expect(insideOut[i]!.x).toBeLessThan(insideOut[i - 1]!.x)
    for (let i = 0; i < 5; i++) {
      expect(Math.abs(insideOut[i]!.angle - outside[i]!.angle)).toBeCloseTo(Math.PI, 6)
    }
  })

  it('text along the bottom of a ring reads left-to-right, the right way up', () => {
    // Centred + inside puts the run at 6 o'clock with no `start` at all: the
    // reversed walk measures from the far end of the ring, so the centre of an
    // inside run lands half a turn from the centre of an outside one.
    const spec: TextPathSpec = { follow: 'circle', radius: 1, side: 'inside', fit: false }
    const g = guideFromSpec(spec, W, 0)!
    const out = placeGlyphs(stubCtx(), layer({ text: 'ABCDE', align: 'center' }), g, W, spec)
    expect(out).toHaveLength(5)
    for (const p of out) expect(p.y).toBeGreaterThan(50)          // below centre
    // Reading order runs left to right across the bottom...
    for (let i = 1; i < out.length; i++) expect(out[i]!.x).toBeGreaterThan(out[i - 1]!.x)
    // ...and each glyph is upright: its baseline direction is within ~30° of +x.
    for (const p of out) {
      let d = p.angle
      while (d > Math.PI) d -= 2 * Math.PI
      while (d < -Math.PI) d += 2 * Math.PI
      expect(Math.abs(d)).toBeLessThan(0.6)
    }
  })
})

// ── the run string ──────────────────────────────────────────────────────────

describe('the display run', () => {
  it('applies the case transform and collapses every newline and space run', () => {
    expect(displayRun({ text: 'a b', textTransform: 'uppercase' })).toBe('A B')
    expect(displayRun({ text: 'AB', textTransform: 'lowercase' })).toBe('ab')
    expect(displayRun({ text: 'hello world', textTransform: 'capitalize' })).toBe('Hello World')
    expect(displayRun({ text: 'one\ntwo', textTransform: undefined })).toBe('one two')
    expect(displayRun({ text: 'a \n\t b', textTransform: undefined })).toBe('a b')
    expect(displayRun({ text: undefined as unknown as string, textTransform: undefined })).toBe('')
  })

  it('spaces advance the cursor but are not returned as glyphs', () => {
    const spec = flat()
    const g = guideFromSpec(spec, W, 0)!
    const out = placeGlyphs(stubCtx(), layer({ text: 'A B' }), g, W, spec)
    expect(out.map(p => p.ch)).toEqual(['A', 'B'])
    // The gap is still there: B sits two advances along, not one.
    expect(out[1]!.x - out[0]!.x).toBeCloseTo(2 * CH, 6)
  })

  it('honours the layer case transform in placement', () => {
    const spec = flat()
    const g = guideFromSpec(spec, W, 0)!
    const out = placeGlyphs(stubCtx(), layer({ text: 'ab', textTransform: 'uppercase' }), g, W, spec)
    expect(out.map(p => p.ch)).toEqual(['A', 'B'])
  })

  it('reads spec off layer.path when none is passed', () => {
    const spec = flat({ align: undefined } as Partial<TextPathSpec>)
    const g = guideFromSpec(spec, W, 0)!
    const l = layer({ text: 'ABCDE', path: spec })
    expect(placeGlyphs(stubCtx(), l, g, W)).toEqual(placeGlyphs(stubCtx(), l, g, W, spec))
  })
})

// ── degenerate input ────────────────────────────────────────────────────────

describe('degenerate input never produces NaN', () => {
  it('returns an empty array rather than junk', () => {
    const spec = flat()
    const g = guideFromSpec(spec, W, 0)!
    expect(placeGlyphs(stubCtx(), layer({ text: '' }), g, W, spec)).toEqual([])
    expect(placeGlyphs(stubCtx(), layer({ text: '   ' }), g, W, spec)).toEqual([])
    expect(placeGlyphs(stubCtx(), layer(), null, W, spec)).toEqual([])
    expect(placeGlyphs(stubCtx(), layer(), undefined, W, spec)).toEqual([])
    expect(placeGlyphs(stubCtx(), layer(), g, W, null)).toHaveLength(5)   // no spec ⇒ plain walk
  })

  it('survives a context that measures NaN', () => {
    const spec = flat()
    const g = guideFromSpec(spec, W, 0)!
    const out = placeGlyphs(stubCtx(() => Number.NaN), layer({ text: 'ABC' }), g, W, spec)
    for (const p of out) {
      expect(Number.isFinite(p.x)).toBe(true)
      expect(Number.isFinite(p.y)).toBe(true)
      expect(Number.isFinite(p.angle)).toBe(true)
      expect(Number.isFinite(p.advance)).toBe(true)
    }
  })

  it('no NaN reaches a placement across a sweep of specs', () => {
    const specs: TextPathSpec[] = [
      { follow: 'curve', bend: 0, runLength: 3 },
      { follow: 'curve', bend: -1, runLength: 3, side: 'inside' },
      { follow: 'curve', bend: 1, runLength: 3, fit: true, start: 0.9 },
      { follow: 'circle', radius: 0.5, startAngle: 210, shift: -0.4, fit: true },
      { follow: 'circle', radius: 2, side: 'inside', start: 1 },
      { follow: 'wave', runLength: 4, amplitude: 0, frequency: 0 },
      { follow: 'wave', runLength: 4, amplitude: 0.4, frequency: 7, fit: true, shift: 0.2 },
    ]
    for (const spec of specs) {
      const g = guideFromSpec(spec, W, 120)
      expect(g, JSON.stringify(spec)).toBeTruthy()
      expect(Number.isFinite(g!.length)).toBe(true)
      expect(g!.length).toBeGreaterThan(0)
      expect(Number.isFinite(g!.bounds().w)).toBe(true)
      expect(Number.isFinite(g!.bounds().h)).toBe(true)
      for (const align of ['left', 'center', 'right', 'justify'] as const) {
        const out = placeGlyphs(stubCtx(), layer({ text: 'Hello, world', align }), g, W, spec)
        expect(out.length).toBeGreaterThan(0)
        for (const p of out) {
          expect(Number.isFinite(p.x), `${JSON.stringify(spec)} ${p.ch}`).toBe(true)
          expect(Number.isFinite(p.y)).toBe(true)
          expect(Number.isFinite(p.angle)).toBe(true)
          expect(Number.isFinite(p.advance)).toBe(true)
        }
      }
    }
  })
})

// ── purity ──────────────────────────────────────────────────────────────────

// ── outline guides (shape library + a drawn path) ───────────────────────────
//
// These share one route with the parametric curves: whatever the source, a
// Guide answers the same question. So the properties asserted for a circle
// above must hold for an outline too, or "one engine" is a claim and not a fact.

describe('outline guides', () => {
  /** A unit square, drawn clockwise, centred on the origin: perimeter 4. */
  const SQUARE = 'M-0.5 -0.5 L0.5 -0.5 L0.5 0.5 L-0.5 0.5 Z'

  it('walks a closed outline at its true perimeter', () => {
    const g = guideFromPathD(SQUARE, 100)!
    // 4 sides of 100px. The closing chord is IMPLIED by pathFlatten and added by
    // the guide — without it this would come back 300, not 400.
    expect(g.length).toBeCloseTo(400, 6)
    expect(g.closed).toBe(true)
    expect(g.bounds()).toEqual({ w: 100, h: 100 })
  })

  it('is centred on the origin, exactly like a parametric guide', () => {
    // Deliberately OFF-centre input: the guide must recentre it, or a shape whose
    // path data is not centred would drag its type away from the layer origin.
    const g = guideFromPolyline([{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 20 }, { x: 10, y: 20 }], true)!
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
    for (let s = 0; s <= g.length; s += g.length / 400) {
      const p = g.at(s)
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
    }
    expect((minX + maxX) / 2).toBeCloseTo(0, 6)
    expect((minY + maxY) / 2).toBeCloseTo(0, 6)
  })

  it('advances by arc length, not by point index', () => {
    // The square has 4 points but 4 sides of 100px. A guide that interpolated by
    // point INDEX would put s=100 a quarter of the way along the first side;
    // by arc length it lands exactly on the second corner. Walking the corners
    // is the assertion that separates the two.
    const g = guideFromPathD(SQUARE, 100)!
    const corners = [g.at(0), g.at(100), g.at(200), g.at(300)]
    const expected = [{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }]
    corners.forEach((c, i) => {
      expect(c.x).toBeCloseTo(expected[i]!.x, 6)
      expect(c.y).toBeCloseTo(expected[i]!.y, 6)
    })
    // And WITHIN a side (no corner between the samples) equal steps in `s` are
    // equal steps in space.
    for (const step of [7, 33] as const) {
      expect(dist(g.at(step), g.at(step * 2))).toBeCloseTo(step, 6)
    }
  })

  it('wraps a closed outline instead of extrapolating', () => {
    const g = guideFromPathD(SQUARE, 100)!
    const at10 = g.at(10)
    expect(g.at(10 + g.length).x).toBeCloseTo(at10.x, 6)
    expect(g.at(10 + g.length).y).toBeCloseTo(at10.y, 6)
    expect(g.at(10 - g.length).x).toBeCloseTo(at10.x, 6)   // negative s too
  })

  it('extrapolates off an OPEN outline', () => {
    const g = guideFromPolyline([{ x: 0, y: 0 }, { x: 100, y: 0 }], false)!
    expect(g.closed).toBe(false)
    expect(dist(g.at(g.length), g.at(g.length + 40))).toBeCloseTo(40, 6)
    expect(dist(g.at(0), g.at(-40))).toBeCloseTo(40, 6)
  })

  it('refits a drawn path to the requested width', () => {
    const g = guideFromPathD(SQUARE, 100, 250)!
    expect(g.bounds().w).toBeCloseTo(250, 6)
    expect(g.bounds().h).toBeCloseTo(250, 6)   // aspect preserved
  })

  it('follows a real library shape, and places every glyph on it', () => {
    const spec: TextPathSpec = { follow: 'shape', shapeId: 'circle', size: 0.4 }
    const g = guideFromSpec(spec, W, 100)!
    // The library circle, fitted to 0.4 of canvas width.
    expect(g.bounds().w).toBeCloseTo(0.4 * W, 0)
    expect(g.closed).toBe(true)
    const ctx = stubCtx()
    const layer = { text: 'AROUND THE SHAPE', align: 'center', fontSize: 0.05 } as unknown as PathTextLayer
    const placed = placeGlyphs(ctx, layer, g, W, spec)
    expect(placed.length).toBeGreaterThan(10)
    // Every glyph sits on the outline: its distance from the origin matches the
    // guide's own radius at that point, within the flattener's tolerance.
    const r = g.bounds().w / 2
    for (const p of placed) {
      expect(Math.hypot(p.x, p.y)).toBeGreaterThan(r - 2)
      expect(Math.hypot(p.x, p.y)).toBeLessThan(r + 2)
      expect(Number.isFinite(p.angle)).toBe(true)
    }
  })

  it('fit fills an outline exactly, as it does a curve', () => {
    const spec: TextPathSpec = { follow: 'shape', shapeId: 'circle', size: 0.4, fit: true, start: 0 }
    const g = guideFromSpec(spec, W, 100)!
    const ctx = stubCtx()
    const layer = { text: 'FILL ME', align: 'left', fontSize: 0.05 } as unknown as PathTextLayer
    const placed = placeGlyphs(ctx, layer, g, W, spec)
    const spanned = placed.reduce((a, p) => a + p.advance, 0)
    // Every advance but the last was stretched; the run now spans the outline.
    expect(spanned).toBeGreaterThan(g.length - 40)
  })

  it('normalises a closed outline to start at the top, running clockwise', () => {
    // Same square, authored four different ways: a different starting corner and
    // the opposite winding. All four must behave identically, or the same dials
    // would place type differently on shapes that merely LOOK the same.
    const variants = [
      'M-0.5 -0.5 L0.5 -0.5 L0.5 0.5 L-0.5 0.5 Z',   // from top-left, clockwise
      'M0.5 0.5 L-0.5 0.5 L-0.5 -0.5 L0.5 -0.5 Z',   // from bottom-right, clockwise
      'M-0.5 -0.5 L-0.5 0.5 L0.5 0.5 L0.5 -0.5 Z',   // from top-left, ANTIclockwise
      'M0.5 -0.5 L-0.5 -0.5 L-0.5 0.5 L0.5 0.5 Z',   // from top-right, anticlockwise
    ]
    for (const d of variants) {
      const g = guideFromPathD(d, 100)!
      const start = g.at(0)
      expect(start.y).toBeCloseTo(-50, 6)                 // on the TOP edge
      expect(Math.cos(start.angle)).toBeGreaterThan(0.5)  // heading RIGHT
      // A quarter of the way round is the right-hand edge, every time.
      expect(g.at(g.length / 4).x).toBeCloseTo(50, 6)
    }
  })

  it('centres type over the top of any shape at start 0.5, like a ring', () => {
    const ctx = stubCtx()
    const layer = { text: 'TOP', align: 'center', fontSize: 0.05 } as unknown as PathTextLayer
    for (const shapeId of ['circle', 'badge', 'clover-x', 'cloud']) {
      const spec: TextPathSpec = { follow: 'shape', shapeId, size: 0.5, start: 0.5 }
      const g = guideFromSpec(spec, W, 100)
      expect(g, shapeId).not.toBeNull()
      const placed = placeGlyphs(ctx, layer, g!, W, spec)
      const mid = placed[Math.floor(placed.length / 2)]!
      // Above the origin, and upright rather than turned on its side.
      expect(mid.y, shapeId).toBeLessThan(0)
      expect(Math.abs(Math.sin(mid.angle)), shapeId).toBeLessThan(0.5)
    }
  })

  it('returns null rather than NaN for degenerate outlines', () => {
    expect(guideFromPolyline([], false)).toBeNull()
    expect(guideFromPolyline([{ x: 1, y: 1 }], true)).toBeNull()
    expect(guideFromPolyline([{ x: 1, y: 1 }, { x: 1, y: 1 }], false)).toBeNull()  // zero length
    expect(guideFromPolyline([{ x: Number.NaN, y: 0 }, { x: 1, y: 0 }], false)).toBeNull()
    expect(guideFromPathD('', 100)).toBeNull()
    expect(guideFromPathD(SQUARE, 0)).not.toBeNull()   // W falls back to 1, still a guide
  })
})

describe('the module is pure', () => {
  it('imports nothing but the curve sampler (and a type)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../app/lib/compositor/textPath.ts', import.meta.url)),
      'utf8',
    )
    const imports = [...src.matchAll(/\bfrom\s+'([^']+)'/g)].map(m => m[1])
    // Every dependency is a pure module: the arc-length sampler, the SVG
    // flattener, and the shape library's data + geometry. Nothing Vue, nothing
    // that touches a document — this module runs inside the draw loop.
    expect(imports.sort()).toEqual([
      '~/composables/useCompositorLayers',
      '~/lib/compositor/pathFlatten',
      '~/lib/shapes/catalog',
      '~/lib/shapes/pathLayer',
      '~/lib/vectortype/curve',
    ])
    // The type-only one is erased at runtime, so nothing Vue-shaped is ever loaded.
    expect(src).toMatch(/import type \{ TextLayer \} from '~\/composables\/useCompositorLayers'/)
    expect(src).not.toMatch(/\bdocument\b|\bwindow\b|createElement/)
  })
})

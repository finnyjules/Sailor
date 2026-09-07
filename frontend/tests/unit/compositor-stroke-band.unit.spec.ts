import { describe, it, expect } from 'vitest'
import { paintStrokeBand, strokeAligned } from '~/composables/useCompositorLayers'
import {
  inkAt, makeCtx, makeCtxWithoutDocument, installScratchDocument,
} from './_strokeCtx'

// paintStrokeBand is Task 2's replacement painter: nothing calls it yet (Task 3
// routes the stroked kinds through it). These tests exercise it directly, the
// same way compositor-stroke-style.unit.spec.ts exercises strokeAligned directly
// in its "resets its own dash pattern" test — no paintLayerStack involved.
//
// DEVIATION FROM THE BRIEF: the brief's sample test file recorded property
// SETS (`{ op: 'set', k: 'lineWidth', v: 10 }`) and a `scratches()` list whose
// first entry alone carried both the outer AND inner stroke widths. Neither
// harness shape exists in this repo — `compositor-stroke-style.unit.spec.ts`
// (the file Task 2's brief says to lift the harness FROM) uses the geometry/
// ink-replay `Recorder` model in `./_strokeCtx`, which records METHOD CALLS
// (fill/stroke/clip/stamp), not property assignments. And the given
// `paintStrokeBand` source creates outer and inner on two SEPARATE scratch
// canvases (`s` for the outer dilation, a second `scratchLike(ctx)` — `knock`
// — for the inner one, combined via one `destination-out` `drawImage`), so
// the two widths land on `scratches()[0]` and `scratches()[1]` respectively,
// never both on the first. The assertions below check the same underlying
// claims the brief's tests intended (exact radii, join, single stamp, no
// destination-out on the shared ctx, the no-document fallback) against the
// real harness and the real two-scratch construction.

function rectPath(c: CanvasRenderingContext2D) {
  c.beginPath()
  c.rect(-50, -50, 100, 100) // fake ctx draws centred rects regardless of x/y args
}

describe('paintStrokeBand at distance 0', () => {
  it('is byte-for-byte the strokeAligned call it replaces (default/centered)', () => {
    const { ctx: legacyCtx, rec: legacyRec } = makeCtx('legacy')
    rectPath(legacyCtx)
    strokeAligned(legacyCtx, { width: 10, style: () => '#f00' })

    const { ctx: bandCtx, rec: bandRec } = makeCtx('band')
    rectPath(bandCtx)
    paintStrokeBand(bandCtx, { width: 10, style: () => '#f00' })

    expect(bandRec.ops.map(o => o.kind)).toEqual(legacyRec.ops.map(o => o.kind))
    expect(bandRec.ops.length).toBeGreaterThan(0)
    expect(inkAt(bandRec, { x: 45, y: 0 })).toBe(inkAt(legacyRec, { x: 45, y: 0 }))
    expect(inkAt(bandRec, { x: 55, y: 0 })).toBe(inkAt(legacyRec, { x: 55, y: 0 }))
    expect(inkAt(bandRec, { x: 65, y: 0 })).toBe(inkAt(legacyRec, { x: 65, y: 0 }))
    expect(inkAt(bandRec, { x: 45, y: 0 })).toBe(true)
    expect(inkAt(bandRec, { x: 55, y: 0 })).toBe(true)
    expect(inkAt(bandRec, { x: 65, y: 0 })).toBe(false)
  })

  it('clips and doubles for inside, exactly as strokeAligned does', () => {
    const { ctx: legacyCtx, rec: legacyRec } = makeCtx('legacy')
    rectPath(legacyCtx)
    strokeAligned(legacyCtx, { width: 10, style: () => '#f00', align: 'inside' })

    const { ctx: bandCtx, rec: bandRec } = makeCtx('band')
    rectPath(bandCtx)
    paintStrokeBand(bandCtx, { width: 10, style: () => '#f00', align: 'inside' })

    expect(bandRec.ops.map(o => o.kind)).toEqual(legacyRec.ops.map(o => o.kind))
    expect(bandRec.ops.map(o => o.kind)).toEqual(['save', 'clip', 'stroke', 'restore'])
    const stroke = bandRec.ops.find(o => o.kind === 'stroke') as any
    expect(stroke.lineWidth).toBe(20)
    expect(inkAt(bandRec, { x: 45, y: 0 })).toBe(true)   // just inside the edge
    expect(inkAt(bandRec, { x: 55, y: 0 })).toBe(false)  // nothing outside the silhouette
  })

  const scratchDoc = installScratchDocument()

  it('never runs destination-out on the shared context (outside align, at distance 0)', () => {
    const { ctx, rec } = makeCtx('main')
    const build = (c: CanvasRenderingContext2D) => rectPath(c)
    build(ctx)
    paintStrokeBand(ctx, { width: 10, style: () => '#f00', align: 'outside', build })
    expect(rec.ops.some(o => o.kind === 'fill' && (o as any).erase)).toBe(false)
    expect(rec.ops.some(o => o.kind === 'stroke' && (o as any).erase)).toBe(false)
    expect(rec.ops.some(o => o.kind === 'stamp' && (o as any).erase)).toBe(false)
    // …but the knockout DID happen, just on the offscreen the brief's Critical warns about.
    expect(scratchDoc.count()).toBe(1)
    expect(scratchDoc.scratches()[0]!.ops.some(o => o.kind === 'fill' && (o as any).erase)).toBe(true)
  })
})

describe('paintStrokeBand at a distance', () => {
  const scratchDoc = installScratchDocument()
  const build = (c: CanvasRenderingContext2D) => rectPath(c)

  it('draws the outer dilation and the inner knockout on separate scratch canvases and stamps once', () => {
    const { ctx, rec } = makeCtx('main')
    paintStrokeBand(ctx, { width: 10, distance: 30, style: () => '#f00', build })

    // Nothing but a single stamp (wrapped in save/restore) lands on the shared context.
    expect(rec.ops.map(o => o.kind)).toEqual(['save', 'stamp', 'restore'])
    expect(rec.ops.some(o => o.kind === 'stroke')).toBe(false)
    expect(rec.ops.some(o => o.kind === 'fill')).toBe(false)

    // Two scratches: the outer dilation (`s`) and the inner one used to knock it out (`knock`).
    expect(scratchDoc.count()).toBe(2)
    const [outerRec, innerRec] = scratchDoc.scratches()
    // Centre alignment ⇒ radii 35 and 25 ⇒ line widths 70 and 50 (2× each).
    const outerStroke = outerRec!.ops.find(o => o.kind === 'stroke') as any
    const innerStroke = innerRec!.ops.find(o => o.kind === 'stroke') as any
    expect(outerStroke.lineWidth).toBe(70)
    expect(innerStroke.lineWidth).toBe(50)
    // The inner dilation is subtracted from the outer one via a destination-out stamp,
    // on the scratch — never on the shared ctx (already asserted above).
    expect(outerRec!.ops.some(o => o.kind === 'stamp' && (o as any).erase)).toBe(true)
  })

  it('uses the alignment to pick the two radii', () => {
    // `installScratchDocument`'s counter/list reset per TEST (beforeEach), not per call —
    // this helper is called 3× within one test, so it slices off just the scratches THIS
    // call created rather than re-reading from index 0 each time.
    const radii = (align: 'center' | 'inside' | 'outside') => {
      const { ctx } = makeCtx('main')
      const before = scratchDoc.count()
      paintStrokeBand(ctx, { width: 10, distance: 30, align, style: () => '#f00', build })
      const [outerRec, innerRec] = scratchDoc.scratches().slice(before)
      const outerStroke = outerRec!.ops.find(o => o.kind === 'stroke') as any
      const innerStroke = innerRec!.ops.find(o => o.kind === 'stroke') as any
      return [outerStroke.lineWidth, innerStroke.lineWidth]
    }
    expect(radii('center')).toEqual([70, 50])   // 35, 25
    expect(radii('outside')).toEqual([80, 60])  // 40, 30
    expect(radii('inside')).toEqual([60, 40])   // 30, 20
  })

  it('sets the corner join from `join`, defaulting to miter', () => {
    const joins = (join?: 'sharp' | 'round') => {
      const { ctx } = makeCtx('main')
      const before = scratchDoc.count()
      paintStrokeBand(ctx, { width: 10, distance: 30, join, style: () => '#f00', build })
      return scratchDoc.scratches().slice(before)
        .flatMap(r => r.ops.filter(o => o.kind === 'stroke').map(o => (o as any).lineJoin))
    }
    expect(joins()).toEqual(['miter', 'miter'])
    expect(joins('sharp')).toEqual(['miter', 'miter'])
    expect(joins('round')).toEqual(['round', 'round'])
  })

  it('draws nothing at all for a zero or negative width', () => {
    const { ctx, rec } = makeCtx('main')
    paintStrokeBand(ctx, { width: 0, distance: 30, style: () => '#f00' })
    expect(rec.ops).toEqual([])
    expect(scratchDoc.count()).toBe(0)

    const { ctx: ctx2, rec: rec2 } = makeCtx('main2')
    paintStrokeBand(ctx2, { width: -5, distance: 30, style: () => '#f00' })
    expect(rec2.ops).toEqual([])
  })

  it('falls back to the centred stroke when no scratch canvas exists', () => {
    // A worker/SSR context with no document: knocking out on the shared ctx would eat
    // the layer's own fill and every backdrop pixel under it, so it must not try.
    const { ctx, rec } = makeCtxWithoutDocument('main')
    rectPath(ctx)
    paintStrokeBand(ctx, { width: 10, distance: 30, style: () => '#f00' })
    expect(rec.ops.some(o => o.kind === 'fill' && (o as any).erase)).toBe(false)
    expect(rec.ops.some(o => o.kind === 'stroke' && (o as any).erase)).toBe(false)
    expect(rec.ops.some(o => o.kind === 'stroke')).toBe(true)
    // The fallback ignores `distance`/`align` entirely — it's the plain centred stroke.
    const stroke = rec.ops.find(o => o.kind === 'stroke') as any
    expect(stroke.lineWidth).toBe(10)
  })
})

// The `region(c, r)` closure inside paintStrokeBand takes an EROSION branch
// (fill, then a destination-out stroke at 2|r|, centred on the edge) whenever
// r < 0. Every test above uses `distance: 30, width: 10`, which keeps both
// `outer`/`inner` radii positive in all three alignments (35/25, 40/30,
// 30/20) — the erosion branch never runs. It IS reachable in real use:
// `align: 'inside'` with `distance < width` puts `inner` negative, and a
// negative `distance` puts BOTH radii negative (the `align: 'center'`,
// `distance: -0.05` case a later task's browser test exercises).
describe('paintStrokeBand erosion branch (negative radii)', () => {
  const scratchDoc = installScratchDocument()
  const build = (c: CanvasRenderingContext2D) => rectPath(c)

  it('both radii negative (negative distance, center align): erodes twice and bands the interior ring', () => {
    // center ⇒ outer = d + width/2, inner = d - width/2.
    // d = -30, width = 10 ⇒ outer = -25, inner = -35. Both negative ⇒ both
    // scratches take the erosion branch.
    const { ctx, rec } = makeCtx('main')
    paintStrokeBand(ctx, { width: 10, distance: -30, style: () => '#f00', build })

    // Shared ctx: still just the one non-erasing stamp, same as the dilation case.
    expect(rec.ops.map(o => o.kind)).toEqual(['save', 'stamp', 'restore'])
    expect(rec.ops.some(o => (o as any).erase)).toBe(false)

    expect(scratchDoc.count()).toBe(2)
    const [outerRec, innerRec] = scratchDoc.scratches()

    // Erosion is fill() + a DESTINATION-OUT stroke at 2|r| — on the scratch,
    // never on the shared ctx (asserted above). This is the line this test
    // exists to cover: without it, a sign error collapsing erosion into
    // dilation would slip through the whole suite unnoticed.
    const outerFill = outerRec!.ops.find(o => o.kind === 'fill') as any
    const outerStroke = outerRec!.ops.find(o => o.kind === 'stroke') as any
    expect(outerFill.erase).toBe(false)
    expect(outerStroke.erase).toBe(true)
    expect(outerStroke.lineWidth).toBe(50) // 2 * |−25|

    const innerFill = innerRec!.ops.find(o => o.kind === 'fill') as any
    const innerStroke = innerRec!.ops.find(o => o.kind === 'stroke') as any
    expect(innerFill.erase).toBe(false)
    expect(innerStroke.erase).toBe(true)
    expect(innerStroke.lineWidth).toBe(70) // 2 * |−35|

    // The outer scratch then knocks the inner scratch's shape out of itself.
    expect(outerRec!.ops.some(o => o.kind === 'stamp' && (o as any).erase)).toBe(true)

    // Ink check: erosion-by-25 keeps points farther than 25 from the ORIGINAL
    // edge; erosion-by-35 keeps points farther than 35. The band is their
    // difference: a ring 25..35 units INSIDE the original edge (x = ±50).
    // A broken "erosion == dilation" implementation would instead put ink
    // 25..35 units OUTSIDE the shape — the two are checked at the same
    // distances so a sign flip cannot pass both.
    expect(inkAt(rec, { x: 20, y: 0 })).toBe(true)   // 30 from the edge: inside the ring
    expect(inkAt(rec, { x: 10, y: 0 })).toBe(false)  // 40 from the edge: eroded away by both
    expect(inkAt(rec, { x: 30, y: 0 })).toBe(false)  // 20 from the edge: not yet eroded into the ring
    expect(inkAt(rec, { x: 0, y: 0 })).toBe(false)   // dead centre: nowhere near either erosion depth
    expect(inkAt(rec, { x: 60, y: 0 })).toBe(false)  // outside the shape entirely — erosion never goes here
  })

  it('mixed radii (inside align, distance < width): outer dilates, inner erodes', () => {
    // inside ⇒ outer = d, inner = d - width.
    // d = 3, width = 10 ⇒ outer = 3 (positive, dilation), inner = -7 (negative, erosion).
    const { ctx, rec } = makeCtx('main')
    paintStrokeBand(ctx, { width: 10, distance: 3, align: 'inside', style: () => '#f00', build })

    expect(rec.ops.map(o => o.kind)).toEqual(['save', 'stamp', 'restore'])
    expect(scratchDoc.count()).toBe(2)
    const [outerRec, innerRec] = scratchDoc.scratches()

    // Outer (r = 3 > 0): the ordinary dilation branch — a plain, non-erasing stroke.
    const outerStroke = outerRec!.ops.find(o => o.kind === 'stroke') as any
    expect(outerStroke.erase).toBe(false)
    expect(outerStroke.lineWidth).toBe(6) // 2 * 3

    // Inner (r = -7 < 0): the erosion branch under test — destination-out, on the scratch.
    const innerStroke = innerRec!.ops.find(o => o.kind === 'stroke') as any
    expect(innerStroke.erase).toBe(true)
    expect(innerStroke.lineWidth).toBe(14) // 2 * |−7|

    // Never on the shared ctx.
    expect(rec.ops.some(o => (o as any).erase)).toBe(false)

    // Ink check (edge at x = ±50): the band is dilation-by-3 minus erosion-by-7,
    // i.e. everywhere from 7 inside the edge to 3 outside it.
    expect(inkAt(rec, { x: 50, y: 0 })).toBe(true)   // on the edge: within both radii
    expect(inkAt(rec, { x: 45, y: 0 })).toBe(true)   // 5 inside: within the 7px erosion depth
    expect(inkAt(rec, { x: 52, y: 0 })).toBe(true)   // 2 outside: within the 3px dilation
    expect(inkAt(rec, { x: 54, y: 0 })).toBe(false)  // 4 outside: past the dilation
    expect(inkAt(rec, { x: 40, y: 0 })).toBe(false)  // 10 inside: past the erosion depth, eroded away
  })
})

// Task 3b. `region()` used to hardcode its two ink primitives as `fill(path)/fill()` and
// `stroke(path)/stroke()`, which is why a band needed a Path2D and text — which has none,
// only `fillText`/`strokeText` — was left at distance 0. `fillText(t,x,y)` plus
// `strokeText(t,x,y)` at `lineWidth = 2r` IS the dilation of that run's ink by `r`: the
// same construction with different primitives. So the pair is injectable, and the text
// paths supply the text one.
//
// Every case below injects a DIFFERENT geometry (a square at ±20 or ±40) from the one on
// the context (±50) so "the injected pair actually ran" is observable as ink in a place
// the default primitives could not have put it — an ignored option would leave the band
// around the context path and fail every probe.
describe('paintStrokeBand — injectable ink primitives', () => {
  const scratchDoc = installScratchDocument()

  /** A 40×40 square (edge at ±20), deliberately smaller than `rectPath`'s ±50. */
  function smallPath(c: CanvasRenderingContext2D) {
    c.beginPath()
    c.rect(-20, -20, 40, 40)
  }

  it('bands the INJECTED shape, not the context path', () => {
    const { ctx, rec } = makeCtx('main')
    rectPath(ctx)                    // the shape the DEFAULT primitives would band (±50)
    let fills = 0, strokes = 0
    paintStrokeBand(ctx, {
      width: 10, distance: 30, style: () => '#f00',
      inkFill: (c) => { fills++; smallPath(c); c.fill() },
      inkStroke: (c) => { strokes++; smallPath(c); c.stroke() },
    })

    // Once per dilation surface: the outer scratch and the inner (knockout) scratch.
    expect(fills).toBe(2)
    expect(strokes).toBe(2)

    // centre ⇒ radii 35 / 25. Around the INJECTED edge (±20) the band is x 45..55;
    // around the CONTEXT path's edge (±50) it would be x 75..85.
    expect(inkAt(rec, { x: 50, y: 0 })).toBe(true)
    expect(inkAt(rec, { x: 30, y: 0 })).toBe(false)   // inside the inner dilation
    expect(inkAt(rec, { x: 80, y: 0 })).toBe(false)   // where the DEFAULT band would be
    expect(inkAt(rec, { x: 90, y: 0 })).toBe(false)
  })

  // A guard, not a red-first case: before the injection existed the defaults were the ONLY
  // behaviour, so this cannot fail against the old code. It fails if a later change moves
  // the default off `fill(path)/stroke(path)` — proved by mutation, see the task report.
  it('with no primitives supplied, bands the context path exactly as it always did', () => {
    const { ctx: defCtx, rec: defRec } = makeCtx('default')
    const before = scratchDoc.count()
    paintStrokeBand(defCtx, { width: 10, distance: 30, style: () => '#f00', build: rectPath })
    const defScratches = scratchDoc.scratches().slice(before)

    const { ctx: injCtx, rec: injRec } = makeCtx('injected')
    const before2 = scratchDoc.count()
    paintStrokeBand(injCtx, {
      width: 10, distance: 30, style: () => '#f00', build: rectPath,
      // Literally the default pair, spelled out.
      inkFill: (c) => c.fill(),
      inkStroke: (c) => c.stroke(),
    })
    const injScratches = scratchDoc.scratches().slice(before2)

    const shape = (ops: typeof defRec.ops) =>
      ops.map(o => [o.kind, (o as any).erase ?? false, (o as any).lineWidth ?? null, (o as any).lineJoin ?? null])
    expect(shape(injRec.ops)).toEqual(shape(defRec.ops))
    expect(injScratches.map(r => shape(r.ops))).toEqual(defScratches.map(r => shape(r.ops)))
    for (const x of [40, 45, 50, 55, 60, 75, 80, 85, 90]) {
      expect([x, inkAt(injRec, { x, y: 0 })]).toEqual([x, inkAt(defRec, { x, y: 0 })])
    }
    // …and it really is the band the other tests pin: ink 75..85 around the ±50 edge.
    expect(inkAt(defRec, { x: 80, y: 0 })).toBe(true)
  })

  it('reaches the EROSION branch through the injected pair too', () => {
    const { ctx, rec } = makeCtx('main')
    rectPath(ctx)
    /** An 80×80 square (edge at ±40) — big enough to survive an erosion by 35. */
    const bigger = (c: CanvasRenderingContext2D) => { c.beginPath(); c.rect(-40, -40, 80, 80) }
    const erasingAt: boolean[] = []
    paintStrokeBand(ctx, {
      width: 10, distance: -30, style: () => '#f00',
      inkFill: (c) => { bigger(c); c.fill() },
      inkStroke: (c) => {
        erasingAt.push(c.globalCompositeOperation === 'destination-out')
        bigger(c); c.stroke()
      },
    })

    // centre ⇒ outer = -25, inner = -35: BOTH negative, so both surfaces erode. The
    // injected stroke must therefore run while the context is knocking out.
    expect(erasingAt).toEqual([true, true])
    const [outerRec, innerRec] = scratchDoc.scratches()
    const outerStroke = outerRec!.ops.find(o => o.kind === 'stroke') as any
    const innerStroke = innerRec!.ops.find(o => o.kind === 'stroke') as any
    expect(outerStroke.erase).toBe(true)
    expect(innerStroke.erase).toBe(true)
    expect(outerStroke.lineWidth).toBe(50)   // 2 * |−25|
    expect(innerStroke.lineWidth).toBe(70)   // 2 * |−35|

    // Ink: erosion-by-25 minus erosion-by-35 around the INJECTED edge (±40) is a ring
    // 25..35 units inside it, i.e. x 5..15. Around the CONTEXT path (±50) it would be
    // x 15..25 — the two windows are disjoint, so a dropped injection cannot pass.
    expect(inkAt(rec, { x: 10, y: 0 })).toBe(true)
    expect(inkAt(rec, { x: 20, y: 0 })).toBe(false)
    expect(inkAt(rec, { x: 0, y: 0 })).toBe(false)
    expect(inkAt(rec, { x: 45, y: 0 })).toBe(false)
  })
})

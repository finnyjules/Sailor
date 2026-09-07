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

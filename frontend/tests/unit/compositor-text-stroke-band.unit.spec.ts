import { describe, it, expect } from 'vitest'
import {
  paintLayerStack, createTextLayer, outsideStrokePadPx, silhouettePadPx,
  type LocalLayer,
} from '~/composables/useCompositorLayers'
import { SILHOUETTE_RASTER_PAD_PX } from '~/lib/compositor/silhouetteCache'
import { makeCtx, installScratchDocument, type Recorder } from './_strokeCtx'

/**
 * A TEXT layer's strokes at a DISTANCE (Task 3b).
 *
 * Task 3 gave text multiple strokes but left every one of them on the glyph edge: the
 * band painter's `region()` closure hardcoded `fill(path)` / `stroke(path)`, and a Frame
 * text layer has no path — it stores a CSS family name and draws with `fillText` /
 * `strokeText`. Task 3b made those two ink primitives injectable, because
 * `fillText(t,x,y)` + `strokeText(t,x,y)` at `lineWidth = 2r` IS the dilation of that
 * run's ink by `r`.
 *
 * This suite is structural, not pixel-based: the recording context has no glyph outlines,
 * so it cannot answer "is this point painted" for text. What it CAN answer — and what the
 * whole change turns on — is WHICH SURFACE each text draw landed on and at what
 * `lineWidth`. A distance stroke that quietly stayed on the old `strokeText` path shows up
 * here as an extra run on the shared context and no dilation surfaces at all. The browser
 * test in tests/compositor-multi-stroke.spec.ts measures the actual pixels.
 */

const W = 200, H = 200

/** Every draw a text layer makes, split by the surface it landed on. */
function paintText(layer: LocalLayer, scratchDoc: ReturnType<typeof installScratchDocument>) {
  // `installScratchDocument`'s list resets per TEST, not per call, and one case below
  // paints four times — so only the canvases THIS paint created are considered.
  const before = scratchDoc.count()
  const { ctx, rec } = makeCtx('main', W, H)
  paintLayerStack(ctx, W, H, [{ type: 'local' as const, key: `l:${layer.id}`, layer }], [layer])
  // `measureCtx()` also asks the mocked document for a canvas; it never draws text, so
  // the dilation surfaces are exactly the ones that did.
  const inked: Recorder[] = scratchDoc.scratches().slice(before).filter(r => r.texts.length > 0)
  return { rec, inked }
}

describe('a text stroke at distance 0 — unchanged, and the reason byte-identity holds', () => {
  const scratchDoc = installScratchDocument()

  it('takes the plain strokeText path and builds no dilation surface at all', () => {
    // The LEGACY single-stroke shape every saved frame carries.
    const layer = createTextLayer({ id: 't1', text: 'AB', fontSize: 0.1, strokeColor: '#f00', strokeWidth: 0.01 })
    const { rec, inked } = paintText(layer, scratchDoc)
    expect(inked).toEqual([])
    expect(rec.texts.map(t => [t.kind, t.lineWidth])).toEqual([['strokeText', 2], ['fillText', 2]])
    expect(rec.ops.some(o => o.kind === 'stamp')).toBe(false)
  })
})

describe('a text stroke at a DISTANCE — dilated, once for the whole block', () => {
  const scratchDoc = installScratchDocument()

  /** Two strokes: one pushed 10 px out, one on the edge. Painted in reverse list order, so
   *  'near' (last) goes down first and 'far' (first) lands on top of it. */
  const twoStrokes = (align?: 'center' | 'inside' | 'outside') => createTextLayer({
    id: 't2', text: 'A\nB', fontSize: 0.1, lineHeight: 1.2, align: 'center',
    strokeColor: undefined, strokeWidth: undefined,
    strokes: [
      { id: 'far', paint: '#f00', width: 0.01, distance: 0.05, ...(align ? { align } : {}) },
      { id: 'near', paint: '#0f0', width: 0.01 },
    ],
  } as never)

  it('draws the distant stroke on dilation surfaces, NOT as another strokeText on the shared context', () => {
    const { rec, inked } = paintText(twoStrokes(), scratchDoc)

    // Shared context: two lines, each stroked ONCE (the near pass) and filled once.
    // Before this task the distant stroke was a second centred strokeText per line — four
    // strokeTexts here instead of two.
    expect(rec.texts.map(t => t.kind)).toEqual(['strokeText', 'fillText', 'strokeText', 'fillText'])
    expect(rec.texts.filter(t => t.kind === 'strokeText').every(t => t.lineWidth === 2)).toBe(true)

    // …and exactly two dilation surfaces (outer + inner), each carrying BOTH lines, so the
    // band is the offset of the whole block rather than one ring per line.
    expect(inked.length).toBe(2)
    for (const s of inked) {
      expect(s.texts.map(t => t.kind)).toEqual(['fillText', 'fillText', 'strokeText', 'strokeText'])
      expect(s.texts.map(t => t.text)).toEqual(['A', 'B', 'A', 'B'])
    }
    // The band is stamped back onto the shared context (once), never knocked out on it.
    expect(rec.ops.filter(o => o.kind === 'stamp').length).toBe(1)
    expect(rec.ops.some(o => (o as { erase?: boolean }).erase)).toBe(false)
  })

  it('takes the two dilation radii from distance and align together', () => {
    // width 0.01 ⇒ 2 px, distance 0.05 ⇒ 10 px. lineWidth is 2r.
    const radii = (align?: 'center' | 'inside' | 'outside') => {
      const { inked } = paintText(twoStrokes(align), scratchDoc)
      return inked.map(s => s.texts.find(t => t.kind === 'strokeText')!.lineWidth)
    }
    expect(radii()).toEqual([22, 18])           // centre: 10 ± 1
    expect(radii('center')).toEqual([22, 18])
    expect(radii('outside')).toEqual([24, 20])  // 10 + 2, 10
    expect(radii('inside')).toEqual([20, 16])   // 10, 10 − 2
  })
})

/**
 * How far a TEXT layer's ink now reaches past its box — Task 3b item 4.
 *
 * Two helpers answer that, for two different consumers, and only one of them ever saw a
 * text layer before this task:
 *
 *  - `outsideStrokePadPx` sizes the CORNER-PIN offscreen and, load-bearingly, SCALES the
 *    quad that offscreen is warped onto (`hw = box.w / 2 + pad`). It returned a flat 0 for
 *    text. With the outline welded to the glyph edge that was defensible; a band pushed 20
 *    px out is simply clipped away by the offscreen's edge, which is the bug this pad
 *    exists to prevent.
 *  - `silhouettePadPx` sizes the raster the torn-edge / feather effects measure their edge
 *    from. Text takes its own branch there (a full em plus the outline's width) and never
 *    consulted `distance` at all, so a distant band fell outside the baked silhouette.
 *
 * The saved-frame constraint is the same one the shape pad's "centre at distance 0"
 * exception encodes, and text needs it MORE, not less: a text layer can carry a stored
 * `strokeAlign` that the text painter has always ignored (`strokeText` is centred, full
 * stop). Honouring that alignment here would re-warp saved pinned frames for an outline
 * that has never been drawn anywhere but on the edge. So a text stroke AT DISTANCE 0
 * contributes 0 whatever it claims about alignment — and only a distance, which no saved
 * frame can carry, is padded for.
 */
describe('a text layer\'s stroke reach (item 4)', () => {
  const W = 200

  const textLayer = (extra: Record<string, unknown>) => ({
    id: 'tp', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
    text: 'Edge', fontFamily: 'Inter', fontWeight: 700, fontSize: 0.05,
    color: '#fff', align: 'center', lineHeight: 1.1, boxH: 0, ...extra,
  }) as unknown as LocalLayer

  describe('outsideStrokePadPx — the corner-pin pad', () => {
    it('is still 0 for the legacy on-the-edge outline every saved frame carries', () => {
      expect(outsideStrokePadPx(textLayer({ strokeColor: '#f00', strokeWidth: 0.1 }), W)).toBe(0)
      // …including one that stored an alignment `strokeText` has always ignored. Padding
      // for it would move the corner-pin quad of a frame whose pixels never change.
      expect(outsideStrokePadPx(textLayer({ strokeColor: '#f00', strokeWidth: 0.1, strokeAlign: 'outside' }), W)).toBe(0)
      // Same for the flag the silhouette raster passes: text's raster overhang comes from
      // its own font-size rule (see silhouettePadPx below), never from this helper.
      expect(outsideStrokePadPx(textLayer({ strokeColor: '#f00', strokeWidth: 0.1 }), W, true)).toBe(0)
    })

    it('DOES pad for a stroke a distance pushed off the glyph edge', () => {
      const l = textLayer({ strokes: [{ id: 'a', paint: '#f00', width: 0.01, distance: 0.05, align: 'center' }] })
      expect(outsideStrokePadPx(l, W)).toBeCloseTo((0.05 + 0.005) * W, 6)   // 11 px
      const out = textLayer({ strokes: [{ id: 'a', paint: '#f00', width: 0.01, distance: 0.05, align: 'outside' }] })
      expect(outsideStrokePadPx(out, W)).toBeCloseTo((0.05 + 0.01) * W, 6)  // 12 px
    })

    it('pads for the furthest-reaching stroke in the stack, and ignores an invisible one', () => {
      const l = textLayer({
        strokes: [
          { id: 'a', paint: '#f00', width: 0.01, distance: 0.02 },
          { id: 'b', paint: '#0f0', width: 0.01, distance: 0.09, visible: false },
          { id: 'c', paint: '#00f', width: 0.02, distance: 0.04 },
        ],
      })
      expect(outsideStrokePadPx(l, W)).toBeCloseTo((0.04 + 0.01) * W, 6)    // 10 px, from 'c'
    })
  })

  describe('silhouettePadPx — the torn-edge / feather raster', () => {
    const MARGIN = SILHOUETTE_RASTER_PAD_PX
    const BOX = { w: 100, h: 100 }
    // fontPx = 0.05 * 200 = 10, and text's overhang is a full em PLUS the outline's reach.

    it('is unchanged for a stroke on the edge — the widest stroke width, as before', () => {
      const l = textLayer({ strokes: [{ id: 'a', paint: '#f00', width: 0.03 }] })
      expect(silhouettePadPx(l, W, 1, BOX)).toBeCloseTo(MARGIN + 10 + 6, 6)
    })

    it('grows for a stroke pushed out by a distance, which no width alone can express', () => {
      const l = textLayer({ strokes: [{ id: 'a', paint: '#f00', width: 0.01, distance: 0.05 }] })
      // reach = 0.05 + 0.01 = 0.06 ⇒ 12 px, well past the 2 px the width alone gives.
      expect(silhouettePadPx(l, W, 1, BOX)).toBeCloseTo(MARGIN + 10 + 12, 6)
    })

    it('never shrinks for a band pulled INWARD by a negative distance', () => {
      const l = textLayer({ strokes: [{ id: 'a', paint: '#f00', width: 0.03, distance: -0.05 }] })
      // An inward band paints inside the ink; the raster still needs the full width.
      expect(silhouettePadPx(l, W, 1, BOX)).toBeCloseTo(MARGIN + 10 + 6, 6)
    })
  })
})

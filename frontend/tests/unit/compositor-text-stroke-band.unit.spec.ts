import { describe, it, expect } from 'vitest'
import {
  paintLayerStack, createTextLayer, strokeReachPx, cornerPinPadPx, silhouettePadPx, applyFont,
  type LocalLayer,
} from '~/composables/useCompositorLayers'
import { SILHOUETTE_RASTER_PAD_PX } from '~/lib/compositor/silhouetteCache'
import { guideFromSpec, placeGlyphs, measureRunPx } from '~/lib/compositor/textPath'
import { layoutExpressive } from '~~/shared/text-layout/expressive'
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
 * Task 3b finding 2 (fix wave 1): a NEGATIVE text distance.
 *
 * `strokeDistancePx` is the ONE place a text stroke is classified on-edge vs distant
 * (§1.4 of the report) — `textStrokePasses` skips a stroke whose distance is non-zero,
 * `paintTextStrokeBands` skips one whose distance IS zero, so a stroke can never be
 * claimed by both or dropped by both — PROVIDED both sides read the same sign. A gate
 * mutated from `!== 0` to `> 0` still treats a negative distance as "non-zero" only in
 * `paintTextStrokeBands`, not in `textStrokePasses` — so it slips back onto the on-edge
 * `strokeText` list AND still gets a band: drawn twice. Wrapping the read in `Math.abs`
 * keeps both gates agreeing on "non-zero", but hands `paintStrokeBand` a positive
 * distance for a stroke that should erode INWARD — it dilates outward instead, same
 * `lineWidth`s, wrong side of the ink. Every existing suite only ever stores a positive
 * distance, so neither mistake shows up without a case like this one.
 */
describe('a text stroke at a NEGATIVE distance — bands inward, never doubles up', () => {
  const scratchDoc = installScratchDocument()

  const inward = () => createTextLayer({
    id: 't4', text: 'A', fontSize: 0.1,
    strokeColor: undefined, strokeWidth: undefined,
    strokes: [{ id: 'in', paint: '#f00', width: 0.01, distance: -0.05 }],
  } as never)

  it('is never drawn as a second centred strokeText — only the band', () => {
    const { rec, inked } = paintText(inward(), scratchDoc)
    // The entire outline for this one stroke must come from the band: no on-edge
    // strokeText pass at all on the shared context (a `> 0` gate would add one back).
    expect(rec.texts.some(t => t.kind === 'strokeText')).toBe(false)
    expect(rec.texts.some(t => t.kind === 'fillText')).toBe(true)   // the glyph fill still lands
    expect(inked.length).toBe(2)                                    // outer + inner dilation surfaces
    expect(rec.ops.filter(o => o.kind === 'stamp').length).toBe(1)
  })

  it('bands on the correct side: an inward distance ERODES, it does not dilate', () => {
    // width 0.01 ⇒ 2px, distance -0.05 ⇒ -10px. Center align: outer = d + w/2 = -9,
    // inner = d - w/2 = -11 — BOTH negative, so BOTH dilation surfaces take the EROSION
    // branch (fill, then a DESTINATION-OUT strokeText at 2|r|), never the plain dilation
    // one (fill, then a non-erasing strokeText). An `Math.abs`-wrapped distance would
    // flip the sign to +10, taking the dilation branch at the SAME two lineWidths (22,
    // 18) but with `erase: false` — the numbers alone would not catch it.
    const { inked } = paintText(inward(), scratchDoc)
    expect(inked.length).toBe(2)
    for (const s of inked) {
      const strokeTextCalls = s.texts.filter(t => t.kind === 'strokeText')
      expect(strokeTextCalls.length).toBeGreaterThan(0)
      expect(strokeTextCalls.every(t => t.erase)).toBe(true)
    }
    const lineWidths = inked.map(s => s.texts.find(t => t.kind === 'strokeText')!.lineWidth).sort((a, b) => a - b)
    expect(lineWidths).toEqual([18, 22])   // 2×9, 2×11
  })
})

/**
 * Task 3b finding 1 (fix wave 1): the ROTATED-RUN branch of `eachRun` — one glyph on a
 * path, `save(); translate(r.x, r.y); rotate(r.angle); draw(0, 0); restore()` — had zero
 * band coverage. Every existing case (this file's plain `'A\nB'`, the browser byte-identity
 * fixture) draws through the OTHER branch (`draw(r.text, r.x, r.y)`, no rotation at all).
 *
 * `_strokeCtx.ts`'s fake context has no glyph geometry, so the only way to see a dropped
 * `rotate()` or an offset `translate()` is to record the calls themselves — which is what
 * the harness's `translate`/`rotate` ops (added for this fix) do. The "expected" placements
 * come from calling `guideFromSpec` + `placeGlyphs` directly, in the SAME order and against
 * the SAME (constant-width) fake `measureText` `drawTextOnPath` itself uses — so this checks
 * that `eachRun` actually replays those placements frame-for-frame, not that the placement
 * MATH is right (that is `lib/vectortype/curve.ts` / `textPath.ts`'s own suite).
 */
describe('text-on-a-path distant band — the rotated run frame (finding 1)', () => {
  const scratchDoc = installScratchDocument()

  const pathLayer = () => createTextLayer({
    id: 't6', text: 'AB', fontSize: 0.1, align: 'left',
    strokeColor: undefined, strokeWidth: undefined,
    path: { follow: 'circle', radius: 0.3 },
    strokes: [{ id: 'far', paint: '#f00', width: 0.01, distance: 0.05 }],
  } as never)

  /** The same placements `drawTextOnPath` computes, via the same (fake) measurement. */
  function referencePlacements(l: ReturnType<typeof pathLayer>) {
    const { ctx: refCtx } = makeCtx('ref', W, H)
    applyFont(refCtx, l, W)
    const guide = guideFromSpec(l.path, W, measureRunPx(refCtx, l))
    return placeGlyphs(refCtx, l, guide, W)
  }

  it('rotates each glyph band frame to the guide tangent — not a flat anchor', () => {
    const l = pathLayer()
    const placed = referencePlacements(l)
    expect(placed.length).toBe(2)
    // Sanity: the guide actually turns, so this exercises the ROTATED branch, not the flat one.
    expect(placed.every(g => g.angle !== 0)).toBe(true)

    const { inked } = paintText(l, scratchDoc)
    expect(inked.length).toBe(2)   // outer + inner dilation surfaces
    // `region()` runs `eachRun` TWICE per scratch — once via `inkFill` (all glyphs),
    // once via `inkStroke` (all glyphs again) — exactly like the fillText/fillText/
    // strokeText/strokeText pattern the distance-0 test above already pins. So the
    // rotate/translate sequence is the placements, twice: fill pass then stroke pass.
    const expectedSeq = [...placed, ...placed]
    for (const s of inked) {
      const rotates = s.ops.filter(o => o.kind === 'rotate') as { kind: 'rotate'; angle: number }[]
      const translates = s.ops.filter(o => o.kind === 'translate') as { kind: 'translate'; x: number; y: number }[]
      expect(rotates.length).toBe(expectedSeq.length)
      expect(translates.length).toBe(expectedSeq.length)
      expectedSeq.forEach((g, i) => {
        expect(translates[i]!.x).toBeCloseTo(g.x, 6)
        expect(translates[i]!.y).toBeCloseTo(g.y, 6)
        expect(rotates[i]!.angle).toBeCloseTo(g.angle, 6)
      })
      // Each glyph's ink is drawn at the LOCAL origin of its own translated+rotated
      // frame (0, 0), never at its world (x, y) directly — that is what save/translate/
      // rotate buys, and what a dropped `rotate()` (still translating to the right spot)
      // would NOT change, which is why the rotate/translate op assertions above exist too.
      const fillCalls = s.texts.filter(t => t.kind === 'fillText')
      expect(fillCalls.length).toBe(placed.length)
      for (const t of fillCalls) { expect(t.x).toBe(0); expect(t.y).toBe(0) }
    }
  })
})

/**
 * Task 3b finding 1 (fix wave 1), the other half: an EXPRESSIVE text layer's distant band.
 * `layoutExpressive` never rotates a word (no field for it), so this exercises `eachRun`'s
 * OTHER leg (`draw(r.text, r.x, r.y)`) — but with real per-word anchors instead of the
 * per-LINE ones the existing `'A\nB'` case already covers, closing the gap the finding
 * flagged for `drawExpressiveText` (~line 3147) specifically.
 */
describe('expressive text distant band — per-word anchors (finding 1)', () => {
  const scratchDoc = installScratchDocument()

  const expressiveLayer = () => createTextLayer({
    id: 't7', text: 'One Two Three', fontSize: 0.05, lineHeight: 1.2,
    boxW: 0.6, align: 'left',
    strokeColor: undefined, strokeWidth: undefined,
    expressive: { wordsPerLine: 1, placement: 'random', jitterX: 0.4, jitterY: 0, seed: 7 },
    strokes: [{ id: 'far', paint: '#f00', width: 0.01, distance: 0.05 }],
  } as never)

  /** The same per-word placements `drawExpressiveText` computes. */
  function referenceRuns(l: ReturnType<typeof expressiveLayer>) {
    const { ctx: refCtx } = makeCtx('ref', W, H)
    applyFont(refCtx, l, W)
    const lineH = l.fontSize * W * l.lineHeight
    const boxWidth = l.boxW! * W
    const lay = layoutExpressive({
      text: l.text!, boxWidth, lineHeight: lineH,
      measure: (word) => refCtx.measureText(word).width,
      params: l.expressive!,
      justifyX: l.align === 'justify',
      justifyY: l.valign === 'justify',
    })
    const originX = -boxWidth / 2
    const originY = -lay.height / 2
    return lay.words.map(wd => ({ x: originX + wd.x, y: originY + wd.y + lineH / 2 }))
  }

  it('bands each word at its OWN placed anchor, not a per-line one', () => {
    const l = expressiveLayer()
    const runs = referenceRuns(l)
    expect(runs.length).toBe(3)   // 'One', 'Two', 'Three' — one word per line

    const { inked } = paintText(l, scratchDoc)
    expect(inked.length).toBe(2)
    for (const s of inked) {
      const fillCalls = s.texts.filter(t => t.kind === 'fillText')
      expect(fillCalls.length).toBe(runs.length)
      runs.forEach((r, i) => {
        expect(fillCalls[i]!.x).toBeCloseTo(r.x, 6)
        expect(fillCalls[i]!.y).toBeCloseTo(r.y, 6)
      })
      // Never routed through the rotated frame: expressive words carry no angle.
      expect(s.ops.some(o => o.kind === 'rotate')).toBe(false)
    }
  })
})

/**
 * How far a TEXT layer's ink now reaches past its box — Task 3b item 4.
 *
 * Two helpers answer that, for two different consumers, and only one of them ever saw a
 * text layer before this task:
 *
 *  - `cornerPinPadPx` sizes the CORNER-PIN offscreen and, load-bearingly, SCALES the
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

  describe('cornerPinPadPx — the corner-pin pad', () => {
    it('is still 0 for the legacy on-the-edge outline every saved frame carries', () => {
      expect(cornerPinPadPx(textLayer({ strokeColor: '#f00', strokeWidth: 0.1 }), W)).toBe(0)
      // …including one that stored an alignment `strokeText` has always ignored. Padding
      // for it would move the corner-pin quad of a frame whose pixels never change.
      expect(cornerPinPadPx(textLayer({ strokeColor: '#f00', strokeWidth: 0.1, strokeAlign: 'outside' }), W)).toBe(0)
      // Same for the flag the silhouette raster passes: text's raster overhang comes from
      // its own font-size rule (see silhouettePadPx below), never from this helper.
      expect(strokeReachPx(textLayer({ strokeColor: '#f00', strokeWidth: 0.1 }), W)).toBe(0)
    })

    it('DOES pad for a stroke a distance pushed off the glyph edge', () => {
      const l = textLayer({ strokes: [{ id: 'a', paint: '#f00', width: 0.01, distance: 0.05, align: 'center' }] })
      expect(cornerPinPadPx(l, W)).toBeCloseTo((0.05 + 0.005) * W, 6)   // 11 px
      const out = textLayer({ strokes: [{ id: 'a', paint: '#f00', width: 0.01, distance: 0.05, align: 'outside' }] })
      expect(cornerPinPadPx(out, W)).toBeCloseTo((0.05 + 0.01) * W, 6)  // 12 px
    })

    it('pads for the furthest-reaching stroke in the stack, and ignores an invisible one', () => {
      const l = textLayer({
        strokes: [
          { id: 'a', paint: '#f00', width: 0.01, distance: 0.02 },
          { id: 'b', paint: '#0f0', width: 0.01, distance: 0.09, visible: false },
          { id: 'c', paint: '#00f', width: 0.02, distance: 0.04 },
        ],
      })
      expect(cornerPinPadPx(l, W)).toBeCloseTo((0.04 + 0.01) * W, 6)    // 10 px, from 'c'
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

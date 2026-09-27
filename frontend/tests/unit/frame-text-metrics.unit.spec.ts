// frontend/tests/unit/frame-text-metrics.unit.spec.ts
// textMetrics against the renderer: the lines `drawText` draws (fillText y = each line's middle,
// textBaseline 'middle', relative to the layer origin) must be exactly where textMetrics puts them.
import { describe, it, expect } from 'vitest'
import {
  createTextLayer, drawLocalLayer, localLayerBox, textVAlignCenterOffset, fillFontSize, type TextLayer,
} from '~/composables/useCompositorLayers'
import { textMetrics } from '~/lib/frame/textMetrics'
import { makeCtx, installScratchDocument } from './_strokeCtx'

const W = 200, H = 200
const scratchDoc = installScratchDocument()

/** A measuring context with known cap metrics: 'H' reaches 0.3 em above the line's middle and
 *  0.4 em below it (its baseline) in 'middle' mode. Widths match the renderer's fake (10 px). */
function probe(): CanvasRenderingContext2D {
  const { ctx } = makeCtx('probe', W, H)
  const c = ctx as any
  c.measureText = (_s: string) => {
    const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(c.font)?.[1] ?? '10')
    const mid = c.textBaseline === 'middle'
    return { width: 10, actualBoundingBoxAscent: (mid ? 0.3 : 0.7) * px, actualBoundingBoxDescent: (mid ? 0.4 : 0) * px }
  }
  return ctx
}

/** Each line's middle as the renderer draws it (unique fillText y's, sorted), across every surface. */
function drawnMiddles(layer: TextLayer): number[] {
  const before = scratchDoc.count()
  const { ctx, rec } = makeCtx('main', W, H)
  drawLocalLayer(ctx, layer, W, H)
  const texts = [rec, ...scratchDoc.scratches().slice(before)].flatMap(r => r.texts).filter(t => t.kind === 'fillText')
  return [...new Set(texts.map(t => t.y))].sort((a, b) => a - b)
}

const three = (p: Partial<TextLayer> = {}) =>
  createTextLayer({ text: 'A\nB\nC', fontSize: 0.1, lineHeight: 1.2, align: 'left', ...p } as Partial<TextLayer>)

describe('textMetrics matches the renderer', () => {
  const cases: [string, Partial<TextLayer>][] = [
    ['centred block, no box', {}],
    ['valign top in a box', { boxW: 1, boxH: 0.6, valign: 'top' }],
    ['valign bottom in a box', { boxW: 1, boxH: 0.6, valign: 'bottom' }],
    ['valign middle in a box', { boxW: 1, boxH: 0.6, valign: 'middle' }],
  ]
  for (const [name, p] of cases) {
    it(`${name}: each baseline is its drawn line's middle plus the cap descent, from the box top`, () => {
      const layer = three(p)
      const c = probe()
      const m = textMetrics(layer, W, c)!
      const mids = drawnMiddles(layer)
      expect(mids).toHaveLength(3)
      const box = localLayerBox(c, layer, W, H)
      const top = textVAlignCenterOffset(layer, box.h) - box.h / 2
      const px = 0.1 * W
      expect(m.lines).toBe(3)
      expect(m.boxH).toBeCloseTo(box.h, 9)
      m.baselines.forEach((b, i) => expect(b).toBeCloseTo(mids[i]! + 0.4 * px - top, 9))
      expect(m.capTop).toBeCloseTo(mids[0]! - 0.3 * px - top, 9)
    })
  }
  it('known numbers: a centred 3-line block and a top-aligned box agree (capitals 6, baselines 20/44/68)', () => {
    const c = probe()
    const near = (m: { capTop: number; baselines: number[] } | null, cap: number, bs: number[]) => {
      expect(m!.capTop).toBeCloseTo(cap, 9)
      expect(m!.baselines).toHaveLength(bs.length)
      bs.forEach((b, i) => expect(m!.baselines[i]!).toBeCloseTo(b, 9))
    }
    near(textMetrics(three(), W, c), 6, [20, 44, 68])
    near(textMetrics(three({ boxW: 1, boxH: 0.6, valign: 'top' }), W, c), 6, [20, 44, 68])
    near(textMetrics(three({ boxW: 1, boxH: 0.6, valign: 'bottom' }), W, c), 54, [68, 92, 116])
  })
  it('the first baseline minus the capitals is the cap height; baselines are one line apart', () => {
    const m = textMetrics(three(), W, probe())!
    expect(m.baselines[0]! - m.capTop).toBeCloseTo(0.7 * 0.1 * W, 9)
    expect(m.baselines[1]! - m.baselines[0]!).toBeCloseTo(0.1 * W * 1.2, 9)
    expect(m.baselines[2]! - m.baselines[1]!).toBeCloseTo(0.1 * W * 1.2, 9)
  })
  it('fill-fitted text is measured at the size the renderer fits it to', () => {
    const c = probe()
    const fill = three({ boxW: 1, boxH: 0.6, valign: 'top', boxFit: 'fill' })
    const asWrap = { ...fill, boxFit: 'wrap' as const, fontSize: fillFontSize(c, fill, W) }
    const a = textMetrics(fill, W, c)!, b = textMetrics(asWrap, W, c)!
    expect(a.capTop).toBeCloseTo(b.capTop, 9)
    a.baselines.forEach((v, i) => expect(v).toBeCloseTo(b.baselines[i]!, 9))
  })
})

describe('textMetrics edges', () => {
  it('without a canvas, capitals and baselines are 0.35 em either side of the line middle', () => {
    const m = textMetrics(three(), W, null)!
    const px = 0.1 * W
    expect(m.baselines[0]! - m.capTop).toBeCloseTo(0.7 * px, 9)
    expect(m.capTop).toBeCloseTo(36 - 24 - 0.35 * px, 9)     // first middle −24 from a block top at −36
  })
  it('placed lines, type on a path and expressive text are not measured (they snap as boxes)', () => {
    expect(textMetrics(three({ runs: [{ text: 'A', x: 0, y: 0 }] } as any), W, probe())).toBeNull()
    expect(textMetrics(three({ path: { kind: 'arc' } } as any), W, probe())).toBeNull()
    expect(textMetrics(three({ expressive: {} } as any), W, probe())).toBeNull()
  })
  it('is cached by what shapes the lines, per context', () => {
    const c = probe()
    const l = three()
    const a = textMetrics(l, W, c)
    expect(textMetrics({ ...l }, W, c)).toBe(a)                        // same inputs → the cached result
    expect(textMetrics({ ...l, text: 'A\nB' }, W, c)).not.toBe(a)      // new words → measured again
    expect(textMetrics({ ...l, valign: 'bottom', boxW: 1, boxH: 0.6 }, W, c)).not.toBe(a)
    expect(textMetrics(l, W, null)).not.toBe(a)                         // another context never shares
  })
})

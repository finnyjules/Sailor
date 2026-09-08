/**
 * The SVG writer's half of the stroke stack.
 *
 * `pathLayersToSvgDoc` is the only writer in the app that turns Compositor layers into SVG
 * elements, and until this task it read ONE stroke out of the legacy `stroke`/`strokeWidth`
 * pair — the pair a stacked layer does not have. So a two-stroke shape exported with no
 * outline at all, not merely a missing second one.
 *
 * What is asserted here is the ORDER, the UNITS and the HONESTY:
 *
 *  - order: the stack paints first-row-on-top, and SVG paints later-element-on-top, so the
 *    elements come out reversed relative to the stored list. Getting this backwards swaps a
 *    hairline and the band under it, which is invisible in a screenshot and obvious in a
 *    file.
 *  - units: a stroke width lives in the layer's LOCAL units and the element's `transform`
 *    already scales them, so `stroke-width` is the stored number, unmultiplied. The old
 *    writer multiplied by the transform's own scale — a 1000×-too-thick outline.
 *  - honesty: a band at a distance cannot be exported exactly (the offset geometry is a
 *    raster difference of two dilations, not a path), and neither can inside/outside
 *    alignment. Those come back as NOTES naming the layer rather than as a silent lie.
 */
import { describe, it, expect } from 'vitest'
import {
  createRectLayer, createPathLayer, shapeToPathLayer, type PathLayer,
} from '~/composables/useCompositorLayers'
import { pathLayersToSvgDoc, pathLayersToSvg } from '~/composables/useVectorSvg'
import { shapeById } from '~/lib/shapes/catalog'

/** Every `<path ... />` element in document (= paint) order. */
function paths(svg: string): string[] {
  return svg.match(/<path\b[^>]*\/>/g) ?? []
}
const attr = (el: string, name: string): string | null => {
  const m = el.match(new RegExp(`\\s${name}="([^"]*)"`))
  return m ? m[1]! : null
}

const rectWithStrokes = (strokes: unknown[]): PathLayer =>
  shapeToPathLayer(createRectLayer({
    id: 'r1', w: 0.4, h: 0.2, fill: '#123456', radius: 0,
    // The stacked shape: `strokes` set, every legacy field cleared.
    stroke: undefined, strokeWidth: undefined, strokes,
  } as never))!

describe('pathLayersToSvgDoc — band strokes', () => {
  it('a two-stroke rect emits two stroke paths, in the order they paint', () => {
    const l = rectWithStrokes([
      { id: 'a', paint: '#ff0000', width: 0.01, distance: 0, style: 'band' },
      { id: 'b', paint: '#0000ff', width: 0.03, distance: 0, style: 'band' },
    ])
    const { svg, notes } = pathLayersToSvgDoc([l], 1)
    const outlines = paths(svg).filter(p => attr(p, 'stroke'))
    expect(outlines).toHaveLength(2)
    // The stack paints the LAST row first so the FIRST row lands on top; SVG paints in
    // document order, so the first row must be the LAST element.
    expect(attr(outlines[0]!, 'stroke')).toBe('#0000ff')
    expect(attr(outlines[1]!, 'stroke')).toBe('#ff0000')
    // fill:none on a stroke element — an outline is not a filled copy of the shape.
    expect(attr(outlines[0]!, 'fill')).toBe('none')
    expect(attr(outlines[1]!, 'fill')).toBe('none')
    expect(notes).toEqual([])
  })

  it('a stroke width is written in the layer local units the transform already scales', () => {
    const l = rectWithStrokes([{ id: 'a', paint: '#ff0000', width: 0.01, distance: 0, style: 'band' }])
    const outline = paths(pathLayersToSvgDoc([l], 1).svg).find(p => attr(p, 'stroke'))!
    // 0.01 local units under the layer's own scale(1 * 1000) renders as 10 viewBox px —
    // exactly what the canvas paints at W = 1000 (`widthScale` 1, ctx pre-scaled by s).
    expect(Number(attr(outline, 'stroke-width'))).toBeCloseTo(0.01, 6)
  })

  it('an inkless entry has a row but no element — never a black stroke', () => {
    const l = rectWithStrokes([
      { id: 'a', paint: 'none', width: 0.01, distance: 0, style: 'band' },
      { id: 'b', paint: '#0000ff', width: 0.02, distance: 0, style: 'band' },
    ])
    const outlines = paths(pathLayersToSvgDoc([l], 1).svg).filter(p => attr(p, 'stroke'))
    expect(outlines).toHaveLength(1)
    expect(attr(outlines[0]!, 'stroke')).toBe('#0000ff')
  })

  it('a hidden entry and a zero-width entry write nothing', () => {
    const l = rectWithStrokes([
      { id: 'a', paint: '#ff0000', width: 0.01, distance: 0, style: 'band', visible: false },
      { id: 'b', paint: '#00ff00', width: 0, distance: 0, style: 'band' },
    ])
    expect(paths(pathLayersToSvgDoc([l], 1).svg).filter(p => attr(p, 'stroke'))).toHaveLength(0)
  })

  it('a dash reaches the file as stroke-dasharray in the same local units', () => {
    const l = rectWithStrokes([
      { id: 'a', paint: '#ff0000', width: 0.01, distance: 0, style: 'band', dash: { dash: 0.02, gap: 0.01 } },
    ])
    const outline = paths(pathLayersToSvgDoc([l], 1).svg).find(p => attr(p, 'stroke'))!
    expect(attr(outline, 'stroke-dasharray')).toBe('0.02 0.01')
  })

  it('a LEGACY single-stroke layer still exports its one outline', () => {
    const l = createPathLayer({
      id: 'p1', d: 'M -0.1 -0.1 L 0.1 -0.1 L 0.1 0.1 L -0.1 0.1 Z',
      fill: 'none', stroke: '#ffffff', strokeWidth: 0.006,
    })
    const outlines = paths(pathLayersToSvgDoc([l], 1).svg).filter(p => attr(p, 'stroke'))
    expect(outlines).toHaveLength(1)
    expect(attr(outlines[0]!, 'stroke')).toBe('#ffffff')
    expect(Number(attr(outlines[0]!, 'stroke-width'))).toBeCloseTo(0.006, 6)
  })
})

describe('pathLayersToSvgDoc — what it cannot export exactly', () => {
  it('a band at a distance is written on the un-offset path AND reported, naming the layer', () => {
    const l = rectWithStrokes([{ id: 'a', paint: '#ff0000', width: 0.01, distance: 0.02, style: 'band' }])
    const { svg, notes } = pathLayersToSvgDoc([l], 1)
    const outline = paths(svg).find(p => attr(p, 'stroke'))!
    // Written at its stored width on the shape's own outline — the same `d` as the fill.
    expect(Number(attr(outline, 'stroke-width'))).toBeCloseTo(0.01, 6)
    expect(attr(outline, 'd')).toBe(attr(paths(svg)[0]!, 'd'))
    // Named by the layer the writer actually wrote: `shapeToPathLayer` mints a FRESH id
    // for the converted path (it is a new layer, not a renamed rect), so the note carries
    // that id and not the rect's.
    expect(notes.some(n => n.includes(l.id))).toBe(true)
    expect(notes.join(' ')).toMatch(/edge/i)
  })

  it('an inside/outside aligned band is reported too — SVG has no stroke alignment', () => {
    const l = rectWithStrokes([{ id: 'a', paint: '#ff0000', width: 0.01, distance: 0, align: 'outside', style: 'band' }])
    const { notes } = pathLayersToSvgDoc([l], 1)
    expect(notes.some(n => /centred|centered|alignment/i.test(n))).toBe(true)
  })

  // FINDING 6b (final review): a wobbled BAND is written as the layer's own straight `d` —
  // the wave exists on canvas only as a displaced, resampled polyline — and it used to go out
  // with no note at all, while the same arm already reports the distance and the alignment.
  // Marching shapes DO export wobbled, which makes a silently straight band the easier one to
  // miss. (Exporting the geometry itself is out of scope; saying so is not.)
  it('a wobbled band is written straight AND reported, like the distance and the alignment', () => {
    for (const [shape, word] of [['wave', /wavy/i], ['zigzag', /zigzag/i]] as const) {
      const l = rectWithStrokes([{
        id: 'a', paint: '#ff0000', width: 0.01, distance: 0, align: 'center', style: 'band',
        wobble: shape, wobbleAmount: 0.02, wobbleLength: 0.08, wobblePhase: 0,
      }])
      const { svg, notes } = pathLayersToSvgDoc([l], 1)
      // Still the shape's own outline, unchanged — this note is about honesty, not geometry.
      const outline = paths(svg).find(p => attr(p, 'stroke'))!
      expect(attr(outline, 'd')).toBe(attr(paths(svg)[0]!, 'd'))
      expect(notes.some(n => n.includes(l.id) && word.test(n)), `${shape} is reported`).toBe(true)
    }
    // A wobble the painter reads as off exports a genuinely straight band: no note.
    const off = rectWithStrokes([{
      id: 'a', paint: '#ff0000', width: 0.01, distance: 0, align: 'center', style: 'band',
      wobble: 'wave', wobbleAmount: 0, wobbleLength: 0.08,
    }])
    expect(pathLayersToSvgDoc([off], 1).notes).toEqual([])
  })

  it('a centred band at distance 0 is exact — no note at all', () => {
    const l = rectWithStrokes([{ id: 'a', paint: '#ff0000', width: 0.01, distance: 0, align: 'center', style: 'band' }])
    expect(pathLayersToSvgDoc([l], 1).notes).toEqual([])
  })

  it('a gradient stroke is flattened to one colour and says so', () => {
    const l = rectWithStrokes([{
      id: 'a', width: 0.01, distance: 0, style: 'band',
      paint: { type: 'linear', angle: 45, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff' }] },
    }])
    const { svg, notes } = pathLayersToSvgDoc([l], 1)
    const outline = paths(svg).find(p => attr(p, 'stroke'))!
    expect(attr(outline, 'stroke')).toBe('#ff0000')
    expect(notes.some(n => /colour|color/i.test(n))).toBe(true)
  })
})

describe('pathLayersToSvgDoc — shapes strokes', () => {
  // A square outline of side 0.2: perimeter 0.8, so a spacing of 0.1 on a CLOSED guide
  // asks for round(0.8 / 0.1) = 8 marks.
  const square = 'M -0.1 -0.1 L 0.1 -0.1 L 0.1 0.1 L -0.1 0.1 Z'
  const shapesLayer = (spec: Record<string, unknown>) => createPathLayer({
    id: 'p2', d: square, fill: 'none', stroke: undefined, strokeWidth: undefined,
    strokes: [{ id: 's', paint: '#00ff00', width: 0.01, distance: 0, style: 'shapes', shapes: spec }],
  } as never)

  it('emits one path per mark, each FILLED with the stroke paint and never stroked', () => {
    const { svg } = pathLayersToSvgDoc([shapesLayer({ shapeId: 'beak', size: 0.03, spacing: 0.1 })], 1)
    const marks = paths(svg).filter(p => attr(p, 'transform'))
    expect(marks).toHaveLength(8)
    for (const m of marks) {
      expect(attr(m, 'fill')).toBe('#00ff00')
      expect(attr(m, 'stroke')).toBeNull()
      expect(attr(m, 'd')).toBe(shapeById('beak')!.d)
      expect(attr(m, 'transform')).toMatch(/^matrix\(/)
    }
  })

  it('carries the library shape own fill rule, not the layer own', () => {
    const { svg } = pathLayersToSvgDoc([shapesLayer({ shapeId: 'beak', size: 0.03, spacing: 0.1 })], 1)
    const mark = paths(svg).find(p => attr(p, 'transform'))!
    expect(attr(mark, 'fill-rule')).toBe(shapeById('beak')!.fillRule)
  })

  it('an unknown or empty shape id writes nothing rather than a band', () => {
    const { svg } = pathLayersToSvgDoc([shapesLayer({ shapeId: '', size: 0.03, spacing: 0.1 })], 1)
    expect(paths(svg).filter(p => attr(p, 'stroke'))).toHaveLength(0)
    expect(paths(svg).filter(p => attr(p, 'transform'))).toHaveLength(0)
  })

  /**
   * THE WOBBLE REACHES THE FILE TOO.
   *
   * `shapeStrokeMarkMatrices` is the one seam the canvas painter and this writer both place
   * marks through, and until the fix it called `shapeStrokeGuideFit` with three positional
   * arguments — no wobble — so a marching-shapes stroke ran straight on screen AND in the
   * file while the inspector happily stored an amplitude. The canvas half is proved in
   * `tests/compositor-multi-stroke.spec.ts`; this is the writer's half, so the two cannot
   * agree only by both being wrong.
   *
   * ARITHMETIC. The square has side 0.2 and perimeter 0.8, and `d` starts at its TOP-LEFT
   * corner, so the top edge is arc length s ∈ [0, 0.2]. `wobbleLength` 0.2 divides the
   * perimeter exactly (4 cycles), so the effective wavelength is 0.2 and the top edge holds
   * exactly one cycle: a crest at s = 0.05 and a trough at s = 0.15. On a straight edge the
   * offset direction is the edge normal — purely vertical — so a mark's x is untouched and
   * its y is `-0.1 - (distance + amount·sin(2π·s/0.2))`.
   *
   * A mark's matrix carries a CONSTANT extra offset: `circle`'s ink box is [4, 4, 88, 88],
   * whose centre is not the origin, so `e`/`f` sit `s·(-48)` off the placement point in BOTH
   * axes (the box is square, so it is the same number twice). It is measured off the
   * unwobbled run rather than hardcoded, exactly as the browser test measures its own
   * antialiasing bias.
   */
  const WOB = { distance: 0.05, amount: 0.02, length: 0.2, size: 0.015, spacing: 0.02 } as const
  const wobbledShapesLayer = (wobbled: boolean) => createPathLayer({
    id: 'p4', d: square, fill: 'none', stroke: undefined, strokeWidth: undefined,
    strokes: [{
      id: 's', paint: '#00ff00', width: 0.01, distance: WOB.distance, style: 'shapes',
      shapes: { shapeId: 'circle', size: WOB.size, spacing: WOB.spacing, follow: false },
      ...(wobbled
        ? { wobble: 'wave', wobbleAmount: WOB.amount, wobbleLength: WOB.length, wobblePhase: 0 }
        : {}),
    }],
  } as never)

  /** The `e`/`f` (translation) pair of every mark, in the layer's own local units. */
  const markXY = (svg: string) => paths(svg)
    .map(p => attr(p, 'transform'))
    .filter((t): t is string => !!t)
    .map((t) => {
      const n = t.slice(t.indexOf('(') + 1, t.indexOf(')')).trim().split(/\s+/).map(Number)
      return { x: n[4]!, y: n[5]! }
    })

  it('marching shapes ride the wobbled line in the exported file, not the straight one', () => {
    // (a) The straight control: every top-edge mark on one line, `distance` above the edge.
    const flat = markXY(pathLayersToSvgDoc([wobbledShapesLayer(false)], 1).svg)
      .filter(m => m.y < -0.1 && m.x > -0.06 && m.x < 0.06)
    expect(flat.length, 'the straight stroke puts marks along the top edge').toBeGreaterThan(4)
    const flatYs = flat.map(m => m.y)
    expect(Math.max(...flatYs) - Math.min(...flatYs), 'unwobbled, they are all on one line')
      .toBeLessThan(1e-9)
    const bias = flatYs[0]! - (-0.1 - WOB.distance)

    // (b) The same stroke, wobbled. Every mark on the sine the band traces — not merely
    //     "somewhere else", which a wrong wavelength or a wrong unit would satisfy too.
    const wob = markXY(pathLayersToSvgDoc([wobbledShapesLayer(true)], 1).svg)
      .filter(m => m.y < -0.1 && m.x - bias > -0.06 && m.x - bias < 0.06)
    expect(wob.length, 'the wobbled stroke still puts marks along the top edge').toBeGreaterThan(4)
    const errs = wob.map((m) => {
      const s = (m.x - bias) + 0.1
      const predicted = -0.1 - (WOB.distance + WOB.amount * Math.sin((2 * Math.PI * s) / WOB.length))
      return m.y - (predicted + bias)
    })
    expect(Math.max(...errs.map(Math.abs)), 'every exported mark sits on the wobbled guide')
      .toBeLessThan(0.003)
    // …and they really moved by the AMOUNT, so a guide that fits the sine while barely
    // deviating cannot pass.
    const ys = wob.map(m => m.y)
    expect(Math.max(...ys) - Math.min(...ys), 'top to bottom, nearly 2 x amount')
      .toBeGreaterThan(1.5 * WOB.amount)
  })

  it('a shapes stroke at a distance needs NO note — the marks really are offset', () => {
    const near = pathLayersToSvgDoc([shapesLayer({ shapeId: 'beak', size: 0.03, spacing: 0.1 })], 1)
    const far = pathLayersToSvgDoc([createPathLayer({
      id: 'p3', d: square, fill: 'none', stroke: undefined, strokeWidth: undefined,
      strokes: [{ id: 's', paint: '#00ff00', width: 0.01, distance: 0.05, style: 'shapes', shapes: { shapeId: 'beak', size: 0.03, spacing: 0.1 } }],
    } as never)], 1)
    expect(far.notes).toEqual([])
    // And they are genuinely somewhere else: the offset ring is bigger, so it holds more marks.
    const count = (d: { svg: string }) => paths(d.svg).filter(p => attr(p, 'transform')).length
    expect(count(far)).toBeGreaterThan(count(near))
  })
})

describe('pathLayersToSvg', () => {
  it('is still the plain string form of the same document', () => {
    const l = rectWithStrokes([{ id: 'a', paint: '#ff0000', width: 0.01, distance: 0, style: 'band' }])
    expect(pathLayersToSvg([l], 1)).toBe(pathLayersToSvgDoc([l], 1).svg)
  })
})

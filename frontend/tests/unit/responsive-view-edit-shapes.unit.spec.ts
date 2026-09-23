import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer, type LocalLayer } from '~/composables/useCompositorLayers'
import { resolveLayout } from '~/lib/frame/responsive'
import { resizeLayerAtView, scaleLayerAtView, rotateLayerAtView, hitTestView, viewSelectionGeometry, moveUnitAtView, type ViewEdit } from '~/lib/frame/responsive/viewEdit'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: LocalLayer[]): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: null, motion: null,
})
const unitAt = (layers: LocalLayer[], id: string, measureCtx?: CanvasRenderingContext2D) =>
  resolveLayout(doc(layers), 3000, 500, { withBoxes: true, measureCtx }).units.get(id)!
const WH = { w: 'w', h: 'h' }

/** Apply a ViewEdit's patches and pins to the layers the way the editor will (an `undefined` pin
 *  is removed), then re-resolve at the same 3000×500 view. Returns the new layers and the result. */
function applyAndResolve(layers: LocalLayer[], e: ViewEdit, measureCtx?: CanvasRenderingContext2D) {
  const next = layers.map((l) => {
    const p = e.patches.find(x => x.id === l.id)?.patch
    let out: LocalLayer = p ? ({ ...l, ...p } as LocalLayer) : l
    if (e.pins && !e.pins.onGroup && e.pins.unitId === l.id) {
      const pins: Record<string, unknown> = { ...(l.pins ?? {}), ...e.pins.patch }
      for (const k of Object.keys(pins)) if (pins[k] === undefined) delete pins[k]
      out = { ...out, pins: Object.keys(pins).length ? pins : undefined } as LocalLayer
    }
    return out
  })
  return { layers: next, result: resolveLayout(doc(next), 3000, 500, { withBoxes: true, measureCtx }) }
}
const drawnAfter = (layers: LocalLayer[], e: ViewEdit, id: string, measureCtx?: CanvasRenderingContext2D) =>
  applyAndResolve(layers, e, measureCtx).result.boxes.get(id)!
const expectBox = (got: { x: number; y: number; w: number; h: number }, want: { x: number; y: number; w: number; h: number }) => {
  expect(got.x).toBeCloseTo(want.x, 6); expect(got.y).toBeCloseTo(want.y, 6)
  expect(got.w).toBeCloseTo(want.w, 6); expect(got.h).toBeCloseTo(want.h, 6)
}

describe('resizeLayerAtView', () => {
  it('a left-held rect widened to the right stays left-held and stores the new width', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })     // drawn 550..650 × 200..300
    const e = resizeLayerAtView(unitAt([l], 'a'), l, { x: 550, y: 200, w: 200, h: 100 }, 1000, 500, 'drop', WH)
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.15, 9)     // centre 650 → 650 − 500 = 150
    expect(e.patches[0]!.patch.w).toBeCloseTo(0.2, 9)
    expect(e.patches[0]!.patch.h).toBeCloseTo(0.1, 9)      // heights are fractions of WIDTH
    expect(e.pins!.patch).toEqual({ h: undefined, v: undefined })
  })
  it('a stretched rect widened stays stretched (the drop rule falls through to the pin it had)', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.9, h: 0.1 })     // design 50..950, drawn 550..2450
    const u = unitAt([l], 'a')
    expect(u.h.kind).toBe('both')
    const e = resizeLayerAtView(u, l, { x: 550, y: 200, w: 2000, h: 100 }, 1000, 500, 'drop', WH)
    // centred reading (1550 is within 4% of 1500) maps to −450..1550, which reads as stretched → rejected;
    // stretched maps the edges back to 50..1050, but a stretched free edge stops EDGE_GAP (0.01) inside
    // the frame (else it would bleed to the real edge): 50..999.99 → reads as stretched → accepted.
    expect(e.patches[0]!.patch.w).toBeCloseTo(0.94999, 9)     // 949.99 / 1000
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.524995, 9)    // (50 + 999.99) / 2 / 1000
    expect(e.pins!.patch.h).toBeUndefined()
    // Drawn where it was dropped — the far edge stopped at 1500 + 999.99, exactly where the drag held it.
    const drop = drawnAfter([l], e, 'a')
    expectBox(drop, { x: 550, y: 200, w: 1949.99, h: 100 })
    const drag = resizeLayerAtView(u, l, { x: 550, y: 200, w: 2000, h: 100 }, 1000, 500, 'drag', WH)
    expectBox(drawnAfter([l], drag, 'a'), drop)
  })
  it('a stretched rect narrowed hard draws on drop exactly where the last drag frame drew it (sweep)', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.9, h: 0.1 })     // design 50..950, drawn 550..2450
    const u = unitAt([l], 'a')
    for (let right = 600; right <= 2900; right += 50) {
      const box = { x: 550, y: 200, w: right - 550, h: 100 }
      const drag = drawnAfter([l], resizeLayerAtView(u, l, box, 1000, 500, 'drag', WH), 'a')
      const drop = drawnAfter([l], resizeLayerAtView(u, l, box, 1000, 500, 'drop', WH), 'a')
      expectBox(drop, drag)
      expect(drop.w).toBeGreaterThan(0)
    }
    // The re-review's case: right edge to 1000 → far maps to −500, stops at 50 + 1 → drawn 550..1551.
    // The left reading of that stopped box, 50..1051, reads stretched → rejected; the held pin is stored.
    const e = resizeLayerAtView(u, l, { x: 550, y: 200, w: 450, h: 100 }, 1000, 500, 'drop', WH)
    expect(e.patches[0]!.patch.w).toBeCloseTo(0.001, 9)
    expect(e.pins!.patch.h).toBe('both')
    expectBox(drawnAfter([l], e, 'a'), { x: 550, y: 200, w: 1001, h: 100 })
  })
  it('a stretched rect narrowed below the spare room stops at a 1 px design width (never negative)', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.9, h: 0.1 })     // design 50..950, drawn 550..2450
    const u = unitAt([l], 'a')
    const box = { x: 550, y: 200, w: 900, h: 100 }                            // right edge to 1450 → far 1450 − 1500 = −50
    const drag = resizeLayerAtView(u, l, box, 1000, 500, 'drag', WH)
    const drop = resizeLayerAtView(u, l, box, 1000, 500, 'drop', WH)
    for (const e of [drag, drop]) {
      expect(e.patches[0]!.patch.w).toBeCloseTo(0.001, 9)                     // far stops at near + 1 = 51
      expect(e.patches[0]!.patch.x).toBeCloseTo(0.0505, 9)
      expect(e.pins!.patch.h).toBe('both')                                    // 50..51 reads left → the held pin is stored
    }
    const after = drawnAfter([l], drop, 'a')
    expectBox(after, { x: 550, y: 200, w: 1001, h: 100 })                     // 550..1551: the edge stopped
    expectBox(after, drawnAfter([l], drag, 'a'))
  })
  it('a stretched edge dragged past the frame edge stops inside it, and draws where the drag held it', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.9, h: 0.1 })
    const u = unitAt([l], 'a')
    const box = { x: 550, y: 200, w: 2650, h: 100 }                           // right edge to 3200, past the 3000 view
    const drag = resizeLayerAtView(u, l, box, 1000, 500, 'drag', WH)
    const drop = resizeLayerAtView(u, l, box, 1000, 500, 'drop', WH)
    const { layers } = applyAndResolve([l], drop)
    const a = layers[0]!
    expect((a.x + a.w / 2) * 1000).toBeLessThan(1000)                         // design far < the frame's end
    expect((a.x + a.w / 2) * 1000).toBeCloseTo(999.99, 6)
    const after = drawnAfter([l], drop, 'a')
    expectBox(after, { x: 550, y: 200, w: 1949.99, h: 100 })
    expectBox(after, drawnAfter([l], drag, 'a'))
  })
  it('a bleeding side stays welded to the frame edge', () => {
    const l = createRectLayer({ id: 'bg', x: 0.5, y: 0.5, w: 1, h: 0.5 })
    const e = resizeLayerAtView(unitAt([l], 'bg'), l, { x: 0, y: 0, w: 2600, h: 500 }, 1000, 500, 'drop', WH)
    expect(e.patches[0]!.patch.w).toBeCloseTo(1, 9)
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.5, 9)
  })
  it('writes the box fields named by the caller, and no height when it is derived', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })
    const e = resizeLayerAtView(unitAt([l], 'a'), l, { x: 550, y: 200, w: 200, h: 100 }, 1000, 500, 'drop', { w: 'boxW', h: null })
    expect(e.patches[0]!.patch.boxW).toBeCloseTo(0.2, 9)
    expect('h' in e.patches[0]!.patch).toBe(false)
    expect('w' in e.patches[0]!.patch).toBe(false)
  })
  it('drag holds the pins', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })
    const e = resizeLayerAtView(unitAt([l], 'a'), l, { x: 550, y: 200, w: 200, h: 100 }, 1000, 500, 'drag', WH)
    expect(e.pins!.patch).toEqual({ h: 'left', v: 'middle' })
  })
})

describe('scaleLayerAtView', () => {
  it('scales the size fields and keeps a still-fitting pin automatic', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })     // 50..150 → ×2 → 0..200: still left
    const e = scaleLayerAtView(unitAt([l], 'a'), l, { w: 0.1, h: 0.1 }, 2, 'drop')
    expect(e.patches[0]!.patch).toEqual({ w: 0.2, h: 0.2 })
    expect(e.pins!.patch.h).toBeUndefined()
  })
  it('stores the held pin when the new size would read differently', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.5, h: 0.1 })     // 250..750 centred → ×2 → 0..1000 reads stretched
    const e = scaleLayerAtView(unitAt([l], 'a'), l, { w: 0.5, h: 0.1 }, 2, 'drop')
    expect(e.patches[0]!.patch.w).toBeCloseTo(1, 9)
    expect(e.pins!.patch.h).toBe('center')
  })
  it('clamps like the design-size scale does', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })
    const e = scaleLayerAtView(unitAt([l], 'a'), l, { w: 0.1, h: 0.1 }, 100, 'drag')
    expect(e.patches[0]!.patch).toEqual({ w: 4, h: 4 })
  })
})

describe('rotateLayerAtView', () => {
  it('writes the rotation; a rotated layer cannot stretch, so a tall result still reads centred', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.4, h: 0.1 })     // 400×100, centred
    const e = rotateLayerAtView(unitAt([l], 'a'), l, 90, { w: 400, h: 100 }, 'drop')
    expect(e.patches[0]!.patch).toEqual({ rotation: 90 })
    expect(e.pins!.patch).toEqual({ h: undefined, v: undefined })
  })
  it('rotating back to 0° judges stretch from the NEW rotation, so the drop draws where the drag did', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.9, h: 0.05, rotation: 10 })   // cannot stretch while rotated: held centre
    const u = unitAt([l], 'a')
    expect(u.h.kind).toBe('center')
    const drag = rotateLayerAtView(u, l, 0, { w: 900, h: 50 }, 'drag')
    const drop = rotateLayerAtView(u, l, 0, { w: 900, h: 50 }, 'drop')
    // At 0° the 900-wide box reads as stretched, not the held centre → the centre pin is stored.
    expect(drop.pins!.patch.h).toBe('center')
    const after = drawnAfter([l], drop, 'a')
    expect(after.x).toBeCloseTo(1050, 6); expect(after.w).toBeCloseTo(900, 6)   // centre map: 1000 + 50 .. 1000 + 950
    expectBox(after, drawnAfter([l], drag, 'a'))
  })
  it('an automatic stretched banner rotated 15° stays automatic: a rotated layer holds "both" as centred', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.8, h: 0.1 })     // 800×50, centred, span 0.8
    const u = unitAt([l], 'a')
    expect(u.h.kind).toBe('both')
    expect(u.hExplicit).toBe(false)
    const drag = rotateLayerAtView(u, l, 15, { w: 800, h: 50 }, 'drag')
    const drop = rotateLayerAtView(u, l, 15, { w: 800, h: 50 }, 'drop')
    // Rotated, it cannot stretch, so the held "both" is drawn centred — which is also what the
    // automatic reading of the rotated box gives. Nothing to store.
    expect(drop.pins!.patch).toEqual({ h: undefined, v: undefined })
    expectBox(drawnAfter([l], drop, 'a'), drawnAfter([l], drag, 'a'))
  })
})

describe('the 1 px stop and moves', () => {
  it('a zero move of a stretched hairline thinner than 1 px leaves it exactly where it was', () => {
    // h .0005 → 0.5 px tall, explicitly stretched vertically: design 249.75..250.25.
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.2, h: 0.0005, pins: { v: 'both' } })
    const e = moveUnitAtView(unitAt([l], 'a'), [l], 1000, 500, 0, 0, 'drop')
    expect(e.patches[0]!.patch.y).toBeCloseTo(0.5, 12)                        // was .5005 (grown to 1 px about near)
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.5, 12)
  })
})

describe('scaleLayerAtView at the frame edge', () => {
  it('a stretched layer scaled past the frame edge stops EDGE_GAP inside it, keeping its centre', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.9, h: 0.1 })     // design 50..950, drawn 550..2450
    const e = scaleLayerAtView(unitAt([l], 'a'), l, { w: 0.9, h: 0.1 }, 1.2, 'drop')
    // ×1.2 would be −40..1040; the ratio stops at (500 − 0.01) / 450 so the edges land at 0.01..999.99.
    const r = 499.99 / 450
    expect(e.patches[0]!.patch.w).toBeCloseTo(0.9 * r, 9)
    expect(e.patches[0]!.patch.h).toBeCloseTo(0.1 * r, 9)
    expect(e.pins!.patch.h).toBeUndefined()
    const after = drawnAfter([l], e, 'a')
    expect(after.x).toBeCloseTo(500.01, 6); expect(after.x + after.w).toBeCloseTo(2499.99, 6)
  })
})

describe('re-wrapped text', () => {
  // 10 px per character, whatever the font.
  const ctx = { font: '', letterSpacing: '0px', fontKerning: 'auto', measureText: (s: string) => ({ width: s.length * 10 }) } as unknown as CanvasRenderingContext2D
  it('a width-only drag leaves the design-size y and box height alone, and draws its width where dropped', () => {
    const word = 'a'.repeat(40)
    const l = createTextLayer({ id: 't', text: `${word} ${word} ${word}`, x: 0.5, y: 0.2, boxW: 0.85, fontSize: 0.08, lineHeight: 1.2 })
    const u = unitAt([l], 't', ctx)
    expect(u.h.kind).toBe('both')
    expect(u.viewBox.h).toBeLessThan(u.mappedBox.h)                           // fewer lines at the wide view
    const vb = u.viewBox
    const box = { x: vb.x, y: vb.y, w: vb.w - 125, h: vb.h }
    const e = resizeLayerAtView(u, l, box, 1000, 500, 'drop', { w: 'boxW', h: 'boxH' })
    const p = e.patches[0]!.patch
    expect(p.y).toBeCloseTo(0.2, 9)
    expect('boxH' in p).toBe(false)
    expect(p.boxW as number).toBeLessThan(0.85)
    const after = drawnAfter([l], e, 't', ctx)
    expect(after.x).toBeCloseTo(box.x, 6); expect(after.w).toBeCloseTo(box.w, 6)
  })
  it('centred: a width-only drag keeps the design-size y and writes no box height', () => {
    const word = 'a'.repeat(40)
    const l = createTextLayer({ id: 't', text: `${word} ${word} ${word}`, x: 0.5, y: 0.5, boxW: 0.85, fontSize: 0.08, lineHeight: 1.2 })
    const u = unitAt([l], 't', ctx)
    expect(u.v.kind).toBe('center')
    expect(u.viewBox.h).toBeLessThan(u.mappedBox.h)                           // drawn = re-wrapped
    const vb = u.viewBox
    const e = resizeLayerAtView(u, l, { x: vb.x, y: vb.y, w: vb.w - 125, h: vb.h }, 1000, 500, 'drop', { w: 'boxW', h: 'boxH' })
    const p = e.patches[0]!.patch
    expect(p.y).toBeCloseTo(0.5, 9)
    expect('boxH' in p).toBe(false)
  })
  it('centred: a top-handle drag from the drawn box is drawn where it was dropped', () => {
    const word = 'a'.repeat(40)
    const l = createTextLayer({ id: 't', text: `${word} ${word} ${word}`, x: 0.5, y: 0.5, boxW: 0.85, fontSize: 0.08, lineHeight: 1.2 })
    const u = unitAt([l], 't', ctx)
    const vb = u.viewBox
    const box = { x: vb.x, y: vb.y - 10, w: vb.w, h: vb.h + 10 }               // top edge up 10 view px
    const e = resizeLayerAtView(u, l, box, 1000, 500, 'drop', { w: 'boxW', h: 'boxH' })
    expect(e.patches[0]!.patch.boxH as number).toBeCloseTo(box.h / 1000, 9)   // from the DRAWN height
    expectBox(drawnAfter([l], e, 't', ctx), box)
  })
})

describe('hitTestView', () => {
  const boxes = new Map([['a', { x: 0, y: 0, w: 100, h: 100 }], ['b', { x: 50, y: 50, w: 100, h: 100 }]])
  it('returns the topmost box under the point, with padding', () => {
    expect(hitTestView(boxes, ['b', 'a'], 60, 60, 0)).toBe('b')
    expect(hitTestView(boxes, ['b', 'a'], 10, 10, 0)).toBe('a')
    expect(hitTestView(boxes, ['b', 'a'], 158, 60, 8)).toBe('b')
    expect(hitTestView(boxes, ['b', 'a'], 159, 60, 8)).toBeNull()
    expect(hitTestView(boxes, ['b', 'a'], 500, 500, 8)).toBeNull()
  })
})

describe('viewSelectionGeometry', () => {
  it('an unrotated layer uses its drawn box, scaled to canvas px', () => {
    const l = createRectLayer({ id: 'a', x: 0.1, y: 0.5, w: 0.1, h: 0.1 })     // drawn 550..650 × 200..300
    const g = viewSelectionGeometry(unitAt([l], 'a'), 0, { w: 100, h: 100 }, 0.2)
    expect(g.cx).toBeCloseTo(120, 9); expect(g.cy).toBeCloseTo(50, 9)
    expect(g.hw).toBeCloseTo(10, 9); expect(g.hh).toBeCloseTo(10, 9); expect(g.rot).toBe(0)
  })
  it('a rotated layer uses its own size × the fit scale, rotated', () => {
    const l = createRectLayer({ id: 'a', x: 0.5, y: 0.5, w: 0.2, h: 0.1, rotation: 30 })
    const g = viewSelectionGeometry(unitAt([l], 'a'), 30, { w: 200, h: 100 }, 0.2)
    expect(g.hw).toBeCloseTo(20, 9); expect(g.hh).toBeCloseTo(10, 9); expect(g.rot).toBe(30)
  })
})

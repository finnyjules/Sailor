import { describe, it, expect } from 'vitest'
import { createRectLayer, type LocalLayer } from '~/composables/useCompositorLayers'
import { resolveLayout } from '~/lib/frame/responsive'
import { resizeLayerAtView, scaleLayerAtView, rotateLayerAtView, hitTestView, viewSelectionGeometry } from '~/lib/frame/responsive/viewEdit'
import type { FrameDoc } from '~/lib/frame/responsive/types'

const doc = (layers: LocalLayer[]): FrameDoc => ({
  responsive: true, designW: 1000, designH: 500, layers, stackOrder: layers.map(l => `l:${l.id}`),
  groups: [], grid: null, motion: null,
})
const unitAt = (layers: LocalLayer[], id: string) =>
  resolveLayout(doc(layers), 3000, 500, { withBoxes: true }).units.get(id)!
const WH = { w: 'w', h: 'h' }

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
    // stretched maps the edges back to 50..1050 → reads as stretched → accepted.
    expect(e.patches[0]!.patch.w).toBeCloseTo(1.0, 9)
    expect(e.patches[0]!.patch.x).toBeCloseTo(0.55, 9)
    expect(e.pins!.patch.h).toBeUndefined()
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

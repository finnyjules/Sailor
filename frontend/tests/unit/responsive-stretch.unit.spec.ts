import { describe, it, expect } from 'vitest'
import { createRectLayer, createTextLayer, createImageLayer } from '~/composables/useCompositorLayers'
import { placeLayer, textNaturalHeightPx } from '~/lib/frame/responsive/stretch'

const W = 2000, H = 1000, k = 0.5   // e.g. design 1000 wide fitted ×1 into a 2000 box → k = 0.5

describe('placeLayer', () => {
  it('position only: writes x/y, keeps every size field, new object', () => {
    const r = createRectLayer({ w: 0.2, h: 0.1 })
    const out = placeLayer(r, { cx: 1500, cy: 250 }, W, H, k, null)
    expect(out).not.toBe(r)
    expect(out.x).toBe(0.75); expect(out.y).toBe(0.25)
    expect((out as any).w).toBe(0.2); expect((out as any).h).toBe(0.1)
  })
  it('returns the same reference when nothing changes', () => {
    const r = createRectLayer({ x: 0.75, y: 0.25 })
    expect(placeLayer(r, { cx: 1500, cy: 250 }, W, H, k, null)).toBe(r)
  })
  it('a stretched rect gets the target size in stored units (T / (W·k)); radius untouched', () => {
    const r = createRectLayer({ w: 0.2, h: 0.1, radius: 0.02 })
    const out = placeLayer(r, { cx: 1000, cy: 500, w: 1800, h: 100 }, W, H, k, null) as any
    expect(out.w).toBeCloseTo(1.8, 9)      // 1800 / (2000 × 0.5)
    expect(out.h).toBeCloseTo(0.1, 9)
    expect(out.radius).toBe(0.02)
  })
  it('a stretched image is never distorted: it covers the box and gets a crop', () => {
    const img = createImageLayer('a.png', 2, { w: 0.4 })   // aspect 2 ⇒ h = 0.2
    const out = placeLayer(img, { cx: 1000, cy: 500, w: 1800, h: 300 }, W, H, k, null) as any
    // box in stored units: 1.8 × 0.3; image aspect 2 ⇒ cover ⇒ w = 1.8, h = 0.9 (too tall) → crop
    expect(out.w).toBeCloseTo(1.8, 9)
    expect(out.h).toBeCloseTo(0.9, 9)
    // The crop mask is applied in CANVAS space (before the painter's layout scale k),
    // so its w/h are plain canvas fractions: 1800/2000 and 300/2000.
    expect(out.mask).toEqual({ kind: 'rect', x: 0.5, y: 0.5, w: 0.9, h: 0.15 })
  })
  it('an image whose box is taller than its aspect covers by height', () => {
    const img = createImageLayer('a.png', 2, { w: 0.4 })
    const out = placeLayer(img, { cx: 1000, cy: 500, w: 200, h: 600 }, W, H, k, null) as any
    expect(out.h).toBeCloseTo(0.6, 9)
    expect(out.w).toBeCloseTo(1.2, 9)
  })
  it('a boxed text layer stretches its boxW; fontSize untouched', () => {
    const t = createTextLayer({ boxW: 0.3, fontSize: 0.05 })
    const out = placeLayer(t, { cx: 1000, cy: 500, w: 1500 }, W, H, k, null) as any
    expect(out.boxW).toBeCloseTo(1.5, 9)
    expect(out.fontSize).toBe(0.05)
  })
})

describe('textNaturalHeightPx', () => {
  const measure = (charPx: number) => ({
    measureText: (s: string) => ({ width: s.length * charPx }),
    set font(_v: string) {},
    letterSpacing: '0px', fontKerning: 'normal',
  } as unknown as CanvasRenderingContext2D)
  it('counts wrapped lines × line height at the design width', () => {
    // fontSize 0.05 of W0=1000 → 50px; 10px per char; box 300px → 30 chars per line
    const t = createTextLayer({ text: 'a'.repeat(25) + ' ' + 'b'.repeat(25), fontSize: 0.05, lineHeight: 1.2, boxW: 0.3 })
    expect(textNaturalHeightPx(t, 300, measure(10), 1000)).toBe(2 * 50 * 1.2)
    expect(textNaturalHeightPx(t, 600, measure(10), 1000)).toBe(1 * 50 * 1.2)
  })
})

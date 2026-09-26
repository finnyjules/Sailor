// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { hasAnimatedShaderFill, brushMaterialPad, brushMaterialPadPx, brushMaterialOf, cornerPinPadPx, silhouettePadPx, createBrushLayer, localLayerBox } from '~/composables/useCompositorLayers'
import { NEON_HALO_UNITS } from '~/lib/brushTips/engine'
const item = (layer: any) => ({ type: 'local', layer }) as any
describe('brush material layer', () => {
  it('a moving material needs the clock, a still one does not', () => {
    expect(hasAnimatedShaderFill([item(createBrushLayer({ material: { id: 'lava', moving: true } } as any))])).toBe(true)
    expect(hasAnimatedShaderFill([item(createBrushLayer({ material: { id: 'lava', moving: false } } as any))])).toBe(false)
    expect(hasAnimatedShaderFill([item(createBrushLayer())])).toBe(false)
  })
  it('neon grows the bounds for its glow', () => {
    expect(brushMaterialPad(createBrushLayer({ material: { id: 'neon', moving: true } } as any))).toBeGreaterThan(0)
    expect(brushMaterialPad(createBrushLayer({ material: { id: 'foil', moving: true } } as any))).toBe(0)
  })
  it('a neon material never grows localLayerBox — resize maths reads the unpadded box', () => {
    const strokes = [{ points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.3 }], radius: 0.01, hardness: 1, opacity: 1, erase: false }] as any
    const plain = createBrushLayer({ strokes, w: 0.22 })
    const neon = createBrushLayer({ strokes, w: 0.22, material: { id: 'neon', moving: true } } as any)
    expect(localLayerBox(null, neon, 1000, 1000)).toEqual(localLayerBox(null, plain, 1000, 1000))
  })
  it('an unknown material id renders, pads and ticks exactly like Colour', () => {
    const gold = createBrushLayer({ material: { id: 'gold', moving: true } } as any)
    expect(brushMaterialOf(gold)).toBeUndefined()
    expect(brushMaterialPad(gold)).toBe(0)
    expect(brushMaterialPadPx(gold, 1000)).toBe(0)
    expect(hasAnimatedShaderFill([item(gold)])).toBe(false)
    expect(brushMaterialOf(createBrushLayer({ material: { id: 'lava', moving: false } } as any))).toEqual({ id: 'lava', moving: false })
  })
  it('the neon halo pads every box-sized offscreen, in logical px at the keep-proportions scale', () => {
    const strokes = [{ points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.3 }], radius: 0.01, hardness: 1, opacity: 1, erase: false }] as any
    const plain = createBrushLayer({ strokes, w: 0.22 })
    const nw = localLayerBox(null, plain, 1000, 1000).w / 1000 // natural width at scale 1
    const neon = createBrushLayer({ strokes, w: nw * 2, material: { id: 'neon', moving: false } } as any)
    const want = (NEON_HALO_UNITS / 1080) * 1000 * 2
    expect(brushMaterialPadPx(neon, 1000)).toBeCloseTo(want, 6)
    const plain2 = createBrushLayer({ strokes, w: nw * 2 })
    expect(cornerPinPadPx(neon, 1000) - cornerPinPadPx(plain2, 1000)).toBeCloseTo(want, 6)
    const box = localLayerBox(null, plain2, 1000, 1000)
    expect(silhouettePadPx(neon, 1000, 1, box) - silhouettePadPx(plain2, 1000, 1, box)).toBeCloseTo(want, 6)
    // every other material, and no material: 0 — byte-identical pads
    const foil = createBrushLayer({ strokes, w: nw * 2, material: { id: 'foil', moving: false } } as any)
    expect(brushMaterialPadPx(foil, 1000)).toBe(0)
    expect(cornerPinPadPx(foil, 1000)).toBe(cornerPinPadPx(plain2, 1000))
  })
  it('a still material hides a moving shader fill — no clock; legacy strokes still wear it', () => {
    const movingFill = { a: '#fff', b: '#000', density: 1, type: 'shader', shader: { speed: 1, anchor: 'object' } } as any
    const tip = { tip: 'round', v: 1, size: 0.02, settings: {}, seed: 1, pts: [0.2, 0.3, 0] }
    const legacy = { points: [{ x: 0.2, y: 0.3 }], radius: 0.01, hardness: 1, opacity: 1, erase: false }
    const probe = createBrushLayer({ strokes: [tip], fill: movingFill } as any)
    // control: the fill counts as live on a plain layer, or the rest proves nothing
    expect(hasAnimatedShaderFill([item(probe)])).toBe(true)
    expect(hasAnimatedShaderFill([item(createBrushLayer({ strokes: [tip], fill: movingFill, material: { id: 'lava', moving: false } } as any))])).toBe(false)
    expect(hasAnimatedShaderFill([item(createBrushLayer({ strokes: [legacy, tip], fill: movingFill, material: { id: 'lava', moving: false } } as any))])).toBe(true)
    expect(hasAnimatedShaderFill([item(createBrushLayer({ strokes: [tip], fill: movingFill, material: { id: 'gold', moving: false } } as any))])).toBe(true)
  })
})

// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { hasAnimatedShaderFill, brushMaterialPad, createBrushLayer, localLayerBox } from '~/composables/useCompositorLayers'
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
})

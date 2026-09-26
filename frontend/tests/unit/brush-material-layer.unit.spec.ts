// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { hasAnimatedShaderFill, brushMaterialPad, createBrushLayer } from '~/composables/useCompositorLayers'
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
})

import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyResolvedValue } from '~/lib/motionx/adapter/frame'
import type { GradientStop } from '~/lib/color/harmony'

const grad = () => ({ type: 'linear' as const, angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ff0000' }] })
const layer = (over: Partial<any> = {}) => ({ id: 'L1', x: 0.5, y: 0.5, rotation: 0, scale: 1, opacity: 1, fill: grad(), effects: [], ...over } as unknown as LocalLayer)

describe('applyResolvedValue', () => {
  it('sets a transform/opacity number field on a clone', () => {
    const out = applyResolvedValue(layer(), 'opacity', 0.4)
    expect((out as any).opacity).toBe(0.4)
    expect(out).not.toBe(layer())
  })
  it('fill gradient value rebuilds the fill (offset shape, type/angle kept)', () => {
    const stops: GradientStop[] = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]
    const out = applyResolvedValue(layer(), 'fill', stops) as any
    expect(out.fill.type).toBe('linear'); expect(out.fill.stops[0]).toHaveProperty('offset')
  })
  it('fill.phase scrolls the gradient stops', () => {
    const out = applyResolvedValue(layer(), 'fill.phase', 0.25) as any
    expect(out.fill.stops.length).toBeGreaterThan(2) // scrolled wheel resample
  })
  it('unknown prop returns the input unchanged', () => {
    const l = layer(); expect(applyResolvedValue(l, 'nope', 1)).toBe(l)
  })
})

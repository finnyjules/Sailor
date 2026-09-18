import { describe, it, expect } from 'vitest'
import { interpolateValue } from '~/lib/motionx/interpolate'
import type { GradientStop } from '~/lib/color/harmony'

describe('interpolateValue', () => {
  it('number lerps', () => {
    expect(interpolateValue('number', 0, 10, 0.5)).toBeCloseTo(5, 6)
  })
  it('color mixes with exact endpoints', () => {
    expect(interpolateValue('color', '#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(interpolateValue('color', '#ff0000', '#0000ff', 1)).toBe('#0000ff')
    expect(interpolateValue('color', '#ff0000', '#0000ff', 0.5)).not.toBe('#ff0000')
  })
  it('gradient crossfade/travel returns a stop array', () => {
    const A: GradientStop[] = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
    const B: GradientStop[] = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]
    const c = interpolateValue('gradient', A, B, 0.5, { mode: 'crossfade' }) as GradientStop[]
    expect(Array.isArray(c)).toBe(true)
    const tr = interpolateValue('gradient', A, B, 0.5, { mode: 'travel' }) as GradientStop[]
    expect(Array.isArray(tr)).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyResolvedValue, applyMotionxTracks, frameTarget, animatableProperties } from '~/lib/motionx/adapter/frame'
import type { GradientStop } from '~/lib/color/harmony'
import type { Track } from '~/lib/motionx'

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

describe('applyMotionxTracks', () => {
  const opacityTrack: Track = { path: 'layers.L1.opacity', type: 'number', keyframes: [
    { t: 0, value: 0, ease: 'linear' }, { t: 1, value: 1, ease: 'linear' } ] }
  it('same reference when idle', () => {
    const arr = [layer()]
    expect(applyMotionxTracks(arr, undefined, 0)).toBe(arr)
    expect(applyMotionxTracks(arr, [], 0)).toBe(arr)
  })
  it('applies a resolved value onto the targeted layer', () => {
    const out = applyMotionxTracks([layer()], [opacityTrack], 0.5)
    expect((out[0] as any).opacity).toBeCloseTo(0.5, 6)
  })
  it('leaves non-targeted layers by identity', () => {
    const other = layer({ id: 'L2' })
    const out = applyMotionxTracks([layer(), other], [opacityTrack], 0.5)
    expect(out[1]).toBe(other)
  })
})

describe('frameTarget + animatableProperties', () => {
  it('target reads current values', () => {
    const tg = frameTarget(layer({ opacity: 0.7 }))
    expect(tg.get('opacity')).toBe(0.7)
    expect(Array.isArray(tg.get('fill'))).toBe(true) // gradient -> {pos,color}[]
    expect(tg.get('nope')).toBeUndefined()
  })
  it('enumerates transform + fill properties for a gradient-filled layer', () => {
    const paths = animatableProperties(layer()).map(p => p.path)
    expect(paths).toContain('layers.L1.opacity')
    expect(paths).toContain('layers.L1.fill')
    expect(paths).toContain('layers.L1.fill.phase')
  })
  it('tags every property with a group (Transform / Fill / Effects)', () => {
    const props = animatableProperties(layer())
    expect(props.find(p => p.path === 'layers.L1.x')!.group).toBe('Transform')
    expect(props.find(p => p.path === 'layers.L1.fill')!.group).toBe('Fill')
    expect(props.every(p => ['Transform', 'Fill', 'Effects'].includes(p.group))).toBe(true)
  })
  it('enumerates every number/colour/gradient effect dial, with range, skipping enum/bool dials', () => {
    const l = layer({ effects: [{ id: 'fx1', type: 'bloom', threshold: 0.5, radius: 0.1, intensity: 1 }] })
    const props = animatableProperties(l)
    const intensity = props.find(p => p.path === 'layers.L1.effects.fx1.intensity')!
    expect(intensity).toMatchObject({ type: 'number', group: 'Effects', min: 0, max: 2 })
    expect(intensity.label).toMatch(/Bloom .* Intensity/i)
    expect(props.filter(p => p.group === 'Effects')).toHaveLength(3)   // threshold, radius, intensity
  })
})

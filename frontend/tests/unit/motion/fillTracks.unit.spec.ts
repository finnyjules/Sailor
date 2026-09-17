import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { EffectDialTrack } from '~/lib/motion/effectTracks'
import { fillDialTargets, applyFillPhaseTracks, applyFillTracks } from '~/lib/motion/fillTracks'

const grad = () => ({ type: 'linear' as const, angle: 0, stops: [
  { offset: 0, color: '#1436ff' }, { offset: 0.5, color: '#ff2d2d' }, { offset: 1, color: '#ffd21f' },
] })
const layer = (over: Partial<LocalLayer> = {}) => ({ id: 'L1', fill: grad(), ...over } as unknown as LocalLayer)

describe('fillDialTargets', () => {
  it('emits phase + gradient targets only for a gradient fill', () => {
    expect(fillDialTargets(layer())).toEqual([
      { path: 'layers.L1.fill.phase', label: 'Fill · Scroll', kind: 'number', min: 0, max: 1, effectId: '', dialKey: 'phase' },
      { path: 'layers.L1.fill', label: 'Fill · Gradient', kind: 'gradient', effectId: '', dialKey: 'fill' },
    ])
    expect(fillDialTargets(layer({ fill: '#ff0000' } as any))).toEqual([])
  })
})

describe('applyFillPhaseTracks', () => {
  const track = (kfs: { t: number; v: number }[]): EffectDialTrack => ({ target: 'layers.L1.fill.phase', keyframes: kfs })

  it('returns the SAME reference when there are no tracks', () => {
    const arr = [layer()]
    expect(applyFillPhaseTracks(arr, undefined, 0)).toBe(arr)
    expect(applyFillPhaseTracks(arr, [], 0)).toBe(arr)
  })
  it('rewrites the gradient fill at the evaluated phase', () => {
    const arr = [layer()]
    const out = applyFillPhaseTracks(arr, [track([{ t: 0, v: 0 }, { t: 1, v: 1 }])], 0.5)
    expect(out).not.toBe(arr)
    const fill = (out[0] as any).fill
    expect(fill.type).toBe('linear')
    expect(fill.stops.length).toBeGreaterThan(3) // resampled wheel
    expect(out[0]).not.toBe(arr[0]) // cloned
  })
  it('leaves non-targeted layers by identity', () => {
    const other = layer({ id: 'L2' })
    const arr = [layer(), other]
    const out = applyFillPhaseTracks(arr, [track([{ t: 0, v: 0.3 }])], 0)
    expect(out[1]).toBe(other)
  })
})

describe('applyFillTracks — gradient keyframes', () => {
  const gradFill = () => ({ type: 'linear' as const, angle: 30, stops: [
    { offset: 0, color: '#000000' }, { offset: 1, color: '#ff0000' },
  ] })
  const gradLayer = () => ({ id: 'L1', fill: gradFill() } as any)
  const A = [{ pos: 0, color: '#000000' }, { pos: 1, color: '#ff0000' }]
  const B = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]

  it('folds a gradient fill track onto layer.fill, keeping type + angle', () => {
    const track = { target: 'layers.L1.fill', mode: 'crossfade' as const, keyframes: [{ t: 0, v: A }, { t: 1, v: B }] }
    const out = applyFillTracks([gradLayer()], [track], 0.5)
    const fill = (out[0] as any).fill
    expect(fill.type).toBe('linear')
    expect(fill.angle).toBe(30)
    expect(fill.stops[0]).toHaveProperty('offset')
    expect(fill.stops.length).toBeGreaterThan(2) // resolved crossfade stops
  })
  it('returns same reference when idle', () => {
    const arr = [gradLayer()]
    expect(applyFillTracks(arr, undefined, 0)).toBe(arr)
  })
})

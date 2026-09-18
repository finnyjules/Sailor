import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { compileBehaviourForLayer, applyMotionxTracks } from '~/lib/motionx/adapter/frame'

const grad = () => ({ type: 'linear' as const, angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ff0000' }] })
const layer = () => ({ id: 'L1', x: 0.5, y: 0.5, rotation: 0, scale: 1, opacity: 1, fill: grad(), effects: [] } as unknown as LocalLayer)

describe('motionx author pipeline (behaviour -> compile-for-layer -> fold -> animated layer)', () => {
  it('fade in animates opacity through the fold', () => {
    const tracks = compileBehaviourForLayer(layer(), { id: 'f', kind: 'fade', timing: { start: 0, duration: 2 }, params: { dir: 'in' } })
    expect(tracks[0]!.path).toBe('layers.L1.opacity')
    expect((applyMotionxTracks([layer()], tracks, 0)[0] as any).opacity).toBe(0)
    const mid = (applyMotionxTracks([layer()], tracks, 1)[0] as any).opacity
    expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(1)
    expect((applyMotionxTracks([layer()], tracks, 2)[0] as any).opacity).toBe(1)
  })
  it('gradient scroll animates the fill through the fold', () => {
    const tracks = compileBehaviourForLayer(layer(), { id: 's', kind: 'gradientScroll', timing: { start: 0, duration: 2, loop: true } })
    expect(tracks[0]!.path).toBe('layers.L1.fill.phase')
    const out = applyMotionxTracks([layer()], tracks, 1) // phase 0.5
    expect((out[0] as any).fill.stops.length).toBeGreaterThan(2) // scrolled wheel resample
  })
})

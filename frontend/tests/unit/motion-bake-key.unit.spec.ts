import { describe, it, expect } from 'vitest'
import { motionSourceKey } from '../../app/lib/motion/bake'
import { createTextLayer } from '../../app/composables/useCompositorLayers'

describe('motionSourceKey', () => {
  const layers = [createTextLayer({ text: 'HELLO' })]
  const motion = { fps: 30, duration: 4 }
  it('is deterministic', () => {
    expect(motionSourceKey(layers, motion, 1280, 720)).toBe(motionSourceKey(layers, motion, 1280, 720))
  })
  it('changes when anything that affects pixels changes', () => {
    const base = motionSourceKey(layers, motion, 1280, 720)
    expect(motionSourceKey([{ ...layers[0], text: 'WORLD' }], motion, 1280, 720)).not.toBe(base)
    expect(motionSourceKey(layers, { fps: 24, duration: 4 }, 1280, 720)).not.toBe(base)
    expect(motionSourceKey(layers, motion, 1920, 1080)).not.toBe(base)
  })
  it('hashes the lighting record only while the Frame has a light layer', () => {
    const lamp = { id: 'lp', kind: 'light', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
      light: { type: 'lamp', height: 0.55, color: '#ffb36b', brightness: 1.6, reach: 1, aimX: 0.5, aimY: 0.5, cone: 0.35, edge: 0.5 } } as never
    const lit = [...layers, lamp]
    const a = { darkness: 0.45, backgroundLit: true }
    // A Darkness edit marks a lit Frame's bake stale…
    expect(motionSourceKey(lit, motion, 1280, 720, a)).not.toBe(motionSourceKey(lit, motion, 1280, 720, { ...a, darkness: 0.8 }))
    expect(motionSourceKey(lit, motion, 1280, 720, a)).not.toBe(motionSourceKey(lit, motion, 1280, 720, { ...a, backgroundLit: false }))
    // …while a light-less Frame keeps the key it had before lighting existed.
    expect(motionSourceKey(layers, motion, 1280, 720, a)).toBe(motionSourceKey(layers, motion, 1280, 720))
    expect(motionSourceKey(layers, motion, 1280, 720, { ...a, darkness: 0.8 })).toBe(motionSourceKey(layers, motion, 1280, 720))
  })
})

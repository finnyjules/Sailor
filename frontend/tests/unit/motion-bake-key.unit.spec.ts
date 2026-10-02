import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { motionSourceKey, bakeSourceKey } from '../../app/lib/motion/bake'
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
  it('the bake and the stale check compute the same key for a lit Frame', () => {
    const lamp = { id: 'lp', kind: 'light', x: 0.5, y: 0.5, rotation: 0, opacity: 1,
      light: { type: 'lamp', height: 0.55, color: '#ffb36b', brightness: 1.6, reach: 1, aimX: 0.5, aimY: 0.5, cone: 0.35, edge: 0.5 } } as never
    const lit = [...layers, lamp]
    const doc = { lighting: { darkness: 0.45, backgroundLit: true } }
    // The key bakeAndUpload stores: the doc's lighting is in it.
    const stored = bakeSourceKey(lit, motion, 1280, 720, doc)
    expect(stored).toBe(motionSourceKey(lit, motion, 1280, 720, doc.lighting))
    // Recomputed from the same doc ⇒ fresh; after a Darkness edit ⇒ stale.
    expect(bakeSourceKey(lit, motion, 1280, 720, { ...doc })).toBe(stored)
    expect(bakeSourceKey(lit, motion, 1280, 720, { lighting: { ...doc.lighting, darkness: 0.9 } })).not.toBe(stored)
    // Both call sites go through bakeSourceKey with the painter's doc — never the bare key.
    const bake = readFileSync(resolve(__dirname, '../../app/lib/motion/bake.ts'), 'utf8')
    expect(bake).toMatch(/source_key: bakeSourceKey\(localLayers, motion, W, H, doc\)/)
    const modal = readFileSync(resolve(__dirname, '../../app/components/vue-canvas/CompositorModal.vue'), 'utf8')
    expect(modal).toMatch(/stored\.source_key !== bakeSourceKey\([^\n]*frameDocPaint\(\)\)/)
    expect(modal).not.toMatch(/motionSourceKey\(/)
  })
})

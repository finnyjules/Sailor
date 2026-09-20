import { describe, it, expect } from 'vitest'
import { shaderSpecFromEffect } from '~/composables/useCompositorLayers'
import type { ShaderPixelEffect } from '~/lib/compositor/effectStack'

/**
 * F5 Task 2 — the pure mapping from a stored `shader` layer effect to the `ShaderSpec`
 * `renderFieldWithBase` (~/lib/shaderfill/field.ts) needs to run the catalog effect.
 *
 * Only effectId/params/speed/seed are ever dereferenced by `resolve()`/`buildPasses()` on
 * the `renderFieldWithBase` path — `anchor`/`input`/`readsBackdrop`/`readsLayerKey` are
 * fill-only fields on `ShaderSpec` with no equivalent for a pass over a layer's own
 * pixels. This is the one pure, canvas-free piece of `applyShaderPixelEffect`; the
 * surrounding canvas recombine needs a real GPU context and is covered by the live
 * Playwright gate (compositor-layer-effects.spec.ts).
 */
describe('shaderSpecFromEffect', () => {
  const effect: ShaderPixelEffect = {
    type: 'shader', id: 'sh1', visible: true,
    effectId: 'chromatic_aberration', params: { amount: 0.3 }, speed: 1, seed: 42,
  }

  it('carries effectId/params/speed/seed straight through', () => {
    const spec = shaderSpecFromEffect(effect)
    expect(spec.effectId).toBe('chromatic_aberration')
    expect(spec.params).toEqual({ amount: 0.3 })
    expect(spec.speed).toBe(1)
    expect(spec.seed).toBe(42)
  })

  it('params is the SAME reference, not a defensive clone (no reason to copy a plain pass-through)', () => {
    const spec = shaderSpecFromEffect(effect)
    expect(spec.params).toBe(effect.params)
  })

  it('is a pure function of its input: two calls on equal-but-distinct effects yield equal specs', () => {
    const a = shaderSpecFromEffect({ type: 'shader', visible: true, effectId: 'fbm_warp', params: { scale: 2 }, speed: 0.5, seed: 7 })
    const b = shaderSpecFromEffect({ type: 'shader', visible: true, effectId: 'fbm_warp', params: { scale: 2 }, speed: 0.5, seed: 7 })
    expect(a).toEqual(b)
  })
})

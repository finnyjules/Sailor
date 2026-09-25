// frontend/tests/unit/shaderstudio-passes.unit.spec.ts
import { describe, expect, it } from 'vitest'
import { composePasses } from '~/lib/shaderstudio/passes'
import { defaultConfig, defaultMask } from '~/lib/shaderstudio/types'
import { MASK_SHAPE_IDX } from '~/lib/shaderstudio/mask'
import type { EffectDef } from '~/lib/shaderfx/types'

const fakeEffect: EffectDef = {
  id: 'halftone', name: 'Halftone', category: 'stylize', animated: false, passes: 1,
  centerParam: null, textures: [],
  params: [{ uniform: 'u_size', label: 'Size', type: 'float', min: 1, max: 10, default: 4, step: 1 }],
  source: 'EFFECT_SRC',
}

// composePasses now takes a resolveDef: (id) => EffectDef | null. For configs with no
// enabled effect the loop never calls it, so `() => null` is a safe stand-in there.
const noDef = () => null

describe('composePasses', () => {
  it('returns [] when nothing is enabled and no effect picked', () => {
    const c = defaultConfig() // effects[0].id '' , all stages disabled
    expect(composePasses(c, noDef, 0)).toEqual([])
  })

  it('includes the effect pass with resolved uniforms when enabled', () => {
    const c = defaultConfig()
    c.effects = [{ layerId: 'L0', id: 'halftone', params: { u_size: 6 }, enabled: true, blend: 'normal', opacity: 1 }]
    const passes = composePasses(c, () => fakeEffect, 0.5)
    expect(passes).toHaveLength(1)
    expect(passes[0]!.id).toBe('halftone')
    expect(passes[0]!.uniforms.u_size).toBe(6)
    expect(passes[0]!.uniforms.u_time).toBe(0.5)
    expect(passes[0]!.uniforms.u_hasInput).toBe(1)
  })

  it('hands every effect the host’s loop length as u_loop (0 when the host has none)', () => {
    const c = defaultConfig()
    c.effects = [{ layerId: 'L0', id: 'halftone', params: {}, enabled: true, blend: 'normal', opacity: 1 }]
    expect(composePasses(c, () => fakeEffect, 0.5, undefined, 6)[0]!.uniforms.u_loop).toBe(6)
    expect(composePasses(c, () => fakeEffect, 0.5)[0]!.uniforms.u_loop).toBe(0)
  })

  it('appends duotone/adjust/blur/chromatic in order, splitting colors to _r/_g/_b', () => {
    const c = defaultConfig()
    c.duotone = { enabled: true, ink: '#000000', paper: '#ffffff' }
    c.adjust.enabled = true
    c.post.blur.enabled = true
    c.post.chromatic.enabled = true
    const passes = composePasses(c, noDef, 0) // no effect
    expect(passes.map(p => p.id)).toEqual(['studio:duotone', 'studio:adjust', 'studio:blur', 'studio:chromatic'])
    const duo = passes[0]!
    expect(duo.uniforms.u_ink_r).toBe(0)
    expect(duo.uniforms.u_paper_r).toBe(1)
  })

  it('appends bloom last with its uniforms when enabled', () => {
    const c = defaultConfig()
    c.post.chromatic.enabled = true
    c.post.bloom = { enabled: true, threshold: 0.6, intensity: 1.2, radius: 80 }
    const passes = composePasses(c, noDef, 0)
    expect(passes.map(p => p.id)).toEqual(['studio:chromatic', 'studio:bloom'])
    const bloom = passes[passes.length - 1]!
    expect(bloom.uniforms.u_threshold).toBe(0.6)
    expect(bloom.uniforms.u_intensity).toBe(1.2)
    expect(bloom.uniforms.u_radius).toBe(80)
  })

  it('appends a gradient-map pass with pos-sorted stop uniforms when enabled', () => {
    const c = defaultConfig()
    ;(c as any).gradientMap = { enabled: true, mix: 0.8, stops: [
      { pos: 1, color: '#ffffff' },
      { pos: 0, color: '#000000' },
      { pos: 0.5, color: '#ff0000' },
    ] }
    const passes = composePasses(c, noDef, 0)
    expect(passes.map(p => p.id)).toEqual(['studio:gradientMap'])
    const u = passes[0]!.uniforms
    expect(u.u_gm_n).toBe(3)
    expect(u.u_gm_mix).toBe(0.8)
    expect(u['u_gm_pos[0]']).toBe(0)
    expect(u['u_gm_pos[1]']).toBe(0.5)
    expect(u['u_gm_pos[2]']).toBe(1)
    expect(u['u_gm_r[0]']).toBe(0)   // black
    expect(u['u_gm_r[1]']).toBe(1)   // red
    expect(u['u_gm_g[1]']).toBe(0)
    expect(u['u_gm_r[2]']).toBe(1)   // white
  })

  it('caps the gradient map at 8 stops', () => {
    const c = defaultConfig()
    ;(c as any).gradientMap = { enabled: true, mix: 1, stops: Array.from({ length: 12 }, (_, i) => ({ pos: i / 11, color: '#808080' })) }
    const passes = composePasses(c, noDef, 0)
    expect(passes[0]!.uniforms.u_gm_n).toBe(8)
    expect(passes[0]!.uniforms['u_gm_pos[8]']).toBeUndefined()
  })

  it('expands a multi-pass effect into N passes', () => {
    const c = defaultConfig()
    c.effects = [{ layerId: 'L0', id: 'bloom', params: {}, enabled: true, blend: 'normal', opacity: 1 }]
    const bloom: EffectDef = { ...fakeEffect, id: 'bloom', passes: 3, params: [] }
    const passes = composePasses(c, () => bloom, 0)
    expect(passes).toHaveLength(3)
    expect(passes.every(p => p.id === 'bloom')).toBe(true)
  })

  // The base layer keeps u_source = original image (captureSource absent), so
  // u_source-sampling effects (bloom/glow/tilt_shift) composite over the source —
  // the pre-stacking behaviour, byte-identical for a single-effect doc.
  it('does not mark the base layer to capture its source', () => {
    const c = defaultConfig()
    c.effects = [{ layerId: 'L0', id: 'bloom', params: {}, enabled: true, blend: 'normal', opacity: 1 }]
    const bloom: EffectDef = { ...fakeEffect, id: 'bloom', passes: 2, params: [] }
    const passes = composePasses(c, () => bloom, 0)
    expect(passes.every(p => !p.captureSource)).toBe(true)
  })

  // A stacked layer captures the image beneath it as u_source, so a bloom/glow/
  // tilt_shift layer builds on the layer below rather than the original image —
  // the fix for "the top shader doesn't apply to the shader underneath".
  it('marks a stacked layer to capture its source, on its first pass only', () => {
    const c = defaultConfig()
    c.effects = [
      { layerId: 'L0', id: 'halftone', params: {}, enabled: true, blend: 'normal', opacity: 1 },
      { layerId: 'L1', id: 'bloom', params: {}, enabled: true, blend: 'normal', opacity: 1 },
    ]
    const resolve = (id: string): EffectDef | null =>
      id === 'bloom' ? { ...fakeEffect, id: 'bloom', passes: 2, params: [] } : fakeEffect
    const passes = composePasses(c, resolve, 0)
    // base halftone pass + 2 bloom passes = 3
    expect(passes).toHaveLength(3)
    expect(passes[0]!.captureSource).toBeFalsy()          // base layer
    expect(passes[1]!.captureSource).toBe(true)           // stacked layer, first pass
    expect(passes[2]!.captureSource).toBeFalsy()          // stacked layer, later pass
  })

  // captureSource is orthogonal to compositing: a stacked layer with a non-normal
  // blend both captures its source AND snapshots for the composite pass.
  it('sets both captureSource and snapshot on a stacked non-normal layer', () => {
    const c = defaultConfig()
    c.effects = [
      { layerId: 'L0', id: 'halftone', params: {}, enabled: true, blend: 'normal', opacity: 1 },
      { layerId: 'L1', id: 'bloom', params: {}, enabled: true, blend: 'screen', opacity: 0.5 },
    ]
    const resolve = (id: string): EffectDef | null =>
      id === 'bloom' ? { ...fakeEffect, id: 'bloom', passes: 1, params: [] } : fakeEffect
    const passes = composePasses(c, resolve, 0)
    // base + bloom + composite = 3
    expect(passes.map(p => p.id)).toEqual(['halftone', 'bloom', 'studio:composite'])
    expect(passes[1]!.captureSource).toBe(true)
    expect(passes[1]!.snapshot).toBe(true)
  })

  it('appends no mask pass when the mask is absent or disabled', () => {
    const c = defaultConfig()
    c.effects = [{ layerId: 'L0', id: 'halftone', params: {}, enabled: true, blend: 'normal', opacity: 1, mask: { ...defaultMask(), enabled: false } }]
    const passes = composePasses(c, () => fakeEffect, 0)
    expect(passes.map(p => p.id)).toEqual(['halftone'])
    expect(passes[0]!.snapshot).toBeFalsy()
  })

  it('appends a studio:mask pass (with the effect snapshotted) on a masked base layer', () => {
    const c = defaultConfig()
    c.effects = [{ layerId: 'L0', id: 'halftone', params: {}, enabled: true, blend: 'normal', opacity: 1, mask: { ...defaultMask(), enabled: true, shape: 'band', size: 0.15 } }]
    const passes = composePasses(c, () => fakeEffect, 0)
    expect(passes.map(p => p.id)).toEqual(['halftone', 'studio:mask'])
    expect(passes[0]!.snapshot).toBe(true)                 // effect input captured for the mix
    const mp = passes[1]!
    expect(mp.maskComposite).toBeTruthy()
    expect(mp.maskComposite!.u_maskShape).toBe(MASK_SHAPE_IDX.band)
    expect(mp.maskComposite!.u_maskSize).toBe(0.15)
  })

  it('orders masked effect → mask → blend composite when a masked layer also blends', () => {
    const c = defaultConfig()
    c.effects = [
      { layerId: 'L0', id: 'halftone', params: {}, enabled: true, blend: 'normal', opacity: 1 },
      { layerId: 'L1', id: 'halftone', params: {}, enabled: true, blend: 'screen', opacity: 0.5, mask: { ...defaultMask(), enabled: true } },
    ]
    const passes = composePasses(c, () => fakeEffect, 0)
    expect(passes.map(p => p.id)).toEqual(['halftone', 'halftone', 'studio:mask', 'studio:composite'])
    expect(passes[1]!.snapshot).toBe(true)   // one snapshot serves both mask and blend
    expect(passes[1]!.captureSource).toBe(true)
  })
})

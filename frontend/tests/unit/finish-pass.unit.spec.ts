import { describe, it, expect } from 'vitest'
import { FOIL_FRAG, SPOT_UV_FRAG, METALS, METAL_LABELS, foilUniforms, spotUvUniforms } from '~/lib/compositor/finishPass'

const light = { x: 0.15, y: 0.1, height: 0.6 }

describe('finish shaders', () => {
  it('are GLSL ES 3.00 and read the layer through uColor', () => {
    for (const f of [FOIL_FRAG, SPOT_UV_FRAG]) {
      expect(f.startsWith('#version 300 es')).toBe(true)
      expect(f).toContain('uniform sampler2D uColor')
    }
  })
  it('declare every uniform their builders send', () => {
    for (const k of Object.keys(foilUniforms({ metal: 'gold', brushed: 0.5, pressed: 0.5 }, light, 100, 125, 2))) expect(FOIL_FRAG).toContain(k)
    for (const k of Object.keys(spotUvUniforms({ gloss: 0.75, raised: 0.5, varnishOnly: false }, light, 100, 125, 2))) expect(SPOT_UV_FRAG).toContain(k)
  })
  it('never use a descending smoothstep (undefined in GLSL ES 3.00)', () => {
    for (const f of [FOIL_FRAG, SPOT_UV_FRAG]) {
      for (const m of f.matchAll(/smoothstep\(\s*([0-9.]+)\s*,\s*([0-9.]+)/g)) expect(+m[1]!).toBeLessThan(+m[2]!)
    }
  })
})

describe('foilUniforms', () => {
  it('sends the metal ramp as four vec3s, dark to bright', () => {
    const u = foilUniforms({ metal: 'gold', brushed: 0.5, pressed: 0.5 }, light, 100, 125, 2) as any
    expect(u.uM0.vec3).toEqual([0x24 / 255, 0x15 / 255, 0x03 / 255])
    expect(u.uM3.vec3).toEqual([1, 0xf1 / 255, 0xc6 / 255])
  })
  it('sends the light in world space with y up, and the Frame aspect', () => {
    const u = foilUniforms({ metal: 'gold', brushed: 0, pressed: 0 }, { x: 0.5, y: 0, height: 0 }, 100, 125, 2) as any
    expect(u.uAspect).toBeCloseTo(1.25)
    expect(u.uLight.vec3[1]).toBeCloseTo(0.625)
    expect(u.uScale).toBe(2)
  })
  it('clamps dials to 0..1', () => {
    const u = foilUniforms({ metal: 'silver', brushed: 5, pressed: -1 }, light, 100, 100, 1) as any
    expect(u.uBrushed).toBe(1); expect(u.uPressed).toBe(0)
  })
})

describe('spotUvUniforms', () => {
  it('sends varnish-only as a float flag', () => {
    expect((spotUvUniforms({ gloss: 0.75, raised: 0.5, varnishOnly: true }, light, 10, 10, 1) as any).uVarnishOnly).toBe(1)
    expect((spotUvUniforms({ gloss: 0.75, raised: 0.5, varnishOnly: false }, light, 10, 10, 1) as any).uVarnishOnly).toBe(0)
  })
})

describe('metals', () => {
  it('offers four, labelled in sentence case', () => {
    expect(Object.keys(METALS)).toEqual(['gold', 'silver', 'rose', 'copper'])
    expect(Object.values(METAL_LABELS)).toEqual(['Gold', 'Silver', 'Rose gold', 'Copper'])
  })
})

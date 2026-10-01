import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { FOIL_FRAG, SPOT_UV_FRAG } from '~/lib/compositor/finishPass'
import { FOIL_LIT_FRAG, SPOT_UV_LIT_FRAG, finishLightUniforms, finishLightWorld } from '~/lib/compositor/finishLights'
import { DEFAULT_FRAME_LIGHT, lightWorld } from '~/lib/compositor/frameLight'
import { packLightUniforms } from '~/lib/frame/lighting/shade'
import { newLightLayer, DEFAULT_LIGHTING, type LightLayer } from '~/lib/frame/lighting/settings'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const vec4 = (u: Record<string, unknown>, k: string) => (u[k] as { vec4: number[] }).vec4

function lamp(x: number, y: number, patch: Partial<LightLayer['light']> = {}, type: 'lamp' | 'spot' | 'sun' = 'lamp'): LightLayer {
  const l = newLightLayer(type, { x, y })
  return { ...l, light: { ...l.light, ...patch } }
}
/** The look-target light: white, brightness 1, where the hidden light sits by default. */
const hiddenTwin = () => lamp(DEFAULT_FRAME_LIGHT.x, DEFAULT_FRAME_LIGHT.y, { color: '#ffffff', brightness: 1, height: DEFAULT_FRAME_LIGHT.height })

describe('lit finish shaders', () => {
  it('declare the light-layer arrays, Darkness and the count, and no hidden light', () => {
    for (const f of [FOIL_LIT_FRAG, SPOT_UV_LIT_FRAG]) {
      expect(f.startsWith('#version 300 es')).toBe(true)
      for (const u of ['uniform vec4 uA[6]', 'uniform vec4 uB[6]', 'uniform vec4 uC[6]', 'uniform vec4 uW[6]', 'uCount', 'uDark']) expect(f).toContain(u)
      expect(f).not.toContain('uLight')
    }
  })
  it('use the lighting pass\'s falloff, cone and ambient', () => {
    for (const f of [FOIL_LIT_FRAG, SPOT_UV_LIT_FRAG]) {
      expect(f).toContain('r * r / (r * r + dist * dist * 3.0)')
      expect(f).toContain('smoothstep(uC[i].z, uC[i].w, c)')
      expect(f).toContain('1.0 - uDark * 0.92')
    }
  })
  it('never use a descending smoothstep (undefined in GLSL ES 3.00)', () => {
    for (const f of [FOIL_LIT_FRAG, SPOT_UV_LIT_FRAG]) {
      for (const m of f.matchAll(/smoothstep\(\s*([0-9.]+)\s*,\s*([0-9.]+)/g)) expect(+m[1]!).toBeLessThan(+m[2]!)
    }
  })
  it('declare every uniform the builder sends', () => {
    const u = finishLightUniforms([hiddenTwin()], DEFAULT_LIGHTING, 100, 125, 2)
    for (const k of Object.keys(u)) {
      const name = k.replace(/\[\d+\]$/, '')
      expect(FOIL_LIT_FRAG).toContain(name)
      expect(SPOT_UV_LIT_FRAG).toContain(name)
    }
  })
  it('keep the foil\'s dials (metal ramp, brushed, pressed, grain) and Spot UV\'s (gloss, raised, varnish only)', () => {
    for (const k of ['uM0', 'uM3', 'uBrushed', 'uPressed', 'uGrain']) expect(FOIL_LIT_FRAG).toContain(`uniform ${k.startsWith('uM') ? 'vec3' : 'float'} ${k};`)
    for (const k of ['uGloss', 'uRaised', 'uVarnishOnly']) expect(SPOT_UV_LIT_FRAG).toContain(`uniform float ${k};`)
  })
})

describe('the unlit finish shaders are untouched', () => {
  it('FOIL_FRAG and SPOT_UV_FRAG match their text before stage 3', () => {
    expect(sha(FOIL_FRAG)).toBe('7d61282d25ab84d129565c24fafa46a772743914fd6f7a30a87bc7e0b80c5674')
    expect(sha(SPOT_UV_FRAG)).toBe('163a18422fa09f415b7954b2f49be35b5a4a67afb28f98b9e6d545ac841424c5')
  })
})

describe('finishLightUniforms', () => {
  it('a white lamp at the hidden light\'s default position lands where lightWorld puts the hidden light', () => {
    for (const [w, h] of [[100, 125], [1080, 1350], [200, 100]] as const) {
      const u = finishLightUniforms([hiddenTwin()], DEFAULT_LIGHTING, w, h, 2)
      const want = lightWorld(DEFAULT_FRAME_LIGHT, h / w)
      const got = vec4(u, 'uW[0]')
      for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i]!, 10)
      expect(got[3]).toBe(1)
      expect(u.uAspect).toBeCloseTo(h / w)
      // White, brightness 1: linear (1, 1, 1).
      expect(vec4(u, 'uB[0]').slice(0, 3)).toEqual([1, 1, 1])
    }
  })
  it('places a region\'s lights by the whole Frame (aspect from the frame, not the box)', () => {
    const u = finishLightUniforms([hiddenTwin()], DEFAULT_LIGHTING, 40, 30, 1, { x: 10, y: 20, frameW: 100, frameH: 150 })
    expect(u.uAspect).toBeCloseTo(1.5)
    const want = lightWorld(DEFAULT_FRAME_LIGHT, 1.5)
    const got = vec4(u, 'uW[0]')
    for (let i = 0; i < 3; i++) expect(got[i]).toBeCloseTo(want[i]!, 10)
  })
  it('sends uA/uB/uC exactly as the lighting pass packs them', () => {
    const lights = [hiddenTwin(), lamp(0.8, 0.7, { color: '#ff0000' }, 'spot'), lamp(-0.2, 0.3, {}, 'sun')]
    const u = finishLightUniforms(lights, { darkness: 0.7, backgroundLit: true }, 100, 125, 1)
    const p = packLightUniforms(lights, { darkness: 0.7, backgroundLit: true }, 1.25, 0)
    for (let i = 0; i < 6; i++) {
      expect(vec4(u, `uA[${i}]`)).toEqual(Array.from(p.uA.slice(i * 4, i * 4 + 4)))
      expect(vec4(u, `uB[${i}]`)).toEqual(Array.from(p.uB.slice(i * 4, i * 4 + 4)))
      expect(vec4(u, `uC[${i}]`)).toEqual(Array.from(p.uC.slice(i * 4, i * 4 + 4)))
    }
    expect(u.uCount).toBe(3)
    expect(u.uDark).toBe(0.7)
  })
  it('linearises colour as the lighting pass does (sRGB^2.2 × brightness)', () => {
    const u = finishLightUniforms([lamp(0.5, 0.5, { color: '#804020', brightness: 2 })], DEFAULT_LIGHTING, 10, 10, 1)
    const b = vec4(u, 'uB[0]')
    expect(b[0]).toBeCloseTo(Math.pow(0x80 / 255, 2.2) * 2, 6)
    expect(b[1]).toBeCloseTo(Math.pow(0x40 / 255, 2.2) * 2, 6)
    expect(b[2]).toBeCloseTo(Math.pow(0x20 / 255, 2.2) * 2, 6)
  })
  it('sends 0..6 lights; a 7th is dropped; unused slots are zero', () => {
    for (let n = 0; n <= 7; n++) {
      const lights = Array.from({ length: n }, (_, i) => lamp(0.1 * i, 0.5))
      const u = finishLightUniforms(lights, DEFAULT_LIGHTING, 10, 10, 1)
      expect(u.uCount).toBe(Math.min(n, 6))
      for (let i = Math.min(n, 6); i < 6; i++) {
        for (const a of ['uA', 'uB', 'uC', 'uW']) expect(vec4(u, `${a}[${i}]`)).toEqual([0, 0, 0, 0])
      }
      expect(u['uA[6]']).toBeUndefined()
    }
  })
  it('world positions: x centred, y flipped up, height → z 0.3..2.0', () => {
    const at = finishLightWorld(lamp(1, 0, { height: 1 }), 2)
    expect(at).toEqual([0.5, 1, 2])
    const low = finishLightWorld(lamp(0, 1, { height: 0 }), 2)
    expect(low).toEqual([-0.5, -1, 0.3])
  })
  it('a sun sends its direction with y flipped up (it comes from the top when its dot is above)', () => {
    const sun = lamp(0.5, -0.5, { height: 0.4 }, 'sun')
    const w = finishLightWorld(sun, 1)
    const a = vec4(finishLightUniforms([sun], DEFAULT_LIGHTING, 10, 10, 1), 'uA[0]')
    expect(w[0]).toBeCloseTo(a[0]!, 6)
    expect(w[1]).toBeCloseTo(-a[1]!, 6)
    expect(w[2]).toBeCloseTo(a[2]!, 6)
    expect(w[1]).toBeGreaterThan(0)
  })
})

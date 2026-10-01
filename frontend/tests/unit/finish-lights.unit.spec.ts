import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { FOIL_FRAG, SPOT_UV_FRAG } from '~/lib/compositor/finishPass'
import { FOIL_LIT_FRAG, SPOT_UV_LIT_FRAG, FOIL_LIGHT_GAIN, SPOT_UV_LIGHT_GAIN, finishLightUniforms, finishLightWorld, varnishDarkTerm } from '~/lib/compositor/finishLights'
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
      const arr = /\[\d+\]$/.test(k)
      const name = k.replace(/\[\d+\]$/, '')
      // A real declaration: `uniform <type> name;`, `uniform vec4 name[6];`, or one of a list.
      const decl = arr
        ? new RegExp(`uniform vec4 ${name}\\[6\\];`)
        : new RegExp(`uniform \\w+ (?:\\w+, )*${name}\\b[^\\[]`)
      expect(FOIL_LIT_FRAG).toMatch(decl)
      expect(SPOT_UV_LIT_FRAG).toMatch(decl)
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

describe('fix round 1', () => {
  it('scale every light\'s radiance by its finish\'s own gain (foil 2, Spot UV 1.25), in the finish shaders only', () => {
    expect(FOIL_LIGHT_GAIN).toBe(2)
    expect(SPOT_UV_LIGHT_GAIN).toBe(1.25)
    for (const [f, g] of [[FOIL_LIT_FRAG, FOIL_LIGHT_GAIN], [SPOT_UV_LIT_FRAG, SPOT_UV_LIGHT_GAIN]] as const) {
      expect(f).toContain(`const float LIGHT_GAIN = ${g.toFixed(4)};`)
      expect(f.match(/const float LIGHT_GAIN/g)).toHaveLength(1)
      expect(f).toContain('return uB[i].rgb * att * LIGHT_GAIN;')
    }
  })
  it('varnish-only keeps today\'s flat-normalised dark term (never from Darkness or distance)', () => {
    expect(SPOT_UV_LIT_FRAG).not.toContain('1.0 - lum(lit)')
    expect(SPOT_UV_LIT_FRAG).toContain('edge += w * (max(dot(N, L), 0.0) - max(L.z, 0.0));')
    expect(SPOT_UV_LIT_FRAG).toContain('float flatLit = 1.0 + 0.4 * (wsum > 1e-5 ? edge / wsum : 0.0);')
    expect(SPOT_UV_LIT_FRAG).toContain('float dk = clamp(0.06 + max(1.0 - flatLit, 0.0) * 0.5, 0.0, 1.0);')
  })
  it('a flat region far from every lamp, at Darkness 1, gets the faint 0.06 dark term', () => {
    const flat: [number, number, number] = [0, 0, 1]
    // Far lamps: grazing directions, tiny weights (Darkness never enters the term).
    const far = [{ L: [0.97, 0, 0.243] as [number, number, number], weight: 0.002 }, { L: [-0.6, 0.79, 0.1] as [number, number, number], weight: 0.0005 }]
    expect(varnishDarkTerm(flat, far)).toBeCloseTo(0.06, 10)
    expect(varnishDarkTerm(flat, [])).toBeCloseTo(0.06, 10)
    // A bevel facing away from the light deepens, as today.
    const tilted: [number, number, number] = [-0.6, 0, 0.8]
    expect(varnishDarkTerm(tilted, [{ L: [0.6, 0, 0.8], weight: 1 }])).toBeGreaterThan(0.06)
  })
  it('a drifted FINISH_COMMON never throws at import: the lit shaders are empty and applyFinishLit falls back', async () => {
    vi.resetModules()
    vi.doMock('~/lib/compositor/finishPass', async (orig) => ({ ...(await orig<object>()), FINISH_COMMON: '#version 300 es\n// no hidden light here\n' }))
    try {
      const m = await import('~/lib/compositor/finishLights')
      expect(m.FOIL_LIT_FRAG).toBe('')
      expect(m.SPOT_UV_LIT_FRAG).toBe('')
      const off = { width: 10, height: 10 } as HTMLCanvasElement
      expect(m.applyFinishLit(off, 'gold_foil', { metal: 'gold', brushed: 0, pressed: 0, grain: 0 }, [], DEFAULT_LIGHTING, 1)).toBe(false)
    } finally {
      vi.doUnmock('~/lib/compositor/finishPass')
      vi.resetModules()
    }
  })
})

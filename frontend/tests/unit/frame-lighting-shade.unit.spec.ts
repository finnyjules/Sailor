import { describe, it, expect } from 'vitest'
import { lightAt, packLight, packLightUniforms, shadePixel, type PackedLight } from '~/lib/frame/lighting/shade'
import { newLightLayer, LIGHT_DEFAULTS, DEFAULT_LIGHTING } from '~/lib/frame/lighting/settings'
import type { LightLayer } from '~/lib/frame/lighting/settings'

const ASPECT = 1350 / 1080
const at = (x: number, y: number, z = 0): [number, number, number] => [x, y * ASPECT, z]
const sum = (c: readonly number[]) => c[0]! + c[1]! + c[2]!
function light(type: 'lamp' | 'spot' | 'sun', x: number, y: number, patch: Partial<LightLayer['light']> = {}): PackedLight {
  const l = newLightLayer(type, { x, y })
  return packLight({ ...l, light: { ...l.light, ...patch } }, ASPECT)
}

describe('lightAt — the per-light term (TS mirror of the shader)', () => {
  it('a lamp on the left gives more on the left', () => {
    const lamp = light('lamp', 0.1, 0.5)
    expect(sum(lightAt(lamp, at(0.15, 0.5)))).toBeGreaterThan(sum(lightAt(lamp, at(0.85, 0.5))))
  })

  it('a spot outside its cone gives 0', () => {
    // Spot straight above the centre aiming at the centre, narrow cone: a far corner is outside.
    const spot = light('spot', 0.5, 0.5, { aimX: 0.5, aimY: 0.5, cone: 0.1, edge: 0, height: 0.2 })
    expect(sum(lightAt(spot, at(0.98, 0.98)))).toBe(0)
    expect(sum(lightAt(spot, at(0.5, 0.5)))).toBeGreaterThan(0)
  })

  it('a sun has no falloff', () => {
    const sun = light('sun', -0.2, 0.3)
    const a = lightAt(sun, at(0.1, 0.1)), b = lightAt(sun, at(0.9, 0.9))
    for (let i = 0; i < 3; i++) expect(a[i]).toBeCloseTo(b[i]!, 10)
    expect(sum(a)).toBeGreaterThan(0)
  })

  it('packs colour in linear light × brightness, and the type code 1/2/3', () => {
    const p = light('lamp', 0.2, 0.3, { color: '#ffffff', brightness: 2 })
    expect(p.type).toBe(1)
    expect(p.color).toEqual([2, 2, 2])
    expect(p.pos[1]).toBeCloseTo(0.3 * ASPECT)
    expect(p.pos[2]).toBeCloseTo(0.04 + LIGHT_DEFAULTS.lamp.height * 0.9)
    expect(light('spot', 0, 0).type).toBe(2)
    expect(light('sun', 0, 0).type).toBe(3)
  })

  it('uniforms: vec4 arrays of 6, count, darkness, aspect', () => {
    const u = packLightUniforms([newLightLayer('lamp'), newLightLayer('sun')], DEFAULT_LIGHTING, ASPECT, 0.16)
    expect(u.uA).toBeInstanceOf(Float32Array)
    expect(u.uA.length).toBe(24)
    expect(u.uCount).toBe(2)
    expect(u.uDark).toBe(DEFAULT_LIGHTING.darkness)
    expect(u.uAspect).toBe(ASPECT)
    expect(u.uLiftScale).toBe(0.16)
    expect(u.uA[3]).toBe(1)
    expect(u.uA[7]).toBe(3)
  })
})

describe('shadePixel — Darkness', () => {
  it('Darkness 0 never darkens, whatever the albedo and wherever the light', () => {
    const lights = [light('lamp', 0.05, 0.05, { brightness: 0.3, reach: 0.2 })]
    for (const v of [0, 0.1, 0.35, 0.5, 0.8, 1]) {
      for (const [x, y] of [[0.05, 0.05], [0.5, 0.5], [0.95, 0.95]]) {
        const out = shadePixel([v, v * 0.7, v * 0.2], lights, at(x!, y!), 0)
        expect(out[0]).toBeGreaterThanOrEqual(v - 1e-6)
        expect(out[1]).toBeGreaterThanOrEqual(v * 0.7 - 1e-6)
        expect(out[2]).toBeGreaterThanOrEqual(v * 0.2 - 1e-6)
      }
    }
  })

  it('Darkness 1 with no light reaching is darker than the picture', () => {
    const out = shadePixel([0.8, 0.8, 0.8], [], at(0.5, 0.5), 1)
    expect(out[0]).toBeLessThan(0.8)
  })
})

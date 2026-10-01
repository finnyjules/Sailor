import { describe, it, expect } from 'vitest'
import {
  lightAt, packLight, packLightUniforms, shadePixel, shadowWalk, WALK_STEP, WALK_STEPS, type PackedLight,
  decodeFacing, encodeFacing, FLAT_FACING, FLAT_FACING_RGB, SHINE_GAIN, SHINE_POWER, shineAt, type Facing, type Vec3,
} from '~/lib/frame/lighting/shade'
import { LIGHTING_FRAG, frameDeviceRect, lightsInBox } from '~/lib/frame/lighting/lightingPass'
import { relightBoxToFrame } from '~/lib/frame/lighting/convertRelight'
import type { LocalLayer } from '~/composables/useCompositorLayers'
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

describe('shadowWalk — the walk stops above the tallest layer', () => {
  // A 0.05-high block occupying u in [0.4, 0.5], everything else flat.
  const block = (u: number) => (u >= 0.4 && u <= 0.5 ? 0.05 : 0)
  const field = (u: number, _v: number) => block(u)
  const toLight: [number, number, number] = (() => { const v = [-0.6, 0, 0.3]; const l = Math.hypot(...v); return v.map(x => x / l) as [number, number, number] })()

  it('a layer between the pixel and the light shadows it; with no casters the walk is skipped', () => {
    expect(shadowWalk([0.55, 0.5, 0], toLight, 2, field, 1, 0.05)).toBeLessThan(0.5)
    expect(shadowWalk([0.55, 0.5, 0], toLight, 2, field, 1, 0)).toBe(1)
  })

  it('stopping above maxLift changes nothing (exact early out)', () => {
    for (const u of [0.3, 0.52, 0.55, 0.6, 0.7, 0.9]) {
      for (const j of [0, 0.37, 0.9]) {
        const full = shadowWalk([u, 0.5, 0], toLight, 2, field, 1, 1e9, j)
        const early = shadowWalk([u, 0.5, 0], toLight, 2, field, 1, 0.05, j)
        expect(early).toBe(full)
      }
    }
  })
})

describe('LIGHTING_FRAG and shade.ts cannot drift', () => {
  it('the shader carries every constant the TS mirror uses', () => {
    for (const c of ['uDark * 0.92', '* 0.85 + 0.15', 'dist * dist * 3.0', `* ${WALK_STEP}`, `k <= ${WALK_STEPS}`, 'col * 0.18', 'smoothstep(0.0, 0.02 + t * 0.25, above) * 0.85', 'P.z + t * slope > uMaxLift', 'pow(src.rgb, vec3(2.2))']) {
      expect(LIGHTING_FRAG, c).toContain(c)
    }
    expect(WALK_STEP).toBe(0.0075)
    expect(WALK_STEPS).toBe(56)
  })
})

describe('frameDeviceRect — tiles round independently', () => {
  it('within a pixel of the whole canvas is the whole canvas (no crop)', () => {
    expect(frameDeviceRect({ a: 1.333, d: 1.333, e: 0, f: 0 }, 300, 375, 400, 501)).toEqual({ x: 0, y: 0, w: 400, h: 501, whole: true })
    expect(frameDeviceRect({ a: 2, d: 2, e: 0, f: 0 }, 1081, 1350, 2162, 2700).whole).toBe(true)
  })
  it('a Frame inside a bigger canvas is cropped', () => {
    const r = frameDeviceRect({ a: 1, d: 1, e: 10, f: 20 }, 100, 100, 200, 200)
    expect(r).toEqual({ x: 10, y: 20, w: 100, h: 100, whole: false })
    expect(frameDeviceRect({ a: 1, d: 1, e: 0, f: 0 }, 100, 100, 104, 100).whole).toBe(false)
  })
})

describe('web-export bleed darkening', () => {
  it('matches what the pass does to an unlit-by-any-light background pixel', async () => {
    const { bleedAmbientAlpha } = await import('~/lib/embed/frame/bleed')
    expect(bleedAmbientAlpha(0)).toBeCloseTo(0, 10)
    for (const d of [0.2, 0.45, 0.9]) {
      for (const c of [0.2, 0.6, 0.95]) {
        const passed = shadePixel([c, c, c], [], at(0.5, 0.5), d)[0]
        expect(c * (1 - bleedAmbientAlpha(d))).toBeCloseTo(passed, 6)
      }
    }
  })
})

// ── Stage 2: facing, contact, shine ─────────────────────────────────────────────────────────
const unit = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return v.map(x => x / l) as Vec3 }
const facing = (n: Vec3, contact = 1, shine = 0): Facing => ({ n: unit(n), contact, shine })

describe('facing — the map encoding', () => {
  it('flat (128,128,255) decodes to exactly n = +z and contact 1', () => {
    const d = decodeFacing(...FLAT_FACING_RGB)
    expect(d.n).toEqual([0, 0, 1])
    expect(d.contact).toBe(1)
    expect(encodeFacing([0, 0, 1], 1)).toEqual([...FLAT_FACING_RGB])
  })

  it('round-trips a tilted normal within one 8-bit step', () => {
    const n = unit([-0.5, 0.3, 0.8])
    const d = decodeFacing(...encodeFacing(n, 0.6))
    for (let i = 0; i < 3; i++) expect(Math.abs(d.n[i]! - n[i]!)).toBeLessThan(0.02)
    expect(d.contact).toBeCloseTo(0.6, 2)
  })
})

describe('flat facing equals stage 1', () => {
  it('lightAt and shadePixel with the flat facing are stage 1\'s numbers exactly', () => {
    const lights = [light('lamp', 0.2, 0.3), light('spot', 0.7, 0.2, { aimX: 0.6, aimY: 0.6 }), light('sun', -0.2, 0.4)]
    const flat = { ...decodeFacing(...FLAT_FACING_RGB), shine: 0 }
    for (const [x, y] of [[0.1, 0.1], [0.5, 0.5], [0.9, 0.8]]) {
      for (const p of lights) expect(lightAt(p, at(x!, y!), flat)).toEqual(lightAt(p, at(x!, y!)))
      expect(shadePixel([0.6, 0.4, 0.2], lights, at(x!, y!), 0.45, flat)).toEqual(shadePixel([0.6, 0.4, 0.2], lights, at(x!, y!), 0.45))
      expect(shadePixel([0.6, 0.4, 0.2], lights, at(x!, y!), 0.45, FLAT_FACING)).toEqual(shadePixel([0.6, 0.4, 0.2], lights, at(x!, y!), 0.45))
    }
  })
})

describe('facing changes the light', () => {
  const lamp = light('lamp', 0.1, 0.5, { height: 0.2 })
  const P = at(0.5, 0.5)

  it('a normal facing the light is brighter than one facing away', () => {
    const toward = sum(lightAt(lamp, P, facing([-0.6, 0, 0.8])))
    const flat = sum(lightAt(lamp, P))
    const away = sum(lightAt(lamp, P, facing([0.6, 0, 0.8])))
    expect(toward).toBeGreaterThan(flat)
    expect(flat).toBeGreaterThan(away)
  })

  it('the contact term darkens, in proportion', () => {
    const open = lightAt(lamp, P, facing([0, 0, 1], 1))
    const shut = lightAt(lamp, P, facing([0, 0, 1], 0.5))
    expect(sum(shut)).toBeCloseTo(sum(open) * 0.5, 10)
    expect(shadePixel([0.5, 0.5, 0.5], [lamp], P, 0.45, facing([0, 0, 1], 0.5))[0])
      .toBeLessThan(shadePixel([0.5, 0.5, 0.5], [lamp], P, 0.45)[0])
  })

  it('shine adds a highlight where the normal meets the half vector; 0 shine adds nothing', () => {
    // Half of (toward the lamp) and the view: tilt the normal toward the lamp.
    const n: Vec3 = [-0.45, 0, 0.9]
    expect(sum(shineAt(lamp, P, facing(n, 1, 0)))).toBe(0)
    expect(sum(shineAt(lamp, P, facing(n, 1, 1)))).toBeGreaterThan(0)
    expect(shadePixel([0.3, 0.3, 0.3], [lamp], P, 0.45, facing(n, 1, 1))[0])
      .toBeGreaterThan(shadePixel([0.3, 0.3, 0.3], [lamp], P, 0.45, facing(n, 1, 0))[0])
  })

  it('the shader carries the facing decode, contact and the prototype\'s shine', () => {
    for (const c of ['(f.rg - 128.0) / 127.0', 'sqrt(max(1.0 - dot(nxy, nxy), 0.0))', 'contact = f.b / 255.0', 'att * sh * contact',
      `0.0), ${SHINE_POWER}.0) * shineK * ${SHINE_GAIN}.0`, 'normalize(L + vec3(0.0, 0.0, 1.0))', 'shineK = texture(uLit, vUv).g', 'alb * acc + spec']) {
      expect(LIGHTING_FRAG, c).toContain(c)
    }
    expect(SHINE_POWER).toBe(48)
    expect(SHINE_GAIN).toBe(2)
  })
})

describe('lightsInBox — the Frame\'s lights in a photo\'s box (Finish guide)', () => {
  const W = 1080, H = 1350
  const photo = { id: 'p', kind: 'image', x: 0.4, y: 0.55, w: 0.5, h: 0.4, rotation: 30, opacity: 1 } as unknown as LocalLayer
  it('a lamp maps to the box fraction the conversion maps back from, height and reach in box widths', () => {
    const lamp = newLightLayer('lamp', relightBoxToFrame(photo, 0.2, 0.3, W, H))
    const [b] = lightsInBox(photo, [lamp], W, H)
    expect(b!.x).toBeCloseTo(0.2, 9)
    expect(b!.y).toBeCloseTo(0.3, 9)
    // Same height above the page: z_box · boxWidth = z_frame.
    expect((0.04 + b!.light.height * 0.9) * 0.5).toBeCloseTo(0.04 + lamp.light.height * 0.9, 9)
    expect(b!.light.reach).toBeCloseTo(lamp.light.reach / 0.5, 9)
  })
  it('a sun keeps its height; its dot turns with the photo', () => {
    const sun = newLightLayer('sun', { x: 0.1, y: 0.5 })
    const [b] = lightsInBox(photo, [sun], W, H)
    expect(b!.light.height).toBe(sun.light.height)
    expect(b!.x).not.toBeCloseTo(0.1, 3)
  })
})

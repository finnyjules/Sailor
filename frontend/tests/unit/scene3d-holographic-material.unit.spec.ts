import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { materialFor, updateMaterial, disposeMaterial, holoRoughness } from '~/lib/scene3d/materials'
import { MATERIAL_DEFAULTS, type SceneMaterial } from '~/lib/scene3d/config'

// Headless like the opalescent suite: a MeshPhysicalMaterial and its ramp DataTexture build
// without a GL context, and onBeforeCompile is a function we invoke against a stub carrying the
// include placeholders the foil injects at. These guard the control → uniform → injection path;
// the "rainbow streak near the highlight that moves with the camera" is a live check.

const foil = (over: Partial<SceneMaterial> = {}): SceneMaterial => ({
  type: 'holographic', color: '#dddddd', roughness: 0.5, metalness: 0,
  gradientStops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }],
  ...over,
})

function compile(m: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\n#include <begin_vertex>\n#include <worldpos_vertex>',
    fragmentShader: '#include <common>\n#include <emissivemap_fragment>\nvec4 diffuseColor;',
  }
  ;(m as any).onBeforeCompile?.(shader)
  return shader
}

describe('holographic material — the three include points it depends on', () => {
  it('three still ships the chunks the foil injects at', () => {
    for (const k of ['common', 'worldpos_vertex', 'emissivemap_fragment']) {
      expect(THREE.ShaderChunk[k as keyof typeof THREE.ShaderChunk], k).toBeDefined()
    }
    expect(THREE.ShaderLib.physical.vertexShader).toContain('#include <worldpos_vertex>')
    const frag = THREE.ShaderLib.physical.fragmentShader
    // The body adds to totalEmissiveRadiance and reads directionalLights / normal / vViewPosition:
    // all four must already exist by the injection point.
    for (const dep of ['totalEmissiveRadiance', '#include <lights_pars_begin>', '#include <normal_fragment_begin>']) {
      expect(frag.indexOf(dep), dep).toBeLessThan(frag.indexOf('#include <emissivemap_fragment>'))
    }
  })
})

describe('holographic material — build', () => {
  it('is a MeshPhysicalMaterial pinned at metalness 1, with roughness from Gloss', () => {
    const m = materialFor(foil({ holoGloss: 1 })) as THREE.MeshPhysicalMaterial
    expect(m.isMeshPhysicalMaterial).toBe(true)
    expect(m.metalness).toBe(1) // the doc's metalness 0 is ignored — a foil IS metal
    expect(m.roughness).toBeCloseTo(0.04)
    disposeMaterial(m)
    const brushed = materialFor(foil({ holoGloss: 0 })) as THREE.MeshPhysicalMaterial
    expect(brushed.roughness).toBeCloseTo(0.55)
    disposeMaterial(brushed)
  })

  it('holoRoughness clamps its dial and never reaches a mirror below gloss 1', () => {
    expect(holoRoughness(-1)).toBeCloseTo(0.55)
    expect(holoRoughness(2)).toBeCloseTo(0.04)
    expect(holoRoughness(0.5)).toBeGreaterThan(0.04)
  })

  it('wires the holo uniforms from the doc — hue is normalised to 0..1', () => {
    const m = materialFor(foil({ holoStrength: 1.5, holoBands: 5, holoAngle: 45, holoFlakes: 0.8, holoFlakeSize: 0.05, holoHueShift: 180 }))
    const u = m.userData.holoUniforms as Record<string, { value: number }>
    expect(u.uStrength.value).toBe(1.5)
    expect(u.uBands.value).toBe(5)
    expect(u.uAngle.value).toBe(45)
    expect(u.uFlakes.value).toBe(0.8)
    expect(u.uFlakeSize.value).toBe(0.05)
    expect(u.uHueShift.value).toBeCloseTo(0.5) // 180 / 360
    expect(u.uRamp.value).toBeInstanceOf(THREE.DataTexture)
    disposeMaterial(m)
  })

  it('falls back to defaults for absent holo fields', () => {
    const m = materialFor(foil())
    const u = m.userData.holoUniforms as Record<string, { value: number }>
    expect(u.uBands.value).toBe(MATERIAL_DEFAULTS.holoBands)
    expect(u.uFlakes.value).toBe(MATERIAL_DEFAULTS.holoFlakes) // 0 → a clean linear foil
    expect((m as THREE.MeshPhysicalMaterial).roughness).toBeCloseTo(holoRoughness(MATERIAL_DEFAULTS.holoGloss))
    disposeMaterial(m)
  })

  it('injects the grating in BOTH stages: a varying from worldpos_vertex, the sweep at emissivemap_fragment', () => {
    const m = materialFor(foil())
    const sh = compile(m)
    expect(sh.vertexShader).toContain('varying vec3 vHoloPos;')
    expect(sh.vertexShader).toMatch(/#include <worldpos_vertex>\s*vHoloPos = transformed;/)
    expect(sh.fragmentShader).toContain('varying vec3 vHoloPos;')
    expect(sh.fragmentShader).toContain('#include <emissivemap_fragment>') // kept, we append after it
    expect(sh.fragmentShader).toContain('directionalLights[ 0 ].direction')
    expect(sh.fragmentShader).toContain('totalEmissiveRadiance += rainbow * env * uStrength;')
    expect(sh.fragmentShader).toContain('diffuseColor.rgb = mix( diffuseColor.rgb, diffuseColor.rgb * ( 0.35 + rainbow )')
    // three's <common> owns `rand` — the foil's hash must not shadow it.
    expect(sh.fragmentShader).toContain('float holoHash(')
    expect(sh.fragmentShader).not.toMatch(/float rand\s*\(/)
    // The uniform objects wired into the program are the SAME objects updateMaterial mutates.
    expect(sh.uniforms.uBands).toBe((m.userData.holoUniforms as Record<string, unknown>).uBands)
    disposeMaterial(m)
  })

  it('carries its own program cache key and does not register anywhere per-frame', () => {
    const m = materialFor(foil())
    expect(String(m.customProgramCacheKey())).toBe('scene3d-holographic')
    expect(m.userData.matType).toBe('holographic')
    disposeMaterial(m)
  })
})

describe('holographic material — update', () => {
  it('mutates the uniforms and physical fields in place and keeps metalness pinned', () => {
    const m = materialFor(foil()) as THREE.MeshPhysicalMaterial
    const ramp = (m.userData.holoUniforms as Record<string, { value: unknown }>).uRamp.value
    const ok = updateMaterial(m, foil({
      holoStrength: 0.2, holoBands: 7, holoAngle: 90, holoFlakes: 1, holoFlakeSize: 0.2, holoGloss: 0, holoHueShift: 90,
      color: '#ff8800', metalness: 0, clearcoat: 1, clearcoatRoughness: 0.3, envMapIntensity: 2,
    }))
    expect(ok).toBe(true)
    const u = m.userData.holoUniforms as Record<string, { value: number }>
    expect(u.uStrength.value).toBe(0.2)
    expect(u.uBands.value).toBe(7)
    expect(u.uAngle.value).toBe(90)
    expect(u.uFlakes.value).toBe(1)
    expect(u.uFlakeSize.value).toBe(0.2)
    expect(u.uHueShift.value).toBeCloseTo(0.25)
    expect(m.roughness).toBeCloseTo(0.55)
    expect(m.metalness).toBe(1)
    expect(m.clearcoat).toBe(1)
    expect(m.clearcoatRoughness).toBe(0.3)
    expect(m.envMapIntensity).toBe(2)
    expect(m.color.getHexString()).toBe('ff8800')
    // Same stops → the LUT is NOT rebuilt.
    expect(u.uRamp.value).toBe(ramp)
    disposeMaterial(m)
  })

  it('rebuilds the ramp LUT only when the stops change, disposing the old one', () => {
    const m = materialFor(foil())
    const u = m.userData.holoUniforms as Record<string, { value: THREE.DataTexture }>
    const before = u.uRamp.value
    let disposed = false
    before.addEventListener('dispose', () => { disposed = true })
    expect(updateMaterial(m, foil({ gradientStops: [{ pos: 0, color: '#00ff00' }, { pos: 1, color: '#ff00ff' }] }))).toBe(true)
    expect(u.uRamp.value).not.toBe(before)
    expect(disposed).toBe(true)
    disposeMaterial(m)
  })

  it('refuses a type change (rebuild boundary), like every other type', () => {
    const m = materialFor(foil())
    expect(updateMaterial(m, { ...foil(), type: 'opalescent' })).toBe(false)
    disposeMaterial(m)
  })
})

describe('holographic material — dispose', () => {
  it('disposes the ramp LUT it owns', () => {
    const m = materialFor(foil())
    const ramp = (m.userData.holoUniforms as Record<string, { value: THREE.DataTexture }>).uRamp.value
    let disposed = false
    ramp.addEventListener('dispose', () => { disposed = true })
    disposeMaterial(m)
    expect(disposed).toBe(true)
  })
})

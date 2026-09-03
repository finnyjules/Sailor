import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { materialFor, updateMaterial, disposeMaterial } from '~/lib/scene3d/materials'
import { MATERIAL_DEFAULTS, type SceneMaterial, type ScreenSpec } from '~/lib/scene3d/config'

// Headless like the opalescent suite: materials build without a GL context and
// onBeforeCompile runs against a stub carrying the four include placeholders the screen targets.
const base = (patch: Partial<SceneMaterial> = {}): SceneMaterial =>
  ({ type: 'standard', color: '#9aa3af', roughness: 0.6, metalness: 0, ...patch })
const dots = (over: Partial<ScreenSpec> = {}): ScreenSpec =>
  ({ pattern: 'dots', density: 48, angle: 45, contrast: 1, softness: 0.15, misregister: 0, gap: 'transparent', ink: 'lit', ...over })

function compile(m: THREE.Material) {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\n#include <uv_pars_vertex>\n#include <begin_vertex>\n#include <uv_vertex>',
    fragmentShader: '#include <common>\n#include <uv_pars_fragment>\nvec4 diffuseColor;\n#include <color_fragment>\n#include <emissivemap_fragment>\nvec3 outgoingLight;\n#include <opaque_fragment>',
  }
  ;(m as any).onBeforeCompile?.(shader, {} as any)
  return shader
}

// The injection targets are three's own chunk names. If a three upgrade renames or drops
// one of them, every replace() below silently becomes a no-op and the screen just stops
// rendering — so assert the chunks exist before testing what we do with them.
describe('screen finish — the three include points it depends on', () => {
  it('three still ships the four chunks the screen injects at', () => {
    for (const k of ['uv_pars_vertex', 'uv_vertex', 'uv_pars_fragment', 'opaque_fragment']) {
      expect(THREE.ShaderChunk[k as keyof typeof THREE.ShaderChunk], k).toBeDefined()
    }
  })

  it('every material family the screen applies to still includes <opaque_fragment>', () => {
    for (const lib of ['physical', 'basic', 'toon', 'matcap', 'phong'] as const) {
      expect(THREE.ShaderLib[lib].fragmentShader, lib).toContain('#include <opaque_fragment>')
    }
  })
})

describe('screen finish — build', () => {
  it('does nothing when the screen is absent or pattern is none', () => {
    for (const m of [materialFor(base()), materialFor(base({ screen: dots({ pattern: 'none' }) }))]) {
      expect(m.userData.screenUniforms).toBeUndefined()
      expect(compile(m).fragmentShader).toContain('#include <opaque_fragment>')
      expect(m.transparent).toBe(false)
      disposeMaterial(m)
    }
  })

  it('injects its own varying at the uv chunks and replaces opaque_fragment', () => {
    const m = materialFor(base({ screen: dots() }))
    const sh = compile(m)
    expect(sh.vertexShader).toContain('varying vec2 vScrUv;')
    expect(sh.vertexShader).toMatch(/#include <uv_vertex>[\s\S]*vScrUv = uv;/)
    expect(sh.fragmentShader).toContain('scrCoverage')
    expect(sh.fragmentShader).not.toContain('#include <opaque_fragment>')
    expect(sh.fragmentShader).toContain('gl_FragColor')
    expect(sh.uniforms.uScrDensity!.value).toBe(48)
    disposeMaterial(m)
  })

  it('wires every dial into a uniform', () => {
    const m = materialFor(base({ screen: dots({ pattern: 'cross', density: 90, angle: 30, contrast: 2, softness: 0.4, misregister: 0.5, invert: true, gap: 'colour', gapColor: '#ff2d95', ink: 'colour', inkColor: '#000000' }) }))
    const u = m.userData.screenUniforms as Record<string, { value: any }>
    expect(u.uScrPattern.value).toBe(2)
    expect(u.uScrDensity.value).toBe(90)
    expect(u.uScrAngle.value).toBeCloseTo(Math.PI / 6, 6)
    expect(u.uScrContrast.value).toBe(2)
    expect(u.uScrSoft.value).toBe(0.4)
    expect(u.uScrMisreg.value).toBe(0.5)
    expect(u.uScrInvert.value).toBe(1)
    expect(u.uScrGapMode.value).toBe(1)
    expect((u.uScrGapColor.value as THREE.Color).getHexString()).toBe('ff2d95')
    expect(u.uScrInkMode.value).toBe(1)
    expect((u.uScrInkColor.value as THREE.Color).getHexString()).toBe('000000')
    disposeMaterial(m)
  })

  it('transparent gaps flip the material transparent, keep depth writes, and discard open gaps', () => {
    const m = materialFor(base({ screen: dots({ gap: 'transparent' }) }))
    expect(m.transparent).toBe(true)
    expect(m.depthWrite).toBe(true)
    // Not alphaTest: three's <alphatest_fragment> runs BEFORE lighting, on diffuseColor.a,
    // so it can never see the screen coverage. The shader discards the open gaps itself.
    expect(compile(m).fragmentShader).toContain('discard')
    expect(m.userData.screenTransparent).toBe(true)
    const c = materialFor(base({ screen: dots({ gap: 'colour' }) }))
    expect(c.transparent).toBe(false)
    disposeMaterial(m); disposeMaterial(c)
  })

  it('chains onto a material that already injects (gradient) — both bodies present', () => {
    const m = materialFor(base({ type: 'gradient', gradientB: '#123456', screen: dots() }))
    const sh = compile(m)
    expect(sh.fragmentShader).toContain('uRamp')        // gradient body still there
    expect(sh.fragmentShader).toContain('scrCoverage')  // screen body added
    expect(String((m as any).customProgramCacheKey())).toContain('|screen')
    disposeMaterial(m)
  })

  it('applies to toon, matcap, phong, opalescent, image, shaderFill (unlit too) — and never to glass', () => {
    for (const patch of [
      { type: 'toon' as const }, { type: 'matcap' as const }, { type: 'phong' as const }, { type: 'opalescent' as const },
      { type: 'image' as const, image: 'a.png' }, { type: 'shaderFill' as const, unlit: true },
    ]) {
      const m = materialFor(base({ ...patch, screen: dots() }))
      expect(m.userData.screenUniforms, patch.type).toBeDefined()
      disposeMaterial(m)
    }
    const g = materialFor(base({ type: 'glass', screen: dots() }))
    expect(g.userData.screenUniforms).toBeUndefined()
    disposeMaterial(g)
  })

  it('anti-aliases on BOTH axes and rotates counter-clockwise', () => {
    const sh = compile(materialFor(base({ screen: dots() })))
    // fwidth(p.x) alone collapses to ~0 at 90 degrees, where the cell varies along y.
    expect(sh.fragmentShader).toContain('max(fwidth(p.x), fwidth(p.y))')
    // A rising Angle must turn the grid the same way every other angle dial does.
    expect(sh.fragmentShader).toContain('mat2(c, s, -s, c)')
  })

  it('gives a screened material its own program cache key', () => {
    // Three's default customProgramCacheKey is onBeforeCompile.toString(); without a
    // distinct key a screened and an unscreened toon material can share one program.
    const plain = materialFor(base({ type: 'toon' }))
    const screened = materialFor(base({ type: 'toon', screen: dots() }))
    expect(String(screened.customProgramCacheKey())).not.toBe(String(plain.customProgramCacheKey()))
    expect(String(screened.customProgramCacheKey())).toContain('|screen')
    // And it must be the BASE material's key plus the suffix: capturing the previous key
    // after replacing onBeforeCompile would hash the screen wrapper's own source instead,
    // which is one identical string for every screened material.
    expect(String(screened.customProgramCacheKey())).toBe(`${String(plain.customProgramCacheKey())}|screen`)
    disposeMaterial(plain); disposeMaterial(screened)
  })
})

describe('screen finish — identity and in-place update', () => {
  it('off→on, on→off and gap transparent↔colour force a rebuild; dials update in place', () => {
    const m = materialFor(base({ screen: dots() }))
    expect(updateMaterial(m, base())).toBe(false)                                   // on→off
    expect(updateMaterial(m, base({ screen: dots({ gap: 'colour' }) }))).toBe(false) // gap boundary
    expect(updateMaterial(m, base({ screen: dots({ pattern: 'lines', density: 120, angle: 90, contrast: 3, softness: 0.5, misregister: 0.8, invert: true, ink: 'colour', inkColor: '#ff0000' }) }))).toBe(true)
    const u = m.userData.screenUniforms as Record<string, { value: any }>
    expect(u.uScrPattern.value).toBe(1)
    expect(u.uScrDensity.value).toBe(120)
    expect(u.uScrAngle.value).toBeCloseTo(Math.PI / 2, 6)
    expect(u.uScrContrast.value).toBe(3)
    expect(u.uScrSoft.value).toBe(0.5)
    expect(u.uScrMisreg.value).toBe(0.8)
    expect(u.uScrInvert.value).toBe(1)
    expect(u.uScrInkMode.value).toBe(1)
    expect((u.uScrInkColor.value as THREE.Color).getHexString()).toBe('ff0000')
    disposeMaterial(m)
    const off = materialFor(base())
    expect(updateMaterial(off, base({ screen: dots() }))).toBe(false)              // off→on
    disposeMaterial(off)
  })

  it('an unrelated in-place update on a standard material keeps transparent gaps transparent', () => {
    const m = materialFor(base({ screen: dots() }))
    expect(updateMaterial(m, base({ roughness: 0.1, screen: dots() }))).toBe(true)
    expect(m.transparent).toBe(true) // applyPhysical must not reset it to opacity < 1
    disposeMaterial(m)
  })

  it('a material without a screen is byte-identical to before: no uniforms, no flags, same identity key', () => {
    const a = materialFor(base()), b = materialFor(base({ screen: dots({ pattern: 'none' }) }))
    expect(a.userData.identity).toBe(b.userData.identity)
    expect(a.transparent).toBe(false); expect(b.transparent).toBe(false)
    disposeMaterial(a); disposeMaterial(b)
  })
})

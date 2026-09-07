import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { materialFor, updateMaterial } from '~/lib/scene3d/materials'
import type { SceneMaterial } from '~/lib/scene3d/config'

const MAT = { type: 'standard', color: '#3366cc' } as SceneMaterial

/** The seven material types that DO carry a per-copy Vary colour. `gradient`,
 *  `opalescent`, `image` and `shaderFill` are in NO_BASE_COLOR and are covered
 *  separately below. */
const TINTED_TYPES = ['standard', 'glass', 'toon', 'phong', 'matcap', 'fresnel', 'holographic'] as const

const plain = () => new THREE.BoxGeometry(1, 1, 1)

/** A geometry with a `color` attribute but NO stamp — what `GLTFLoader` produces
 *  from a glTF `COLOR_0`. Must NOT be mistaken for a clone set. */
const withColorAttribute = (g: THREE.BufferGeometry) => {
  const n = g.getAttribute('position').count
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(1), 3))
  return g
}

/** A geometry as `mergeClones` leaves it: the per-copy `color` attribute AND the
 *  `varyTint` stamp that identifies it as Cloner-baked. The blend STRENGTH is
 *  deliberately not here — it is a material property, passed to
 *  `materialFor`/`updateMaterial` explicitly, never stamped on the geometry. */
const tinted = () => {
  const g = withColorAttribute(plain())
  g.userData.varyTint = true
  return g
}

type Tintable = THREE.Material & { vertexColors: boolean; color?: THREE.Color }
const varyUniforms = (m: THREE.Material) =>
  m.userData.varyUniforms as { uVaryStrength: { value: number } } | undefined

/** The material's own base colour, read back from `.color` — not all seven tinted
 *  types carry one (`matcap` never writes it at all; see the comment above
 *  `NO_BASE_COLOR` in config.ts, `applyVaryTint` in materials.ts), so this can be `undefined`. */
const baseColorHex = (m: THREE.Material) => (m as Tintable).color?.getHexString()

describe('materialFor with vertex colours', () => {
  it('leaves an untinted geometry exactly as before', () => {
    const m = materialFor(MAT, plain()) as THREE.MeshStandardMaterial
    expect(m.vertexColors).toBe(false)
    expect(`#${m.color.getHexString()}`).toBe('#3366cc')
    expect(m.userData.vertexTint).toBeUndefined()
    expect(m.userData.varyUniforms).toBeUndefined()
  })

  it('leaves the base colour ALONE — the tint is a shader mix, not a neutralised base', () => {
    const m = materialFor(MAT, tinted()) as THREE.MeshStandardMaterial
    expect(m.vertexColors).toBe(true)
    expect(`#${m.color.getHexString()}`).toBe('#3366cc')
  })

  it('ignores vertex colours for the four types with no base colour to mix against', () => {
    for (const type of ['image', 'shaderFill', 'gradient', 'opalescent'] as const) {
      const m = materialFor({ ...MAT, type } as SceneMaterial, tinted())
      expect((m as Tintable).vertexColors, type).toBe(false)
      expect(m.userData.vertexTint, type).toBeUndefined()
    }
  })

  it('does NOT mistake a GLB COLOR_0 attribute for a clone set', () => {
    // Defect 2's guard: `hasVertexTint` reads the stamp, never the attribute.
    const glb = withColorAttribute(plain())
    const m = materialFor(MAT, glb) as THREE.MeshStandardMaterial
    expect(m.vertexColors).toBe(false)
    expect(`#${m.color.getHexString()}`).toBe('#3366cc')
    expect(m.userData.vertexTint).toBeUndefined()
  })
})

describe('the tint SURVIVES a second sync (regression guard for the Critical)', () => {
  // Every one of the seven, not just `standard`: the original defect was
  // type-specific (each in-place branch rewrites the base colour its own way,
  // and `matcap` — the one type with no colour write at all — escaped it), so a
  // single-type test is exactly what let it ship green.
  for (const type of TINTED_TYPES) {
    it(`${type}: still renders the palette after updateMaterial`, () => {
      const mat = { ...MAT, type } as SceneMaterial
      const g = tinted()
      const m = materialFor(mat, g)

      expect((m as Tintable).vertexColors).toBe(true)
      expect(m.userData.vertexTint).toBe(true)
      expect(varyUniforms(m)?.uVaryStrength.value).toBe(1)
      const before = baseColorHex(m)

      // The same spec, the same geometry — nothing about the tint changed, so this
      // is the in-place path (and this is the call that used to undo everything).
      expect(updateMaterial(m, mat, g)).toBe(true)

      expect((m as Tintable).vertexColors).toBe(true)
      expect(m.userData.vertexTint).toBe(true)
      expect(varyUniforms(m)?.uVaryStrength.value).toBe(1)
      // The base colour the tint mixes FROM must survive the sync exactly as it was —
      // this is the property the original Critical destroyed: it neutralised `.color`
      // to white so the palette read true at build time, and every in-place branch of
      // `updateMaterial` then rewrote the base colour from the document one sync later,
      // undoing the neutralisation while the vertex-colour multiply stayed in force.
      // Asserting the CONCRETE colour (not merely "is the tint still on") is what makes
      // this able to fail: a helper that also accepted a neutralised-white base passed
      // on both sides of the bug it existed to catch.
      expect(baseColorHex(m)).toBe(before)
    })
  }
})

describe('vary colour strength', () => {
  it('round-trips the EXPLICIT strength into the uniform', () => {
    const m = materialFor(MAT, tinted(), undefined, 0.4)
    expect(varyUniforms(m)?.uVaryStrength.value).toBe(0.4)
  })

  it('updates IN PLACE — a strength change must never rebuild the material', () => {
    const g = tinted()
    const m = materialFor(MAT, g, undefined, 0.4)
    expect(varyUniforms(m)?.uVaryStrength.value).toBe(0.4)
    // The SAME geometry object: a strength change no longer rebuilds the geometry
    // either, which is the whole point of taking it as a parameter.
    expect(updateMaterial(m, MAT, g, 0.9)).toBe(true)
    expect(varyUniforms(m)?.uVaryStrength.value).toBe(0.9)
  })

  it('defaults to 1 when no strength is supplied', () => {
    const g = plain()
    g.userData.varyTint = true
    expect(varyUniforms(materialFor(MAT, g))?.uVaryStrength.value).toBe(1)
  })

  it('leaves the uniform ALONE when updateMaterial is given no strength', () => {
    // A caller with no opinion must not silently reset a tuned strength to the default.
    const g = tinted()
    const m = materialFor(MAT, g, undefined, 0.4)
    expect(updateMaterial(m, MAT, g)).toBe(true)
    expect(varyUniforms(m)?.uVaryStrength.value).toBe(0.4)
  })

  it('clamps to 0..1', () => {
    expect(varyUniforms(materialFor(MAT, tinted(), undefined, -3))?.uVaryStrength.value).toBe(0)
    expect(varyUniforms(materialFor(MAT, tinted(), undefined, 7))?.uVaryStrength.value).toBe(1)
  })
})

describe('updateMaterial vertex-colour boundary', () => {
  it('updates in place when the tint state is unchanged', () => {
    const m = materialFor(MAT, plain())
    expect(updateMaterial(m, MAT, plain())).toBe(true)
  })

  it('forces a rebuild when the geometry gains the tint stamp', () => {
    const m = materialFor(MAT, plain())
    expect(updateMaterial(m, MAT, tinted())).toBe(false)
  })

  it('forces a rebuild when the geometry loses the tint stamp', () => {
    const m = materialFor(MAT, tinted())
    expect(updateMaterial(m, MAT, plain())).toBe(false)
  })

  it('behaves exactly as before when no geometry is passed', () => {
    const m = materialFor(MAT, plain())
    expect(updateMaterial(m, MAT)).toBe(true)
  })
})

// ── Shader composition ───────────────────────────────────────────────────────
// The injection is only real if the mix line survives into the compiled program in
// the right place. Nothing here can render, so run each material's own
// `onBeforeCompile` against three's REAL ShaderLib source (the same unresolved
// text WebGLRenderer hands it) and resolve the includes exactly as three does.

const SHADER_ID: Record<string, string> = {
  MeshPhysicalMaterial: 'physical',
  MeshStandardMaterial: 'physical',
  MeshToonMaterial: 'toon',
  MeshPhongMaterial: 'phong',
  MeshMatcapMaterial: 'matcap',
}

const INCLUDE = /^[ \t]*#include +<([\w\d./]+)>/gm
function resolveIncludes(src: string): string {
  return src.replace(INCLUDE, (_m, name: string) => resolveIncludes(THREE.ShaderChunk[name as keyof typeof THREE.ShaderChunk] ?? ''))
}

/** Run `m.onBeforeCompile` the way WebGLRenderer does, then resolve includes. */
function compiledFragment(m: THREE.Material): { src: string; uniforms: Record<string, unknown> } {
  const id = SHADER_ID[m.constructor.name]
  expect(id, `no ShaderLib id for ${m.constructor.name}`).toBeDefined()
  const lib = THREE.ShaderLib[id as keyof typeof THREE.ShaderLib]
  const shader = {
    uniforms: {} as Record<string, unknown>,
    vertexShader: lib.vertexShader,
    fragmentShader: lib.fragmentShader,
  }
  m.onBeforeCompile(shader as never, null as never)
  return { src: resolveIncludes(shader.fragmentShader), uniforms: shader.uniforms }
}

const MIX_LINE = 'diffuseColor.rgb = mix( varyBase, vColor.rgb, uVaryStrength );'
const VARY_BASE_DECL = 'vec3 varyBase = diffuseColor.rgb;'

describe('the vary mix reaches the fragment shader, in the right place', () => {
  for (const type of TINTED_TYPES) {
    it(`${type}: mix lands after vColor is declared and after the color_fragment chunk`, () => {
      const m = materialFor({ ...MAT, type } as SceneMaterial, tinted())
      const { src, uniforms } = compiledFragment(m)

      // The uniform is wired into the compiled program, not just held on userData.
      expect(uniforms.uVaryStrength).toBe(varyUniforms(m)!.uVaryStrength)

      const mix = src.indexOf(MIX_LINE)
      expect(mix, 'mix line missing').toBeGreaterThan(-1)

      // `vColor` is in scope: three's color_pars_fragment declares it under USE_COLOR,
      // which `vertexColors = true` turns on, and it is declared BEFORE the mix.
      const decl = src.indexOf('varying vec3 vColor;')
      expect(decl, 'vColor never declared').toBeGreaterThan(-1)
      expect(decl).toBeLessThan(mix)

      // The real color_fragment chunk still ran — we appended to it, not replaced it.
      const chunk = src.indexOf('diffuseColor.rgb *= vColor;')
      expect(chunk, 'color_fragment chunk was replaced, not extended').toBeGreaterThan(-1)
      expect(chunk).toBeLessThan(mix)

      // And `diffuseColor` is still live at that point — it is assigned above and
      // consumed below (lighting), never before. Guarded with toBeGreaterThan(-1) like
      // the assertions above: without it, an ABSENT needle (indexOf === -1) would still
      // satisfy toBeLessThan(mix), since -1 < mix is true, and the assertion would pass
      // vacuously on a declaration that was never found.
      const diffuseColorDecl = src.indexOf('vec4 diffuseColor = vec4( diffuse, opacity );')
      expect(diffuseColorDecl, 'diffuseColor declaration missing').toBeGreaterThan(-1)
      expect(diffuseColorDecl).toBeLessThan(mix)
    })
  }

  it('Finding 1 regression: the mix reads the captured PRE-multiply base, not diffuseColor.rgb', () => {
    // `<color_fragment>`'s real body is `diffuseColor.rgb *= vColor;`, and it runs
    // BEFORE our mix (we reissue the chunk, we don't replace it). If the mix's first
    // argument were `diffuseColor.rgb` instead of a value captured before that multiply,
    // strength 0 would render `material × palette` instead of the plain material colour
    // — the same class of wrongness the whole Vary rework existed to remove.
    const m = materialFor(MAT, tinted())
    const { src } = compiledFragment(m)

    const decl = src.indexOf(VARY_BASE_DECL)
    expect(decl, 'varyBase capture missing').toBeGreaterThan(-1)

    const chunk = src.indexOf('diffuseColor.rgb *= vColor;')
    expect(chunk, 'color_fragment chunk missing').toBeGreaterThan(-1)

    // Capture happens before the multiply, which happens before the mix.
    expect(decl).toBeLessThan(chunk)
    expect(chunk).toBeLessThan(src.indexOf(MIX_LINE))

    // Extract the mix call's actual first argument by regex — a semantic check on
    // WHAT is being mixed FROM, independent of matching the whole literal line, so a
    // reformatted-but-still-wrong mix (e.g. `mix( diffuseColor.rgb, ... )`) cannot slip
    // past by accident.
    const mixCall = src.match(/diffuseColor\.rgb = mix\(\s*([^,]+),/)
    expect(mixCall?.[1].trim(), 'mix call not found').toBe('varyBase')
  })

  it('fresnel: the rim injection reads the ALREADY-tinted surface', () => {
    const m = materialFor({ ...MAT, type: 'fresnel' } as SceneMaterial, tinted())
    const { src } = compiledFragment(m)
    expect(src.indexOf(MIX_LINE)).toBeLessThan(src.indexOf('totalEmissiveRadiance += uRim * rim;'))
  })

  it('holographic: the foil multiplies the ALREADY-tinted base', () => {
    const m = materialFor({ ...MAT, type: 'holographic' } as SceneMaterial, tinted())
    const { src } = compiledFragment(m)
    const mix = src.indexOf(MIX_LINE)
    expect(mix).toBeLessThan(src.indexOf('totalEmissiveRadiance += rainbow * env * uStrength;'))
    // its own diffuseColor mix comes after ours, so it blends the tinted colour
    expect(mix).toBeLessThan(src.indexOf('diffuseColor.rgb * ( 0.35 + rainbow )'))
  })

  it('chains onto applyScreen rather than replacing it', () => {
    const mat = { ...MAT, screen: { pattern: 'dots' } } as SceneMaterial
    const m = materialFor(mat, tinted())
    const { src, uniforms } = compiledFragment(m)
    expect(src).toContain(MIX_LINE)          // ours
    expect(src).toContain('float scrCoverage') // the screen's, still there
    expect(uniforms.uScrPattern).toBeDefined()
    expect(uniforms.uVaryStrength).toBeDefined()
    // Distinct program keys, so a screened+tinted material cannot reuse either one's program.
    expect(String(m.customProgramCacheKey())).toContain('|screen|varyTint')
  })

  it('an untinted material is byte-identical to one built with no geometry at all', () => {
    const a = materialFor(MAT, plain())
    const b = materialFor(MAT)
    expect(compiledFragment(a).src).toBe(compiledFragment(b).src)
    expect(String(a.customProgramCacheKey())).toBe(String(b.customProgramCacheKey()))
    expect(String(a.customProgramCacheKey())).not.toContain('varyTint')
  })
})

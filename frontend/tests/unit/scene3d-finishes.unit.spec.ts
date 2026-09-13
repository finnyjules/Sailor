import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as THREE from 'three'
import { applyFinish, updateFinishUniforms, finishKey, opalescenceRGB, foilShimmerRGB, matcapCoatUV } from '~/lib/scene3d/finishes'
import { createTreatment, type OpalescenceTreatment, type FoilShimmerTreatment, type MatcapCoatTreatment, type FinishTreatment } from '~/lib/scene3d/treatments'
import { MATCAP_IDS } from '~/lib/scene3d/config'

const opal = (overrides: Partial<OpalescenceTreatment> = {}): OpalescenceTreatment =>
  ({ ...createTreatment('opalescence'), ...overrides } as OpalescenceTreatment)
const foil = (overrides: Partial<FoilShimmerTreatment> = {}): FoilShimmerTreatment =>
  ({ ...createTreatment('foilShimmer'), ...overrides } as FoilShimmerTreatment)
const matcap = (overrides: Partial<MatcapCoatTreatment> = {}): MatcapCoatTreatment =>
  ({ ...createTreatment('matcapCoat'), ...overrides } as MatcapCoatTreatment)

// ── Byte-identity: the S5 non-negotiable ─────────────────────────────────────
// `applyFinish(m, [])` must be a COMPLETE no-op — same compiled fragment source, same
// customProgramCacheKey, no userData stamp at all — so an object with no finish treatment
// builds/compiles exactly as it did before this feature existed. Written RED-first against a
// version of `applyFinish` with no early-out (which touches the material unconditionally); only
// once the `finishes.length === 0` guard is in place does this go green — proving the guard is
// actually load-bearing, not merely present.
describe('applyFinish: byte-identical when absent', () => {
  it('does not touch onBeforeCompile, the cache key, or userData when finishes is empty', () => {
    const before = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const beforeCompile = before.onBeforeCompile
    const beforeKey = String(before.customProgramCacheKey())

    applyFinish(before, [])

    expect(before.onBeforeCompile).toBe(beforeCompile)
    expect(String(before.customProgramCacheKey())).toBe(beforeKey)
    expect(before.userData.finishUniforms).toBeUndefined()
  })

  it('an untinted, unscreened, unfinished material compiles identically to one built before applyFinish ever ran', () => {
    // Two independently constructed materials of the same type/colour, one that had
    // `applyFinish(m, [])` called on it and one that never saw finishes.ts at all — their
    // resolved fragment source and cache key must be indistinguishable.
    const a = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const b = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(a, [])
    expect(String(a.customProgramCacheKey())).toBe(String(b.customProgramCacheKey()))
  })
})

describe('finishKey', () => {
  it('is empty for no finishes', () => {
    expect(finishKey([])).toBe('')
  })
  it('is ordered and kind-based', () => {
    const a = opal({ id: 'a' })
    const b = opal({ id: 'b' })
    expect(finishKey([a, b])).toBe('|fin:opalescence,opalescence')
  })
})

// ── The injection reaches the compiled program ───────────────────────────────
const INCLUDE = /^[ \t]*#include +<([\w\d./]+)>/gm
function resolveIncludes(src: string): string {
  return src.replace(INCLUDE, (_m, name: string) => resolveIncludes(THREE.ShaderChunk[name as keyof typeof THREE.ShaderChunk] ?? ''))
}
function compiledFragment(m: THREE.Material): { src: string; uniforms: Record<string, unknown> } {
  const lib = THREE.ShaderLib.physical
  const shader = { uniforms: {} as Record<string, unknown>, vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader }
  m.onBeforeCompile(shader as never, null as never)
  return { src: resolveIncludes(shader.fragmentShader), uniforms: shader.uniforms }
}

describe('applyFinish: the opalescence body reaches the fragment shader, in the right place', () => {
  it('injects right before dithering_fragment, after gl_FragColor exists', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const t = opal()
    applyFinish(m, [t])
    const { src, uniforms } = compiledFragment(m)

    expect(uniforms.uFinOpalStrength_0).toBeDefined()
    expect(uniforms.uFinOpalRamp_0).toBeDefined()

    const bodyIdx = src.indexOf('finRainbow_0')
    expect(bodyIdx, 'finish body missing').toBeGreaterThan(-1)

    const glFragColorAssign = src.indexOf('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')
    expect(glFragColorAssign, 'gl_FragColor assignment missing').toBeGreaterThan(-1)
    expect(glFragColorAssign).toBeLessThan(bodyIdx)

    // The mix WRITES gl_FragColor.rgb — must land before three's own dithering noise touches it.
    const ditherMarker = src.lastIndexOf('gl_FragColor.rgb') // our own write is one occurrence
    expect(ditherMarker).toBeGreaterThanOrEqual(bodyIdx)
  })

  it('the uniform declarations are prepended at the top, above void main()', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [opal()])
    const { src } = compiledFragment(m)
    const decl = src.indexOf('uniform float uFinOpalStrength_0;')
    expect(decl).toBeGreaterThan(-1)
    expect(decl).toBeLessThan(src.indexOf('void main()'))
  })

  it('chains onto the base material — the physical shader body is still present', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [opal()])
    const { src } = compiledFragment(m)
    expect(src).toContain('#define STANDARD')
    expect(src).toContain('ReflectedLight reflectedLight')
  })

  it('two stacked finishes both land, in stack order, each with its own suffixed uniforms', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [opal({ id: 'a' }), opal({ id: 'b' })])
    const { src, uniforms } = compiledFragment(m)
    expect(uniforms.uFinOpalStrength_0).toBeDefined()
    expect(uniforms.uFinOpalStrength_1).toBeDefined()
    const i0 = src.indexOf('finRainbow_0')
    const i1 = src.indexOf('finRainbow_1')
    expect(i0).toBeGreaterThan(-1)
    expect(i1).toBeGreaterThan(i0)
    // Both still precede the very end of main() — neither landed after everything.
    expect(i1).toBeLessThan(src.lastIndexOf('}'))
  })

  it('the injected cache key is distinct from the unfinished one and order-sensitive', () => {
    const m1 = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const plainKey = String(m1.customProgramCacheKey())
    applyFinish(m1, [opal({ id: 'a' })])
    expect(String(m1.customProgramCacheKey())).not.toBe(plainKey)
    expect(String(m1.customProgramCacheKey())).toContain('|fin:opalescence')
  })
})

describe('applyFinish: the foil-shimmer body reaches the fragment shader, in the right place', () => {
  it('injects right before dithering_fragment, after gl_FragColor exists', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [foil()])
    const { src, uniforms } = compiledFragment(m)

    expect(uniforms.uFinFoilStrength_0).toBeDefined()
    expect(uniforms.uFinFoilRamp_0).toBeDefined()

    const bodyIdx = src.indexOf('finRainbow_0')
    expect(bodyIdx, 'finish body missing').toBeGreaterThan(-1)

    const glFragColorAssign = src.indexOf('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')
    expect(glFragColorAssign, 'gl_FragColor assignment missing').toBeGreaterThan(-1)
    expect(glFragColorAssign).toBeLessThan(bodyIdx)
  })

  it('guards directionalLights[0] with #if NUM_DIR_LIGHTS > 0 — a lightless scene must not read past an empty array', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [foil()])
    const { src } = compiledFragment(m)
    const bodyIdx = src.indexOf('finRainbow_0')
    const guardIdx = src.lastIndexOf('#if NUM_DIR_LIGHTS > 0', bodyIdx)
    expect(guardIdx, 'no NUM_DIR_LIGHTS guard before the foil body').toBeGreaterThan(-1)
    const elseIdx = src.indexOf('#else', guardIdx)
    expect(elseIdx).toBeGreaterThan(guardIdx)
    expect(elseIdx).toBeLessThan(bodyIdx)
  })

  it('is additive: writes gl_FragColor.rgb from itself, not a mix() toward the ramp', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [foil()])
    const { src } = compiledFragment(m)
    const line = src.split('\n').find((l) => l.includes('finRainbow_0') && l.includes('gl_FragColor'))
    expect(line, 'no gl_FragColor write referencing finRainbow_0').toBeDefined()
    expect(line).toContain('gl_FragColor.rgb + finRainbow_0')
  })

  it('does not force metalness or roughness — no such uniform/assignment in the injected body', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [foil()])
    const { src } = compiledFragment(m)
    const bodyIdx = src.indexOf('{\n  vec3 finNrm_0')
    const bodyEnd = src.indexOf('\n}', bodyIdx)
    const body = src.slice(bodyIdx, bodyEnd)
    expect(body).not.toMatch(/metalness|roughness/i)
  })

  it('a foil-shimmer and an opalescence finish stack together, each with its own suffixed uniforms', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [opal({ id: 'a' }), foil({ id: 'b' })])
    const { src, uniforms } = compiledFragment(m)
    expect(uniforms.uFinOpalStrength_0).toBeDefined()
    expect(uniforms.uFinFoilStrength_1).toBeDefined()
    const i0 = src.indexOf('finRainbow_0')
    const i1 = src.indexOf('finRainbow_1')
    expect(i0).toBeGreaterThan(-1)
    expect(i1).toBeGreaterThan(i0)
    expect(String(m.customProgramCacheKey())).toContain('|fin:opalescence,foilShimmer')
  })
})

describe('applyFinish: the matcap-coat body reaches the fragment shader, in the right place', () => {
  it('injects right before dithering_fragment, after gl_FragColor exists', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [matcap()])
    const { src, uniforms } = compiledFragment(m)

    expect(uniforms.uFinMatcapStrength_0).toBeDefined()
    expect(uniforms.uFinMatcapTex_0).toBeDefined()

    const bodyIdx = src.indexOf('finMatcap_0')
    expect(bodyIdx, 'finish body missing').toBeGreaterThan(-1)

    const glFragColorAssign = src.indexOf('gl_FragColor = vec4( outgoingLight, diffuseColor.a );')
    expect(glFragColorAssign, 'gl_FragColor assignment missing').toBeGreaterThan(-1)
    expect(glFragColorAssign).toBeLessThan(bodyIdx)
  })

  it('is a mix() toward the sampled matcap colour, like opalescence — not additive like foil', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [matcap()])
    const { src } = compiledFragment(m)
    const line = src.split('\n').find((l) => l.includes('finMatcap_0') && l.includes('gl_FragColor'))
    expect(line, 'no gl_FragColor write referencing finMatcap_0').toBeDefined()
    expect(line).toContain('mix( gl_FragColor.rgb, finMatcap_0')
  })

  it('samples the local `normal`, never the raw `vNormal` varying (undeclared under flat shading)', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [matcap()])
    const { src } = compiledFragment(m)
    const bodyIdx = src.indexOf('{\n  vec3 finNrm_0')
    const bodyEnd = src.indexOf('\n}', bodyIdx)
    const body = src.slice(bodyIdx, bodyEnd)
    expect(body).not.toContain('vNormal')
    expect(body).toContain('normalize( normal )')
  })

  it('a matcap coat and an opalescence finish stack together, each with its own suffixed uniforms', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [opal({ id: 'a' }), matcap({ id: 'b' })])
    const { src, uniforms } = compiledFragment(m)
    expect(uniforms.uFinOpalStrength_0).toBeDefined()
    expect(uniforms.uFinMatcapStrength_1).toBeDefined()
    const i0 = src.indexOf('finRainbow_0')
    const i1 = src.indexOf('finMatcap_1')
    expect(i0).toBeGreaterThan(-1)
    expect(i1).toBeGreaterThan(i0)
    expect(String(m.customProgramCacheKey())).toContain('|fin:opalescence,matcapCoat:')
  })

  it('the injected cache key folds in the matcap id, order-sensitively', () => {
    const m1 = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const plainKey = String(m1.customProgramCacheKey())
    applyFinish(m1, [matcap({ id: 'a', matcap: 'gold' })])
    expect(String(m1.customProgramCacheKey())).not.toBe(plainKey)
    expect(String(m1.customProgramCacheKey())).toContain('|fin:matcapCoat:gold')
  })
})

// ── Source guard: the S4 GPU lesson ──────────────────────────────────────────
// "Never interpolate a JS number into a GLSL float context without a decimal" — a bare-int
// operand on either side of `/` makes ANGLE reject the shader at compile, silently no-op'ing the
// whole injection. This finish never bakes a JS number into the GLSL at all (every dial rides a
// uniform; only the stack INDEX is interpolated, and only into identifier names, never into
// arithmetic), so this is a regression guard against a future finish body doing that.
describe('applyFinish: no bare-int GLSL operand (the S4 ANGLE-rejects-float÷int lesson)', () => {
  it('the compiled fragment source contains no integer/integer division', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [opal(), opal({ id: 'b' })])
    const { src } = compiledFragment(m)
    // Look only at the lines our own injection added — a bare-int division of three's OWN
    // shader source (if any existed) is not this module's concern.
    const finLines = src.split('\n').filter((l) => l.includes('_0') || l.includes('_1') || l.includes('uFinOpal'))
    for (const line of finLines) {
      expect(line, `suspicious bare-int division: ${line}`).not.toMatch(/\b\d+\s*\/\s*\d+\b/)
    }
  })

  it('the foil-shimmer body contains no integer/integer division either', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [foil(), foil({ id: 'b' })])
    const { src } = compiledFragment(m)
    const finLines = src.split('\n').filter((l) => l.includes('_0') || l.includes('_1') || l.includes('uFinFoil'))
    for (const line of finLines) {
      expect(line, `suspicious bare-int division: ${line}`).not.toMatch(/\b\d+\s*\/\s*\d+\b/)
    }
  })

  it('the matcap-coat body contains no integer/integer division either', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [matcap(), matcap({ id: 'b' })])
    const { src } = compiledFragment(m)
    const finLines = src.split('\n').filter((l) => l.includes('_0') || l.includes('_1') || l.includes('uFinMatcap'))
    for (const line of finLines) {
      expect(line, `suspicious bare-int division: ${line}`).not.toMatch(/\b\d+\s*\/\s*\d+\b/)
    }
  })
})

// ── Ramp texture colour space: the S5 review Critical ────────────────────────
// The finish injects at the TERMINAL `<dithering_fragment>` anchor, which runs AFTER
// `<colorspace_fragment>` has already display-encoded `gl_FragColor` — so `texture2D` on the
// ramp must return the raw authored sRGB bytes, unmodified. Tagging the DataTexture
// `THREE.SRGBColorSpace` (correct at opal's ORIGINAL emissivemap_fragment site in materials.ts,
// which is pre-tonemap/scene-linear) is wrong here: it makes the GPU decode sRGB→linear on every
// sample, so the `mix(gl_FragColor.rgb, finRainbow, strength)` blends a LINEAR sample into a
// DISPLAY-ENCODED buffer — the rainbow renders darker/less saturated than OPAL_DEFAULT_STOPS at
// every strength > 0.
describe('applyFinish: the opalescence ramp texture is display-space (no GPU decode)', () => {
  it('tags the ramp DataTexture NoColorSpace, not SRGBColorSpace', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [opal()])
    const { uniforms } = compiledFragment(m)
    const ramp = (uniforms.uFinOpalRamp_0 as { value: THREE.DataTexture }).value
    expect(ramp.colorSpace).toBe(THREE.NoColorSpace)
  })
})

// Foil shimmer's grating adds `finRainbow_i * env * strength` straight into the already
// display-encoded `gl_FragColor.rgb` — the same terminal anchor, so the same colour-space rule
// applies: the ramp it samples (in fact the SAME shared texture object opalescence uses, see
// finishes.ts's `opalRamp()`) must be NoColorSpace, never SRGBColorSpace.
describe('applyFinish: the foil-shimmer ramp texture is display-space (no GPU decode)', () => {
  it('tags the ramp DataTexture NoColorSpace, not SRGBColorSpace', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [foil()])
    const { uniforms } = compiledFragment(m)
    const ramp = (uniforms.uFinFoilRamp_0 as { value: THREE.DataTexture }).value
    expect(ramp.colorSpace).toBe(THREE.NoColorSpace)
  })
})

// The matcap-coat finish's `mix()` writes gl_FragColor.rgb straight from a `texture2D` sample, at
// the same terminal display-space anchor as opal/foil — so the SAME colour-space rule applies:
// the sampled texture must be NoColorSpace, never SRGBColorSpace. Unlike opal/foil's ramp,
// though, this finish's texture is NOT shared with materials.ts's `getMatcap()` cache (the
// `type:'matcap'` MATERIAL's own texture, tagged SRGBColorSpace — correct THERE, since that
// material samples it upstream of tonemapping/colour-space encode) — see finishes.ts's
// `matcapFinishTexture` for why mutating that shared instance's tag in place would be wrong.
//
// `matcapFinishTexture`'s `document` check is DYNAMIC (`typeof document === 'undefined'`, read on
// every call — unlike materials.ts's `hasDOM`, a module-level constant frozen at import time,
// long before this suite runs), so stubbing `document` with a fake `<canvas>` here (this
// codebase's established pattern for canvas-touching code under vitest's node environment — see
// scene3d-relief-shaderfield-heal.unit.spec.ts) is enough to exercise the real draw path.
function fakeMatcapCanvas(): HTMLCanvasElement {
  const ctx = {
    createRadialGradient: () => ({ addColorStop: () => {} }),
    fillRect: () => {},
    fillStyle: '',
  }
  return {
    width: 0, height: 0,
    getContext: (type: string) => (type === '2d' ? ctx : null),
  } as unknown as HTMLCanvasElement
}

describe('applyFinish: the matcap-coat texture is display-space (no GPU decode) and NOT the shared getMatcap() instance', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => fakeMatcapCanvas() })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('tags its own texture NoColorSpace, not SRGBColorSpace', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [matcap()])
    const { uniforms } = compiledFragment(m)
    const tex = (uniforms.uFinMatcapTex_0 as { value: THREE.Texture | null }).value
    expect(tex).not.toBeNull()
    expect(tex!.colorSpace).toBe(THREE.NoColorSpace)
  })

  it('caches its own texture per matcap id — two finishes with the same id share ONE instance', () => {
    const a = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const b = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(a, [matcap({ matcap: 'gold' })])
    applyFinish(b, [matcap({ matcap: 'gold' })])
    const texA = (compiledFragment(a).uniforms.uFinMatcapTex_0 as { value: THREE.Texture }).value
    const texB = (compiledFragment(b).uniforms.uFinMatcapTex_0 as { value: THREE.Texture }).value
    expect(texA).toBe(texB)
  })

  it("never calls materials.ts's shared getMatcap() — builds its own texture via drawMatcap instead", async () => {
    const materials = await import('~/lib/scene3d/materials')
    const spy = vi.spyOn(materials, 'getMatcap')
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [matcap()])
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

// ── CPU twin ──────────────────────────────────────────────────────────────────
describe('opalescenceRGB (CPU twin)', () => {
  const white: [number, number, number] = [1, 1, 1]
  const black: [number, number, number] = [0, 0, 0]
  const flatRamp = (rgb: readonly [number, number, number]) => () => rgb

  it('strength 0 leaves the base colour untouched', () => {
    const out = opalescenceRGB(
      [0.2, 0.3, 0.4], [0, 1, 0], [0, 0, 1],
      { hueShiftNorm: 0, frequency: 1.5, angleMix: 0.6, strength: 0 },
      flatRamp([1, 0, 0]),
    )
    expect(out).toEqual([0.2, 0.3, 0.4])
  })

  it('strength 1 fully replaces with the sampled ramp colour', () => {
    const out = opalescenceRGB(
      black, [0, 1, 0], [0, 0, 1],
      { hueShiftNorm: 0, frequency: 1.5, angleMix: 0.6, strength: 1 },
      flatRamp([0.5, 0.25, 0.75]),
    )
    expect(out[0]).toBeCloseTo(0.5)
    expect(out[1]).toBeCloseTo(0.25)
    expect(out[2]).toBeCloseTo(0.75)
  })

  it('blends linearly at intermediate strengths', () => {
    const out = opalescenceRGB(
      black, [0, 1, 0], [0, 0, 1],
      { hueShiftNorm: 0, frequency: 1.5, angleMix: 0, strength: 0.5 },
      flatRamp(white),
    )
    expect(out[0]).toBeCloseTo(0.5)
    expect(out[1]).toBeCloseTo(0.5)
    expect(out[2]).toBeCloseTo(0.5)
  })

  it('is deterministic — same inputs, same output', () => {
    const args = [[0.1, 0.2, 0.3], [0.3, 0.9, 0.1], [0.4, 0.2, 0.8],
      { hueShiftNorm: 0.2, frequency: 2, angleMix: 0.4, strength: 0.7 },
      flatRamp([0.9, 0.1, 0.5])] as const
    // @ts-expect-error spreading a readonly tuple into positional args
    const a = opalescenceRGB(...args)
    // @ts-expect-error spreading a readonly tuple into positional args
    const b = opalescenceRGB(...args)
    expect(a).toEqual(b)
  })

  it('normal.y drives the normal-term half of the mix (angleMix 0)', () => {
    // frequency 0.5 so up's nterm (1) and down's (0) land on DIFFERENT ramp positions after
    // fract() — frequency 1 would wrap both to the same sample (fract(1) === fract(0) === 0),
    // which is a property of fract(), not evidence the normal term was ignored.
    const up = opalescenceRGB(black, [0, 1, 0], [0, 0, 1], { hueShiftNorm: 0, frequency: 0.5, angleMix: 0, strength: 1 }, (s) => [s, s, s])
    const down = opalescenceRGB(black, [0, -1, 0], [0, 0, 1], { hueShiftNorm: 0, frequency: 0.5, angleMix: 0, strength: 1 }, (s) => [s, s, s])
    expect(up[0]).not.toBeCloseTo(down[0]!, 3)
  })

  it('wraps past 1 via fract()', () => {
    const out = opalescenceRGB(black, [0, 1, 0], [0, 0, 1], { hueShiftNorm: 0.9, frequency: 3, angleMix: 0, strength: 1 }, (s) => {
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(1)
      return [s, s, s]
    })
    expect(out).toBeDefined()
  })
})

// ── CPU twin: foil shimmer ────────────────────────────────────────────────────
// Unlike opalescenceRGB's mix(), this is ADDITIVE — with a flat white ramp and `base` pinned to
// black, the return value IS the raw `env * strength` contribution, which makes the highlight
// geometry assertable in closed form: with `normal = [0,0,1]`, `angle = 0` and the light/view
// pair below, the tangent frame collapses to `tang = [1,0,0]`, `au = 0.5` (inside the smoothstep
// pass-band, so the envelope term is exactly 1) and `dot(normal, h) ≈ 0.866` — leaving only the
// gloss-driven `pow(0.866, glossPow)` term to verify.
describe('foilShimmerRGB (CPU twin)', () => {
  const black: [number, number, number] = [0, 0, 0]
  const flatWhite = () => [1, 1, 1] as const
  // ldir = [0,0,1] (straight-on), vdir = [sin60°, 0, cos60°] — see the comment above for the
  // closed-form geometry this produces.
  const ldir: [number, number, number] = [0, 0, 1]
  const vdir: [number, number, number] = [Math.sin(Math.PI / 3), 0, Math.cos(Math.PI / 3)]
  const normal: [number, number, number] = [0, 0, 1]

  it('strength 0 leaves the base colour untouched', () => {
    const out = foilShimmerRGB(
      [0.2, 0.3, 0.4], normal, vdir, ldir,
      { hueShiftNorm: 0, bands: 3, angleDeg: 0, gloss: 0.5, strength: 0 },
      flatWhite,
    )
    expect(out).toEqual([0.2, 0.3, 0.4])
  })

  it('is additive: a non-zero strength only ever adds to (never subtracts from) the base', () => {
    const out = foilShimmerRGB(
      [0.2, 0.2, 0.2], normal, vdir, ldir,
      { hueShiftNorm: 0, bands: 3, angleDeg: 0, gloss: 0.5, strength: 1 },
      flatWhite,
    )
    expect(out[0]).toBeGreaterThanOrEqual(0.2)
    expect(out[1]).toBeGreaterThanOrEqual(0.2)
    expect(out[2]).toBeGreaterThanOrEqual(0.2)
  })

  it('is deterministic — same inputs, same output', () => {
    const args = [[0.1, 0.2, 0.3], [0.2, 0.4, 0.9], [0.1, 0.1, 1], [0.3, 0.1, 0.9],
      { hueShiftNorm: 0.2, bands: 4, angleDeg: 35, gloss: 0.6, strength: 0.8 },
      flatWhite] as const
    // @ts-expect-error spreading a readonly tuple into positional args
    const a = foilShimmerRGB(...args)
    // @ts-expect-error spreading a readonly tuple into positional args
    const b = foilShimmerRGB(...args)
    expect(a).toEqual(b)
  })

  it('a null lightDir (no directional light) falls back to the same forward direction the shader guard uses', () => {
    const withLight = foilShimmerRGB(black, normal, vdir, [0, 0, 1], { hueShiftNorm: 0, bands: 3, angleDeg: 0, gloss: 0.5, strength: 1 }, flatWhite)
    const noLight = foilShimmerRGB(black, normal, vdir, null, { hueShiftNorm: 0, bands: 3, angleDeg: 0, gloss: 0.5, strength: 1 }, flatWhite)
    expect(noLight).toEqual(withLight)
  })

  it('higher gloss narrows the highlight — off-peak contribution shrinks as gloss rises', () => {
    const low = foilShimmerRGB(black, normal, vdir, ldir, { hueShiftNorm: 0, bands: 3, angleDeg: 0, gloss: 0, strength: 1 }, flatWhite)
    const high = foilShimmerRGB(black, normal, vdir, ldir, { hueShiftNorm: 0, bands: 3, angleDeg: 0, gloss: 1, strength: 1 }, flatWhite)
    expect(low[0]).toBeGreaterThan(0)
    expect(high[0]).toBeGreaterThan(0)
    expect(high[0]).toBeLessThan(low[0]!)
    // Closed-form check on the geometry the comment above derives: au = 0.5 sits inside the
    // smoothstep pass-band (envelope exactly 1), and dot(normal, h) ≈ 0.866.
    expect(low[0]).toBeCloseTo(0.866, 2)
    expect(high[0]).toBeCloseTo(Math.pow(0.866, 6), 2)
  })

  it('the grating angle picks which surfaces catch the sweep — a 90° turn can extinguish it entirely', () => {
    const onAxis = foilShimmerRGB(black, normal, vdir, ldir, { hueShiftNorm: 0, bands: 3, angleDeg: 0, gloss: 0.5, strength: 1 }, flatWhite)
    const rotated = foilShimmerRGB(black, normal, vdir, ldir, { hueShiftNorm: 0, bands: 3, angleDeg: 90, gloss: 0.5, strength: 1 }, flatWhite)
    expect(onAxis[0]).toBeGreaterThan(0)
    expect(rotated[0]).toBe(0)
  })

  it('wraps the band position past 1 via fract()', () => {
    const out = foilShimmerRGB(black, normal, vdir, ldir, { hueShiftNorm: 0.9, bands: 6, angleDeg: 0, gloss: 0.5, strength: 1 }, (s) => {
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(1)
      return [s, s, s]
    })
    expect(out).toBeDefined()
  })

  it('clamps the additive result to 1 rather than overflowing', () => {
    const out = foilShimmerRGB([0.9, 0.9, 0.9], normal, vdir, ldir, { hueShiftNorm: 0, bands: 3, angleDeg: 0, gloss: 0.5, strength: 2 }, flatWhite)
    expect(out[0]).toBeLessThanOrEqual(1)
    expect(out[1]).toBeLessThanOrEqual(1)
    expect(out[2]).toBeLessThanOrEqual(1)
  })
})

// ── CPU twin: matcap coat's UV lookup ────────────────────────────────────────
// Re-derives three's own meshmatcap.glsl.js formula by hand for one concrete case, so the twin is
// checked against an independently-computed answer, not just against itself.
//
// normal = viewPos = [0, 0, 1] (looking straight at a point facing the camera):
//   viewDir = normalize([0,0,1]) = [0,0,1]
//   x = normalize([viewDir.z, 0, -viewDir.x]) = normalize([1,0,0]) = [1,0,0]
//   y = cross(viewDir, x) = cross([0,0,1],[1,0,0]) = [0*0-1*0, 1*1-0*0, 0*0-0*1] = [0,1,0]
//   uv = (dot(x,normal), dot(y,normal)) * 0.495 + 0.5 = (0,0) * 0.495 + 0.5 = (0.5, 0.5)
// — the dead-centre of the matcap disk, matching the convention every matcap texture is drawn to
// (materials.ts's `drawMatcap` centres its highlight near, and its sphere gradient exactly at,
// the texture's middle).
describe('matcapCoatUV (CPU twin)', () => {
  it('a normal facing straight at the camera samples the centre of the matcap disk', () => {
    const uv = matcapCoatUV([0, 0, 1], [0, 0, 1])
    expect(uv[0]).toBeCloseTo(0.5)
    expect(uv[1]).toBeCloseTo(0.5)
  })

  it('is deterministic — same inputs, same output', () => {
    const args = [[0.3, 0.6, 0.1], [0.2, 0.1, 0.9]] as const
    const a = matcapCoatUV(...args)
    const b = matcapCoatUV(...args)
    expect(a).toEqual(b)
  })

  it('does not require pre-normalized inputs — normalizes normal and viewPos itself', () => {
    const unit = matcapCoatUV([0, 0, 1], [0, 0, 1])
    const scaled = matcapCoatUV([0, 0, 5], [0, 0, 9])
    expect(scaled[0]).toBeCloseTo(unit[0]!)
    expect(scaled[1]).toBeCloseTo(unit[1]!)
  })

  it('a tilted normal moves the sample away from the disk centre', () => {
    const straight = matcapCoatUV([0, 0, 1], [0, 0, 1])
    const tilted = matcapCoatUV([1, 0, 1], [0, 0, 1])
    expect(tilted[0]).not.toBeCloseTo(straight[0]!, 3)
  })

  it('stays within the matcap disk (the 0.495 scale keeps uv inside [0.005, 0.995] for a unit normal)', () => {
    const samples: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0], [1, 1, 1]]
    for (const n of samples) {
      const [u, v] = matcapCoatUV(n, [0, 0, 1])
      expect(u).toBeGreaterThanOrEqual(0.005 - 1e-9)
      expect(u).toBeLessThanOrEqual(0.995 + 1e-9)
      expect(v).toBeGreaterThanOrEqual(0.005 - 1e-9)
      expect(v).toBeLessThanOrEqual(0.995 + 1e-9)
    }
  })
})

describe('updateFinishUniforms', () => {
  it('writes dial values in place when the kind sequence is unchanged', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const t = opal({ strength: 0.4 })
    applyFinish(m, [t])
    const changed = { ...t, strength: 0.9 } as FinishTreatment
    expect(updateFinishUniforms(m, [changed])).toBe(true)
    const bag = (m.userData.finishUniforms as { u: Record<string, { value: unknown }> }[])[0]!.u
    expect(bag.uFinOpalStrength_0!.value).toBe(0.9)
  })

  it('returns false when the finish was removed (rebuild boundary)', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [opal()])
    expect(updateFinishUniforms(m, [])).toBe(false)
  })

  it('returns false when a finish was added to a material that had none', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    expect(updateFinishUniforms(m, [opal()])).toBe(false)
  })

  it('returns true (no-op) when both sides are empty', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    expect(updateFinishUniforms(m, [])).toBe(true)
  })

  it('writes foil-shimmer dial values in place when the kind sequence is unchanged', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const t = foil({ strength: 0.4, bands: 3, angle: 10, hueShift: 20, gloss: 0.2 })
    applyFinish(m, [t])
    const changed = { ...t, strength: 1.2, bands: 5, angle: 90, hueShift: 200, gloss: 0.9 } as FinishTreatment
    expect(updateFinishUniforms(m, [changed])).toBe(true)
    const bag = (m.userData.finishUniforms as { u: Record<string, { value: unknown }> }[])[0]!.u
    expect(bag.uFinFoilStrength_0!.value).toBe(1.2)
    expect(bag.uFinFoilBands_0!.value).toBe(5)
    expect(bag.uFinFoilAngle_0!.value).toBe(90)
    expect(bag.uFinFoilHueShift_0!.value).toBeCloseTo(200 / 360)
    expect(bag.uFinFoilGloss_0!.value).toBe(0.9)
  })

  it('returns false when the finish kind changed (opalescence -> foilShimmer at the same slot)', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    applyFinish(m, [opal()])
    expect(updateFinishUniforms(m, [foil()])).toBe(false)
  })

  it('writes matcap-coat strength in place when the kind and matcap id are unchanged', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const t = matcap({ matcap: 'gold', strength: 0.4 })
    applyFinish(m, [t])
    const changed = { ...t, strength: 0.9 } as FinishTreatment
    expect(updateFinishUniforms(m, [changed])).toBe(true)
    const bag = (m.userData.finishUniforms as { u: Record<string, { value: unknown }> }[])[0]!.u
    expect(bag.uFinMatcapStrength_0!.value).toBe(0.9)
  })

  // The plan's REBUILD requirement: a matcap-id change swaps the sampled texture uniform, so it
  // must NOT update in place like every other finish dial — `updateFinishUniforms` must return
  // `false`, forcing the caller (materials.ts's `updateMaterial`) to rebuild via `materialFor`.
  it('returns false when the matcap id changed — a rebuild boundary, unlike every other dial', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const t = matcap({ matcap: 'chrome' })
    applyFinish(m, [t])
    const changed = { ...t, matcap: 'gold' } as FinishTreatment
    expect(updateFinishUniforms(m, [changed])).toBe(false)
  })

  it('returns true when the matcap id is unchanged even alongside other dial changes', () => {
    const m = new THREE.MeshStandardMaterial({ color: '#3366cc' })
    const t = matcap({ matcap: 'pearl', strength: 0.2 })
    applyFinish(m, [t])
    const changed = { ...t, matcap: 'pearl', strength: 0.8 } as FinishTreatment
    expect(updateFinishUniforms(m, [changed])).toBe(true)
  })
})

// ── finishKey folds in the matcap id (the S5 task 3 rebuild boundary) ────────
describe('finishKey: matcap id fold-in', () => {
  it('folds the matcap id into the key for a matcapCoat entry', () => {
    expect(finishKey([matcap({ matcap: 'gold' })])).toBe('|fin:matcapCoat:gold')
  })

  it('two matcapCoat entries with different ids produce different keys', () => {
    const a = finishKey([matcap({ matcap: 'chrome' })])
    const b = finishKey([matcap({ matcap: 'gold' })])
    expect(a).not.toBe(b)
  })

  it('does not affect non-matcap finish kinds', () => {
    expect(finishKey([opal({ id: 'a' }), foil({ id: 'b' })])).toBe('|fin:opalescence,foilShimmer')
  })
})

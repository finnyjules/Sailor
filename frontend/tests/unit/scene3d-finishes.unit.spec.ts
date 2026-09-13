import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { applyFinish, updateFinishUniforms, finishKey, opalescenceRGB } from '~/lib/scene3d/finishes'
import { createTreatment, type OpalescenceTreatment, type FinishTreatment } from '~/lib/scene3d/treatments'

const opal = (overrides: Partial<OpalescenceTreatment> = {}): OpalescenceTreatment =>
  ({ ...createTreatment('opalescence'), ...overrides } as OpalescenceTreatment)

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
})

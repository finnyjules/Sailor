import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { materialFor, updateMaterial, disposeMaterial, buildRampTexture, MATCAP_IDS, __bindTextureMapsForTest, applyTextureSet } from '~/lib/scene3d/materials'
import { gradientAngles, gradientDirection, MATERIAL_DEFAULTS, type GradientStop, type SceneMaterial } from '~/lib/scene3d/config'

const base = (patch: Partial<SceneMaterial> = {}): SceneMaterial =>
  ({ type: 'standard', color: '#9aa3af', roughness: 0.6, metalness: 0, ...patch })

describe('scene3d materials factory', () => {
  it('maps each type to the right THREE material class', () => {
    expect(materialFor(base())).toBeInstanceOf(THREE.MeshStandardMaterial)
    // standard is a full physical surface now
    expect(materialFor(base())).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    // Phong is a deliberate stylistic addition (hard specular highlight the PBR
    // types cannot reproduce) — see MaterialType's doc in config.ts.
    expect(materialFor(base({ type: 'phong' }))).toBeInstanceOf(THREE.MeshPhongMaterial)
    expect(materialFor(base({ type: 'toon' }))).toBeInstanceOf(THREE.MeshToonMaterial)
    expect(materialFor(base({ type: 'matcap' }))).toBeInstanceOf(THREE.MeshMatcapMaterial)
    expect(materialFor(base({ type: 'glass' }))).toBeInstanceOf(THREE.MeshPhysicalMaterial)
    // Fresnel is a LIT standard material (rim injected as emissive) — like gradient.
    expect(materialFor(base({ type: 'fresnel' }))).toBeInstanceOf(THREE.MeshStandardMaterial)
    // Gradient is a LIT standard material (ramp injected into diffuseColor via
    // onBeforeCompile) — an unlit ShaderMaterial would flatten the surface.
    expect(materialFor(base({ type: 'gradient' }))).toBeInstanceOf(THREE.MeshStandardMaterial)
    expect(materialFor(base({ type: 'image' }))).toBeInstanceOf(THREE.MeshStandardMaterial)
  })

  it('updates in place while type and identity params are unchanged', () => {
    const m = materialFor(base())
    expect(updateMaterial(m, base({ color: '#ff0000', roughness: 0.2 }))).toBe(true)
    expect((m as THREE.MeshStandardMaterial).roughness).toBe(0.2)
  })

  it('requests a rebuild on type change and identity-param change', () => {
    expect(updateMaterial(materialFor(base()), base({ type: 'toon' }))).toBe(false)
    expect(updateMaterial(materialFor(base({ type: 'toon' })), base({ type: 'toon', toonSteps: 5 }))).toBe(false)
    expect(updateMaterial(materialFor(base({ type: 'matcap' })), base({ type: 'matcap', matcap: 'gold' }))).toBe(false)
    expect(updateMaterial(materialFor(base({ type: 'image' })), base({ type: 'image', image: 'a.png' }))).toBe(false)
  })

  it('updates phong params in place', () => {
    const m = materialFor(base({ type: 'phong' })) as THREE.MeshPhongMaterial
    expect(m.shininess).toBe(MATERIAL_DEFAULTS.shininess)
    expect(`#${m.specular.getHexString()}`).toBe(MATERIAL_DEFAULTS.specular)
    expect(updateMaterial(m, base({
      type: 'phong', color: '#ff0000', shininess: 90, specular: '#00ff00',
      emissive: '#111111', emissiveIntensity: 2,
    }))).toBe(true)
    expect(m.shininess).toBe(90)
    expect(`#${m.specular.getHexString()}`).toBe('#00ff00')
    expect(`#${m.emissive.getHexString()}`).toBe('#111111')
    expect(m.emissiveIntensity).toBe(2)
  })

  it('strips alpha from phong colours (8-digit hex must not render white)', () => {
    const m = materialFor(base({ type: 'phong', color: '#ff000080', specular: '#00ff0080' })) as THREE.MeshPhongMaterial
    expect(`#${m.color.getHexString()}`).toBe('#ff0000')
    expect(`#${m.specular.getHexString()}`).toBe('#00ff00')
  })

  it('rebuilds when switching to/from phong', () => {
    expect(updateMaterial(materialFor(base()), base({ type: 'phong' }))).toBe(false)
    expect(updateMaterial(materialFor(base({ type: 'phong' })), base())).toBe(false)
  })

  it('updates glass params in place', () => {
    const m = materialFor(base({ type: 'glass' }))
    expect(updateMaterial(m, base({ type: 'glass', ior: 2.0, thickness: 1.5 }))).toBe(true)
    expect((m as THREE.MeshPhysicalMaterial).ior).toBe(2.0)
  })

  it('renders transmissive surfaces double-sided so the interior is visible', () => {
    // Glass defaults to full transmission → double-sided, so refraction reaches
    // the object's own back walls / interior facets (a solid gem, not a shell).
    expect((materialFor(base({ type: 'glass' })) as THREE.MeshPhysicalMaterial).side).toBe(THREE.DoubleSide)
    // An opaque standard surface stays single-sided.
    expect((materialFor(base()) as THREE.MeshPhysicalMaterial).side).toBe(THREE.FrontSide)
    // A standard surface with transmission dialed up also goes double-sided.
    expect((materialFor(base({ transmission: 0.6 })) as THREE.MeshPhysicalMaterial).side).toBe(THREE.DoubleSide)
  })

  it('flips side and recompiles when transmission crosses zero', () => {
    const m = materialFor(base()) as THREE.MeshPhysicalMaterial
    expect(m.side).toBe(THREE.FrontSide)
    const v0 = m.version
    expect(updateMaterial(m, base({ transmission: 0.8 }))).toBe(true)
    expect(m.side).toBe(THREE.DoubleSide)
    expect(m.version).toBeGreaterThan(v0) // the side define changed → recompile
  })

  it('updates gradient uniforms in place through userData', () => {
    const m = materialFor(base({ type: 'gradient' }))
    expect(updateMaterial(m, base({ type: 'gradient', gradientB: '#112233', gradientAxis: 'z' }))).toBe(true)
    // The axis is now expressed as a direction vector (z preset → +Z).
    expect((m.userData.gradUniforms as any).uDir.value.toArray()).toEqual([0, 0, 1])
  })

  it('rebuilds the gradient when crossing the smooth↔facet program boundary', () => {
    const m = materialFor(base({ type: 'gradient' })) // smooth program
    expect(updateMaterial(m, base({ type: 'gradient', gradientShading: 'faceted' }))).toBe(false)
    expect(updateMaterial(m, base({ type: 'gradient', gradientShading: 'prismatic' }))).toBe(false)
  })

  it('switches faceted↔prismatic in place via the uMode uniform', () => {
    const m = materialFor(base({ type: 'gradient', gradientShading: 'faceted' }))
    expect((m.userData.gradUniforms as any).uMode.value).toBe(1)
    expect(updateMaterial(m, base({ type: 'gradient', gradientShading: 'prismatic' }))).toBe(true)
    expect((m.userData.gradUniforms as any).uMode.value).toBe(2)
  })

  it('updates fresnel rim uniforms in place through userData', () => {
    const m = materialFor(base({ type: 'fresnel' }))
    expect(updateMaterial(m, base({ type: 'fresnel', fresnelPower: 6.5 }))).toBe(true)
    expect((m.userData.fresnelUniforms as any).uPower.value).toBe(6.5)
  })

  it('updates physical params in place and recompiles only on define crossings', () => {
    const m = materialFor(base()) as THREE.MeshPhysicalMaterial
    const v0 = m.version
    // plain param movement: no recompile
    expect(updateMaterial(m, base({ clearcoatRoughness: 0.3, envMapIntensity: 2 }))).toBe(true)
    expect(m.version).toBe(v0)
    // crossing zero on a define-gated param: exactly one recompile
    expect(updateMaterial(m, base({ transmission: 0.5 }))).toBe(true)
    expect(m.version).toBe(v0 + 1)
    // moving within the enabled range: no further recompile
    expect(updateMaterial(m, base({ transmission: 0.7 }))).toBe(true)
    expect(m.version).toBe(v0 + 1)
    // opacity < 1 toggles transparent: recompile
    expect(updateMaterial(m, base({ transmission: 0.7, opacity: 0.5 }))).toBe(true)
    expect(m.version).toBe(v0 + 2)
    expect(m.transparent).toBe(true)
  })

  it('maps attenuationDistance 0 to Infinity (off)', () => {
    const m = materialFor(base({ attenuationDistance: 0 })) as THREE.MeshPhysicalMaterial
    expect(m.attenuationDistance).toBe(Infinity)
    const m2 = materialFor(base({ attenuationDistance: 2 })) as THREE.MeshPhysicalMaterial
    expect(m2.attenuationDistance).toBe(2)
  })

  it('exposes the five matcap ids', () => {
    expect(MATCAP_IDS).toEqual(['chrome', 'clay', 'pearl', 'gold', 'carbon'])
  })
})

// ── Gradient ramp: LUT, uniforms, and the projection-equivalence proof ───────

const gmat = (patch: Partial<SceneMaterial> = {}): SceneMaterial =>
  ({ type: 'gradient', color: '#9aa3af', roughness: 0.6, metalness: 0, ...patch })

const texel = (t: THREE.DataTexture, i: number): [number, number, number] => {
  const d = t.image.data as Uint8Array
  return [d[i * 4]!, d[i * 4 + 1]!, d[i * 4 + 2]!]
}
const uniforms = (m: THREE.Material) => m.userData.gradUniforms as Record<string, { value: any }>

describe('scene3d gradient ramp LUT', () => {
  it('is a 256x1 sRGB clamped texture ready to upload', () => {
    const t = buildRampTexture([{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }])
    expect(t.image.width).toBe(256)
    expect(t.image.height).toBe(1)
    expect((t.image.data as Uint8Array).length).toBe(256 * 4)
    expect(t.colorSpace).toBe(THREE.SRGBColorSpace)
    expect(t.magFilter).toBe(THREE.LinearFilter)
    expect(t.minFilter).toBe(THREE.LinearFilter)
    expect(t.wrapS).toBe(THREE.ClampToEdgeWrapping)
    expect(t.wrapT).toBe(THREE.ClampToEdgeWrapping)
    // `needsUpdate` is a write-only setter on THREE.Texture (it bumps .version
    // and reads back undefined), so the observable effect is the version bump.
    expect(t.version).toBeGreaterThan(0)
  })

  it('places the endpoint colours at the endpoint texels', () => {
    const t = buildRampTexture([{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#0000ff' }])
    expect(texel(t, 0)).toEqual([255, 0, 0])
    expect(texel(t, 255)).toEqual([0, 0, 255])
    // alpha is opaque throughout
    expect((t.image.data as Uint8Array)[3]).toBe(255)
  })

  it('interpolates in sRGB between adjacent stops (matches a CSS gradient)', () => {
    const t = buildRampTexture([{ pos: 0, color: '#000000' }, { pos: 1, color: '#ffffff' }])
    // texel 128 sits at x = 128/255, so the sRGB-space value is 128 exactly.
    expect(texel(t, 128)).toEqual([128, 128, 128])
    // A linear-space blend would land near 188 — assert we are NOT doing that.
    expect(texel(t, 128)[0]).not.toBe(188)
  })

  it('interpolates within the correct segment of a multi-stop ramp', () => {
    const t = buildRampTexture([
      { pos: 0, color: '#000000' }, { pos: 0.5, color: '#ff0000' }, { pos: 1, color: '#00ff00' },
    ])
    // x = 128/255 ≈ 0.50196 → just past the middle stop, so essentially red.
    expect(texel(t, 128)[0]).toBeGreaterThan(250)
    // Quarter point of the first segment: half way from black to red.
    expect(texel(t, 64)).toEqual([128, 0, 0])           // x = 64/255 → f = 0.50196
    // Three-quarter point: half way from red to green.
    expect(texel(t, 191)).toEqual([128, 127, 0])        // x = 191/255 → f = 0.49804
  })

  it('floods the edge colour beyond the outermost stops', () => {
    const t = buildRampTexture([{ pos: 0.25, color: '#ff0000' }, { pos: 0.75, color: '#0000ff' }])
    for (const i of [0, 32, 63]) expect(texel(t, i)).toEqual([255, 0, 0])
    expect(texel(t, 64)).toEqual([255, 0, 0])           // x = 0.25098, first texel past the stop
    for (const i of [192, 220, 255]) expect(texel(t, i)).toEqual([0, 0, 255])
  })

  // The ramp editor deliberately leaves its working array unsorted while a stop
  // is being dragged (sorting live would make the handle jump under the cursor),
  // and that array reaches buildRampTexture on every pointermove. An unsorted
  // array must therefore produce exactly the LUT its sorted equivalent does —
  // otherwise every frame of a stop crossing a neighbour renders a glitched ramp.
  it('is order-independent: unsorted stops build the same LUT as sorted', () => {
    const sorted = [
      { pos: 0, color: '#ff0000' },
      { pos: 0.4, color: '#00ff00' },
      { pos: 0.85, color: '#0000ff' },
    ]
    // Mid-crossing orderings: the middle stop dragged below the first, and past the last.
    const shuffles = [
      [sorted[1]!, sorted[0]!, sorted[2]!],
      [sorted[0]!, sorted[2]!, sorted[1]!],
      [sorted[2]!, sorted[1]!, sorted[0]!],
    ]
    const expected = (buildRampTexture(sorted).image.data as Uint8Array)
    for (const s of shuffles) {
      expect(Array.from(buildRampTexture(s).image.data as Uint8Array))
        .toEqual(Array.from(expected))
    }
  })

  it('reproduces the legacy two-colour endpoints from color + gradientB', () => {
    const t = buildRampTexture([
      { pos: 0, color: '#9aa3af' }, { pos: 1, color: MATERIAL_DEFAULTS.gradientB },
    ])
    expect(texel(t, 0)).toEqual([0x9a, 0xa3, 0xaf])
    expect(texel(t, 255)).toEqual([0x1c, 0x27, 0x40])
  })
})

describe('scene3d gradient uniforms', () => {
  it('seeds direction, type, offset and spread from the document', () => {
    const m = materialFor(gmat({ gradientType: 'radial', gradientOffset: 0.3, gradientSpread: 2 }))
    const u = uniforms(m)
    expect(u.uType!.value).toBe(1)
    expect(u.uOffset!.value).toBe(0.3)
    expect(u.uSpread!.value).toBe(2)
    expect(u.uRamp!.value).toBeInstanceOf(THREE.DataTexture)
    // default axis 'y' → +Y
    expect(u.uDir!.value.toArray()).toEqual([0, 1, 0])
  })

  it('defaults to a linear ramp with no offset and unit spread', () => {
    const u = uniforms(materialFor(gmat()))
    expect(u.uType!.value).toBe(0)
    expect(u.uOffset!.value).toBe(0)
    expect(u.uSpread!.value).toBe(1)
  })

  it('updates direction, type, offset and spread without rebuilding the LUT', () => {
    const m = materialFor(gmat())
    const lut = uniforms(m).uRamp!.value as THREE.DataTexture
    let disposed = false
    lut.addEventListener('dispose', () => { disposed = true })

    expect(updateMaterial(m, gmat({
      gradientYaw: 45, gradientPitch: 10, gradientType: 'radial',
      gradientOffset: -0.4, gradientSpread: 0.5,
    }))).toBe(true)

    const u = uniforms(m)
    expect(u.uRamp!.value).toBe(lut)          // same texture object
    expect(disposed).toBe(false)
    expect(u.uType!.value).toBe(1)
    expect(u.uOffset!.value).toBe(-0.4)
    expect(u.uSpread!.value).toBe(0.5)
    expect(u.uDir!.value.toArray()).toEqual(gradientDirection(45, 10))
  })

  it('swaps and disposes the LUT only when the stops actually change', () => {
    const m = materialFor(gmat())
    const first = uniforms(m).uRamp!.value as THREE.DataTexture
    let disposed = 0
    first.addEventListener('dispose', () => { disposed++ })

    // Same synthesized stops → no rebuild.
    expect(updateMaterial(m, gmat({ gradientOffset: 0.2 }))).toBe(true)
    expect(uniforms(m).uRamp!.value).toBe(first)
    expect(disposed).toBe(0)

    // Colour change moves the synthesized pair → rebuild + dispose the old one.
    expect(updateMaterial(m, gmat({ color: '#ff0000' }))).toBe(true)
    const second = uniforms(m).uRamp!.value as THREE.DataTexture
    expect(second).not.toBe(first)
    expect(disposed).toBe(1)
    expect(texel(second, 0)).toEqual([255, 0, 0])

    // Explicit stops change → another rebuild.
    const stops: GradientStop[] = [
      { pos: 0, color: '#ff0000' }, { pos: 0.5, color: '#00ff00' }, { pos: 1, color: '#0000ff' },
    ]
    expect(updateMaterial(m, gmat({ color: '#ff0000', gradientStops: stops }))).toBe(true)
    expect(uniforms(m).uRamp!.value).not.toBe(second)
    // ...but re-applying the identical stops does not.
    const third = uniforms(m).uRamp!.value
    expect(updateMaterial(m, gmat({ color: '#ff0000', gradientStops: stops.map((s) => ({ ...s })) }))).toBe(true)
    expect(uniforms(m).uRamp!.value).toBe(third)
  })

  it('never rebuilds the material for stops, direction, type, offset or spread', () => {
    const m = materialFor(gmat())
    const identity = m.userData.identity
    expect(updateMaterial(m, gmat({
      gradientStops: [{ pos: 0, color: '#123456' }, { pos: 1, color: '#654321' }],
      gradientType: 'radial', gradientYaw: 12, gradientPitch: 34,
      gradientOffset: 0.9, gradientSpread: 2.5,
    }))).toBe(true)
    expect(m.userData.identity).toBe(identity)
  })

  it('disposes the ramp texture with the material', () => {
    const m = materialFor(gmat())
    let disposed = false
    ;(uniforms(m).uRamp!.value as THREE.DataTexture).addEventListener('dispose', () => { disposed = true })
    disposeMaterial(m)
    expect(disposed).toBe(true)
  })
})

// The default look must not change: the projected-AABB `t` has to reduce to the
// old per-axis formula for each of x/y/z, not merely approximate it. Both
// formulas are ported verbatim from the GLSL so the maths can be checked
// without a GL context.
describe('scene3d gradient projection equivalence', () => {
  type V3 = [number, number, number]
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

  /** The formula the shader used before this change. */
  const oldT = (p: V3, bmin: V3, bmax: V3, axis: 0 | 1 | 2): number =>
    clamp01((p[axis] - bmin[axis]) / Math.max(bmax[axis] - bmin[axis], 1e-5))

  /** The formula the shader uses now (linear branch of gradT). */
  const newT = (p: V3, bmin: V3, bmax: V3, dir: V3): number => {
    const centre = bmin.map((v, i) => (v + bmax[i]!) * 0.5) as V3
    const halfExt = bmin.map((v, i) => (bmax[i]! - v) * 0.5) as V3
    const r = dir.reduce((a, d, i) => a + Math.abs(d) * halfExt[i]!, 0)
    const proj = p.reduce((a, v, i) => a + (v - centre[i]!) * dir[i]!, 0)
    return clamp01((proj + r) / Math.max(2 * r, 1e-5))
  }

  const AXES = [['x', 0], ['y', 1], ['z', 2]] as const
  const BOXES: Array<[V3, V3]> = [
    [[-0.55, -0.55, -0.55], [0.55, 0.55, 0.55]],   // the factory's fallback envelope
    [[-1, -0.5, -2], [1, 0.5, 2]],                  // asymmetric extents
    [[0.25, -3, 1], [2.75, 4, 1.5]],                // off-centre, mixed signs
    [[-1, 0, -1], [1, 0, 1]],                       // degenerate on Y (guard path)
  ]
  const POINTS: V3[] = [
    [0, 0, 0], [-0.55, -0.55, -0.55], [0.55, 0.55, 0.55],
    [0.1, -0.2, 0.3], [1, 0.5, 2], [-3, 7, -0.25], [0.25, 4, 1.5], [2.75, -3, 1],
  ]

  for (const [axis, index] of AXES) {
    it(`reproduces the per-axis formula exactly for ${axis}`, () => {
      const { yaw, pitch } = gradientAngles(gmat({ gradientAxis: axis }))
      const dir = gradientDirection(yaw, pitch) as V3
      for (const [bmin, bmax] of BOXES) {
        for (const p of POINTS) {
          // toBe, not toBeCloseTo: any drift here is a real visual change.
          expect(newT(p, bmin, bmax, dir)).toBe(oldT(p, bmin, bmax, index))
        }
      }
    })
  }

  it('radial spans the bounding radius from the centre', () => {
    const radialT = (p: V3, bmin: V3, bmax: V3): number => {
      const centre = bmin.map((v, i) => (v + bmax[i]!) * 0.5) as V3
      const halfExt = bmin.map((v, i) => (bmax[i]! - v) * 0.5) as V3
      const d = Math.hypot(...p.map((v, i) => v - centre[i]!))
      return clamp01(d / Math.max(Math.hypot(...halfExt), 1e-5))
    }
    const bmin: V3 = [-1, -1, -1], bmax: V3 = [1, 1, 1]
    expect(radialT([0, 0, 0], bmin, bmax)).toBe(0)                 // centre
    expect(radialT([1, 1, 1], bmin, bmax)).toBe(1)                 // corner = radius
    expect(radialT([1, 0, 0], bmin, bmax)).toBeCloseTo(1 / Math.sqrt(3), 12)
  })
})

describe('texture sets', () => {
  const manifest = { id: 'Wood095', maps: ['color', 'roughness', 'normal', 'displacement', 'ao', 'metalness'] as const, fetchedAt: 'x' }

  it('binds every listed map onto a physical material with ao on the primary UVs', () => {
    const m = materialFor(base({ texture: 'ambientcg:Wood095' })) as THREE.MeshPhysicalMaterial
    __bindTextureMapsForTest(m, base({ texture: 'ambientcg:Wood095' }), manifest as any)
    // In node there is no DOM so the texture cache returns null — assert the slots were
    // touched via userData, which the binder stamps regardless (see materials.ts).
    expect(m.userData.textureMaps).toEqual(['color', 'roughness', 'normal', 'displacement', 'ao', 'metalness'])
    expect(m.userData.textureAoChannel).toBe(0)
  })

  it('binds only the maps the manifest lists', () => {
    const m = materialFor(base({ texture: 'ambientcg:X' })) as THREE.MeshPhysicalMaterial
    __bindTextureMapsForTest(m, base({ texture: 'ambientcg:X' }), { id: 'X', maps: ['color'], fetchedAt: 'x' })
    expect(m.userData.textureMaps).toEqual(['color'])
  })

  it('skips non-physical types and unresolved phrases', () => {
    const toon = materialFor(base({ type: 'toon', texture: 'ambientcg:Wood095' }))
    __bindTextureMapsForTest(toon, base({ type: 'toon', texture: 'ambientcg:Wood095' }), manifest as any)
    expect(toon.userData.textureMaps).toBeUndefined()
    const phrase = materialFor(base({ texture: 'wood' }))
    applyTextureSet(phrase, base({ texture: 'wood' }))
    expect(phrase.userData.textureId).toBeUndefined()
  })

  it('leaves the user normal map alone when one is set', () => {
    const mat = base({ texture: 'ambientcg:Wood095', normalImage: 'mine.png' })
    const m = materialFor(mat)
    __bindTextureMapsForTest(m, mat, manifest as any)
    expect(m.userData.textureMaps).not.toContain('normal')
  })

  it('does not use displacement as bump when an explicit relief is on', () => {
    const mat = base({ texture: 'ambientcg:Wood095', relief: { source: 'image', image: 'h.png', scale: 0.3 } })
    const m = materialFor(mat)
    __bindTextureMapsForTest(m, mat, manifest as any)
    expect(m.userData.textureMaps).not.toContain('displacement')
  })

  it('texture change rebuilds; tiling updates in place', () => {
    const m = materialFor(base({ texture: 'ambientcg:Wood095' }))
    expect(updateMaterial(m, base({ texture: 'ambientcg:Bricks075A' }))).toBe(false)
    expect(updateMaterial(m, base({ texture: 'ambientcg:Wood095', textureTiling: 3 }))).toBe(true)
    expect(m.userData.textureTiling).toBe(3)
  })

  // Under node the loader never runs, so these two stamp `userData.textureMaps` by hand and
  // hang stub Textures on the slots — exactly the state a real bind leaves behind. That is
  // what disposal and the retile loop actually read, so the decision IS testable here.
  it('disposal frees only the slots this set bound, leaving a shared-cache normalMap alone', () => {
    const m = materialFor(base({ texture: 'ambientcg:Wood095', normalImage: 'mine.png' })) as THREE.MeshPhysicalMaterial
    const ours = { roughnessMap: new THREE.Texture(), metalnessMap: new THREE.Texture(), aoMap: new THREE.Texture() }
    m.roughnessMap = ours.roughnessMap
    m.metalnessMap = ours.metalnessMap
    m.aoMap = ours.aoMap
    const shared = new THREE.Texture() // the user's own normal map — lives in the shared imageCache
    m.normalMap = shared
    m.userData.textureMaps = ['color', 'roughness', 'metalness', 'ao'] // note: no 'normal'
    const spies = {
      roughness: vi.spyOn(ours.roughnessMap, 'dispose'),
      metalness: vi.spyOn(ours.metalnessMap, 'dispose'),
      ao: vi.spyOn(ours.aoMap, 'dispose'),
      shared: vi.spyOn(shared, 'dispose'),
    }
    disposeMaterial(m)
    expect(spies.roughness).toHaveBeenCalled()
    expect(spies.metalness).toHaveBeenCalled()
    expect(spies.ao).toHaveBeenCalled()
    expect(spies.shared).not.toHaveBeenCalled()
  })

  it('in-place retile touches exactly the stamped slots, not an unstamped bumpMap', () => {
    const m = materialFor(base({ texture: 'ambientcg:Wood095' })) as THREE.MeshPhysicalMaterial
    const color = new THREE.Texture()
    const rough = new THREE.Texture()
    const bump = new THREE.Texture() // an explicit relief's bump — not ours to retile
    m.map = color
    m.roughnessMap = rough
    m.bumpMap = bump
    m.userData.textureMaps = ['color', 'roughness']
    const spies = {
      color: vi.spyOn(color.repeat, 'set'),
      rough: vi.spyOn(rough.repeat, 'set'),
      bump: vi.spyOn(bump.repeat, 'set'),
    }
    expect(updateMaterial(m, base({ texture: 'ambientcg:Wood095', textureTiling: 4 }))).toBe(true)
    expect(spies.color).toHaveBeenCalledWith(4, 4)
    expect(spies.rough).toHaveBeenCalledWith(4, 4)
    expect(spies.bump).not.toHaveBeenCalled()
  })

  it('does not apply a texture set to a disposed material', () => {
    // The async `.then` guard itself is DOM-only (node never reaches the loader), so this
    // exercises the synchronous half: a disposed material is not even stamped.
    const m = materialFor(base({ texture: 'ambientcg:Wood095' }))
    disposeMaterial(m)
    expect(m.userData.disposed).toBe(true)
    const fresh = new THREE.MeshPhysicalMaterial()
    fresh.userData.disposed = true
    expect(() => applyTextureSet(fresh, base({ texture: 'ambientcg:Wood095' }))).not.toThrow()
    expect(fresh.userData.textureId).toBeUndefined()
  })
})

describe('image material texture ownership', () => {
  it('stamps the live spec so the async loader can re-apply the transform', () => {
    const mat = base({ type: 'image', image: 'a.png', imageTiling: 3 })
    const m = materialFor(mat)
    expect(m.userData.imageSpec).toBe(mat)
    const next = base({ type: 'image', image: 'a.png', imageTiling: 5 })
    expect(updateMaterial(m, next)).toBe(true)
    expect(m.userData.imageSpec).toBe(next)
  })

  it('applies the transform to a map it owns, without rebuilding', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    // Node has no DOM, so the loader never binds a map — stand one in, exactly as the
    // normal-map sharing test below does, and prove updateMaterial retiles it in place.
    m.map = new THREE.Texture()
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageTiling: 4, imageWrap: 'tile' }))).toBe(true)
    expect(m.map.repeat.x).toBe(4)
    expect(m.map.wrapS).toBe(THREE.RepeatWrapping)
  })

  it('disposing one image material leaves another on the same file untouched', () => {
    const a = materialFor(base({ type: 'image', image: 'shared.png' })) as THREE.MeshStandardMaterial
    const b = materialFor(base({ type: 'image', image: 'shared.png' })) as THREE.MeshStandardMaterial
    a.map = new THREE.Texture()
    b.map = new THREE.Texture()
    expect(a.map).not.toBe(b.map)
    const disposed = vi.fn()
    b.map.addEventListener('dispose', disposed)
    disposeMaterial(a)
    expect(disposed).not.toHaveBeenCalled()
  })
})

describe('image fit', () => {
  it('is an identity transform until the natural size lands, then crops', () => {
    const mat = base({ type: 'image', image: 'a.png', imageFit: 'cover' })
    const m = materialFor(mat) as THREE.MeshStandardMaterial
    m.map = new THREE.Texture()
    // No natural size yet — a wide picture must not be pre-cropped on a guess.
    expect(updateMaterial(m, mat)).toBe(true)
    expect(m.map.repeat.x).toBe(1)
    // The loader's onLoad fills this; simulate it and re-run the in-place update.
    m.userData.imageNatural = { w: 200, h: 100 }
    expect(updateMaterial(m, mat)).toBe(true)
    expect(m.map.repeat.x).toBeCloseTo(0.5)
    expect(m.map.offset.x).toBeCloseTo(0.25)
  })

  it('does not force a rebuild when only the fit changes', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageFit: 'contain' }))).toBe(true)
  })
})

describe('image tint', () => {
  it('defaults to white so an untinted picture is unchanged', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    expect(`#${m.color.getHexString()}`).toBe('#ffffff')
  })

  it('multiplies the picture by the tint, in place', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageTint: '#ff8800' }))).toBe(true)
    expect(`#${m.color.getHexString()}`).toBe('#ff8800')
  })

  it('accepts the eight-digit hex the studio colour picker emits', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', imageTint: '#ff8800cc' })) as THREE.MeshStandardMaterial
    expect(`#${m.color.getHexString()}`).toBe('#ff8800')
  })

  it('ignores the document colour, which this type has never read', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', color: '#00ff00' })) as THREE.MeshStandardMaterial
    expect(`#${m.color.getHexString()}`).toBe('#ffffff')
  })
})

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

  // The "disposing one image material leaves another on the same file untouched" case used
  // to live here as a hand-assigned-Texture test — vacuous, since it hand-built the very fact
  // it then asserted, regardless of whether ownedImageTexture's per-material ownership exists.
  // scene3d-image-texture-ownership.unit.spec.ts (happy-dom) covers the property for real, by
  // taking materialFor's actual TextureLoader path.
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

describe('image glow', () => {
  it('is off by default', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    expect(m.emissiveMap).toBeNull()
    expect(m.emissiveIntensity).toBe(1)
  })

  it('binds the same texture as the emissive map and drives its intensity', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    m.map = new THREE.Texture()
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageGlow: 2 }))).toBe(true)
    expect(m.emissiveMap).toBe(m.map)
    expect(m.emissiveIntensity).toBe(2)
    // The emissive colour must be white, or the map is multiplied into black and nothing glows.
    expect(`#${m.emissive.getHexString()}`).toBe('#ffffff')
  })

  it('unbinds when the glow returns to zero', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial
    m.map = new THREE.Texture()
    updateMaterial(m, base({ type: 'image', image: 'a.png', imageGlow: 2 }))
    updateMaterial(m, base({ type: 'image', image: 'a.png', imageGlow: 0 }))
    expect(m.emissiveMap).toBeNull()
    expect(`#${m.emissive.getHexString()}`).toBe('#000000')
  })

  it('is a no-op on the flat variant, which has no emissive slot', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', unlit: true, imageGlow: 2 }))
    expect((m as unknown as { emissiveMap?: unknown }).emissiveMap).toBeUndefined()
  })

  // Review Finding 1: applyImageGlow's own doc comment names the invariant this must hold —
  // "the glow must line up with the picture". Compiled against THREE's REAL ShaderLib
  // (not a hand-written fixture): the real `emissivemap_fragment` chunk's literal
  // `texture2D( emissiveMap, vEmissiveMapUv )` must be gone from the compiled source, and
  // the shared projected-coordinate helper must appear in its place. Using the real
  // template means this test actually fails if the emissivemap_fragment replacement in
  // materials.ts is ever deleted — a hand-written fixture containing only the bare
  // `#include <emissivemap_fragment>` marker would not catch that regression, since it
  // never contained the bare sample it is supposed to replace.
  it('routes the emissive sample through the same projected coordinate as the diffuse sample under a projection', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', imageGlow: 2, imageProjection: 'spherical' })) as THREE.MeshStandardMaterial
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: THREE.ShaderLib.standard.vertexShader,
      fragmentShader: THREE.ShaderLib.standard.fragmentShader,
    }
    m.onBeforeCompile!(shader as never, null as never)
    expect(shader.fragmentShader).not.toContain('texture2D( emissiveMap, vEmissiveMapUv )')
    expect(shader.fragmentShader).toContain('sailorImageUv( vEmissiveMapUv )')
  })
})

describe('unlit image', () => {
  it('builds a Basic material so scene lights do not shade the picture', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', unlit: true }))
    expect(m).toBeInstanceOf(THREE.MeshBasicMaterial)
    expect(m).not.toBeInstanceOf(THREE.MeshStandardMaterial)
  })

  it('still applies the tint and the map transform when unlit', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', unlit: true, imageTint: '#ff0000' })) as THREE.MeshBasicMaterial
    expect(`#${m.color.getHexString()}`).toBe('#ff0000')
    m.map = new THREE.Texture()
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', unlit: true, imageTiling: 3, imageOffsetX: 0.25 }))).toBe(true)
    expect(m.map.repeat.x).toBe(3)
    expect(m.map.offset.x).toBe(0.25)
  })

  it('rebuilds when the lit/unlit class boundary is crossed', () => {
    const lit = materialFor(base({ type: 'image', image: 'a.png' }))
    expect(updateMaterial(lit, base({ type: 'image', image: 'a.png', unlit: true }))).toBe(false)
  })

  it('skips roughness and metalness on the Basic variant, which has neither', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', unlit: true }))
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', unlit: true, roughness: 0.2 }))).toBe(true)
    expect((m as unknown as { roughness?: number }).roughness).toBeUndefined()
  })
})

describe('image transparency', () => {
  it('is opaque by default, exactly as before', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    expect(m.transparent).toBe(false)
    expect(m.alphaTest).toBe(0)
    expect(m.opacity).toBe(1)
  })

  it('honours the file alpha when asked', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', imageAlpha: true }))
    expect(m.transparent).toBe(true)
  })

  it('works identically on the unlit (Basic) variant — transparent/opacity/alphaTest are base Material fields', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', unlit: true, imageAlpha: true, imageCutout: 0.3, opacity: 1 }))
    expect(m).toBeInstanceOf(THREE.MeshBasicMaterial)
    expect(m.alphaTest).toBe(0.3)
    // A pure cutout with opacity at 1 stays non-transparent, exactly as on the Standard branch.
    expect(m.transparent).toBe(false)
  })

  it('turns a cutout into alphaTest rather than blending', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', imageAlpha: true, imageCutout: 0.5 }))
    expect(m.alphaTest).toBe(0.5)
  })

  it('ignores the cutout while the file alpha is off', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', imageCutout: 0.5 }))
    expect(m.alphaTest).toBe(0)
  })

  it('makes the whole surface see-through from opacity', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', opacity: 0.4 }))
    expect(m.opacity).toBe(0.4)
    expect(m.transparent).toBe(true)
  })

  it('recompiles only when a define boundary is actually crossed', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    m.version = 0
    // A move within the opaque range must not recompile.
    updateMaterial(m, base({ type: 'image', image: 'a.png', imageTiling: 2 }))
    expect(m.version).toBe(0)
    // Crossing into transparency must.
    updateMaterial(m, base({ type: 'image', image: 'a.png', opacity: 0.5 }))
    expect(m.version).toBeGreaterThan(0)
  })
})

describe('image adjustments', () => {
  it('carries a live uniform bucket that updates without a rebuild', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' })) as THREE.MeshStandardMaterial & { userData: { imageUniforms: { uImgContrast: { value: number } } } }
    const u = m.userData.imageUniforms
    expect(u.uImgContrast.value).toBe(1)
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageContrast: 1.6 }))).toBe(true)
    expect(m.userData.imageUniforms).toBe(u)
    expect(u.uImgContrast.value).toBe(1.6)
  })

  it('injects the adjustment into the compiled fragment shader, and the vertex splice that feeds it', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: 'void main() {\n#include <begin_vertex>\n}',
      fragmentShader: 'void main() {\n#include <map_fragment>\n}',
    }
    m.onBeforeCompile!(shader as never, null as never)
    expect(shader.fragmentShader).toContain('sailorImageAdjust')
    // Task 11: imageMapFragment REPLACES the include outright (the projection has to choose
    // the coordinate before the sample) rather than appending after it as the plain
    // adjustment did — so the literal include tag is gone from the compiled source.
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>')
    expect(shader.uniforms.uImgContrast).toBe((m.userData.imageUniforms as { uImgContrast: unknown }).uImgContrast)
    // Review Finding 2: `vImgPos`/`vImgNrm` are declared as varyings in the fragment stage
    // (asserted via sailorImageAdjust's surrounding pars block above) but only ASSIGNED in
    // the vertex stage — deleting that vertex splice would blank every image material
    // (fails to link) while every fragment-only assertion above kept passing. Assert the
    // vertex side directly rather than only its fragment-side consumer.
    expect(shader.vertexShader).toContain('varying vec3 vImgPos;')
    expect(shader.vertexShader).toContain('varying vec3 vImgNrm;')
    expect(shader.vertexShader).toContain('vImgPos = position;')
    expect(shader.vertexShader).toContain('vImgNrm = normal;')
  })

  // The whole design point of Task 10: brightness/contrast/saturation are injected
  // UNCONDITIONALLY with identity defaults specifically so moving them never crosses a
  // program-define boundary. Tasks 8/9 each asserted the "bumps on a boundary crossing"
  // half of this kind of contract but not the "does NOT bump within a range" half — this
  // is the one property this feature exists for, so it must be asserted directly, not
  // just implied by the absence of a `needsUpdate` write in the source.
  it('never recompiles when brightness, contrast or saturation move — that is the entire design point', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    m.version = 0
    updateMaterial(m, base({ type: 'image', image: 'a.png', imageBrightness: 0.4, imageContrast: 1.7, imageSaturation: 0 }))
    expect(m.version).toBe(0)
  })

  it('also injects on the unlit (Basic) variant, which has no roughness/metalness slot but still has <map_fragment>', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', unlit: true }))
    expect(m).toBeInstanceOf(THREE.MeshBasicMaterial)
    // Review Finding 2: a realistic (non-empty) vertexShader, not '', so the vertex splice
    // on the unlit path is exercised and asserted exactly like the lit variant above —
    // the Basic material's onBeforeCompile runs the same vertex splice unconditionally.
    const shader = {
      uniforms: {} as Record<string, unknown>,
      vertexShader: 'void main() {\n#include <begin_vertex>\n}',
      fragmentShader: 'void main() {\n#include <map_fragment>\n}',
    }
    m.onBeforeCompile!(shader as never, null as never)
    expect(shader.fragmentShader).toContain('sailorImageAdjust')
    expect(shader.vertexShader).toContain('varying vec3 vImgPos;')
    expect(shader.vertexShader).toContain('varying vec3 vImgNrm;')
    expect(shader.vertexShader).toContain('vImgPos = position;')
    expect(shader.vertexShader).toContain('vImgNrm = normal;')
    m.version = 0
    updateMaterial(m, base({ type: 'image', image: 'a.png', unlit: true, imageBrightness: 0.2 }))
    expect(m.version).toBe(0)
  })
})

describe('image projection', () => {
  it('reads the object bounds from the geometry it is built against', () => {
    const geo = new THREE.BoxGeometry(2, 4, 6)
    const m = materialFor(base({ type: 'image', image: 'a.png', imageProjection: 'planar' }), geo)
    const u = m.userData.imageUniforms as { uImgBoundsSize: { value: THREE.Vector3 } }
    expect(u.uImgBoundsSize.value.x).toBeCloseTo(2)
    expect(u.uImgBoundsSize.value.y).toBeCloseTo(4)
    expect(u.uImgBoundsSize.value.z).toBeCloseTo(6)
  })

  it('never divides by a zero extent on a flat object', () => {
    const geo = new THREE.PlaneGeometry(2, 2)
    const m = materialFor(base({ type: 'image', image: 'a.png', imageProjection: 'planar' }), geo)
    const u = m.userData.imageUniforms as { uImgBoundsSize: { value: THREE.Vector3 } }
    expect(u.uImgBoundsSize.value.z).toBeGreaterThan(0)
  })

  // Addition B (required beyond the brief): Tasks 8 and 9 each shipped a ONE-SIDED
  // define-boundary test. Both directions of the recompile contract must be asserted:
  // the four single-sample modes share a program and switch on a uniform (no rebuild, no
  // version bump), while 'box' is a genuinely different program (three samples instead of
  // one) and MUST force a rebuild.
  it('switches between the four single-sample modes without a rebuild or a version bump', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    m.version = 0
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageProjection: 'spherical' }))).toBe(true)
    expect(m.version).toBe(0)
    expect((m.userData.imageUniforms as { uImgProjMode: { value: number } }).uImgProjMode.value).toBe(3)
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageProjection: 'planar' }))).toBe(true)
    expect(m.version).toBe(0)
    expect((m.userData.imageUniforms as { uImgProjMode: { value: number } }).uImgProjMode.value).toBe(1)
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageProjection: 'cylindrical' }))).toBe(true)
    expect(m.version).toBe(0)
    expect((m.userData.imageUniforms as { uImgProjMode: { value: number } }).uImgProjMode.value).toBe(2)
  })

  it('rebuilds for box, which is a different program', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageProjection: 'box' }))).toBe(false)
  })

  it('gives the box program its own cache key', () => {
    const plain = materialFor(base({ type: 'image', image: 'a.png' }))
    const box = materialFor(base({ type: 'image', image: 'a.png', imageProjection: 'box' }))
    expect(plain.customProgramCacheKey!()).not.toBe(box.customProgramCacheKey!())
  })
})

describe('image seamless edge blend', () => {
  // Important 3 (final review): Seamless USED to force a rebuild on every change — a fresh
  // TextureLoader fetch + decode + five canvases per drag tick, since it shipped as a
  // continuous 0–0.45 slider rather than the "discrete decision" the old comment assumed.
  // The fix takes it OUT of identityKey entirely and repaints the owned texture's canvas in
  // place instead (the C1-fix shape, see `imageSetSeamless`), so BOTH of these now update in
  // place — no rebuild boundary at all, unlike the box-projection pair above.
  it('updates in place when the Seamless dial changes — no rebuild, repainted in place instead', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png' }))
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageSeamless: 0.15 }))).toBe(true)
    // The in-place block tracks the width it last painted at, so a real repaint request
    // for the new value actually happened rather than being silently skipped.
    expect(m.userData.imageSeamlessApplied).toBeCloseTo(0.15)
  })

  it('does not rebuild for an unrelated change while Seamless stays put', () => {
    const m = materialFor(base({ type: 'image', image: 'a.png', imageSeamless: 0.15 }))
    expect(updateMaterial(m, base({ type: 'image', image: 'a.png', imageSeamless: 0.15, imageTiling: 3 }))).toBe(true)
    // Still 0.15 — the guard must not re-trigger a repaint for a dial that never moved.
    expect(m.userData.imageSeamlessApplied).toBeCloseTo(0.15)
  })

  it('two materials on the same identity share the SAME rebuild key regardless of Seamless', () => {
    // identityKey no longer folds Seamless in — a material built at one width and one built
    // at another must be considered the SAME identity (in-place update, not a rebuild).
    const a = materialFor(base({ type: 'image', image: 'a.png', imageSeamless: 0 }))
    const b = materialFor(base({ type: 'image', image: 'a.png', imageSeamless: 0.3 }))
    expect(a.userData.identity).toBe(b.userData.identity)
  })
})

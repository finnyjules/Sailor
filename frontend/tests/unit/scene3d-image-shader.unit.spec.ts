import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  imageUniforms, writeImageUniforms, refreshImageBounds, IMAGE_FRAGMENT_PARS,
  imageMapFragment, imageEmissiveMapFragment, IMAGE_PROJECT_VERTEX_GLSL, IMAGE_PROJECT_VERTEX_CALL,
} from '~/lib/scene3d/imageShader'
import type { SceneMaterial } from '~/lib/scene3d/config'

const img = (patch: Partial<SceneMaterial> = {}): SceneMaterial =>
  ({ type: 'image', color: '#ffffff', roughness: 0.6, metalness: 0, image: 'a.png', ...patch })

describe('image adjustment uniforms', () => {
  it('defaults to an identity adjustment', () => {
    const u = imageUniforms(img())
    expect(u.uImgBrightness.value).toBe(0)
    expect(u.uImgContrast.value).toBe(1)
    expect(u.uImgSaturation.value).toBe(1)
  })

  it('writes in place, keeping the uniform objects the program holds by reference', () => {
    const u = imageUniforms(img())
    const b = u.uImgBrightness
    writeImageUniforms(u, img({ imageBrightness: 0.3, imageContrast: 1.5, imageSaturation: 0 }))
    expect(u.uImgBrightness).toBe(b)
    expect(b.value).toBe(0.3)
    expect(u.uImgContrast.value).toBe(1.5)
    expect(u.uImgSaturation.value).toBe(0)
  })
})

// Important 2 (final review): imageUniforms reads the bounding box only at BUILD time —
// a geometry can swap in place (param edit, modifier) without a material rebuild, so the
// projection needs its own in-place refresh, exactly mirroring the gradient material's
// uBoxMin/uBoxMax (engine.ts's per-sync bbox refresh). This is the pure function that refresh
// calls; the engine-level wiring is exercised live, not unit-tested, matching how the
// gradient material's own equivalent has never had an engine-level unit test either.
describe('refreshImageBounds — the in-place bbox refresh (Important 2)', () => {
  it('recomputes min/size from the CURRENT geometry, mutating the same Vector3 objects', () => {
    const u = imageUniforms(img())
    const min = u.uImgBoundsMin.value
    const size = u.uImgBoundsSize.value
    const geo = new THREE.BoxGeometry(2, 4, 6)
    refreshImageBounds(u, geo)
    expect(u.uImgBoundsMin.value).toBe(min)   // same object — the compiled program's reference
    expect(u.uImgBoundsSize.value).toBe(size)
    expect(min.x).toBeCloseTo(-1); expect(min.y).toBeCloseTo(-2); expect(min.z).toBeCloseTo(-3)
    expect(size.x).toBeCloseTo(2); expect(size.y).toBeCloseTo(4); expect(size.z).toBeCloseTo(6)
  })

  it('picks up a LATER geometry change — a param edit that swaps geometry in place', () => {
    const u = imageUniforms(img())
    refreshImageBounds(u, new THREE.BoxGeometry(2, 2, 2))
    expect(u.uImgBoundsSize.value.x).toBeCloseTo(2)
    // The object got fatter (width 2 → 8) with no material rebuild — same uniforms object,
    // a fresh geometry standing in for "the mesh's geometry swapped in place".
    refreshImageBounds(u, new THREE.BoxGeometry(8, 2, 2))
    expect(u.uImgBoundsSize.value.x).toBeCloseTo(8)
  })

  it('floors a flat axis at 1e-4, exactly like the build-time path', () => {
    const u = imageUniforms(img())
    const geo = new THREE.PlaneGeometry(2, 2) // zero extent on Z
    refreshImageBounds(u, geo)
    expect(u.uImgBoundsSize.value.z).toBeCloseTo(1e-4)
  })
})

describe('image adjustment GLSL', () => {
  it('declares each uniform exactly once', () => {
    for (const name of ['uImgBrightness', 'uImgContrast', 'uImgSaturation']) {
      expect(IMAGE_FRAGMENT_PARS.match(new RegExp(`uniform float ${name};`, 'g'))?.length).toBe(1)
    }
  })
})

// Task 11: projection replaces the plain adjustment splice — IMAGE_ADJUST_CALL is gone,
// replaced by imageMapFragment(box). The two Task 10 assertions written against
// IMAGE_ADJUST_CALL ("exposes a function the call line actually invokes" and "keeps the
// include it splices onto") are deleted here; imageMapFragment's own tests below cover the
// same properties against the new shape.
describe('image projection GLSL', () => {
  it('numbers each mode, with the mesh UVs at zero so the default is a no-op', () => {
    expect(imageUniforms(img()).uImgProjMode.value).toBe(0)
    expect(imageUniforms(img({ imageProjection: 'planar' })).uImgProjMode.value).toBe(1)
    expect(imageUniforms(img({ imageProjection: 'cylindrical' })).uImgProjMode.value).toBe(2)
    expect(imageUniforms(img({ imageProjection: 'spherical' })).uImgProjMode.value).toBe(3)
    // Box is its own program, not a mode on this one — see identityKey.
    expect(imageUniforms(img({ imageProjection: 'box' })).uImgProjMode.value).toBe(0)
  })

  it('numbers the axis', () => {
    expect(imageUniforms(img({ imageProjectionAxis: 'x' })).uImgProjAxis.value).toBe(0)
    expect(imageUniforms(img({ imageProjectionAxis: 'y' })).uImgProjAxis.value).toBe(1)
    expect(imageUniforms(img({ imageProjectionAxis: 'z' })).uImgProjAxis.value).toBe(2)
  })

  it('passes object-space position and normal from the vertex shader', () => {
    expect(IMAGE_PROJECT_VERTEX_GLSL).toContain('varying vec3 vImgPos;')
    expect(IMAGE_PROJECT_VERTEX_GLSL).toContain('varying vec3 vImgNrm;')
    expect(IMAGE_PROJECT_VERTEX_CALL).toContain('vImgPos = position;')
    expect(IMAGE_PROJECT_VERTEX_CALL).toContain('vImgNrm = normal;')
  })

  it('replaces the map include rather than appending to it, and still adjusts', () => {
    const frag = imageMapFragment(false)
    expect(frag).not.toContain('#include <map_fragment>')
    expect(frag).toContain('texture2D( map,')
    expect(frag).toContain('sailorImageAdjust')
    // The projected-coordinate maths (including the uImgMapTx transform) now lives in the
    // shared `sailorImageUv` helper in IMAGE_FRAGMENT_PARS, not inlined here — see the
    // review Finding 1 fix, which factored it out so the emissive splice could call the
    // same helper instead of duplicating the expression.
    expect(frag).toContain('sailorImageUv( vMapUv )')
    expect(IMAGE_FRAGMENT_PARS).toContain('uImgMapTx')
  })

  it('falls back to the mesh UVs at mode zero', () => {
    expect(imageMapFragment(false)).toContain('vMapUv')
  })

  it('the box variant triplanar-blends three samples instead of one', () => {
    const frag = imageMapFragment(true)
    expect(frag.match(/texture2D\( map,/g)).toBeNull() // now inside sailorTriplanarSample
    expect(frag).toContain('sailorTriplanarWeights( vImgNrm )')
    expect(frag).toContain('sailorTriplanarSample( map, vImgPos, sailorW )')
    expect(frag).toContain('sailorImageAdjust')
    expect(IMAGE_FRAGMENT_PARS).toContain('uImgBoxBlend')
    expect(IMAGE_FRAGMENT_PARS.match(/texture2D\( tex,/g)?.length).toBe(3)
  })

  it('the emissive splice mirrors the diffuse splice: same coordinate, and the box variant shares the same triplanar blend', () => {
    const single = imageEmissiveMapFragment(false)
    expect(single).not.toContain('#include <emissivemap_fragment>')
    expect(single).toContain('texture2D( emissiveMap,')
    expect(single).toContain('sailorImageUv( vEmissiveMapUv )')
    // No DECODE_VIDEO_TEXTURE_EMISSIVE branch — this material never binds a video texture
    // (mirrors imageMapFragment's own dropped DECODE_VIDEO_TEXTURE branch).
    expect(single).not.toContain('DECODE_VIDEO_TEXTURE')
    // Important 4 (final review): the glow must run through the SAME colour adjustments
    // and tint as the diffuse map (imageMapFragment's `sailorImageAdjust(diffuseColor.rgb)`
    // over an already-tinted diffuseColor) — not just the same coordinate. Without this, a
    // Saturation-0 + Glow surface renders a grey body under a full-colour glow, and a
    // coloured Tint leaves the glow untinted.
    expect(single).toContain('totalEmissiveRadiance *= sailorImageAdjust( emissiveColor.rgb * diffuse );')

    const triplanar = imageEmissiveMapFragment(true)
    expect(triplanar).toContain('sailorTriplanarWeights( vImgNrm )')
    expect(triplanar).toContain('sailorTriplanarSample( emissiveMap,')
    expect(triplanar).toContain('totalEmissiveRadiance *= sailorImageAdjust( emissiveColor.rgb * diffuse );')
  })
})

/**
 * Addition A (required beyond the brief): a `.replace()` onto a string that no longer
 * matches fails SILENTLY — every injection in materials.ts assumes these exact markers
 * exist in three's shader templates. If three ever renamed one of these chunks, every
 * onBeforeCompile splice in this file would quietly stop applying, and every value-based
 * test above (which supplies its own fake shader strings) would keep passing regardless.
 * This test reads three's ACTUAL ShaderLib templates rather than a fixture, so a real
 * rename in a three upgrade fails this test immediately instead of failing silently in
 * the running app.
 */
describe('three ShaderLib still carries the markers this file splices onto', () => {
  it('standard fragment shader has the map_fragment include and a main()', () => {
    expect(THREE.ShaderLib.standard.fragmentShader).toContain('#include <map_fragment>')
    expect(THREE.ShaderLib.standard.fragmentShader).toContain('void main() {')
  })

  it('basic fragment shader has the map_fragment include and a main()', () => {
    expect(THREE.ShaderLib.basic.fragmentShader).toContain('#include <map_fragment>')
    expect(THREE.ShaderLib.basic.fragmentShader).toContain('void main() {')
  })

  // Review Finding 1: the emissive glow splice (imageEmissiveMapFragment) replaces this
  // include on the standard (lit) fragment shader — the basic (unlit) template has no such
  // chunk at all (see applyImageGlow's doc), so it is deliberately not asserted here.
  it('standard fragment shader has the emissivemap_fragment include', () => {
    expect(THREE.ShaderLib.standard.fragmentShader).toContain('#include <emissivemap_fragment>')
  })

  // Review Finding 3: the marker guard was asymmetric — it checked `void main() {` and
  // `#include <begin_vertex>` against the STANDARD vertex shader only, leaving the BASIC
  // (unlit) vertex shader's own copies of the same two markers — which the same
  // IMAGE_PROJECT_VERTEX_GLSL/IMAGE_PROJECT_VERTEX_CALL splice depends on for the unlit
  // variant — completely unguarded.
  it('standard vertex shader has the begin_vertex include and a main()', () => {
    expect(THREE.ShaderLib.standard.vertexShader).toContain('#include <begin_vertex>')
    expect(THREE.ShaderLib.standard.vertexShader).toContain('void main() {')
  })

  it('basic vertex shader has the begin_vertex include and a main()', () => {
    expect(THREE.ShaderLib.basic.vertexShader).toContain('#include <begin_vertex>')
    expect(THREE.ShaderLib.basic.vertexShader).toContain('void main() {')
  })
})

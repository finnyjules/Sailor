import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import {
  imageUniforms, writeImageUniforms, IMAGE_ADJUST_GLSL,
  imageMapFragment, IMAGE_PROJECT_VERTEX_GLSL, IMAGE_PROJECT_VERTEX_CALL,
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

describe('image adjustment GLSL', () => {
  it('declares each uniform exactly once', () => {
    for (const name of ['uImgBrightness', 'uImgContrast', 'uImgSaturation']) {
      expect(IMAGE_ADJUST_GLSL.match(new RegExp(`uniform float ${name};`, 'g'))?.length).toBe(1)
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
    expect(frag).toContain('uImgMapTx')
  })

  it('falls back to the mesh UVs at mode zero', () => {
    expect(imageMapFragment(false)).toContain('vMapUv')
  })

  it('the box variant triplanar-blends three samples instead of one', () => {
    const frag = imageMapFragment(true)
    expect(frag.match(/texture2D\( map,/g)?.length).toBe(3)
    expect(frag).toContain('sailorImageAdjust')
    expect(frag).toContain('uImgBoxBlend')
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

  it('standard vertex shader has the begin_vertex include', () => {
    expect(THREE.ShaderLib.standard.vertexShader).toContain('#include <begin_vertex>')
  })
})

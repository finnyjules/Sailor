import { describe, it, expect } from 'vitest'
import { imageUniforms, writeImageUniforms, IMAGE_ADJUST_GLSL, IMAGE_ADJUST_CALL } from '~/lib/scene3d/imageShader'
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

  it('exposes a function the call line actually invokes', () => {
    expect(IMAGE_ADJUST_GLSL).toContain('vec3 sailorImageAdjust(')
    expect(IMAGE_ADJUST_CALL).toContain('sailorImageAdjust(')
  })

  it('keeps the include it splices onto', () => {
    expect(IMAGE_ADJUST_CALL.startsWith('#include <map_fragment>')).toBe(true)
  })
})

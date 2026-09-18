import { describe, it, expect } from 'vitest'
import { shapeImagePrompt, shapeTexturePrompt, THREE_D_MODELS, DEFAULT_3D_MODEL, resolve3dModel } from '~~/server/utils/scene3dGen'

describe('scene3d text-to-3d generation logic', () => {
  it('shapes the image prompt toward a clean single object', () => {
    const out = shapeImagePrompt('a red ceramic mug')
    expect(out).toContain('a red ceramic mug')
    expect(out.toLowerCase()).toMatch(/single|centered|plain|background/)
  })

  it('defaults to hunyuan3d v2 and resolves unknown ids to the default', () => {
    expect(DEFAULT_3D_MODEL).toBe('hunyuan3d-v2')
    expect(resolve3dModel(undefined)).toBe(THREE_D_MODELS['hunyuan3d-v2'])
    expect(resolve3dModel('nope')).toBe(THREE_D_MODELS['hunyuan3d-v2'])
  })

  it('builds the hunyuan3d input with input_image_url + textured_mesh and reads model_mesh.url', () => {
    const m = THREE_D_MODELS['hunyuan3d-v2']!
    expect(m.app).toBe('fal-ai/hunyuan3d/v2')
    const input = m.buildInput('https://x/img.png', { textured: true, seed: 7 })
    expect(input.input_image_url).toBe('https://x/img.png')
    expect(input.textured_mesh).toBe(true)
    expect(input.seed).toBe(7)
    expect(m.glbUrlFrom({ model_mesh: { url: 'https://x/model.glb' } })).toBe('https://x/model.glb')
    expect(m.glbUrlFrom({})).toBeNull()
  })

  it('every registered model builds an image input and can read a glb url', () => {
    for (const id of Object.keys(THREE_D_MODELS)) {
      const m = THREE_D_MODELS[id]!
      expect(typeof m.app).toBe('string')
      const input = m.buildInput('https://x/i.png', {})
      // each model carries the image url under some field
      expect(Object.values(input)).toContain('https://x/i.png')
      expect(m.glbUrlFrom({ model_mesh: { url: 'g.glb' } })).toBe('g.glb')
    }
  })
})

describe('shapeTexturePrompt', () => {
  it('asks for a flat, evenly lit, tileable surface', () => {
    const p = shapeTexturePrompt('brushed copper')
    expect(p).toContain('brushed copper')
    expect(p.toLowerCase()).toContain('seamless')
    expect(p.toLowerCase()).toContain('flat')
  })

  it('returns an empty string for an empty ask, like its sibling', () => {
    expect(shapeTexturePrompt('   ')).toBe('')
  })

  it('does not reuse the single-object shaping', () => {
    expect(shapeTexturePrompt('wood')).not.toBe(shapeImagePrompt('wood'))
  })
})

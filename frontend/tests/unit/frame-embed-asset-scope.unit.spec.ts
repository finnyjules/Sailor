import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { registerAssetResolver, resolveAssetUrl, __resetAssetResolversForTest } from '~/lib/compositor/assetScope'
import {
  imageLayerUrl, ensureLayerImages, sweepClipCache,
  __setClipFramesForTest, __clipCacheKeysForTest,
} from '~/composables/useCompositorLayers'
import { clipFrameUrl, clipFrameKey, type ImageClip } from '~/lib/compositor/clip'
import { vtFontFileUrl, parseVtFontToken } from '~/lib/vectortype/fontToken'
import { shaderTextureUrl, shaderTextureKey } from '~/lib/shaderfill/field'

const clip = (dir: string): ImageClip => ({ dir, frames: 3, fps: 24, speed: 1, prompt: '', model: '' })
const imageWithClip = (id: string, c: ImageClip) =>
  ({ kind: 'image', id, filename: `${id}.png`, w: 0.5, h: 0.5, clip: c } as any)

afterEach(() => __resetAssetResolversForTest())

describe('asset resolver chain', () => {
  it('falls back to the app URL when nothing is registered (byte-identical app)', () => {
    expect(imageLayerUrl('a b.png')).toBe('/view?filename=a+b.png&type=input')
    expect(clipFrameUrl(clip('d1'), 3)).toBe('/view?filename=000003.png&subfolder=d1&type=input')
    expect(shaderTextureUrl('atlas.png', '7')).toBe('/sailor/shader_effects/assets/atlas.png?v=7')
    expect(shaderTextureUrl('atlas.png')).toBe('/sailor/shader_effects/assets/atlas.png')
    expect(vtFontFileUrl(parseVtFontToken('google:Inter@700')!)).toBe('/api/fonts/google-file?family=Inter&weight=700')
  })

  it('a registered resolver supplies the URL for its kind and key', () => {
    registerAssetResolver((kind, key) => (kind === 'image' && key === 'a.png' ? 'data:image/png;base64,AA' : null))
    expect(imageLayerUrl('a.png')).toBe('data:image/png;base64,AA')
    expect(imageLayerUrl('b.png')).toBe('/view?filename=b.png&type=input')
  })

  it('each builder asks with its own kind and key', () => {
    const asked: string[] = []
    registerAssetResolver((kind, key) => { asked.push(`${kind}|${key}`); return null })
    clipFrameUrl(clip('d1'), 2)
    shaderTextureUrl('atlas.png', 7)
    vtFontFileUrl(parseVtFontToken('google:Inter@700')!)
    expect(asked).toEqual([
      `clipFrame|${clipFrameKey(clip('d1'), 2)}`,
      `shaderTexture|${shaderTextureKey('atlas.png', 7)}`,
      'outlineFont|google:Inter@700',
    ])
    expect(clipFrameKey(clip('d1'), 2)).toBe('d1/2')
    expect(shaderTextureKey('atlas.png', 7)).toBe('atlas.png@7')
    expect(shaderTextureKey('atlas.png')).toBe('atlas.png@')
  })

  it('the most recently registered resolver wins; a miss falls through; unregister restores', () => {
    registerAssetResolver(() => 'data:old')
    const off = registerAssetResolver((_k, key) => (key === 'x' ? 'data:new' : null))
    expect(resolveAssetUrl('image', 'x', 'fb')).toBe('data:new')
    expect(resolveAssetUrl('image', 'y', 'fb')).toBe('data:old')
    off()
    expect(resolveAssetUrl('image', 'x', 'fb')).toBe('data:old')
    __resetAssetResolversForTest()
    expect(resolveAssetUrl('image', 'x', 'fb')).toBe('fb')
  })
})

describe('ensureLayerImages keep option', () => {
  beforeEach(() => sweepClipCache([]))

  it('default call still sweeps clips the layers no longer name', async () => {
    __setClipFramesForTest(clip('other'), [1, 2, 3])
    await ensureLayerImages([imageWithClip('a', clip('a'))])
    expect(__clipCacheKeysForTest()).not.toContain('other:3')
  })

  it('keep: true never sweeps another embed\'s clip', async () => {
    __setClipFramesForTest(clip('other'), [1, 2, 3])
    await ensureLayerImages([imageWithClip('a', clip('a'))], { keep: true })
    expect(__clipCacheKeysForTest()).toContain('other:3')
  })

  it('keep: true pins its clips past the cache cap', async () => {
    const layers = ['p', 'q', 'r'].map(d => imageWithClip(d, clip(d)))
    await ensureLayerImages(layers, { keep: true })
    for (const d of ['p', 'q', 'r']) __setClipFramesForTest(clip(d), [1, 2, 3])
    expect(__clipCacheKeysForTest()).toEqual(expect.arrayContaining(['p:3', 'q:3', 'r:3']))
  })
})

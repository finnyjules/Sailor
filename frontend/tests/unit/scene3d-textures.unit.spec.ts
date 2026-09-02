import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isResolvedTexture, bareTextureId, textureMapFilename, ensureTextureFetched,
  resolveTexturePhrase, loadTextureCatalog, __resetTextureCachesForTest, TEXTURE_MAP_FILES,
} from '~/lib/scene3d/textures'

const jsonFetch = (payload: any) => vi.fn(async () => ({ ok: true, status: 200, json: async () => payload })) as any

describe('scene3d textures helpers', () => {
  beforeEach(() => __resetTextureCachesForTest())

  it('tells a resolved id from a phrase', () => {
    expect(isResolvedTexture('ambientcg:Wood095')).toBe(true)
    expect(isResolvedTexture('wood')).toBe(false)
    expect(isResolvedTexture(undefined)).toBe(false)
    expect(bareTextureId('ambientcg:Wood095')).toBe('Wood095')
  })

  it('derives the input-dir path of a map', () => {
    expect(textureMapFilename('ambientcg:Wood095', 'color')).toBe('sailor_textures/Wood095/Color.jpg')
    expect(textureMapFilename('ambientcg:Wood095', 'normal')).toBe(`sailor_textures/Wood095/${TEXTURE_MAP_FILES.normal}`)
  })

  it('fetches a set once per id and shares the promise', async () => {
    const f = jsonFetch({ id: 'Wood095', maps: ['color'], fetchedAt: 'x' })
    const [a, b] = await Promise.all([ensureTextureFetched('ambientcg:Wood095', f), ensureTextureFetched('ambientcg:Wood095', f)])
    expect(a).toEqual(b)
    expect(f).toHaveBeenCalledTimes(1)
    expect(f.mock.calls[0][0]).toBe('/api/scene3d/textures/fetch')
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ id: 'Wood095' })
  })

  it('forgets a failed fetch so the next call retries', async () => {
    const bad = vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ message: 'down' }) })) as any
    await expect(ensureTextureFetched('ambientcg:Wood095', bad)).rejects.toThrow()
    const good = jsonFetch({ id: 'Wood095', maps: ['color'], fetchedAt: 'x' })
    await expect(ensureTextureFetched('ambientcg:Wood095', good)).resolves.toMatchObject({ id: 'Wood095' })
  })

  it('resolves a phrase through the route', async () => {
    const f = jsonFetch({ id: 'ambientcg:WoodFloor051', name: 'Wood Floor 051' })
    await expect(resolveTexturePhrase('wood', f)).resolves.toEqual({ id: 'ambientcg:WoodFloor051', name: 'Wood Floor 051' })
    expect(f.mock.calls[0][0]).toBe('/api/scene3d/textures/resolve')
  })

  it('loads the catalog once', async () => {
    const f = jsonFetch({ sets: [{ id: 'Wood095', name: 'Wood 095', category: 'Wood', tags: [], thumb: '', popularity: 1 }], count: 1 })
    const a = await loadTextureCatalog(f)
    const b = await loadTextureCatalog(f)
    expect(a).toBe(b)
    expect(f).toHaveBeenCalledTimes(1)
  })
})

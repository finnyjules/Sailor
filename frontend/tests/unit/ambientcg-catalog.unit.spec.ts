import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { slimCatalog, getAmbientcgCatalog, __resetAmbientcgCatalogForTest } from '../../server/utils/ambientcgCatalog'

const sample = JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/ambientcg/catalog-sample.json', import.meta.url)), 'utf8'))

const okFetch = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => sample })) as any
const failFetch = () => vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as any

describe('slimCatalog', () => {
  it('keeps only Material sets with the fields the picker needs', () => {
    const sets = slimCatalog(sample)
    expect(sets.map(s => s.id)).toEqual(['Wood095', 'Bricks075A', 'WoodFloor051'])
    const wood = sets[0]
    expect(wood).toEqual({
      id: 'Wood095', name: 'Wood 095', category: 'Wood', popularity: 81.2,
      tags: ['095', '95', 'beige', 'clean', 'natural', 'polished', 'wood'],
      thumb: 'https://acg-media.struffelproductions.com/file/ambientCG-Web/media/thumbnail/256-JPG-242424/Wood095.jpg',
    })
  })
  it('tolerates junk input', () => {
    expect(slimCatalog(null)).toEqual([])
    expect(slimCatalog({ foundAssets: [{ assetId: 7 }] })).toEqual([])
  })
})

describe('getAmbientcgCatalog', () => {
  beforeEach(() => __resetAmbientcgCatalogForTest())
  it('fetches once and serves the cache afterwards', async () => {
    const f = okFetch()
    const a = await getAmbientcgCatalog(f)
    const b = await getAmbientcgCatalog(f)
    expect(a).toBe(b)
    expect(f).toHaveBeenCalledTimes(1)
    expect(String(f.mock.calls[0][0])).toContain('type=Material')
  })
  it('serves the stale copy when a refresh fails', async () => {
    const good = await getAmbientcgCatalog(okFetch())
    __resetAmbientcgCatalogForTest(true) // expire, keep the data
    const again = await getAmbientcgCatalog(failFetch())
    expect(again).toEqual(good)
  })
  it('throws a 502-shaped error when there is nothing to serve', async () => {
    await expect(getAmbientcgCatalog(failFetch())).rejects.toMatchObject({ statusCode: 502 })
  })
})

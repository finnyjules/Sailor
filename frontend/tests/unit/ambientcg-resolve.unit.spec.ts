import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { slimCatalog } from '../../server/utils/ambientcgCatalog'
import { resolveTexturePhrase, TEXTURE_ID_PREFIX } from '../../server/utils/ambientcgResolve'

const sets = slimCatalog(JSON.parse(readFileSync(fileURLToPath(new URL('../fixtures/ambientcg/catalog-sample.json', import.meta.url)), 'utf8')))

describe('resolveTexturePhrase', () => {
  it('matches an exact id, with or without the prefix, any case', () => {
    expect(resolveTexturePhrase('Wood095', sets)).toEqual({ id: `${TEXTURE_ID_PREFIX}Wood095`, name: 'Wood 095' })
    expect(resolveTexturePhrase('ambientcg:bricks075a', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}Bricks075A`)
  })
  it('picks the most popular set whose tags match a single word', () => {
    // Both wood sets carry the tag; WoodFloor051 is more popular.
    expect(resolveTexturePhrase('wood', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}WoodFloor051`)
  })
  it('ranks by number of matching words before popularity', () => {
    // 'wood' + 'polished' both hit Wood095; only 'wood' hits WoodFloor051.
    expect(resolveTexturePhrase('polished wood', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}Wood095`)
  })
  it('matches on category too', () => {
    expect(resolveTexturePhrase('Bricks', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}Bricks075A`)
  })
  it('walks the synonym table', () => {
    expect(resolveTexturePhrase('wooden', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}WoodFloor051`)
    expect(resolveTexturePhrase('floorboards', sets)?.id).toBe(`${TEXTURE_ID_PREFIX}WoodFloor051`)
  })
  it('returns null on a miss or empty phrase', () => {
    expect(resolveTexturePhrase('unicorn', sets)).toBeNull()
    expect(resolveTexturePhrase('   ', sets)).toBeNull()
  })
})

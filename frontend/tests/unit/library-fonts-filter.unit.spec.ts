import { describe, it, expect } from 'vitest'
import { filterLibraryGroups, librariesByFoundry, featuredFamilies, FEATURED_FOUNDRY_ID } from '../../app/data/library-fonts'

describe('filterLibraryGroups (Pangram tab — excludes Featured)', () => {
  it('empty query returns all non-empty NON-featured foundry groups', () => {
    const all = filterLibraryGroups('')
    const base = librariesByFoundry().filter(g => g.families.length && g.foundry.id !== FEATURED_FOUNDRY_ID)
    expect(all.length).toBe(base.length)
    expect(all.some(g => g.foundry.id === FEATURED_FOUNDRY_ID)).toBe(false)
  })
  it('a query matching a known family narrows to matching families only', () => {
    const groups = filterLibraryGroups('mori')
    expect(groups.length).toBeGreaterThan(0)
    for (const g of groups) for (const f of g.families) expect(f.family.toLowerCase()).toContain('mori')
  })
  it('a nonsense query returns no groups', () => {
    expect(filterLibraryGroups('zzzz-not-a-real-font-xyz')).toEqual([])
  })
})

describe('featuredFamilies', () => {
  it('returns Featured families, filtered by name', () => {
    expect(featuredFamilies('').some(f => f.family === 'Sora')).toBe(true)
    const sora = featuredFamilies('sora')
    expect(sora.length).toBe(1)
    expect(sora[0].family).toBe('Sora')
  })
  it('is sorted by num ascending', () => {
    const nums = featuredFamilies('').map(f => f.num ?? Infinity)
    expect(nums).toEqual([...nums].sort((a, b) => a - b))
  })
})

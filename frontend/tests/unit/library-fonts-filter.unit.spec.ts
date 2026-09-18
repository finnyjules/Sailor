import { describe, it, expect } from 'vitest'
import { filterLibraryGroups, librariesByFoundry } from '../../app/data/library-fonts'

describe('filterLibraryGroups', () => {
  it('empty query returns all non-empty foundry groups, matching librariesByFoundry', () => {
    const all = filterLibraryGroups('')
    const base = librariesByFoundry().filter(g => g.families.length)
    expect(all.length).toBe(base.length)
    for (const g of all) expect(g.families.length).toBeGreaterThan(0)
  })

  it('a query matching a known family narrows to matching families only', () => {
    const groups = filterLibraryGroups('mori')
    expect(groups.length).toBeGreaterThan(0)
    for (const g of groups) {
      for (const f of g.families) expect(f.family.toLowerCase()).toContain('mori')
    }
  })

  it('a nonsense query returns no groups', () => {
    expect(filterLibraryGroups('zzzz-not-a-real-font-xyz')).toEqual([])
  })
})

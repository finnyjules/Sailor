import { describe, it, expect } from 'vitest'
import { facetsOf, matchesCharacter } from '~/lib/color/seedFamily'

describe('facets', () => {
  it('classifies a dark palette as dark, not light', () => {
    const f = facetsOf(['#101014', '#20242e', '#2e3440'])
    expect(matchesCharacter(f, 'dark')).toBe(true)
    expect(matchesCharacter(f, 'light')).toBe(false)
  })
  it('classifies a saturated palette as vivid', () => {
    const f = facetsOf(['#ff0033', '#00ccff', '#ffcc00'])
    expect(matchesCharacter(f, 'vivid')).toBe(true)
  })
  it('any matches everything', () => {
    expect(matchesCharacter(facetsOf(['#808080', '#404040']), 'any')).toBe(true)
  })
})

import { describe, it, expect } from 'vitest'
import { composedFamilies } from '~/lib/color/composed'

describe('composed recipes', () => {
  it('every family contains the seed verbatim', () => {
    for (const f of composedFamilies('#e63946', null, 'any', 0, 12))
      expect(f.hexes.some(h => h === '#e63946')).toBe(true)
  })
  it('two-seed families contain both seeds', () => {
    for (const f of composedFamilies('#f2c4b3', '#5b6e8c', 'any', 0, 8)) {
      expect(f.hexes).toContain('#f2c4b3')
      expect(f.hexes).toContain('#5b6e8c')
    }
  })
  it('is deterministic for the same inputs', () => {
    const a = composedFamilies('#e63946', null, 'any', 0, 12)
    const b = composedFamilies('#e63946', null, 'any', 0, 12)
    expect(a.map(f => f.hexes)).toEqual(b.map(f => f.hexes))
  })
  it('all outputs are valid hexes', () => {
    for (const f of composedFamilies('#123456', null, 'any', 0, 12))
      for (const h of f.hexes) expect(h).toMatch(/^#[0-9a-f]{6}$/)
  })
})

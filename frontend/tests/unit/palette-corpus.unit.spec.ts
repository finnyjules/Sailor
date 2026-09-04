import { describe, it, expect } from 'vitest'
import corpus from '../../public/data/palette-corpus.json'

describe('palette corpus', () => {
  it('has ~1340 entries tagged by source', () => {
    expect(corpus.length).toBeGreaterThan(1200)
    expect(corpus.every(p => p.s === 0 || p.s === 1)).toBe(true)
  })
  it('every palette is 2–5 valid hexes', () => {
    for (const p of corpus) {
      expect(p.c.length).toBeGreaterThanOrEqual(2)
      expect(p.c.length).toBeLessThanOrEqual(5)
      expect(p.c.every(h => /^#[0-9a-f]{6}$/.test(h))).toBe(true)
    }
  })
})

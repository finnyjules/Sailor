import { describe, it, expect } from 'vitest'
import { sheetFor, variantsFor, tileFor } from '~/lib/frame/patterns/sheet'
import { PATTERNS, fittingPatterns } from '~/lib/frame/patterns/catalog'
import { ctxFor } from './_poster-fixtures'

describe('sheet model', () => {
  it('sheetFor yields one tile per fitting pattern, each with ops and a label', () => {
    const ctx = ctxFor()
    const tiles = sheetFor(ctx, 7)
    expect(tiles.map(t => t.patternId)).toEqual(fittingPatterns(ctx).map(p => p.id))
    for (const t of tiles) { expect(t.ops.length).toBeGreaterThan(0); expect(t.did.length).toBeGreaterThan(0); expect(t.seed).toBe(7) }
  })
  it('tiles are deterministic for (pattern, seed) and differ across seeds', () => {
    const ctx = ctxFor()
    const p = PATTERNS.find(x => x.id === 'runoff')!
    expect(tileFor(ctx, p, 3)).toEqual(tileFor(ctx, p, 3))
    const base = tileFor(ctx, p, 3).ops
    const differs = [4, 5, 6, 7, 8, 9].some(seed => JSON.stringify(tileFor(ctx, p, seed).ops) !== JSON.stringify(base))
    expect(differs).toBe(true)                                          // the seed actually steers the pattern
  })
  it('variantsFor returns n tiles of one pattern at distinct seeds', () => {
    const ctx = ctxFor()
    const p = PATTERNS.find(x => x.id === 'runoff')!
    const v = variantsFor(ctx, p, 7, 4)
    expect(v).toHaveLength(4)
    expect(new Set(v.map(t => t.seed)).size).toBe(4)
    expect(v.every(t => t.patternId === 'runoff')).toBe(true)
  })
})

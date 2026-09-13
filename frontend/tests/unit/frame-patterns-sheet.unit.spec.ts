import { describe, it, expect } from 'vitest'
import { sheetFor, variantsFor, tileFor } from '~/lib/frame/patterns/sheet'
import { PATTERNS, fittingPatterns } from '~/lib/frame/patterns/catalog'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
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
  it('offers a generous sheet: more options for a phrase than for a bare word', () => {
    const word = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])
    const phrase = inferElements([{ id: 't', kind: 'text', text: 'SOUND AND THE CITY', fontSize: 0.2 }])
    const wordTiles = sheetFor(ctxFor({ elements: word }), 7)
    const phraseTiles = sheetFor(ctxFor({ elements: phrase }), 7)
    expect(wordTiles.length).toBeGreaterThanOrEqual(6)     // free patterns fit a word
    expect(phraseTiles.length).toBeGreaterThan(wordTiles.length) // expressive + block add more
    // no expressive-only pattern leaks into a single-word sheet
    expect(wordTiles.map(t => t.patternId)).not.toContain('spacedLines')
  })
  it('shows shape moves only with a shape (placed or picked) and image moves only with a photo', () => {
    const wordNoExtras = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }])
    const bare = sheetFor(ctxFor({ elements: wordNoExtras }), 7).map(t => t.patternId)
    expect(bare).not.toContain('knockout')     // no shape
    expect(bare).not.toContain('split')        // no image

    const withShapeMode = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }], { id: 'circle' })
    const shaped = sheetFor(ctxFor({ elements: withShapeMode }), 7).map(t => t.patternId)
    expect(shaped).toContain('knockout')       // a picked shape enables shape moves
    expect(shaped).not.toContain('split')      // still no image

    const withImage = inferElements([{ id: 't', kind: 'text', text: 'NOISE', fontSize: 0.2 }, { id: 'p', kind: 'image' }])
    const imaged = sheetFor(ctxFor({ elements: withImage }), 7).map(t => t.patternId)
    expect(imaged).toContain('split')          // a photo enables image moves
  })
})

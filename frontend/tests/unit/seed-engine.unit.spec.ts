import { describe, it, expect } from 'vitest'
import { assembleShelf, curatedFamilies } from '~/lib/color/seedEngine'
import type { CorpusEntry } from '~/lib/color/anchor'

const CORPUS: CorpusEntry[] = [
  { s: 0, c: ['#69d2e7', '#a7dbd8', '#e0e4cc', '#f38630', '#fa6900'] },
  { s: 1, c: ['#06283d', '#256d85', '#47b5ff', '#dff6ff'] },
  { s: 0, c: ['#556270', '#4ecdc4', '#c7f464', '#ff6b6b', '#c44d58'] },
  { s: 0, c: ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8'] },
  { s: 1, c: ['#2E3440', '#3B4252', '#434C5E', '#4C566A'] },
  { s: 0, c: ['#50E3C2', '#B8E986', '#F5A623', '#D0021B'] },
  { s: 0, c: ['#417EBB', '#7B68EE', '#FF6B9D', '#FFA07A', '#FFD700'] },
  { s: 1, c: ['#264653', '#2A9D8F', '#E9C46A', '#F4A261'] },
  { s: 0, c: ['#E76F51', '#F4A261', '#E9C46A', '#2A9D8F', '#264653'] },
  { s: 1, c: ['#1A1A2E', '#16213E', '#0F3460', '#533483'] },
]

describe('shelf assembly', () => {
  it('every curated family contains the seed', () => {
    for (const f of curatedFamilies(CORPUS, { seedA: '#b64a1f' }))
      expect(f.hexes[f.anchorIdxs[0]!]).toBe('#b64a1f')
  })
  it('assembles a shelf of the requested size mixing both sources', () => {
    const shelf = assembleShelf(CORPUS, { seedA: '#b64a1f' }, 12)
    expect(shelf.length).toBe(12)
    expect(shelf.some(f => f.source === 'curated')).toBe(true)
    expect(shelf.some(f => f.source === 'composed')).toBe(true)
  })
  it('is deterministic', () => {
    const a = assembleShelf(CORPUS, { seedA: '#b64a1f' }, 12)
    const b = assembleShelf(CORPUS, { seedA: '#b64a1f' }, 12)
    expect(a.map(f => f.hexes)).toEqual(b.map(f => f.hexes))
  })
  it('reroll (page 1) differs from page 0', () => {
    const p0 = assembleShelf(CORPUS, { seedA: '#b64a1f', page: 0 }, 6)
    const p1 = assembleShelf(CORPUS, { seedA: '#b64a1f', page: 1 }, 6)
    expect(p0.map(f => f.hexes)).not.toEqual(p1.map(f => f.hexes))
  })
})

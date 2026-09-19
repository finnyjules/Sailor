import { describe, it, expect } from 'vitest'
import { planPileTokens } from '~/lib/spacetype/pile/tokens'
import { FRAME_HALF_H } from '~/lib/spacetype/pile/physics'

const FRAME = { width: 960, height: 540 }

// Self-contained defaults (the canonical control list lives in effects/pile.ts).
const BASE = {
  text: 'MOVE FAST',
  textAs: 'words',
  typeSize: 200,
  shapeCount: 0,
  shape: 'none',
  shapeSize: 120,
  sizeVariation: 0.3,
  seed: 1,
}
function p(over: Record<string, unknown>) {
  return { ...BASE, ...over } as any
}

describe('planPileTokens', () => {
  it('words: one token per whitespace-split word', () => {
    const specs = planPileTokens(p({ text: 'MOVE FAST AND BREAK', textAs: 'words', shapeCount: 0 }), FRAME)
    expect(specs.filter(s => s.kind === 'word')).toHaveLength(4)
    expect(specs.every(s => s.kind === 'word')).toBe(true)
  })

  it('letters: one token per non-space glyph', () => {
    const specs = planPileTokens(p({ text: 'AB CD', textAs: 'letters', shapeCount: 0 }), FRAME)
    expect(specs.filter(s => s.kind === 'letter')).toHaveLength(4) // A B C D, space dropped
  })

  it('shapes are additive to text tokens', () => {
    const specs = planPileTokens(p({ text: 'HI', textAs: 'words', shapeCount: 5 }), FRAME)
    expect(specs.filter(s => s.kind === 'word')).toHaveLength(1)
    expect(specs.filter(s => s.kind === 'shape')).toHaveLength(5)
  })

  it('shape tokens are drawn from the hand-picked set', () => {
    const shapes = JSON.stringify(['hexagon', 'pentagon'])
    const specs = planPileTokens(p({ textAs: 'off', shapeCount: 12, shapes }), FRAME)
    const ids = new Set(specs.map(s => s.shapeId))
    for (const s of specs) expect(['hexagon', 'pentagon']).toContain(s.shapeId)
    expect(ids.size).toBeGreaterThan(1) // a real mix, not one repeated
  })

  it('shape set is deterministic per seed', () => {
    const shapes = JSON.stringify(['hexagon', 'pentagon', 'polygon'])
    const a = planPileTokens(p({ textAs: 'off', shapeCount: 10, shapes, seed: 3 }), FRAME)
    const b = planPileTokens(p({ textAs: 'off', shapeCount: 10, shapes, seed: 3 }), FRAME)
    expect(b.map(s => s.shapeId)).toEqual(a.map(s => s.shapeId))
  })

  it('empty shape set falls back to a real catalog shape (never empty when count>0)', () => {
    const specs = planPileTokens(p({ textAs: 'off', shapeCount: 4, shapes: '[]' }), FRAME)
    expect(specs).toHaveLength(4)
    for (const s of specs) expect(typeof s.shapeId).toBe('string')
    expect(specs.every(s => s.shapeId && s.shapeId !== 'none')).toBe(true)
  })

  it('legacy single `shape` still works when no `shapes` set', () => {
    const specs = planPileTokens(p({ textAs: 'off', shapeCount: 3, shapes: '[]', shape: 'hexagon' }), FRAME)
    for (const s of specs) expect(s.shapeId).toBe('hexagon')
  })

  it('text and shape tokens are interleaved (mixed drop), not words-then-shapes', () => {
    const specs = planPileTokens(p({ text: 'ONE TWO THREE', textAs: 'words', shapeCount: 6, shapes: JSON.stringify(['hexagon']) }), FRAME)
    const kinds = specs.map(s => s.kind)
    const grouped = [...kinds].sort((a, b) => (a === 'word' ? -1 : 1)) // all words then all shapes
    expect(kinds).not.toEqual(grouped) // actually interleaved
    // a shape falls somewhere before the last word (they mix in the drop column)
    expect(kinds.indexOf('shape')).toBeLessThan(kinds.lastIndexOf('word'))
  })

  it('interleave is deterministic per seed', () => {
    const mk = () => planPileTokens(p({ text: 'ONE TWO', textAs: 'words', shapeCount: 5, shapes: JSON.stringify(['hexagon']), seed: 7 }), FRAME).map(s => s.kind)
    expect(mk()).toEqual(mk())
  })

  it('empty pile when text is off and no shapes', () => {
    expect(planPileTokens(p({ textAs: 'off', shapeCount: 0 }), FRAME)).toEqual([])
  })

  it('deterministic: same params -> identical extents; seed changes shape sizes', () => {
    const a = planPileTokens(p({ textAs: 'off', shapeCount: 6, seed: 1 }), FRAME)
    const b = planPileTokens(p({ textAs: 'off', shapeCount: 6, seed: 1 }), FRAME)
    const c = planPileTokens(p({ textAs: 'off', shapeCount: 6, seed: 2 }), FRAME)
    expect(b.map(s => s.w)).toEqual(a.map(s => s.w))
    expect(c.map(s => s.w)).not.toEqual(a.map(s => s.w)) // size jitter reshuffles
  })

  it('clamps a token so its DIAGONAL fits the container (never bridges the walls at any rotation)', () => {
    // A long word at huge type would exceed the container; its diagonal (widest rotated span)
    // must fit the wall gap, uniformly scaled.
    const container = 0.8
    const maxDiag = container * FRAME_HALF_H * (FRAME.width / FRAME.height) * 2 * 0.9
    const specs = planPileTokens(p({ text: 'BREAKING', textAs: 'words', typeSize: 360, container, shapeCount: 0 }), FRAME)
    expect(Math.hypot(specs[0]!.w, specs[0]!.h)).toBeLessThanOrEqual(maxDiag + 1e-6)
    expect(specs[0]!.h).toBeLessThanOrEqual(FRAME_HALF_H * 0.9 + 1e-6)
    // aspect preserved (uniform scale)
    expect(specs[0]!.w / specs[0]!.h).toBeCloseTo(0.62 * 8, 3)
  })

  it('a narrower Container makes tokens smaller (Container = the wall width)', () => {
    const wide = planPileTokens(p({ text: 'BREAKING', textAs: 'words', typeSize: 360, container: 1, shapeCount: 0 }), FRAME)
    const narrow = planPileTokens(p({ text: 'BREAKING', textAs: 'words', typeSize: 360, container: 0.4, shapeCount: 0 }), FRAME)
    expect(narrow[0]!.w).toBeLessThan(wide[0]!.w)
  })

  it('token extents are positive world units', () => {
    const specs = planPileTokens(p({ text: 'W', textAs: 'letters', shapeCount: 0, typeSize: 200 }), FRAME)
    expect(specs[0]!.w).toBeGreaterThan(0)
    expect(specs[0]!.h).toBeGreaterThan(0)
  })
})

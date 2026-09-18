import { describe, it, expect } from 'vitest'
import { planPileTokens } from '~/lib/spacetype/pile/tokens'

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

  it('token extents are positive world units', () => {
    const specs = planPileTokens(p({ text: 'W', textAs: 'letters', shapeCount: 0, typeSize: 200 }), FRAME)
    expect(specs[0]!.w).toBeGreaterThan(0)
    expect(specs[0]!.h).toBeGreaterThan(0)
  })
})

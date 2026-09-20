import { describe, it, expect } from 'vitest'
import { describeControls, validatePatch } from '../../app/lib/spacetype/controlDescriptor'
import type { ControlSpec } from '../../app/lib/spacetype/effect'
import { RAW_WORD_EFFECTS, PER_GLYPH_EFFECTS } from '../../app/lib/spacetype/effect'

const shapeCtl: ControlSpec = { key: 'separator', label: 'Separator', kind: 'shape', default: 'none', group: 'Type' }
const strictCtl: ControlSpec = { key: 'base', label: 'Base shape', kind: 'shape', default: 'circle', allowNone: false, group: 'Shape' }

describe('shape control kind — agent describer', () => {
  it('is agent-editable and lists none + every shape id', () => {
    const [d] = describeControls([shapeCtl], {})
    expect(d?.kind).toBe('shape')
    expect(d?.options?.[0]).toBe('none')
    expect(d?.options?.length).toBe(101)
    expect(d?.options).toContain('sparkle')
    expect(d?.current).toBe('none')
    expect(d?.hint).toMatch(/shape library/i)
  })
  it('omits none when allowNone is false', () => {
    const [d] = describeControls([strictCtl], {})
    expect(d?.options).not.toContain('none')
    expect(d?.options?.length).toBe(100)
  })
  it('validatePatch keeps known ids and none, drops anything else', () => {
    const described = describeControls([shapeCtl], {})
    expect(validatePatch({ separator: 'sparkle' }, described)).toEqual({ separator: 'sparkle' })
    expect(validatePatch({ separator: 'none' }, described)).toEqual({ separator: 'none' })
    expect(validatePatch({ separator: 'unicorn' }, described)).toEqual({})
    expect(validatePatch({ separator: 3 }, described)).toEqual({})
  })
})

describe('effect family sets', () => {
  it('name the raw-word and per-glyph effects', () => {
    // `pile` joined on 09-18: its letters are physics bodies built from the raw word, never a tile.
    expect([...RAW_WORD_EFFECTS].sort()).toEqual(['coil', 'echo', 'elastic', 'pile'])
    expect([...PER_GLYPH_EFFECTS].sort()).toEqual(['blend', 'cascade', 'cylinder', 'onionburst', 'ring', 'slot'])
  })
})

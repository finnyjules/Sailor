import { describe, it, expect } from 'vitest'
import { isAccentGlyph } from '~~/shared/text-layout/expressive'

describe('isAccentGlyph', () => {
  it('first accents only the leading glyph', () => {
    expect([0, 1, 2, 3].map(i => isAccentGlyph(i, 'first'))).toEqual([true, false, false, false])
  })
  it('alternate accents every other glyph from the first', () => {
    expect([0, 1, 2, 3, 4].map(i => isAccentGlyph(i, 'alternate'))).toEqual([true, false, true, false, true])
  })
})

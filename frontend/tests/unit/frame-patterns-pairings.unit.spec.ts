import { describe, it, expect } from 'vitest'
import { suggestTextFace } from '~/lib/frame/patterns/pairings'

describe('suggestTextFace', () => {
  it('pairs a display headline with a clean text face and gives a reason', () => {
    const s = suggestTextFace('Big Shoulders Display')
    expect(s.family).toBe('Inter')
    expect(s.reason.length).toBeGreaterThan(10)
    expect(s.reason[0]).toBe(s.reason[0]!.toUpperCase())   // sentence case
  })
  it('pairs a serif headline with a sans text face', () => {
    expect(suggestTextFace('Source Serif 4').family).toBe('Inter')
  })
  it('never suggests the same family it was given (a real pairing, not a no-op)', () => {
    for (const fam of ['Big Shoulders Display', 'Unbounded', 'Fraunces', 'Bricolage Grotesque', 'Archivo', 'Space Grotesk', 'Inter', 'Source Serif 4', 'Roboto Flex', 'Recursive']) {
      expect(suggestTextFace(fam).family).not.toBe(fam)
    }
  })
  it('falls back to a legible default for an unknown family', () => {
    const s = suggestTextFace('Some Unknown Font')
    expect(s.family).toBe('Inter')
    expect(s.reason.length).toBeGreaterThan(10)
  })
})

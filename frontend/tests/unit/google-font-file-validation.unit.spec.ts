import { describe, expect, it } from 'vitest'
import { validateGoogleCut } from '~~/server/utils/googleFontFile'

const cat = [{ family: 'Inter Tight', weights: [400, 700] }, { family: 'Lora', weights: [400] }]

describe('validateGoogleCut', () => {
  it('accepts a listed family + shipped weight', () => expect(validateGoogleCut(cat, 'Inter Tight', '700')).toEqual({ ok: true, family: 'Inter Tight', weight: 700 }))
  it('defaults a missing weight to the nearest shipped one to 400', () => expect(validateGoogleCut(cat, 'Lora', undefined)).toEqual({ ok: true, family: 'Lora', weight: 400 }))
  it('snaps an unshipped weight to the family\'s nearest shipped one instead of refusing', () => {
    // 500 is nearer to 400 (100) than to 700 (200) among Inter Tight's [400, 700].
    expect(validateGoogleCut(cat, 'Inter Tight', '500')).toEqual({ ok: true, family: 'Inter Tight', weight: 400 })
    // Lora ships only 400 — any other weight snaps straight to it.
    expect(validateGoogleCut(cat, 'Lora', '700')).toEqual({ ok: true, family: 'Lora', weight: 400 })
  })
  it('refuses an unknown family, a non-finite weight, and junk — before any fetch', () => {
    for (const [f, w] of [['Nope', '400'], ['', '400'], ['Inter Tight', 'abc'], ['Inter Tight&x=1', '400']] as const)
      expect(validateGoogleCut(cat, f, w).ok).toBe(false)
  })
})

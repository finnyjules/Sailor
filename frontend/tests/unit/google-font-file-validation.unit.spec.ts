import { describe, expect, it } from 'vitest'
import { validateGoogleCut } from '~~/server/utils/googleFontFile'

const cat = [{ family: 'Inter Tight', weights: [400, 700] }, { family: 'Lora', weights: [400] }]

describe('validateGoogleCut', () => {
  it('accepts a listed family + shipped weight', () => expect(validateGoogleCut(cat, 'Inter Tight', '700')).toEqual({ ok: true, family: 'Inter Tight', weight: 700 }))
  it('defaults a missing weight to the nearest shipped one to 400', () => expect(validateGoogleCut(cat, 'Lora', undefined)).toEqual({ ok: true, family: 'Lora', weight: 400 }))
  it('refuses an unknown family, an unshipped weight, and junk — before any fetch', () => {
    for (const [f, w] of [['Nope', '400'], ['Inter Tight', '500'], ['', '400'], ['Inter Tight', 'abc'], ['Inter Tight&x=1', '400']] as const)
      expect(validateGoogleCut(cat, f, w).ok).toBe(false)
  })
})

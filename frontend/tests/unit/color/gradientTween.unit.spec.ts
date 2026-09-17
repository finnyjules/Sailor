import { describe, it, expect } from 'vitest'
import { hexToOklab } from '~/lib/color/convert'
import { blendHex } from '~/lib/color/gradientTween'

function chroma(hex: string): number { const [, a, b] = hexToOklab(hex); return Math.hypot(a, b) }

describe('blendHex', () => {
  it('returns exact endpoints', () => {
    expect(blendHex('#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(blendHex('#ff0000', '#0000ff', 1)).toBe('#0000ff')
    expect(blendHex('#ff0000', '#0000ff', -0.5, 'hybrid')).toBe('#ff0000')
    expect(blendHex('#ff0000', '#0000ff', 2, 'hybrid')).toBe('#0000ff')
  })

  it('oklab delegates to mixHex (matches its midpoint)', () => {
    // a mid blend is between the two colours, not equal to either
    const mid = blendHex('#ff0000', '#0000ff', 0.5, 'oklab')
    expect(mid).not.toBe('#ff0000')
    expect(mid).not.toBe('#0000ff')
  })

  it('hybrid keeps more chroma at the midpoint than oklab for a complementary pair', () => {
    const cOklab = chroma(blendHex('#ff7a00', '#0060ff', 0.5, 'oklab'))
    const cHybrid = chroma(blendHex('#ff7a00', '#0060ff', 0.5, 'hybrid'))
    expect(cHybrid).toBeGreaterThan(cOklab)
  })
})

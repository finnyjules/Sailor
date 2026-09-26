import { describe, it, expect } from 'vitest'
import { simulateRound } from '~/lib/brushTips/round'
import { defaultSettings, REF_W } from '~/lib/brushTips/tips'
import { encodePts, type TipStroke } from '~/lib/brushTips/record'

const stroke = (): TipStroke => ({ tip: 'round', v: 1, size: 36 / REF_W, settings: defaultSettings('round'), seed: 7,
  pts: encodePts(Array.from({ length: 40 }, (_, i) => ({ x: 0.1 + i * 0.01, y: 0.5, t: i * 12 }))) })

describe('round stroke coordinates', () => {
  it('one coordinate record per dab', () => {
    const r = simulateRound(stroke())
    expect(r.coords.count).toBe(r.dabs.count)
  })
  it('u grows along the stroke, main dabs sit on the centre line, direction follows the stroke', () => {
    const { dabs, coords } = simulateRound(stroke())
    const d = dabs.view(), c = coords.view()
    let lastU = -1
    for (let i = 0; i < dabs.count; i++) {
      if (d[i * 5 + 2] !== 18) continue            // main dabs only (r = size/2)
      expect(c[i * 5]!).toBeGreaterThan(lastU); lastU = c[i * 5]!
      expect(Math.abs(c[i * 5 + 1]!)).toBeLessThan(1e-9)
      expect(c[i * 5 + 2]!).toBeGreaterThan(0.99)   // moving in +x
    }
    expect(lastU).toBeGreaterThan(300)             // ~0.39 of 1080 units travelled
  })
  it('dabs are unchanged by coordinate tracking (same as before)', () => {
    const a = Array.from(simulateRound(stroke()).dabs.view()), b = Array.from(simulateRound(stroke()).dabs.view())
    expect(a).toEqual(b)
  })
})

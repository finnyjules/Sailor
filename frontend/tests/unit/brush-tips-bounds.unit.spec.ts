import { describe, it, expect } from 'vitest'
import { strokeBounds, brushBoxFromStrokes } from '~/lib/compositor/brushStamp'
import { defaultSettings } from '~/lib/brushTips/tips'
import type { TipStroke } from '~/lib/brushTips/record'

describe('tip-aware strokeBounds', () => {
  it('pads a spray stroke by spread and drips', () => {
    const s: TipStroke = { tip: 'spray', v: 1, size: 0.1, settings: { ...defaultSettings('spray'), drips: 1.75 }, seed: 1, pts: [0.5, 0.5, 0, 0.6, 0.5, 100] }
    const b = strokeBounds([s])
    expect(b.minX).toBeLessThan(0.5 - 0.02)
    expect(b.maxX).toBeGreaterThan(0.6 + 0.02)
    expect(b.maxY - 0.5).toBeGreaterThan(0.5 - b.minY)
  })
  it('legacy strokes are unchanged', () => {
    const legacy = { points: [{ x: 0.2, y: 0.3 }, { x: 0.4, y: 0.3 }], radius: 0.01, hardness: 1, opacity: 1, erase: false }
    const b = strokeBounds([legacy])
    expect(b.minX).toBeCloseTo(0.19)
    expect(b.minY).toBeCloseTo(0.29)
    expect(b.maxX).toBeCloseTo(0.41)
    expect(b.maxY).toBeCloseTo(0.31)
    expect(brushBoxFromStrokes([legacy], 1).w).toBeCloseTo(0.22)
  })
  it('a growing live stroke measures the same as a fresh one (memo extends, never goes stale)', () => {
    const live: TipStroke = { tip: 'round', v: 1, size: 0.03, settings: defaultSettings('round'), seed: 1, pts: [] }
    for (let i = 0; i < 50; i++) {
      live.pts.push(0.3 + i * 0.005, 0.5 + Math.sin(i) * 0.1, i * 16)
      expect(strokeBounds([live])).toEqual(strokeBounds([{ ...live, pts: live.pts.slice() }]))
    }
  })
})

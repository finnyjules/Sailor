import { describe, it, expect } from 'vitest'
import { layoutExpressive, defaultExpressiveParams, type ExpressiveParams } from '~~/shared/text-layout/expressive'

const measure = (s: string) => s.length * 10
const p = (over: Partial<ExpressiveParams> = {}): ExpressiveParams => ({ ...defaultExpressiveParams(), placement: 'ring', perChar: true, ...over })

describe('expressive ring', () => {
  it('places glyphs on one circle: equal radii (jitterY 0) at distinct angles spanning it', () => {
    const box = 200, H = 200
    // defaultExpressiveParams has jitterY 0, so every glyph sits at exactly the
    // ring radius — a property random/edges/staircase scatter cannot satisfy.
    const lay = layoutExpressive({ text: 'CIRCLE', boxWidth: box, boxHeight: H, lineHeight: 30, measure, params: p({ seed: 3 }) })
    expect(lay.words).toHaveLength(6)
    const cx = box / 2, cy = H / 2
    const radii = lay.words.map(w => Math.hypot((w.x + w.w / 2) - cx, (w.y + 30 / 2) - cy))
    const mean = radii.reduce((a, b) => a + b, 0) / radii.length
    expect(mean).toBeGreaterThan(20)                                   // a real ring, not collapsed to the centre
    for (const r of radii) expect(Math.abs(r - mean)).toBeLessThan(1)  // ALL on one circle (would fail for scatter)
    // angles cover the circle: sorted gaps are all positive and the span is near 360°
    const angles = lay.words.map(w => Math.atan2((w.y + 30 / 2) - cy, (w.x + w.w / 2) - cx)).sort((a, b) => a - b)
    const span = angles[angles.length - 1]! - angles[0]!
    expect(span).toBeGreaterThan(Math.PI)                              // wraps well past a half-circle
    expect(new Set(angles.map(a => Math.round(a * 20))).size).toBe(6)  // six distinct angular positions
  })
  it('spreads glyphs vertically (not one line) and stays in the box', () => {
    const lay = layoutExpressive({ text: 'RING', boxWidth: 160, boxHeight: 160, lineHeight: 24, measure, params: p({ seed: 1 }) })
    const ys = lay.words.map(w => w.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(10)     // not a single row
    for (const w of lay.words) { expect(w.x).toBeGreaterThanOrEqual(0); expect(w.x + w.w).toBeLessThanOrEqual(160 + 1e-6) }
  })
  it('is deterministic per (seed, text, params)', () => {
    const a = layoutExpressive({ text: 'RING', boxWidth: 160, boxHeight: 160, lineHeight: 24, measure, params: p({ seed: 5 }) })
    const b = layoutExpressive({ text: 'RING', boxWidth: 160, boxHeight: 160, lineHeight: 24, measure, params: p({ seed: 5 }) })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

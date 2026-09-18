import { describe, it, expect } from 'vitest'
import { layoutExpressive, defaultExpressiveParams, type ExpressiveParams } from '~~/shared/text-layout/expressive'

const measure = (s: string) => s.length * 10   // 10px per char
const base = (over: Partial<ExpressiveParams> = {}): ExpressiveParams =>
  ({ ...defaultExpressiveParams(), ...over })

describe('expressive perChar', () => {
  it('splits into single characters, dropping whitespace', () => {
    const lay = layoutExpressive({
      text: 'AB CD', boxWidth: 100, lineHeight: 20, measure,
      params: base({ perChar: true, wordsPerLine: 2 }),
    })
    expect(lay.words.map(w => w.text)).toEqual(['A', 'B', 'C', 'D'])
    expect(lay.words.every(w => w.text.length === 1)).toBe(true)
    expect(lay.lines).toBe(2)                       // 4 glyphs, 2 per line
  })

  it('default (no perChar) still splits on words, byte-identical', () => {
    const p = base()
    const a = layoutExpressive({ text: 'ONE TWO', boxWidth: 120, lineHeight: 20, measure, params: p })
    const b = layoutExpressive({ text: 'ONE TWO', boxWidth: 120, lineHeight: 20, measure, params: { ...p, perChar: false } })
    expect(a.words.map(w => w.text)).toEqual(['ONE', 'TWO'])
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))    // false === absent
  })

  it('is deterministic per (seed, text, params) in perChar mode', () => {
    const p = base({ perChar: true, placement: 'random', jitterX: 0.8, wordsPerLine: 3, seed: 5 })
    const a = layoutExpressive({ text: 'NOISE', boxWidth: 200, lineHeight: 40, measure, params: p })
    const b = layoutExpressive({ text: 'NOISE', boxWidth: 200, lineHeight: 40, measure, params: p })
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('every glyph stays within the box horizontally', () => {
    const lay = layoutExpressive({
      text: 'SCATTER', boxWidth: 150, lineHeight: 30, measure,
      params: base({ perChar: true, placement: 'random', jitterX: 1, wordsPerLine: 3, seed: 9 }),
    })
    for (const g of lay.words) { expect(g.x).toBeGreaterThanOrEqual(0); expect(g.x + g.w).toBeLessThanOrEqual(150 + 1e-6) }
  })

  it('handles a single-glyph title without NaN', () => {
    const lay = layoutExpressive({ text: 'A', boxWidth: 100, lineHeight: 20, measure, params: base({ perChar: true }) })
    expect(lay.words).toHaveLength(1)
    expect(Number.isFinite(lay.words[0]!.x)).toBe(true)
  })
})

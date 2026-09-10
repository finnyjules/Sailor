// frontend/tests/unit/frame-patterns-frame-palette.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { paletteFromFrame } from '~/lib/frame/patterns/framePalette'
import { contrastRatio } from '~/lib/frame/patterns/palette'

const text = (id: string, fontSize: number, color: string) => ({ id, kind: 'text', text: 'x', fontSize, x: .5, y: .5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color, align: 'left', lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0 })

describe('paletteFromFrame', () => {
  it('reads field from a solid background, ink from the TITLE (largest text), accent from the first shape', () => {
    const p = paletteFromFrame({ sailor_localBg: '#fafafa', sailor_localLayers: [
      text('cap', 0.03, '#999999'), text('t', 0.2, '#123456'),
      { id: 's', kind: 'rect', x: .5, y: .5, w: .2, h: .2, rotation: 0, opacity: 1, fill: '#ff0000' },
    ] })
    expect(p).toEqual({ field: '#fafafa', ink: '#123456', accent: '#ff0000' })
  })
  it('falls back: no background → a paper white; no shape → accent = ink; gradient background → paper white', () => {
    const p = paletteFromFrame({ sailor_localBg: { type: 'linear', stops: [] }, sailor_localLayers: [text('t', 0.2, '#123456')] })
    expect(p.field).toBe('#f2f0ef'); expect(p.accent).toBe('#123456')
  })
  it('an ink that cannot be read on the field is auto-contrasted (WCAG ≥ 4.5)', () => {
    const p = paletteFromFrame({ sailor_localBg: '#111111', sailor_localLayers: [text('t', 0.2, '#151515')] })
    expect(contrastRatio(p.field, p.ink)).toBeGreaterThanOrEqual(4.5)
  })
  it('an empty frame yields the paper defaults', () => {
    expect(paletteFromFrame(undefined)).toEqual({ field: '#f2f0ef', ink: '#0e0e0e', accent: '#0e0e0e' })
  })
})

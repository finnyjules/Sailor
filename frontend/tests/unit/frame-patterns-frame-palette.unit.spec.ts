// frontend/tests/unit/frame-patterns-frame-palette.unit.spec.ts
import { describe, it, expect } from 'vitest'
import { ACCENT_POOL, paletteFromFrame } from '~/lib/frame/patterns/framePalette'
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
  it('falls back: no background → a paper white; gradient background → paper white', () => {
    const p = paletteFromFrame({ sailor_localBg: { type: 'linear', stops: [] }, sailor_localLayers: [text('t', 0.2, '#123456')] })
    expect(p.field).toBe('#f2f0ef')
  })
  it('an ink that cannot be read on the field is auto-contrasted (WCAG ≥ 4.5)', () => {
    const p = paletteFromFrame({ sailor_localBg: '#111111', sailor_localLayers: [text('t', 0.2, '#151515')] })
    expect(contrastRatio(p.field, p.ink)).toBeGreaterThanOrEqual(4.5)
  })
  it('an empty frame yields the paper defaults, and the pool accent that reads on both (ruling R7)', () => {
    // #e1251b: min(4.12 vs ink, 4.12 vs paper) — the best of the pool (blue 3.05, yellow 1.60, green 3.85, violet 3.38).
    expect(paletteFromFrame(undefined)).toEqual({ field: '#f2f0ef', ink: '#0e0e0e', accent: '#e1251b' })
  })

  // Ruling R7: with no shape colour the accent used to be the ink — a tag in the ink behind the
  // user's own ink-coloured text could not be read.
  describe('ruling R7', () => {
    const lab = [text('t', 0.2, '#111111'), text('c', 0.03, '#111111')]
    it('no shape colour: the brand kit accent when the caller passes one', () => {
      expect(paletteFromFrame({ sailor_localLayers: lab }, '#2b59c3').accent).toBe('#2b59c3')
      // A shape of the user's own still wins over the kit.
      const withShape = [...lab, { id: 's', kind: 'rect', x: .5, y: .5, w: .2, h: .2, rotation: 0, opacity: 1, fill: '#00aa55' }]
      expect(paletteFromFrame({ sailor_localLayers: withShape }, '#2b59c3').accent).toBe('#00aa55')
    })
    it('no shape colour, no kit: the pool colour with the best min(contrast vs ink, vs field), never the ink', () => {
      const p = paletteFromFrame({ sailor_localLayers: lab })
      expect(p.accent).not.toBe(p.ink)
      const score = (c: string) => Math.min(contrastRatio(c, p.ink), contrastRatio(c, p.field))
      for (const c of ACCENT_POOL) expect(score(p.accent)).toBeGreaterThanOrEqual(score(c))
      expect(p.accent).toBe('#e1251b')
      // A dark page with a white title: another pool colour wins (green: min(4.38, 4.35); red 4.06).
      const dark = paletteFromFrame({ sailor_localBg: '#101010', sailor_localLayers: [text('t', 0.2, '#ffffff')] })
      expect(dark.accent).toBe('#1f8a4c')
    })
    it('skips the layout\'s own pieces: an owned tag is not the user\'s shape, nor an owned text their title', () => {
      const owned = { id: 'layout-tag-0', kind: 'rect', x: .5, y: .5, w: .2, h: .2, rotation: 0, opacity: 1, fill: '#111111', owner: { by: 'layout', key: 'tag-0' } }
      const ownedText = { ...text('layout-x', 0.5, '#ff00ff'), owner: { by: 'layout', key: 'x-0' } }
      const p = paletteFromFrame({ sailor_localLayers: [...lab, owned, ownedText] })
      expect(p.accent).toBe('#e1251b')
      expect(p.ink).toBe('#111111')
    })
  })
})

import { describe, it, expect } from 'vitest'
import { slotsOf, groundOf, inkOf } from '~/lib/compositor/recolour/slots'
import { mapFamily, lightnessOf } from '~/lib/compositor/recolour/map'
import { contrastRatio } from '~/lib/frame/patterns/palette'
import type { ColourSite } from '~/lib/compositor/recolour/sites'

const site = (owner: string, hex: string, weight: number, kind: ColourSite['kind'] = 'shape'): ColourSite => ({ owner, path: 'x', hex, weight, kind, set: () => {} })

describe('slotsOf', () => {
  it('groups identical hexes, sums weights, sorts heaviest first, and knows the ground and the ink', () => {
    const slots = slotsOf([site('bg', '#fafafa', 1, 'bg'), site('t', '#111111', 0.05, 'text'), site('r', '#ff0000', 0.2), site('r2', '#ff0000', 0.1), site('c', '#111111', 0.01, 'text')])
    expect(slots.map(s => [s.hex, +s.weight.toFixed(2)])).toEqual([['#fafafa', 1], ['#ff0000', 0.3], ['#111111', 0.06]])
    expect(slots[2]!.sites).toHaveLength(2)
    expect(groundOf(slots)!.hex).toBe('#fafafa'); expect(inkOf(slots)!.hex).toBe('#111111')
  })
  it('reports a slot\'s alpha: ff when opaque, the shared value when uniform, mixed otherwise', () => {
    const s = (owner: string, alpha?: string) => ({ ...site(owner, '#ff0000', 0.1), alpha })
    expect(slotsOf([s('a'), s('b')])[0]!.alpha).toBe('ff')
    expect(slotsOf([s('a', '80'), s('b', '80')])[0]!.alpha).toBe('80')
    expect(slotsOf([s('a', '80'), s('b')])[0]!.alpha).toBe('mixed')
    expect(slotsOf([s('a', 'ff'), s('b')])[0]!.alpha).toBe('ff')
  })
})

describe('mapFamily', () => {
  const fam = ['#0b132b', '#1c2541', '#3a506b', '#5bc0be', '#f5f5f5']   // dark → light
  it('maps slots to family colours in lightness order and keeps the frame\'s light/dark span', () => {
    const slots = slotsOf([site('bg', '#ffffff', 1, 'bg'), site('t', '#000000', 0.1, 'text'), site('a', '#888888', 0.2)])
    const m = mapFamily(slots, fam)
    expect(m['#ffffff']).toBe('#f5f5f5'); expect(m['#000000']).toBe('#0b132b')
    expect(lightnessOf(m['#888888']!)).toBeGreaterThan(lightnessOf(m['#000000']!)); expect(lightnessOf(m['#888888']!)).toBeLessThan(lightnessOf(m['#ffffff']!))
  })
  it('a dark frame stays dark (frame order is followed, not paper-first)', () => {
    const slots = slotsOf([site('bg', '#101010', 1, 'bg'), site('t', '#eeeeee', 0.1, 'text')])
    const m = mapFamily(slots, fam)
    expect(m['#101010']).toBe('#0b132b'); expect(m['#eeeeee']).toBe('#f5f5f5')
  })
  it('more slots than colours: neighbours share a colour, order preserved', () => {
    const slots = slotsOf(['#000000', '#333333', '#777777', '#bbbbbb', '#ffffff', '#ff0000', '#00ff00'].map((h, i) => site('s' + i, h, 1 - i * 0.1, i === 0 ? 'bg' : 'shape')))
    const m = mapFamily(slots, ['#000000', '#ffffff'])
    expect(new Set(Object.values(m)).size).toBe(2)
    expect(m['#000000']).toBe('#000000'); expect(m['#ffffff']).toBe('#ffffff')
  })
  it('contrast guard: the re-picked ink stays inside the family and is readable on the ground', () => {
    // Light-heavy family (3 light + 1 dark): the plain lightness-quantile mapping puts the
    // text slot on a light family member (next to an equally light ground), so the guard
    // MUST fire — and when it does, it must pick the family's own darkest colour rather
    // than reaching outside the family (autoInk's white/black/paper pool) for contrast.
    const family = ['#e8e8e8', '#f0f0f0', '#fbfbfb', '#1a1a2e']
    const slots = slotsOf([
      site('bg', '#ffffff', 1, 'bg'),
      site('t', '#e0e0e0', 0.15, 'text'),
      site('s', '#888888', 0.05, 'shape'),
    ])
    const m = mapFamily(slots, family)
    expect(m['#e0e0e0']).toBe('#1a1a2e')
    expect(family).toContain(m['#e0e0e0'])
    expect(contrastRatio(m['#ffffff']!, m['#e0e0e0']!)).toBeGreaterThanOrEqual(4.5)
  })
  it('a purely graphic frame (no text) keeps lightness order — the guard never fires', () => {
    // Both slots are 'shape', so there is no text slot at all. The family is deliberately
    // low-contrast between its own two dark members: if the guard mistakenly ran off a
    // non-text fallback ink, it would blow the darker slot out to something outside the
    // family (autoInk reaching for white). It must not run at all here.
    const slots = slotsOf([site('a', '#ffffff', 1, 'shape'), site('b', '#101010', 0.5, 'shape')])
    const m = mapFamily(slots, ['#101010', '#1a1a2e'])
    expect(m['#101010']).toBe('#101010')
    expect(m['#ffffff']).toBe('#1a1a2e')
  })
  it('a single slot maps to the family colour of nearest lightness rank, not always the lightest', () => {
    const slots = slotsOf([site('a', '#101010', 1, 'shape')])
    const m = mapFamily(slots, fam)
    expect(m['#101010']).toBe('#0b132b')   // fam's own darkest — nearest to #101010, not #f5f5f5
  })
  it('is deterministic and every slot is mapped', () => {
    const slots = slotsOf([site('bg', '#ffffff', 1, 'bg'), site('t', '#000000', 0.1, 'text'), site('a', '#888888', 0.2)])
    expect(mapFamily(slots, fam)).toEqual(mapFamily(slots, fam))
    expect(Object.keys(mapFamily(slots, fam)).sort()).toEqual(['#000000', '#888888', '#ffffff'])
  })
})

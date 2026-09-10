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
  it('contrast guard: the ink is re-picked when the lightness mapping leaves it unreadable on the ground', () => {
    const slots = slotsOf([site('bg', '#ffffff', 1, 'bg'), site('t', '#dddddd', 0.1, 'text')])   // frame's own ink is faint
    const m = mapFamily(slots, ['#e8e8e8', '#f0f0f0', '#101010'])
    expect(contrastRatio(m['#ffffff']!, m['#dddddd']!)).toBeGreaterThanOrEqual(4.5)
  })
  it('is deterministic and every slot is mapped', () => {
    const slots = slotsOf([site('bg', '#ffffff', 1, 'bg'), site('t', '#000000', 0.1, 'text'), site('a', '#888888', 0.2)])
    expect(mapFamily(slots, fam)).toEqual(mapFamily(slots, fam))
    expect(Object.keys(mapFamily(slots, fam)).sort()).toEqual(['#000000', '#888888', '#ffffff'])
  })
})

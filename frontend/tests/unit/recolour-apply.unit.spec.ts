import { describe, it, expect } from 'vitest'
import { recolourFrame, recolourSlot } from '~/lib/compositor/recolour/apply'
import { colourSites } from '~/lib/compositor/recolour/sites'
import { slotsOf } from '~/lib/compositor/recolour/slots'
import { mapFamily, lightnessOf } from '~/lib/compositor/recolour/map'

const text = (id: string, color: any, fontSize = 0.1) => ({ id, kind: 'text', text: 'HELLO', fontSize, x: .5, y: .5, rotation: 0, opacity: 1, fontFamily: 'Inter', fontWeight: 700, color, align: 'left', lineHeight: 1.2, strokeColor: '#000000', strokeWidth: 0 })
const rect = (id: string, fill: any, extra: any = {}) => ({ id, kind: 'rect', x: .5, y: .5, w: .4, h: .2, rotation: 0, opacity: 1, fill, stroke: '', strokeWidth: 0, ...extra })
const fam = ['#0b132b', '#3a506b', '#5bc0be', '#f5f5f5']

describe('recolourFrame', () => {
  it('end to end: things that shared a colour still share one, order survives, inputs untouched', () => {
    const layers: any[] = [text('h', '#111111', 0.2), text('c', '#111111', 0.03), rect('a', '#ff0000'), rect('b', '#ff0000'), rect('g', { type: 'linear', angle: 0, stops: [{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#ffffff' }] })]
    const bg = '#ffffff'
    const mapping = mapFamily(slotsOf(colourSites(layers as any, bg, 1)), fam)
    const out = recolourFrame(layers as any, bg, mapping, 1)
    const L = (l: any) => l
    expect(L(out.layers[0]).color).toBe(L(out.layers[1]).color)            // headline and caption still match
    expect(L(out.layers[2]).fill).toBe(L(out.layers[3]).fill)              // the two accents still match
    expect(L(out.layers[4]).fill.stops[0].color).toBe(L(out.layers[2]).fill)  // the gradient's red stop matches the accents
    expect(out.background).toBe(L(out.layers[4]).fill.stops[1].color)      // the white stop matches the ground
    expect(lightnessOf(out.background as string)).toBeGreaterThan(lightnessOf(L(out.layers[0]).color))
    expect(layers[0].color).toBe('#111111'); expect(bg).toBe('#ffffff')   // inputs untouched
    expect(out.layers[0]).not.toBe(layers[0])
  })
  it('keeps alpha and leaves unmapped colours alone', () => {
    const layers: any[] = [rect('a', '#ff000080'), rect('b', '#00ff00')]
    const out = recolourFrame(layers as any, undefined, { '#ff0000': '#123456' }, 1)
    expect((out.layers[0] as any).fill).toBe('#12345680'); expect((out.layers[1] as any).fill).toBe('#00ff00')
  })
  it('recolourSlot rewrites one slot everywhere it appears', () => {
    const layers: any[] = [rect('a', '#ff0000'), rect('b', '#ff0000', { strokes: [{ id: 's', paint: '#ff0000', width: 0.01, distance: 0 }] })]
    const out = recolourSlot(layers as any, '#ff0000', '#ff0000', '#00aa00', 1)
    expect((out.layers[0] as any).fill).toBe('#00aa00'); expect((out.layers[1] as any).strokes[0].paint).toBe('#00aa00'); expect(out.background).toBe('#00aa00')
  })
  it('recolourSlot with an alpha writes that alpha on every use; without one, keeps each use\'s own', () => {
    const layers: any[] = [rect('a', '#ff0000'), rect('b', '#ff000080')]
    const withA = recolourSlot(layers as any, undefined, '#ff0000', '#00aa00', 1, '40')
    expect((withA.layers[0] as any).fill).toBe('#00aa0040'); expect((withA.layers[1] as any).fill).toBe('#00aa0040')
    const noA = recolourSlot(layers as any, undefined, '#ff0000', '#00aa00', 1)
    expect((noA.layers[0] as any).fill).toBe('#00aa00'); expect((noA.layers[1] as any).fill).toBe('#00aa0080')
  })
})

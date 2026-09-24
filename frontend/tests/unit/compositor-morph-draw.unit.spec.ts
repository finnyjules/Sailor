import { describe, expect, it } from 'vitest'
import { blendMorphPaint, morphFillOf, ringsBBoxOfD } from '~/lib/compositor/morphDraw'

describe('morph draw helpers', () => {
  it('reads a text layer colour and a shape fill', () => {
    expect(morphFillOf({ kind: 'text', color: '#112233' })).toBe('#112233')
    expect(morphFillOf({ kind: 'rect', fill: '#445566' })).toBe('#445566')
  })
  it('blends two solid colours and is exact at the ends', () => {
    expect(blendMorphPaint('#000000', '#ffffff', 0).toLowerCase()).toBe('#000000')
    expect(blendMorphPaint('#000000', '#ffffff', 1).toLowerCase()).toBe('#ffffff')
    expect(blendMorphPaint('#000000', '#ffffff', 0.5)).not.toBe('#000000')
  })
  it('switches a non-solid paint at the midpoint', () => {
    const g = { type: 'linear', angle: 0, stops: [] } as never
    expect(blendMorphPaint(g, '#ffffff', 0.4)).toBe(g)
    expect(blendMorphPaint(g, '#ffffff', 0.6)).toBe('#ffffff')
    expect(blendMorphPaint(undefined, undefined, 0.3)).toBe('')
  })
  it('measures a path', () => {
    expect(ringsBBoxOfD('M-5 -2L5 -2L5 2L-5 2Z')).toEqual({ w: 10, h: 4 })
  })
})

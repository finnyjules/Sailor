import { describe, it, expect } from 'vitest'
import { rampColour } from '~/lib/color/ramp'
import { mixHex } from '~/lib/color/mix'
import type { Paint } from '~/lib/compositor/paint'

describe('rampColour', () => {
  it('returns the stops exactly at t = 0 and t = 1', () => {
    expect(rampColour(['#ff00aa', '#00ffaa'], 0)).toBe('#ff00aa')
    expect(rampColour(['#ff00aa', '#00ffaa'], 1)).toBe('#00ffaa')
  })
  it('two stops: t = 0.5 is the perceptual midpoint the shared mixer gives', () => {
    expect(rampColour(['#ff00aa', '#00ffaa'], 0.5)).toBe(mixHex('#ff00aa', '#00ffaa', 0.5))
  })
  it('three stops: t = 0.5 is exactly the middle stop, t = 0.25 mixes the first pair', () => {
    expect(rampColour(['#000000', '#ff0000', '#ffffff'], 0.5)).toBe('#ff0000')
    expect(rampColour(['#000000', '#ff0000', '#ffffff'], 0.25)).toBe(mixHex('#000000', '#ff0000', 0.5))
  })
  it('a pattern/shader stop has no colour to mix: used as-is at its nearest position', () => {
    const pattern = { type: 'stripes', a: '#000000', b: '#ffffff', density: 8, angle: 0 } as unknown as Paint
    expect(rampColour(['#000000', pattern], 0.2)).toBe('#000000')
    expect(rampColour(['#000000', pattern], 0.8)).toBe(pattern)
  })

  describe('gradient stops blend stop-by-stop', () => {
    const A = { type: 'linear' as const, angle: 40, stops: [{ offset: 0, color: '#6a5cff' }, { offset: 1, color: '#ff2fd6' }] }
    const B = { type: 'linear' as const, angle: 60, stops: [{ offset: 0, color: '#e5484d' }, { offset: 1, color: '#f6f1a1' }] }

    it('two linear gradients: the ends are the stops exactly', () => {
      expect(rampColour([A, B], 0)).toEqual(A)
      expect(rampColour([A, B], 1)).toEqual(B)
    })

    it('halfway: each stop colour is the perceptual midpoint of the two gradients at that offset, the angle is halfway', () => {
      const m = rampColour([A, B], 0.5) as any
      expect(m.type).toBe('linear')
      expect(m.angle).toBeCloseTo(50, 6)
      expect(m.stops.map((s: any) => s.offset)).toEqual([0, 1])
      expect(m.stops[0].color).toBe(mixHex('#6a5cff', '#e5484d', 0.5))
      expect(m.stops[1].color).toBe(mixHex('#ff2fd6', '#f6f1a1', 0.5))
    })

    it('the blend is smooth: quarter and three-quarter points differ from both ends and from each other', () => {
      const q = rampColour([A, B], 0.25) as any, r = rampColour([A, B], 0.75) as any
      expect(q.stops[0].color).not.toBe(A.stops[0].color)
      expect(q.stops[0].color).not.toBe(r.stops[0].color)
      expect(r.stops[0].color).not.toBe(B.stops[0].color)
    })

    it('different stop offsets: the mix carries the union of offsets, sampling each gradient at the other\'s stops', () => {
      const C = { type: 'linear' as const, angle: 40, stops: [{ offset: 0, color: '#000000' }, { offset: 0.5, color: '#ff0000' }, { offset: 1, color: '#ffffff' }] }
      const m = rampColour([A, C], 0.5) as any
      expect(m.stops.map((s: any) => s.offset)).toEqual([0, 0.5, 1])
      // A sampled at 0.5 is the midpoint of its two stops.
      expect(m.stops[1].color).toBe(mixHex(mixHex('#6a5cff', '#ff2fd6', 0.5), '#ff0000', 0.5))
    })

    it('a solid stop blends INTO a gradient: the solid acts as a flat gradient of the other\'s kind and angle', () => {
      const m = rampColour(['#000000', A], 0.5) as any
      expect(m.type).toBe('linear')
      expect(m.angle).toBe(40)
      expect(m.stops[0].color).toBe(mixHex('#000000', '#6a5cff', 0.5))
      expect(m.stops[1].color).toBe(mixHex('#000000', '#ff2fd6', 0.5))
      // ends stay exact
      expect(rampColour(['#000000', A], 0)).toBe('#000000')
      expect(rampColour(['#000000', A], 1)).toEqual(A)
    })

    it('linear to radial: the kind flips at the midpoint, colours still mix', () => {
      const R = { type: 'radial' as const, stops: [{ offset: 0, color: '#ffffff' }, { offset: 1, color: '#000000' }] }
      expect((rampColour([A, R], 0.25) as any).type).toBe('linear')
      expect((rampColour([A, R], 0.75) as any).type).toBe('radial')
      expect((rampColour([A, R], 0.75) as any).stops[0].color).toBe(mixHex('#6a5cff', '#ffffff', 0.75))
    })
  })
  it('clamps t and tolerates a single stop', () => {
    expect(rampColour(['#123456'], 0.7)).toBe('#123456')
    expect(rampColour(['#000000', '#ffffff'], 2)).toBe('#ffffff')
    expect(rampColour(['#000000', '#ffffff'], -1)).toBe('#000000')
  })
  it('returns a neutral grey for an empty list', () => {
    expect(rampColour([], 0.5)).toBe('#808080')
  })
})

import { describe, it, expect } from 'vitest'
import { shapePresets, clampViewSize, resizeViewFromEdge, atDesignSize, readoutLabel } from '~/lib/frame/responsive/viewport'

const design = { w: 1000, h: 500 }

describe('shapePresets', () => {
  it('offers Your design first, exactly the design size', () => {
    const p = shapePresets(design)
    expect(p[0]).toEqual({ id: 'design', label: 'Your design', w: 1000, h: 500 })
    expect(p.map(x => x.id)).toEqual(['design', 'wide', 'tall', 'square', 'banner'])
  })
  it('each preset keeps roughly the design area', () => {
    const area = design.w * design.h
    for (const p of shapePresets(design).slice(1)) {
      expect(p.w * p.h).toBeGreaterThan(area * 0.5)
      expect(p.w * p.h).toBeLessThan(area * 2)
      expect(Number.isInteger(p.w)).toBe(true); expect(Number.isInteger(p.h)).toBe(true)
    }
  })
  it('square is square, wide is landscape, tall is portrait', () => {
    const by = Object.fromEntries(shapePresets(design).map(p => [p.id, p]))
    expect(by.square.w).toBe(by.square.h)
    expect(by.wide.w).toBeGreaterThan(by.wide.h)
    expect(by.tall.h).toBeGreaterThan(by.tall.w)
  })
})

describe('clampViewSize', () => {
  it('holds each axis within 0.25x..5x the design', () => {
    expect(clampViewSize({ w: 100, h: 100 }, design)).toEqual({ w: 250, h: 125 })   // both below 0.25x
    expect(clampViewSize({ w: 999999, h: 999999 }, design)).toEqual({ w: 5000, h: 2500 })
    expect(clampViewSize({ w: 1500, h: 400 }, design)).toEqual({ w: 1500, h: 400 }) // in range
  })
})

describe('resizeViewFromEdge', () => {
  // displayScale 0.5 → 100 screen px = 200 output px
  it('the right edge changes width only', () => {
    expect(resizeViewFromEdge(design, { w: 1000, h: 500 }, 'e', 100, 40, 0.5)).toEqual({ w: 1200, h: 500 })
  })
  it('the bottom edge changes height only', () => {
    expect(resizeViewFromEdge(design, { w: 1000, h: 500 }, 's', 100, 40, 0.5)).toEqual({ w: 1000, h: 580 })
  })
  it('the corner changes both', () => {
    expect(resizeViewFromEdge(design, { w: 1000, h: 500 }, 'se', 100, 40, 0.5)).toEqual({ w: 1200, h: 580 })
  })
  it('clamps to the allowed range', () => {
    const r = resizeViewFromEdge(design, { w: 1000, h: 500 }, 'e', -100000, 0, 0.5)
    expect(r.w).toBe(250)
  })
})

describe('atDesignSize / readoutLabel', () => {
  it('true within a pixel of the design size', () => {
    expect(atDesignSize({ w: 1000, h: 500 }, design)).toBe(true)
    expect(atDesignSize({ w: 1001, h: 500 }, design)).toBe(false)
    expect(readoutLabel({ w: 1000, h: 500 }, design)).toBe('Design size')
    expect(readoutLabel({ w: 1200, h: 500 }, design)).toBe('Viewing size')
  })
})

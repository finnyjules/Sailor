import { describe, it, expect } from 'vitest'
import {
  trackSpan, bandsForLayer, numberBandCurve, colorBandCss, gradientBandCss,
} from '~/lib/motionx/bands'
import type { Track } from '~/lib/motionx'

const num = (path: string, ks: Array<[number, number]>): Track => ({
  path, type: 'number', keyframes: ks.map(([t, value]) => ({ t, value, ease: 'linear' })),
})

describe('trackSpan', () => {
  it('returns min/max keyframe t', () => {
    expect(trackSpan(num('layers.a.opacity', [[0.5, 0], [2, 1], [1, 0.5]]))).toEqual({ start: 0.5, end: 2 })
  })
  it('start == end for a single keyframe', () => {
    expect(trackSpan(num('layers.a.opacity', [[1.2, 1]]))).toEqual({ start: 1.2, end: 1.2 })
  })
  it('empty track spans 0..0', () => {
    expect(trackSpan({ path: 'layers.a.x', type: 'number', keyframes: [] })).toEqual({ start: 0, end: 0 })
  })
})

describe('bandsForLayer', () => {
  const tracks: Track[] = [
    num('layers.a.opacity', [[0, 0], [1, 1]]),
    num('layers.b.x', [[0, 0], [2, 100]]),          // other layer — excluded
    {
      path: 'layers.a.fill', type: 'gradient', keyframes: [
        { t: 0, value: [{ pos: 0, color: '#000' }], ease: 'linear' },
        { t: 3, value: [{ pos: 0, color: '#fff' }], ease: 'linear' },
      ],
    },
  ]
  it('includes only this layer\'s tracks, as bands with span + type', () => {
    const bands = bandsForLayer('a', tracks)
    expect(bands.map((b) => b.path)).toEqual(['layers.a.opacity', 'layers.a.fill'])
    expect(bands[0]).toMatchObject({ kind: 'number', type: 'number', start: 0, end: 1, key: 'layers.a.opacity' })
    expect(bands[1]).toMatchObject({ kind: 'gradient', start: 0, end: 3 })
  })
  it('uses labelFor for the human label, falling back to the last path segment', () => {
    const bands = bandsForLayer('a', tracks, (p) => (p.endsWith('opacity') ? 'Opacity' : ''))
    expect(bands[0].label).toBe('Opacity')
    expect(bands[1].label).toBe('fill')
  })
})

describe('numberBandCurve', () => {
  const t = {
    path: 'layers.a.opacity', type: 'number' as const, keyframes: [
      { t: 0, value: 0, ease: 'linear' as const }, { t: 2, value: 10, ease: 'linear' as const },
    ],
  }
  it('samples x across 0..1 and y normalised 0..1 against value min/max', () => {
    const pts = numberBandCurve(t, 3)
    expect(pts).toHaveLength(3)
    expect(pts[0]).toEqual({ x: 0, y: 0 })       // min value → 0
    expect(pts[2]).toEqual({ x: 1, y: 1 })       // max value → 1
    expect(pts[1].x).toBeCloseTo(0.5, 5)
    expect(pts[1].y).toBeCloseTo(0.5, 5)
  })
  it('flat track → y all 0.5 (no divide-by-zero)', () => {
    const flat = {
      path: 'layers.a.x', type: 'number' as const, keyframes: [
        { t: 0, value: 5, ease: 'linear' as const }, { t: 1, value: 5, ease: 'linear' as const }],
    }
    expect(numberBandCurve(flat, 2).every((p) => p.y === 0.5)).toBe(true)
  })
})

describe('colorBandCss', () => {
  it('is a linear-gradient across the keyframe colours by fractional t', () => {
    const css = colorBandCss({
      path: 'layers.a.fill', type: 'color', keyframes: [
        { t: 0, value: '#ff0000', ease: 'linear' }, { t: 4, value: '#0000ff', ease: 'linear' }],
    })
    expect(css).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff 100%)')
  })
})

describe('gradientBandCss', () => {
  it('renders the first gradient keyframe stops as a 90deg gradient', () => {
    const css = gradientBandCss({
      path: 'layers.a.fill', type: 'gradient', keyframes: [
        { t: 0, value: [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }], ease: 'linear' }],
    })
    expect(css).toBe('linear-gradient(90deg, #000 0%, #fff 100%)')
  })
  it('empty → transparent', () => {
    expect(gradientBandCss({ path: 'layers.a.fill', type: 'gradient', keyframes: [] })).toBe('transparent')
  })
})

import { describe, it, expect } from 'vitest'
import { isFill, isGradient, type Gradient } from '~/composables/useCompositorLayers'
import {
  type Fill, FILL_TYPES, DEFAULT_FILL, normalizeFill, parseFills, hexBytes, ombrePicker,
} from '~/lib/spacetype/fillTile'

const fill = (p: Partial<Fill> = {}): Fill => ({ ...DEFAULT_FILL, type: 'checkerboard', ...p })
const linear: Gradient = { type: 'linear', angle: 30, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }
const radial: Gradient = { type: 'radial', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }

describe('Paint guards (resolvePaint dispatch)', () => {
  it('isFill matches only a Fill object', () => {
    expect(isFill(fill())).toBe(true)
    expect(isFill('#ff0000')).toBe(false)
    expect(isFill('none')).toBe(false)
    expect(isFill(undefined)).toBe(false)
    expect(isFill(linear)).toBe(false)   // gradient has stops, no a/density
    expect(isFill(radial)).toBe(false)
  })

  it('isGradient matches only a Gradient object', () => {
    expect(isGradient(linear)).toBe(true)
    expect(isGradient(radial)).toBe(true)
    expect(isGradient('#ff0000')).toBe(false)
    expect(isGradient(fill())).toBe(false) // a fill's type is never linear/radial
    expect(isGradient(undefined)).toBe(false)
  })

  it('the three Paint kinds are mutually exclusive', () => {
    for (const p of ['#abc' as const, linear, fill()]) {
      const flags = [typeof p === 'string', isGradient(p), isFill(p)].filter(Boolean)
      expect(flags.length).toBe(1) // exactly one classification
    }
  })
})

describe('fillTile model', () => {
  it('FILL_TYPES holds the full Type-Studio set', () => {
    expect(FILL_TYPES).toEqual(['solid', 'gradient', 'ombre', 'grid', 'noise', 'checkerboard', 'stripes', 'qr', 'shader', 'shapes'])
  })

  it('normalizeFill fills defaults for junk input', () => {
    expect(normalizeFill(null)).toEqual(DEFAULT_FILL)
    expect(normalizeFill({ type: 'bogus' }).type).toBe('solid')
    expect(normalizeFill({ type: 'ombre', a: '#111', density: 12 })).toMatchObject({ type: 'ombre', a: '#111', density: 12 })
  })

  it('parseFills tolerates bad JSON and always returns ≥1 fill', () => {
    expect(parseFills('not json')).toHaveLength(1)
    expect(parseFills('[]')).toHaveLength(1)
    expect(parseFills(JSON.stringify([fill({ type: 'stripes' })]))[0]!.type).toBe('stripes')
  })

  it('hexBytes parses #rrggbb and #rgb', () => {
    expect(hexBytes('#ff8800')).toEqual([255, 136, 0])
    expect(hexBytes('#f80')).toEqual([255, 136, 0])
  })

  it('ombrePicker density grows along the fade direction', () => {
    const pick = ombrePicker(64, 64, 0) // fade along +x
    // Count "B" pixels in a near column vs a far column; far should have more.
    let near = 0, far = 0
    for (let y = 0; y < 64; y++) { if (pick(1, y)) near++; if (pick(62, y)) far++ }
    expect(far).toBeGreaterThan(near)
  })
})

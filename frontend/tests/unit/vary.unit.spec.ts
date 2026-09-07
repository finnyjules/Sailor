import { describe, it, expect } from 'vitest'
import {
  DEFAULT_VARY, hash32, varyWeights, varyColorAt, varyStepFactor, mixHex,
  type VarySettings,
} from '~/lib/vary'

const V = (over: Partial<VarySettings> = {}): VarySettings => ({ ...DEFAULT_VARY, ...over })

describe('hash32', () => {
  it('is in [0,1) and stable for a given (i, seed)', () => {
    for (let i = 0; i < 50; i++) {
      const h = hash32(i, 7)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
    }
    expect(hash32(3, 7)).toBe(hash32(3, 7))
  })

  it('decorrelates neighbouring indexes and neighbouring seeds', () => {
    expect(hash32(3, 7)).not.toBe(hash32(4, 7))
    expect(hash32(3, 7)).not.toBe(hash32(3, 8))
  })

  // Pins the exact routine so the Python mirror can assert the same numbers.
  it('matches the pinned reference values', () => {
    const got = [0, 1, 2, 3].map((i) => Number(hash32(i, 7).toFixed(9)))
    expect(got).toEqual(REFERENCE_HASHES)
  })
})

// Filled in at Step 3 from the implementation's own output, then frozen. The
// Python parity test (Task 9) asserts against this same list.
const REFERENCE_HASHES: number[] = [0.471620295, 0.288737799, 0.726929131, 0.924138845]

describe('varyWeights', () => {
  it('gives a single copy weight 0 in every mode', () => {
    for (const mode of ['sequence', 'random', 'falloff'] as const) {
      expect(varyWeights([0], V({ mode }))).toEqual([0])
    }
  })

  it('sequence ramps 0 to 1 across the step range', () => {
    expect(varyWeights([0, 1, 2, 3], V())).toEqual([0, 1 / 3, 2 / 3, 1])
  })

  it('sequence gives mirrored twins the same weight (repeated steps)', () => {
    const w = varyWeights([0, 1, 1, 2], V())
    expect(w[1]).toBe(w[2])
    expect(w[3]).toBe(1)
  })

  it('random is inside [0,1) and reshuffles with the seed', () => {
    const a = varyWeights([0, 1, 2, 3], V({ mode: 'random', seed: 1 }))
    const b = varyWeights([0, 1, 2, 3], V({ mode: 'random', seed: 2 }))
    for (const x of a) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1) }
    expect(a).not.toEqual(b)
  })

  it('falloff peaks at the centre and reaches 0 past the radius', () => {
    const v = V({ mode: 'falloff', falloffCenter: 0, falloffRadius: 0.5 })
    const w = varyWeights([0, 1, 2, 3], v)
    expect(w[0]).toBe(1)
    expect(w[3]).toBe(0)
    expect(w[1]).toBeGreaterThan(w[2]!)
  })

  it('falloff centred mid-array peaks in the middle', () => {
    const v = V({ mode: 'falloff', falloffCenter: 0.5, falloffRadius: 1 })
    const w = varyWeights([0, 1, 2, 3, 4], v)
    expect(w[2]).toBe(1)
    expect(w[0]).toBeCloseTo(w[4]!, 10)
    expect(w[0]).toBeLessThan(w[2]!)
  })
})

describe('varyColorAt', () => {
  const pal = ['#ff0000', '#00ff00', '#0000ff']

  it('returns undefined when colour is off', () => {
    expect(varyColorAt(0.5, 1, V({ palette: pal }))).toBeUndefined()
  })

  it('returns undefined for an empty palette even when enabled', () => {
    expect(varyColorAt(0.5, 1, V({ colorEnabled: true, palette: [] }))).toBeUndefined()
  })

  it('cycle in sequence mode walks the palette by index', () => {
    const v = V({ colorEnabled: true, palette: pal, spread: 'cycle' })
    expect(varyColorAt(0, 0, v)).toBe('#ff0000')
    expect(varyColorAt(0, 1, v)).toBe('#00ff00')
    expect(varyColorAt(0, 3, v)).toBe('#ff0000')
  })

  it('cycle in random mode picks the swatch by weight, never out of range', () => {
    const v = V({ mode: 'random', colorEnabled: true, palette: pal, spread: 'cycle' })
    expect(varyColorAt(0, 0, v)).toBe('#ff0000')
    expect(varyColorAt(0.999999, 0, v)).toBe('#0000ff')
    expect(varyColorAt(1, 0, v)).toBe('#0000ff')
  })

  it('blend hits the palette ends exactly and interpolates between', () => {
    const v = V({ colorEnabled: true, palette: pal, spread: 'blend' })
    expect(varyColorAt(0, 0, v)).toBe('#ff0000')
    expect(varyColorAt(1, 2, v)).toBe('#0000ff')
    expect(varyColorAt(0.5, 1, v)).toBe('#00ff00')
  })
})

describe('varyStepFactor', () => {
  it('is 1 in sequence mode regardless of weight, so existing maths is untouched', () => {
    expect(varyStepFactor(0, V())).toBe(1)
    expect(varyStepFactor(0.4, V())).toBe(1)
  })

  it('is the weight in random and falloff modes', () => {
    expect(varyStepFactor(0.4, V({ mode: 'random' }))).toBe(0.4)
    expect(varyStepFactor(0.4, V({ mode: 'falloff' }))).toBe(0.4)
  })
})

describe('mixHex', () => {
  it('returns the endpoints exactly', () => {
    expect(mixHex('#ff0000', '#0000ff', 0)).toBe('#ff0000')
    expect(mixHex('#ff0000', '#0000ff', 1)).toBe('#0000ff')
  })

  it('mixes toward the target', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080')
  })
})

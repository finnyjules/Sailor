import { describe, it, expect } from 'vitest'
import { DEFAULT_CLONER, expandClones, varyOf, type Cloner } from '~/composables/useCloner'

const C = (over: Partial<Cloner> = {}): Cloner => ({ ...DEFAULT_CLONER, enabled: true, ...over })

describe('expandClones without vary', () => {
  it('still returns a single identity transform when disabled', () => {
    const [t] = expandClones(undefined, 1)
    expect(t).toMatchObject({ dx: 0, dy: 0, drot: 0, dscale: 1, dopacity: 1 })
    expect(t!.tint).toBeUndefined()
  })

  it('leaves every existing field untouched for a plain linear cloner', () => {
    const out = expandClones(C({ countX: 3, spacingX: 0.2, stepScale: 0.5 }), 1)
    // Back-to-front: the original (k=0) is LAST.
    expect(out.map((t) => t.dscale)).toEqual([0.25, 0.5, 1])
    expect(out.every((t) => t.tint === undefined)).toBe(true)
  })
})

describe('expandClones with vary colour', () => {
  it('cycles the palette across copies in sequence mode', () => {
    const out = expandClones(C({
      countX: 4, varyColor: true, varyPalette: ['#ff0000', '#00ff00'],
    }), 1)
    // Reversed, so read back-to-front: k=3,2,1,0.
    expect(out.map((t) => t.tint)).toEqual(['#00ff00', '#ff0000', '#00ff00', '#ff0000'])
  })

  it('gives mirrored twins the same weight and colour', () => {
    const out = expandClones(C({
      countX: 3, mirrorX: true, varyColor: true, varyPalette: ['#ff0000', '#00ff00', '#0000ff'],
    }), 1)
    const byStep = new Map<number, string>()
    for (const t of out) {
      const prev = byStep.get(t.weight)
      if (prev !== undefined) expect(t.tint).toBe(prev)
      byStep.set(t.weight, t.tint!)
    }
    expect(byStep.size).toBeGreaterThan(1)
  })

  it('carries the strength through', () => {
    const out = expandClones(C({ countX: 2, varyColor: true, varyColorStrength: 0.4 }), 1)
    expect(out.every((t) => t.tintStrength === 0.4)).toBe(true)
  })

  it('damps the step transforms in falloff mode', () => {
    const out = expandClones(C({
      countX: 4, stepScale: 0.5, varyMode: 'falloff', varyFalloffCenter: 0, varyFalloffRadius: 0.01,
    }), 1)
    // The far copy is fully damped back to no scaling.
    expect(out[0]!.dscale).toBeCloseTo(1, 6)
    // The original is unaffected either way.
    expect(out[out.length - 1]!.dscale).toBe(1)
  })

  it('leaves sequence-mode steps identical to the un-varied result', () => {
    const plain = expandClones(C({ countX: 5, stepScale: 0.8, stepRotation: 10 }), 1)
    const varied = expandClones(C({ countX: 5, stepScale: 0.8, stepRotation: 10, varyMode: 'sequence' }), 1)
    expect(varied.map((t) => [t.dscale, t.drot])).toEqual(plain.map((t) => [t.dscale, t.drot]))
  })
})

describe('varyOf', () => {
  it('reads the cloner into the shared settings shape', () => {
    const v = varyOf(C({ varyMode: 'random', varySeed: 5, varyColor: true, varyPalette: ['#abc'] }))
    expect(v).toMatchObject({ mode: 'random', seed: 5, colorEnabled: true, palette: ['#abc'] })
  })
})

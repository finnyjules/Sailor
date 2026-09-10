import { describe, it, expect } from 'vitest'
import { DEFAULT_CLONER, expandClones, varyOf, type Cloner } from '~/composables/useCloner'
import { DEFAULT_VARY, varyColorAt } from '~/lib/vary'

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

describe('expandClones with a single copy', () => {
  // "Vary" means vary ACROSS copies, and one copy has no across — the 3D renderer
  // already skips its cloner below two copies and the Frame panel hides the Vary
  // block there. Both routes to one copy are exercised, because the guard is on the
  // EXPANDED copies rather than on any one count field.
  const VARIED: Partial<Cloner> = {
    stepScale: 0.5, stepRotation: 10, stepOpacity: 0.9,
    varyMode: 'random', varySeed: 7,
    varyColor: true, varyPalette: ['#ff0000', '#00ff00', '#0000ff'], varyColorStrength: 0.4,
  }

  it('route 1 — linear with both counts at 1: no tint, no damping', () => {
    const out = expandClones(C({ ...VARIED, countX: 1, countY: 1, spacingX: 0.2, spacingY: 0.25 }), 1)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ dx: 0, dy: 0, drot: 0, dscale: 1, dopacity: 1, weight: 0, tintStrength: 1, k: 0, n: 1 })
  })

  it('route 1 still holds with mirroring on — a count of 1 has nothing to mirror', () => {
    const out = expandClones(C({ ...VARIED, countX: 1, countY: 1, mirrorX: true, mirrorY: true }), 1)
    expect(out).toHaveLength(1)
    expect(out[0]!.tint).toBeUndefined()
  })

  it('route 2 — radial with count 1: no tint, but the ring placement survives', () => {
    const out = expandClones(C({
      ...VARIED, mode: 'radial', count: 1, radius: 0.3, startAngle: 30, sweepAngle: 240, faceCenter: true,
    }), 1)
    expect(out).toHaveLength(1)
    expect(out[0]!.tint).toBeUndefined()
    expect(out[0]!.tintStrength).toBe(1)
    expect(out[0]!.weight).toBe(0)
    // Placement is not variation: the offset and the faceCenter rotation stay.
    expect(out[0]!.dx).toBeCloseTo(0.3 * Math.cos(30 * Math.PI / 180), 12)
    expect(out[0]!.drot).toBe(30)
    expect(out[0]!.dscale).toBe(1)
  })

  it('the same config tints again as soon as there are two copies', () => {
    // The guard has to be about the copy count and nothing else.
    const two = expandClones(C({ ...VARIED, countX: 2, spacingX: 0.2 }), 1)
    expect(two).toHaveLength(2)
    expect(two.some((t) => t.tint !== undefined)).toBe(true)
  })

  it('taking a tinted layer from three copies down to one clears the tint', () => {
    // The reported stuck state: the Vary block is hidden at one copy, so the tint
    // could not be turned off from the panel once it was stuck.
    const tinted = C({ ...VARIED, varyMode: 'sequence', countX: 3, spacingX: 0.2 })
    expect(expandClones(tinted, 1).every((t) => t.tint !== undefined)).toBe(true)
    const one = expandClones({ ...tinted, countX: 1 }, 1)
    expect(one).toHaveLength(1)
    expect(one[0]!.tint).toBeUndefined()
  })
})

describe('varyOf', () => {
  it('reads the cloner into the shared settings shape', () => {
    const v = varyOf(C({ varyMode: 'random', varySeed: 5, varyColor: true, varyPalette: ['#abc'] }))
    expect(v).toMatchObject({ mode: 'random', seed: 5, colorEnabled: true, palette: ['#abc'] })
  })

  it('substitutes the default palette only for a MISSING field', () => {
    // An old saved cloner has no varyPalette at all and must still get the defaults.
    const v = varyOf(C({ varyPalette: undefined as unknown as string[] }))
    expect(v.palette).toEqual(DEFAULT_VARY.palette)
  })

  it('honours a deliberately EMPTIED palette, which disables colour', () => {
    // `lib/vary`'s contract: an empty palette disables colour regardless of the flag
    // (varyColorAt returns undefined for it). Substituting the defaults here would tint
    // every copy blue/orange the moment the panel grows a remove-swatch control.
    const v = varyOf(C({ varyColor: true, varyPalette: [] }))
    expect(v.palette).toEqual([])
    expect(varyColorAt(0.5, 0, v)).toBeUndefined()
  })
})

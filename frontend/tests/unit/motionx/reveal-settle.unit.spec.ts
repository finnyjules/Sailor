import { describe, it, expect } from 'vitest'
import {
  SETTLE_EFFECTS, settleParams, settleStrength, settleFade, settleUniforms, settleSpec, settleEffectOf,
  revealEffectIdsFor,
} from '~/lib/motionx/reveal'
import { compileBehaviour, type Behaviour } from '~/lib/motionx'
import manifest from '../../../../shader_effects/manifest.json'
import type { EffectDef } from '~/lib/shaderfx/types'

const effects = (manifest as unknown as { effects: EffectDef[] }).effects

describe('SETTLE_EFFECTS — pinned against the shader manifest', () => {
  it('has exactly the ten tile ids from Addendum 3, in gallery order', () => {
    expect(SETTLE_EFFECTS.map((e) => e.id)).toEqual([
      'slice', 'glitch', 'split', 'blur', 'zoomblur', 'pixelate', 'wave', 'liquify', 'swirl', 'ripple',
    ])
  })

  it('every effectId exists in the catalogue, and every dial key is a declared float param u_<key>', () => {
    for (const row of SETTLE_EFFECTS) {
      const def = effects.find((e) => e.id === row.effectId)
      expect(def, `${row.id} → ${row.effectId} missing from manifest`).toBeDefined()
      for (const dial of row.dials) {
        const uniform = `u_${dial.key}`
        const param = def!.params.find((p) => p.uniform === uniform)
        expect(param, `${row.effectId}.${uniform} not declared`).toBeDefined()
        expect(param!.type, `${row.effectId}.${uniform} is not a float param`).toBe('float')
      }
    }
  })

  it("Glitch drives both amount and chroma", () => {
    const glitch = SETTLE_EFFECTS.find((e) => e.id === 'glitch')!
    expect(glitch.dials.map((d) => d.key)).toEqual(['amount', 'chroma'])
    expect(glitch.dials.map((d) => d.full)).toEqual([0.2, 0.03])
  })
})

describe('settleEffectOf / settleParams', () => {
  it('defaults: dir in, effect slice, strength 70/100, fade on', () => {
    const p = settleParams(undefined)
    expect(p.out).toBe(false)
    expect(p.effect.id).toBe('slice')
    expect(p.strength).toBeCloseTo(0.7, 9)
    expect(p.fade).toBe(true)
  })

  it('dir out', () => {
    expect(settleParams({ dir: 'out' }).out).toBe(true)
  })

  it('an unknown effect id falls back to slice', () => {
    expect(settleEffectOf('nope').id).toBe('slice')
    expect(settleEffectOf(undefined).id).toBe('slice')
    expect(settleEffectOf(42).id).toBe('slice')
    expect(settleParams({ effect: 'nope' }).effect.id).toBe('slice')
  })

  it('every catalogue id round-trips through settleEffectOf', () => {
    for (const row of SETTLE_EFFECTS) expect(settleEffectOf(row.id).id).toBe(row.id)
  })

  it('strength clamps into [0, 100] before dividing, and non-finite falls back to the default', () => {
    expect(settleParams({ strength: -50 }).strength).toBe(0)
    expect(settleParams({ strength: 250 }).strength).toBeCloseTo(1, 9)
    expect(settleParams({ strength: NaN }).strength).toBeCloseTo(0.7, 9)
    expect(settleParams({ strength: '80' }).strength).toBeCloseTo(0.7, 9)
    expect(settleParams({ strength: 0 }).strength).toBe(0)
  })

  it('fade defaults true; only literal false turns it off', () => {
    expect(settleParams({}).fade).toBe(true)
    expect(settleParams({ fade: false }).fade).toBe(false)
    expect(settleParams({ fade: true }).fade).toBe(true)
    expect(settleParams({ fade: 'no' }).fade).toBe(true)   // anything but literal false → on
    expect(settleParams({ fade: 0 }).fade).toBe(true)
  })
})

describe('settleStrength — the (1 − amount)² curve', () => {
  it('is exactly `strength` at amount 0, and 0 at amount 1', () => {
    expect(settleStrength(0, 0.7)).toBeCloseTo(0.7, 9)
    expect(settleStrength(1, 0.7)).toBe(0)
  })
  it('matches (1 - a) ** 2 * strength at a few points', () => {
    for (const a of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      expect(settleStrength(a, 0.4)).toBeCloseTo((1 - a) ** 2 * 0.4, 9)
    }
  })
  it('is monotonically non-increasing as amount rises', () => {
    let prev = Infinity
    for (let a = 0; a <= 1.0001; a += 0.02) {
      const k = settleStrength(a, 1)
      expect(k).toBeLessThanOrEqual(prev + 1e-9)
      prev = k
    }
  })
  it('clamps an out-of-range or non-finite amount into [0, 1]', () => {
    expect(settleStrength(-3, 0.5)).toBeCloseTo(0.5, 9)
    expect(settleStrength(9, 0.5)).toBe(0)
    expect(settleStrength(NaN, 0.5)).toBeCloseTo(0.5, 9)
  })
})

describe('settleFade', () => {
  it('off entirely when fade is false, at any amount', () => {
    expect(settleFade(0, false)).toBe(1)
    expect(settleFade(0.1, false)).toBe(1)
    expect(settleFade(1, false)).toBe(1)
  })
  it('ramps 0 → 1 over the first quarter of the bar, then holds', () => {
    expect(settleFade(0, true)).toBe(0)
    expect(settleFade(0.125, true)).toBeCloseTo(0.5, 9)
    expect(settleFade(0.25, true)).toBe(1)
    expect(settleFade(0.6, true)).toBe(1)
    expect(settleFade(1, true)).toBe(1)
  })
  it('bad amounts clamp rather than going negative or past 1', () => {
    expect(settleFade(-1, true)).toBe(0)
    expect(settleFade(NaN, true)).toBe(0)
  })
})

describe('settleUniforms', () => {
  it('reaches EXACTLY rest at k = 0 and full at k = 1, for all ten effects', () => {
    for (const effect of SETTLE_EFFECTS) {
      const atRest = settleUniforms(effect, 0)
      const atFull = settleUniforms(effect, 1)
      for (const dial of effect.dials) {
        expect(atRest[`u_${dial.key}`], `${effect.id}.${dial.key} @ k=0`).toBe(dial.rest)
        expect(atFull[`u_${dial.key}`], `${effect.id}.${dial.key} @ k=1`).toBe(dial.full)
      }
    }
  })

  it("Glitch's two dials both interpolate", () => {
    const glitch = SETTLE_EFFECTS.find((e) => e.id === 'glitch')!
    const half = settleUniforms(glitch, 0.5)
    expect(half.u_amount).toBeCloseTo(0.1, 9)
    expect(half.u_chroma).toBeCloseTo(0.015, 9)
  })

  it('is linear in between', () => {
    const slice = SETTLE_EFFECTS.find((e) => e.id === 'slice')!
    expect(settleUniforms(slice, 0.5).u_amount).toBeCloseTo(0.175, 9)
  })
})

describe('settleSpec', () => {
  it('no stored params, a fixed speed and seed so the clock agrees everywhere', () => {
    const slice = SETTLE_EFFECTS.find((e) => e.id === 'slice')!
    expect(settleSpec(slice)).toEqual({ effectId: 'slice_shift', params: {}, speed: 1, seed: 42 })
    const swirl = SETTLE_EFFECTS.find((e) => e.id === 'swirl')!
    expect(settleSpec(swirl).effectId).toBe('swirl')
  })
})

describe('the settle compiler', () => {
  const TARGET = { get: () => undefined, has: () => false }
  const beh = (params: Record<string, unknown> = {}, start = 1, duration = 2): Behaviour =>
    ({ id: 'b1', layerId: 'L', kind: 'settle', params, timing: { start, duration } }) as unknown as Behaviour

  it('in: ONE number track on `reveal`, 0 → 1 across the bar', () => {
    const tr = compileBehaviour(beh(), TARGET)
    expect(tr).toHaveLength(1)
    expect(tr[0]!.path).toBe('reveal'); expect(tr[0]!.type).toBe('number')
    expect(tr[0]!.keyframes.map((k) => [k.t, k.value])).toEqual([[1, 0], [3, 1]])
  })

  it('out: 1 → 0', () => {
    const tr = compileBehaviour(beh({ dir: 'out' }), TARGET)
    expect(tr[0]!.keyframes.map((k) => k.value)).toEqual([1, 0])
  })

  it('defaults to a LINEAR curve, exactly like dither', () => {
    for (const dir of ['in', 'out']) {
      const tr = compileBehaviour(beh({ dir }), TARGET)
      expect(tr[0]!.keyframes[0]!.ease, dir).toBe('linear')
    }
  })

  it('honours params.ease like every other bar', () => {
    const tr = compileBehaviour(beh({ ease: 'easeInOut' }), TARGET)
    expect(tr[0]!.keyframes[0]!.ease).toBe('easeInOut')
  })
})

describe('revealEffectIdsFor', () => {
  it('empty / missing behaviours → empty', () => {
    expect(revealEffectIdsFor(undefined)).toEqual([])
    expect(revealEffectIdsFor([])).toEqual([])
  })

  it('a Pixels dither bar needs ascii_dither; a mask-style dither bar needs nothing', () => {
    expect(revealEffectIdsFor([{ kind: 'dither', params: { style: 'pixels' } }])).toEqual(['ascii_dither'])
    expect(revealEffectIdsFor([{ kind: 'dither', params: { style: 'wipe' } }])).toEqual([])
    expect(revealEffectIdsFor([{ kind: 'dither' }])).toEqual(['ascii_dither'])   // Pixels is the default
  })

  it('Assemble needs bayer_dither for the Dither look, ascii_dither for Characters', () => {
    expect(revealEffectIdsFor([{ kind: 'dither', params: { style: 'assemble', look: 'dither' } }])).toEqual(['bayer_dither'])
    expect(revealEffectIdsFor([{ kind: 'dither', params: { style: 'assemble', look: 'characters' } }])).toEqual(['ascii_dither'])
  })

  it("a settle bar needs its own effect's catalogue id", () => {
    expect(revealEffectIdsFor([{ kind: 'settle', params: { effect: 'swirl' } }])).toEqual(['swirl'])
    expect(revealEffectIdsFor([{ kind: 'settle' }])).toEqual(['slice_shift'])   // slice is the default
  })

  it('a mixed set, de-duplicated, non-reveal bars ignored', () => {
    const ids = revealEffectIdsFor([
      { kind: 'fade' },
      { kind: 'dither', params: { style: 'pixels' } },
      { kind: 'dither', params: { style: 'assemble', look: 'characters' } },   // same id as Pixels
      { kind: 'dither', params: { style: 'assemble', look: 'dither' } },
      { kind: 'settle', params: { effect: 'blur' } },
      { kind: 'settle', params: { effect: 'blur' } },   // duplicate settle effect
    ])
    expect(ids).toEqual(['ascii_dither', 'bayer_dither', 'gaussian_blur'])
  })
})

// Found live: two of the ten shaders are NOT the identity at zero strength — the Blur effect
// never blurs by less than one pixel, and the Glitch effect darkens its bands by a fixed 25%
// whatever its Amount — so the end of the bar popped (7–11k pixels, up to 79/255). The real
// layer therefore cross-fades in over the last stretch, as the Pixels style does.
describe('settleSharp — the hand-off to the real layer', () => {
  it('is 0 for most of the bar, 1 at its end, smooth and monotonic between', async () => {
    const { settleSharp } = await import('~/lib/motionx/reveal')
    for (const a of [0, 0.3, 0.6, 0.85]) expect(settleSharp(a)).toBe(0)
    expect(settleSharp(0.925)).toBeCloseTo(0.5, 9)
    expect(settleSharp(1)).toBe(1)
    let prev = -1
    for (let a = 0; a <= 1.0001; a += 0.01) { const v = settleSharp(a); expect(v).toBeGreaterThanOrEqual(prev); prev = v }
  })
  it('clamps and survives bad amounts', async () => {
    const { settleSharp } = await import('~/lib/motionx/reveal')
    expect(settleSharp(-2)).toBe(0); expect(settleSharp(7)).toBe(1); expect(settleSharp(NaN)).toBe(0)
  })
})

import { describe, it, expect } from 'vitest'
import {
  revealParams, revealCellDefault, REVEAL_STYLES, REVEAL_DEFAULTS,
  PIXEL_CHARS, PIXEL_END, PIXEL_JITTER,
  pixelStages, pixelBlock, pixelBrightness, pixelSharp, pixelShaderParams,
  type MotionReveal,
} from '~/lib/motionx/reveal'
import manifest from '../../../../shader_effects/manifest.json'
import type { EffectDef } from '~/lib/shaderfx/types'

const R = (over: Partial<MotionReveal> = {}): MotionReveal =>
  ({ ...revealParams({ style: 'pixels' }), amount: 0.5, elapsed: 0, ...over })

describe('revealParams — Pixels', () => {
  it('Pixels is first in REVEAL_STYLES and is the default', () => {
    expect(REVEAL_STYLES[0]).toBe('pixels')
    expect(REVEAL_DEFAULTS.style).toBe('pixels')
    expect(revealParams(undefined).style).toBe('pixels')
  })

  it('per-style cell default: Pixels 24‰, the three mask styles 8‰', () => {
    expect(revealCellDefault('pixels')).toBe(24)
    expect(revealCellDefault('dissolve')).toBe(8)
    expect(revealCellDefault('wipe')).toBe(8)
    expect(revealCellDefault('dots')).toBe(8)
    expect(revealParams({ style: 'pixels' }).cell).toBeCloseTo(0.024, 9)
    expect(revealParams({ style: 'dissolve' }).cell).toBeCloseTo(0.008, 9)
    expect(revealParams({ style: 'wipe' }).cell).toBeCloseTo(0.008, 9)
    expect(revealParams({ style: 'dots' }).cell).toBeCloseTo(0.008, 9)
  })

  it('an explicit cell wins over the per-style default', () => {
    expect(revealParams({ style: 'pixels', cell: 10 }).cell).toBeCloseTo(0.01, 9)
    expect(revealParams({ style: 'dissolve', cell: 10 }).cell).toBeCloseTo(0.01, 9)
  })

  it('an unknown style falls back to Pixels', () => {
    expect(revealParams({ style: 'plaid' }).style).toBe('pixels')
  })

  it('chars: default 1, only a PIXEL_CHARS value (rounded) survives, everything else → 1', () => {
    expect(revealParams({}).chars).toBe(1)
    expect(revealParams({ chars: 14 }).chars).toBe(1)     // Custom — deliberately excluded
    expect(revealParams({ chars: 99 }).chars).toBe(1)
    expect(revealParams({ chars: NaN }).chars).toBe(1)
    expect(revealParams({ chars: '8' }).chars).toBe(1)    // numbers only
    expect(revealParams({ chars: 8.2 }).chars).toBe(8)    // rounds to a valid value
    expect(revealParams({ chars: 0 }).chars).toBe(0)      // Mixed, value 0 — falsy but valid
    expect(revealParams({ chars: 19 }).chars).toBe(19)    // Gems, the last entry
  })
})

describe('PIXEL_CHARS — pinned against the shader manifest', () => {
  it('equals the ascii_dither u_shape options, minus Custom (value 14)', () => {
    const effects = (manifest as unknown as { effects: EffectDef[] }).effects
    const ascii = effects.find((e) => e.id === 'ascii_dither')
    if (!ascii) throw new Error('no ascii_dither effect in the manifest')
    const shape = (ascii.params as unknown as Array<{ uniform: string; options?: { label: string; value: number }[] }>)
      .find((p) => p.uniform === 'u_shape')
    if (!shape?.options) throw new Error('ascii_dither has no u_shape options')
    const expected = shape.options.filter((o) => o.value !== 14)
    expect(PIXEL_CHARS).toEqual(expected)
  })
})

describe('pixelStages / pixelBlock', () => {
  it('a 0.024 dial halves through [24, 12, 6, 3, 1.5]‰, boundaries at multiples of 0.2', () => {
    expect(pixelStages(0.024)).toBe(4)
    const stagesPerMille = (amount: number) => pixelBlock(amount, 0.024) * 1000
    expect(stagesPerMille(0)).toBeCloseTo(24, 9)
    expect(stagesPerMille(0.19)).toBeCloseTo(24, 9)
    expect(stagesPerMille(0.2)).toBeCloseTo(12, 9)
    expect(stagesPerMille(0.39)).toBeCloseTo(12, 9)
    expect(stagesPerMille(0.4)).toBeCloseTo(6, 9)
    expect(stagesPerMille(0.59)).toBeCloseTo(6, 9)
    expect(stagesPerMille(0.6)).toBeCloseTo(3, 9)
    expect(stagesPerMille(0.79)).toBeCloseTo(3, 9)
    expect(stagesPerMille(0.8)).toBeCloseTo(1.5, 9)
    expect(stagesPerMille(1)).toBeCloseTo(1.5, 9)
  })

  it('a dial already at or below PIXEL_END has one stage: the block never changes with amount', () => {
    expect(pixelStages(PIXEL_END)).toBe(0)
    expect(pixelStages(PIXEL_END / 2)).toBe(0)
    for (const amount of [0, 0.3, 0.7, 1]) expect(pixelBlock(amount, PIXEL_END)).toBeCloseTo(PIXEL_END, 12)
  })

  it('bad amounts clamp into [0, 1] rather than throwing or going out of range', () => {
    expect(pixelBlock(-1, 0.024)).toBeCloseTo(0.024, 9)
    expect(pixelBlock(2, 0.024)).toBeCloseTo(0.0015, 9)
    expect(pixelBlock(NaN, 0.024)).toBeCloseTo(0.024, 9)
    expect(() => pixelBlock(Infinity, 0.024)).not.toThrow()
  })
})

describe('pixelBrightness', () => {
  // The matte shader's tone runs 0.25–0.75 with ±0.125 of jitter (see ascii_dither.frag).
  const density = (tone: number, jitter: number, amount: number) => Math.min(1, Math.max(0, tone + jitter + pixelBrightness(amount)))
  it('draws nothing at all at amount 0, whatever the tone and the jitter', () => {
    expect(pixelBrightness(0)).toBeCloseTo(-0.9, 9)
    expect(density(0.75, 0.125, 0)).toBe(0)
  })
  it('the coarsest blocks are SEEN: by the end of stage one (amount 0.2) bright and mid tones already have density', () => {
    expect(density(0.75, 0, 0.2)).toBeGreaterThan(0.4)
    expect(density(0.5, 0, 0.2)).toBeGreaterThan(0.2)
  })
  it('every covered cell is full by mid-bar, darkest tone and worst jitter included, and stays full', () => {
    for (const a of [0.5, 0.6, 0.8, 1]) expect(density(0.25, -0.125, a)).toBe(1)
    expect(pixelBrightness(1)).toBe(1)                       // never above the shader's own range
  })
  it('never falls as the amount rises; bad amounts clamp', () => {
    let prev = -Infinity
    for (let a = 0; a <= 1.0001; a += 0.02) { const b = pixelBrightness(a); expect(b).toBeGreaterThanOrEqual(prev); prev = b }
    expect(pixelBrightness(-3)).toBeCloseTo(-0.9, 9); expect(pixelBrightness(9)).toBe(1); expect(pixelBrightness(NaN)).toBeCloseTo(-0.9, 9)
  })
})

describe('pixelSharp', () => {
  it('is 0 up to 0.8, 0.5 at 0.9, 1 at 1, and monotonic across the bar', () => {
    expect(pixelSharp(0)).toBe(0)
    expect(pixelSharp(0.5)).toBe(0)
    expect(pixelSharp(0.8)).toBe(0)
    expect(pixelSharp(0.9)).toBeCloseTo(0.5, 9)
    expect(pixelSharp(1)).toBe(1)
    let prev = -1
    for (let a = 0; a <= 1.0001; a += 0.01) {
      const v = pixelSharp(a)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })
})

describe('pixelShaderParams', () => {
  it('keys match the ASCII effect params without the u_ prefix, cell scaled by frame W/H and clamped', () => {
    const r = R({ chars: 8, amount: 0, cell: 0.024, drift: 6 })
    const params = pixelShaderParams(r, 1920, 1080)
    expect(params.shape).toBe(8)
    expect(params.cell).toBeCloseTo(pixelBlock(0, 0.024) * 1920 / 1080, 9)
    expect(params.brightness).toBe(pixelBrightness(0))   // whatever the ramp says at this amount
    expect(params.jitter).toBe(PIXEL_JITTER)
    expect(params.speed).toBeCloseTo(1, 9)   // drift 6 / 6
    expect(params.colored).toBe(1)
    expect(params.underlay).toBe(0)
    expect(params.spacing).toBe(0)
    expect(params.invert).toBe(0)
    expect(params.blur).toBe(0)
  })

  it('speed is 0 when drift is 0', () => {
    expect(pixelShaderParams(R({ drift: 0 }), 1920, 1080).speed).toBe(0)
  })

  it('cell is clamped into the manifest range [0.004, 0.1]', () => {
    const tiny = pixelShaderParams(R({ amount: 1, cell: 0.001 }), 1920, 1080)
    expect(tiny.cell).toBeGreaterThanOrEqual(0.004)
    const huge = pixelShaderParams(R({ amount: 0, cell: 0.5 }), 1920, 1080)
    expect(huge.cell).toBeLessThanOrEqual(0.1)
  })

  it('guards against a zero or negative frame height', () => {
    expect(() => pixelShaderParams(R(), 1920, 0)).not.toThrow()
    expect(() => pixelShaderParams(R(), 1920, -10)).not.toThrow()
    expect(Number.isFinite(pixelShaderParams(R(), 1920, 0).cell)).toBe(true)
  })
})

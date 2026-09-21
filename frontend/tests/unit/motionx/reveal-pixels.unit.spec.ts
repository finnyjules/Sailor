import { describe, it, expect } from 'vitest'
import {
  revealParams, revealCellDefault, REVEAL_STYLES, REVEAL_DEFAULTS,
  PIXEL_CHARS, PIXEL_END, PIXEL_JITTER,
  pixelStages, pixelBlock, pixelBrightness, PIXEL_TONE_MIN, PIXEL_TONE_MAX, pixelSharp, pixelShaderParams, pixelFinest,
  motionUsesPixels,
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
    expect(revealParams({ chars: 14 }).chars).toBe(14)    // Custom — now a valid PIXEL_CHARS value
    expect(revealParams({ chars: 99 }).chars).toBe(1)
    expect(revealParams({ chars: NaN }).chars).toBe(1)
    expect(revealParams({ chars: '8' }).chars).toBe(1)    // numbers only
    expect(revealParams({ chars: 8.2 }).chars).toBe(8)    // rounds to a valid value
    expect(revealParams({ chars: 0 }).chars).toBe(0)      // Mixed, value 0 — falsy but valid
    expect(revealParams({ chars: 19 }).chars).toBe(19)    // Gems, the last entry
  })
})

/**
 * An EXPORT has to know, before its first frame, whether it is going to need the ASCII
 * shader — otherwise a glyph atlas landing mid-bake flips the video from the Dissolve
 * fallback to characters part-way through. This is that question, asked of the stored
 * behaviours and answered through `revealParams` like every other read.
 */
describe('motionUsesPixels', () => {
  it('no behaviours at all', () => {
    expect(motionUsesPixels(undefined)).toBe(false)
    expect(motionUsesPixels([])).toBe(false)
  })

  it('a dither bar with no style set — Pixels is the default, so yes', () => {
    expect(motionUsesPixels([{ kind: 'dither' }])).toBe(true)
    expect(motionUsesPixels([{ kind: 'dither', params: { dir: 'out' } }])).toBe(true)
    // …and an unknown style falls back to Pixels the same way revealParams does.
    expect(motionUsesPixels([{ kind: 'dither', params: { style: 'plaid' } }])).toBe(true)
  })

  it('a dither bar in a MASK style — no shader needed', () => {
    for (const style of ['dissolve', 'wipe', 'dots']) {
      expect(motionUsesPixels([{ kind: 'dither', params: { style } }]), style).toBe(false)
    }
  })

  it('a non-dither bar is not a dither bar, whatever its params say', () => {
    expect(motionUsesPixels([{ kind: 'fade', params: { style: 'pixels' } }])).toBe(false)
    expect(motionUsesPixels([{ kind: 'letters' }, { kind: 'slide' }])).toBe(false)
  })

  it('any ONE Pixels bar in the list is enough', () => {
    expect(motionUsesPixels([
      { kind: 'fade' },
      { kind: 'dither', params: { style: 'wipe' } },
      { kind: 'dither', params: { style: 'pixels' } },
    ])).toBe(true)
  })
})

describe('PIXEL_CHARS — pinned against the shader manifest', () => {
  it('equals the ascii_dither u_shape options EXACTLY, Custom (value 14) included', () => {
    const effects = (manifest as unknown as { effects: EffectDef[] }).effects
    const ascii = effects.find((e) => e.id === 'ascii_dither')
    if (!ascii) throw new Error('no ascii_dither effect in the manifest')
    const shape = (ascii.params as unknown as Array<{ uniform: string; options?: { label: string; value: number }[] }>)
      .find((p) => p.uniform === 'u_shape')
    if (!shape?.options) throw new Error('ascii_dither has no u_shape options')
    expect(PIXEL_CHARS).toEqual(shape.options)
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
  // The matte shader's tone is compressed to PIXEL_TONE_MIN–MAX and its jitter is ±PIXEL_JITTER/2
  // (see ascii_dither.frag — a spec there pins the same numbers).
  const J = PIXEL_JITTER / 2
  const density = (tone: number, jitter: number, amount: number) => Math.min(1, Math.max(0, tone + jitter + pixelBrightness(amount)))
  it('draws nothing at all at amount 0, whatever the tone and the jitter', () => {
    expect(density(PIXEL_TONE_MAX, J, 0)).toBe(0)
  })
  it('a transition STARTS when its bar starts: no tone waits more than a twelfth of the bar for its first cells', () => {
    // Julien, on a 4s bar: "the effects only seem to kick in at the 2s mark". Part of that was
    // a dead zone here: mid and dark tones drew nothing until 14–17% of the way through.
    expect(density(PIXEL_TONE_MAX, J, 0.02)).toBeGreaterThan(0)      // bright: its first cells at once
    expect(density(PIXEL_TONE_MAX, 0, 0.05)).toBeGreaterThan(0)      // bright: the typical cell by 5%
    expect(density(PIXEL_TONE_MIN, J, 0.05)).toBeGreaterThan(0)      // black: its luckiest cells by 5%
    expect(density(PIXEL_TONE_MIN, 0, 1 / 12)).toBeGreaterThan(0)    // black: the typical cell by 8%
  })
  it('the coarsest blocks are SEEN: by the end of stage one (amount 0.2) every tone has real density', () => {
    expect(density(PIXEL_TONE_MAX, 0, 0.2)).toBeGreaterThan(0.5)
    expect(density(PIXEL_TONE_MIN, 0, 0.2)).toBeGreaterThan(0.35)
  })
  it('every covered cell is full by 40% of the bar, darkest tone and worst jitter included, and stays full', () => {
    for (const a of [0.4, 0.5, 0.6, 0.8, 1]) expect(density(PIXEL_TONE_MIN, -J, a)).toBe(1)
    expect(pixelBrightness(1)).toBe(1)                       // never above the shader's own range
  })
  it('never falls as the amount rises; bad amounts clamp', () => {
    let prev = -Infinity
    for (let a = 0; a <= 1.0001; a += 0.02) { const b = pixelBrightness(a); expect(b).toBeGreaterThanOrEqual(prev); prev = b }
    expect(pixelBrightness(-3)).toBe(pixelBrightness(0)); expect(pixelBrightness(9)).toBe(1); expect(pixelBrightness(NaN)).toBe(pixelBrightness(0))
  })
  it('the tone constants are the ones the shader uses', async () => {
    const { readFileSync } = await import('node:fs'); const { resolve } = await import('node:path')
    const frag = readFileSync(resolve(__dirname, '../../../../shader_effects/ascii_dither.frag'), 'utf8')
    const spread = +(PIXEL_TONE_MAX - PIXEL_TONE_MIN).toFixed(3)
    expect(PIXEL_TONE_MIN + spread / 2).toBeCloseTo(0.5, 9)
    expect(frag).toContain(`mix(0.5, lum, ${spread})`)
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

describe('pixelFinest — the ladder ends where the SHADER stops honouring it', () => {
  // The shader clamps `u_cell` (a fraction of the frame's HEIGHT) to the manifest range
  // [0.004, 0.1], but the ladder is built in frame-WIDTH fractions. On a portrait frame the
  // two disagree badly enough that the last three stages collapsed into one cell size.
  it('is the width fraction the shader\'s own 0.004 height floor corresponds to, never finer than PIXEL_END', () => {
    expect(pixelFinest(1920, 1080)).toBeCloseTo(0.004 * 1080 / 1920, 12)
    expect(pixelFinest(1080, 1920)).toBeCloseTo(0.004 * 1920 / 1080, 12)
    // A very wide frame would put the shader's floor below the maths' own end — PIXEL_END wins.
    expect(pixelFinest(4000, 100)).toBe(PIXEL_END)
  })

  it('leaves the classic landscape ladder for 24‰ exactly as it was', () => {
    const finest = pixelFinest(1920, 1080)
    expect(pixelStages(0.024, finest)).toBe(pixelStages(0.024))
    for (const a of [0, 0.2, 0.4, 0.6, 0.8, 1]) {
      expect(pixelBlock(a, 0.024, finest)).toBeCloseTo(pixelBlock(a, 0.024), 12)
    }
  })

  it('defaults to PIXEL_END, so a caller that passes no finest is unchanged', () => {
    expect(pixelStages(0.024, PIXEL_END)).toBe(pixelStages(0.024))
    expect(pixelBlock(0.5, 0.024, PIXEL_END)).toBeCloseTo(pixelBlock(0.5, 0.024), 12)
  })
})

/** Every stage of the ladder, as the shader's own `cell` — sampled at the first amount of
 *  each stage's bucket (`pixelBlock` spreads stages + 1 buckets evenly over the bar). */
function stageCells(dial: number, W: number, H: number): number[] {
  const start = Math.min(dial, 0.1 * H / W)
  const n = pixelStages(start, pixelFinest(W, H))
  return Array.from({ length: n + 1 }, (_, k) => pixelShaderParams(R({ amount: k / (n + 1), cell: dial }), W, H).cell)
}

describe('the halving ladder in the shader\'s own units', () => {
  it('1080×1920, dial 24‰: every stage is a DISTINCT cell inside [0.004, 0.1]', () => {
    const cells = stageCells(0.024, 1080, 1920)
    expect(cells.length).toBeGreaterThan(1)
    for (const c of cells) { expect(c).toBeGreaterThanOrEqual(0.004); expect(c).toBeLessThanOrEqual(0.1) }
    for (let i = 1; i < cells.length; i++) expect(cells[i]).not.toBeCloseTo(cells[i - 1]!, 9)
    // …and each one is finer than the last: this is a refinement, not a shuffle.
    for (let i = 1; i < cells.length; i++) expect(cells[i]!).toBeLessThan(cells[i - 1]!)
  })

  it('1920×1080, dial 24‰: still five stages, all distinct', () => {
    const cells = stageCells(0.024, 1920, 1080)
    expect(cells).toHaveLength(5)
    for (let i = 1; i < cells.length; i++) expect(cells[i]!).toBeLessThan(cells[i - 1]!)
  })

  it('the first stage is the dial\'s own size — or the cap, when the dial is coarser than the shader allows', () => {
    expect(stageCells(0.024, 1920, 1080)[0]).toBeCloseTo(0.024 * 1920 / 1080, 9)
    expect(stageCells(0.024, 1080, 1920)[0]).toBeCloseTo(0.024 * 1080 / 1920, 9)
    // A dial coarser than 0.1 * H / W caps at the shader's own ceiling rather than being
    // clamped flat (which would have made the first TWO stages the same cell).
    const capped = stageCells(0.5, 1920, 1080)
    expect(capped[0]).toBeCloseTo(0.1, 9)
    expect(capped[1]!).toBeLessThan(capped[0]!)
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

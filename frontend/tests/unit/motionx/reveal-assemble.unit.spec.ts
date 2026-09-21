import { describe, it, expect } from 'vitest'
import {
  revealParams, revealCellDefault, REVEAL_STYLES, REVEAL_DEFAULTS,
  motionUsesPixels, motionUsesShaderStyle,
  DITHER_PATTERNS, assembleSoft, assembleCell, assembleTest, buildAssembleMasks,
  assembleShaderParams, assembleGrid,
  type MotionReveal,
} from '~/lib/motionx/reveal'
import manifest from '../../../../shader_effects/manifest.json'
import type { EffectDef } from '~/lib/shaderfx/types'

const GRID = { cols: 40, rows: 24 }
const R = (over: Partial<MotionReveal> = {}): MotionReveal =>
  ({ ...revealParams({ style: 'assemble' }), amount: 0.5, elapsed: 0, ...over })

describe('REVEAL_STYLES — Assemble is second, Pixels stays first', () => {
  it('order', () => {
    expect(REVEAL_STYLES).toEqual(['pixels', 'assemble', 'dissolve', 'wipe', 'dots'])
  })
})

describe('revealParams — Assemble\'s five new dials', () => {
  it('defaults', () => {
    const p = revealParams({ style: 'assemble' })
    expect(p.look).toBe('dither')
    expect(p.pattern).toBe(2)
    expect(p.levels).toBe(3)
    expect(p.band).toBeCloseTo(0.3, 9)
    expect(p.scatter).toBeCloseTo(0.35, 9)
  })

  it('revealCellDefault("assemble") is 16', () => {
    expect(revealCellDefault('assemble')).toBe(16)
    expect(revealParams({ style: 'assemble' }).cell).toBeCloseTo(0.016, 9)
  })

  it('look: only "characters" survives as non-default; anything else (missing, wrong type, unknown string) falls back to "dither"', () => {
    expect(revealParams({ style: 'assemble', look: 'characters' }).look).toBe('characters')
    expect(revealParams({ style: 'assemble' }).look).toBe('dither')
    expect(revealParams({ style: 'assemble', look: 'plaid' }).look).toBe('dither')
    expect(revealParams({ style: 'assemble', look: 7 }).look).toBe('dither')
    expect(revealParams({ style: 'assemble', look: null }).look).toBe('dither')
  })

  it('pattern: a valid manifest value survives; strings, NaN, and out-of-range values fall back to the default (2), never clamp', () => {
    expect(revealParams({ pattern: 5 }).pattern).toBe(5)
    expect(revealParams({ pattern: 0 }).pattern).toBe(0)
    expect(revealParams({ pattern: 11 }).pattern).toBe(11)
    expect(revealParams({ pattern: 99 }).pattern).toBe(2)
    expect(revealParams({ pattern: -1 }).pattern).toBe(2)
    expect(revealParams({ pattern: NaN }).pattern).toBe(2)
    expect(revealParams({ pattern: '5' }).pattern).toBe(2)
    expect(revealParams({ pattern: 4.4 }).pattern).toBe(4)   // rounds to a valid value
  })

  it('levels: clamps into [2, 8] and rounds; bad values fall back to the default (3)', () => {
    expect(revealParams({ levels: 3.6 }).levels).toBe(4)
    expect(revealParams({ levels: 0 }).levels).toBe(2)
    expect(revealParams({ levels: 99 }).levels).toBe(8)
    expect(revealParams({ levels: NaN }).levels).toBe(3)
    expect(revealParams({ levels: 'lots' }).levels).toBe(3)
  })

  it('band / scatter: stored 0–100 → maths 0–1, clamped; bad values fall back to the defaults (30 / 35)', () => {
    expect(revealParams({ band: 60 }).band).toBeCloseTo(0.6, 9)
    expect(revealParams({ band: -10 }).band).toBe(0)
    expect(revealParams({ band: 500 }).band).toBe(1)
    expect(revealParams({ band: NaN }).band).toBeCloseTo(0.3, 9)
    expect(revealParams({ scatter: 0 }).scatter).toBe(0)
    expect(revealParams({ scatter: -10 }).scatter).toBe(0)
    expect(revealParams({ scatter: 500 }).scatter).toBe(1)
    expect(revealParams({ scatter: 'fast' }).scatter).toBeCloseTo(0.35, 9)
  })

  it('an unknown style still falls back to Pixels, and Assemble round-trips', () => {
    expect(revealParams({ style: 'assemble' }).style).toBe('assemble')
    expect(revealParams({ style: 'plaid' }).style).toBe('pixels')
  })
})

describe('DITHER_PATTERNS — pinned against the shader manifest', () => {
  it('equals the bayer_dither u_pattern options, labels and values', () => {
    const effects = (manifest as unknown as { effects: EffectDef[] }).effects
    const bayer = effects.find((e) => e.id === 'bayer_dither')
    if (!bayer) throw new Error('no bayer_dither effect in the manifest')
    const pattern = (bayer.params as unknown as Array<{ uniform: string; options?: { label: string; value: number }[] }>)
      .find((p) => p.uniform === 'u_pattern')
    if (!pattern?.options) throw new Error('bayer_dither has no u_pattern options')
    expect(DITHER_PATTERNS).toEqual(pattern.options)
  })
})

describe('motionUsesShaderStyle / motionUsesPixels — Pixels OR Assemble need a shader', () => {
  it('Assemble counts as a shader style', () => {
    expect(motionUsesShaderStyle([{ kind: 'dither', params: { style: 'assemble' } }])).toBe(true)
    expect(motionUsesPixels([{ kind: 'dither', params: { style: 'assemble' } }])).toBe(true)
  })
  it('the mask styles still do not', () => {
    for (const style of ['dissolve', 'wipe', 'dots']) {
      expect(motionUsesShaderStyle([{ kind: 'dither', params: { style } }]), style).toBe(false)
    }
  })
  it('motionUsesPixels is a plain alias — identical behaviour to motionUsesShaderStyle', () => {
    expect(motionUsesPixels).toBe(motionUsesShaderStyle)
  })
})

// ── assembleCell / assembleTest ────────────────────────────────────────────────────────────

describe('assembleCell', () => {
  it('amount <= 0 is nothing everywhere; amount >= 1 is sharp everywhere; non-finite is nothing', () => {
    for (const amount of [0, -0.3]) for (let y = 0; y < GRID.rows; y += 5) for (let x = 0; x < GRID.cols; x += 5) {
      expect(assembleCell(R({ amount }), x, y, GRID)).toBe(0)
    }
    for (const amount of [1, 1.4]) for (let y = 0; y < GRID.rows; y += 5) for (let x = 0; x < GRID.cols; x += 5) {
      expect(assembleCell(R({ amount }), x, y, GRID)).toBe(2)
    }
    for (const amount of [NaN, Infinity, -Infinity]) {
      expect(assembleCell(R({ amount }), 5, 5, GRID)).toBe(0)
    }
  })

  it('never look AND sharp at once (the function only ever returns one state)', () => {
    for (const amount of [0, 0.1, 0.3, 0.5, 0.7, 0.9, 1]) {
      for (let y = 0; y < GRID.rows; y += 3) for (let x = 0; x < GRID.cols; x += 3) {
        const v = assembleCell(R({ amount, drift: 0 }), x, y, GRID)
        expect([0, 1, 2]).toContain(v)
      }
    }
  })

  it('monotonic per cell with drift 0: 0 → 1 → 2, never backwards, for In and Out, at four angles', () => {
    for (const out of [false, true]) for (const deg of [0, 90, 180, 270]) {
      const angle = (deg * Math.PI) / 180
      for (let y = 0; y < GRID.rows; y += 4) for (let x = 0; x < GRID.cols; x += 4) {
        let prev = 0
        for (let a = 0; a <= 1.0001; a += 0.02) {
          const v = assembleCell(R({ amount: a, drift: 0, out, angle }), x, y, GRID)
          expect(v, `${out} ${deg} @${x},${y} a=${a}`).toBeGreaterThanOrEqual(prev)
          prev = v
        }
      }
    }
  })

  it('with scatter 0, both fronts are hard lines "band" apart — at angle 0 a whole column (fixed x) is one state', () => {
    for (const amount of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const r = R({ amount, scatter: 0, band: 0.3, drift: 0, angle: 0 })
      for (let x = 0; x < GRID.cols; x++) {
        const first = assembleCell(r, x, 0, GRID)
        for (let y = 1; y < GRID.rows; y++) expect(assembleCell(r, x, y, GRID)).toBe(first)
      }
    }
  })

  it('with band 0 and scatter 0, no cell is ever in state 1 at any of a representative set of amounts', () => {
    for (const amount of [0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95]) {
      const r = R({ amount, band: 0, scatter: 0, drift: 0 })
      for (let y = 0; y < GRID.rows; y += 2) for (let x = 0; x < GRID.cols; x += 2) {
        expect(assembleCell(r, x, y, GRID), `@${x},${y} a=${amount}`).not.toBe(1)
      }
    }
  })

  it('Out flips the travel: at angle 0, the FAR side reaches sharp first — the start side is the one left "nothing" longest', () => {
    // Same relationship as Wipe's own OUT test (`the empty side grows from the START side`):
    // flipping `along` makes the low-along (early-reached) side the FAR side under Out.
    const r = R({ amount: 0.5, out: true, drift: 0, angle: 0, scatter: 0 })
    expect(assembleCell(r, 0, 5, GRID)).toBe(0)
    expect(assembleCell(r, GRID.cols - 1, 5, GRID)).toBe(2)
  })

  it('drift changes WHICH cells are scattered but not the fully-behind / fully-ahead regions', () => {
    // Fully ahead of the first front (deep negative lp): always 0, whatever the drift.
    const ahead = R({ amount: 0.05, angle: 0, scatter: 0.5, band: 0.3 })
    const aheadDrift = R({ amount: 0.05, angle: 0, scatter: 0.5, band: 0.3, drift: 6, elapsed: 1 })
    expect(assembleCell(ahead, GRID.cols - 1, 5, GRID)).toBe(0)
    expect(assembleCell(aheadDrift, GRID.cols - 1, 5, GRID)).toBe(0)
    // Fully behind the second front (deep positive tp): always 2, whatever the drift.
    const behind = R({ amount: 0.95, angle: 0, scatter: 0.5, band: 0.3 })
    const behindDrift = R({ amount: 0.95, angle: 0, scatter: 0.5, band: 0.3, drift: 6, elapsed: 1 })
    expect(assembleCell(behind, 0, 5, GRID)).toBe(2)
    expect(assembleCell(behindDrift, 0, 5, GRID)).toBe(2)
    // In the scattered band itself, drift changes which cells are on.
    let differs = false
    const still = R({ amount: 0.5, angle: 0, scatter: 0.5, band: 0.3, drift: 0 })
    const moving = R({ amount: 0.5, angle: 0, scatter: 0.5, band: 0.3, drift: 6, elapsed: 0.5 })
    for (let x = 0; x < GRID.cols && !differs; x++) {
      if (assembleCell(still, x, 5, GRID) !== assembleCell(moving, x, 5, GRID)) differs = true
    }
    expect(differs).toBe(true)
  })
})

describe('assembleTest — the per-frame form agrees with assembleCell', () => {
  it('over a grid including negative indices, every style-relevant combination', () => {
    for (const out of [false, true]) for (const angle of [0, 0.7, Math.PI, 4.1]) {
      for (const scatter of [0, 0.35, 1]) for (const band of [0, 0.3, 1]) {
        for (const amount of [-0.1, 0, 0.17, 0.5, 0.93, 1, 1.2]) {
          const r = R({ out, angle, scatter, band, amount, drift: 6, elapsed: 0.83 })
          const test = assembleTest(r, GRID)
          for (let y = -3; y < GRID.rows + 3; y += 5) for (let x = -3; x < GRID.cols + 3; x += 4) {
            expect(test(x, y), `${out} ${angle} ${scatter} ${band} ${amount} @${x},${y}`).toBe(assembleCell(r, x, y, GRID))
          }
        }
      }
    }
  })
})

// ── buildAssembleMasks ──────────────────────────────────────────────────────────────────────

describe('buildAssembleMasks', () => {
  it('sizes: two RGBA bitmaps of cols × rows × 4 bytes', () => {
    const { look, sharp } = buildAssembleMasks(R({ amount: 0.5 }), GRID)
    expect(look.length).toBe(GRID.cols * GRID.rows * 4)
    expect(sharp.length).toBe(GRID.cols * GRID.rows * 4)
  })

  it('alpha is only ever 0 or 255, and look ∩ sharp = ∅', () => {
    const { look, sharp } = buildAssembleMasks(R({ amount: 0.5, scatter: 0.5, band: 0.3 }), GRID)
    for (let i = 0; i < GRID.cols * GRID.rows; i++) {
      expect([0, 255]).toContain(look[i * 4 + 3])
      expect([0, 255]).toContain(sharp[i * 4 + 3])
      expect(look[i * 4 + 3] === 255 && sharp[i * 4 + 3] === 255).toBe(false)
    }
  })

  it('row 0 is the TOP row: a fully-sharp amount fills every row equally', () => {
    const { sharp } = buildAssembleMasks(R({ amount: 1 }), GRID)
    for (let j = 0; j < GRID.rows; j++) expect(sharp[j * GRID.cols * 4 + 3]).toBe(255)
  })

  it('covered removes cells from the LOOK mask only, never from sharp', () => {
    const r = R({ amount: 0.4, scatter: 0.5, band: 0.3, drift: 0 })
    const full = buildAssembleMasks(r, GRID)
    const covered = new Uint8Array(GRID.cols * GRID.rows).fill(1)
    // Cover nothing on one specific cell that is currently "look".
    let idx = -1
    for (let i = 0; i < GRID.cols * GRID.rows; i++) if (full.look[i * 4 + 3] === 255) { idx = i; break }
    expect(idx).toBeGreaterThanOrEqual(0)
    covered[idx] = 0
    const masked = buildAssembleMasks(r, GRID, covered)
    expect(masked.look[idx * 4 + 3]).toBe(0)
    expect(masked.sharp).toEqual(full.sharp)   // sharp is untouched by `covered`
    // every other look cell is unaffected
    for (let i = 0; i < GRID.cols * GRID.rows; i++) if (i !== idx) expect(masked.look[i * 4 + 3]).toBe(full.look[i * 4 + 3])
  })

  it('amount 0: both masks are entirely empty', () => {
    const { look, sharp } = buildAssembleMasks(R({ amount: 0 }), GRID)
    expect(look.every((v) => v === 0)).toBe(true)
    expect(sharp.every((v) => v === 0)).toBe(true)
  })
})

// ── assembleShaderParams / assembleGrid ─────────────────────────────────────────────────────

describe('assembleShaderParams', () => {
  it('Dither look: bayer_dither with pattern/levels passed through and scale clamped, not matte', () => {
    const r = R({ look: 'dither', pattern: 5, levels: 6, cell: 0.02 })
    const p = assembleShaderParams(r, 1920, 1080)
    expect(p.effectId).toBe('bayer_dither')
    expect(p.matte).toBe(false)
    expect(p.params.pattern).toBe(5)
    expect(p.params.levels).toBe(6)
    expect(p.params.colored).toBe(1)
    expect(p.params.scale).toBeCloseTo(0.02 * 1920 / 1080, 9)
  })

  it('Dither look clamps scale into [0.003, 0.05] on a portrait frame', () => {
    const tiny = assembleShaderParams(R({ cell: 0.001 }), 1080, 1920)
    expect(tiny.params.scale).toBeGreaterThanOrEqual(0.003)
    const huge = assembleShaderParams(R({ cell: 0.5 }), 1080, 1920)
    expect(huge.params.scale).toBeLessThanOrEqual(0.05)
  })

  it('Characters look: ascii_dither, matte, brightness pinned to 1, constant cell', () => {
    const r = R({ look: 'characters', chars: 8, drift: 6, cell: 0.02 })
    const p = assembleShaderParams(r, 1920, 1080)
    expect(p.effectId).toBe('ascii_dither')
    expect(p.matte).toBe(true)
    expect(p.params.shape).toBe(8)
    expect(p.params.brightness).toBe(1)
    expect(p.params.speed).toBeCloseTo(1, 9)
    expect(p.params.colored).toBe(1)
    expect(p.params.underlay).toBe(0)
    expect(p.params.spacing).toBe(0)
    expect(p.params.invert).toBe(0)
    expect(p.params.blur).toBe(0)
    expect(p.params.cell).toBeCloseTo(0.02 * 1920 / 1080, 9)
  })

  it('Characters look clamps cell into [0.004, 0.1] on a portrait frame', () => {
    const tiny = assembleShaderParams(R({ look: 'characters', cell: 0.001 }), 1080, 1920)
    expect(tiny.params.cell).toBeGreaterThanOrEqual(0.004)
    const huge = assembleShaderParams(R({ look: 'characters', cell: 0.5 }), 1080, 1920)
    expect(huge.params.cell).toBeLessThanOrEqual(0.1)
  })

  it('guards against a zero or negative frame size', () => {
    expect(() => assembleShaderParams(R(), 1920, 0)).not.toThrow()
    expect(() => assembleShaderParams(R(), 0, 1080)).not.toThrow()
    expect(Number.isFinite(assembleShaderParams(R(), 1920, 0).params.scale)).toBe(true)
  })
})

describe('assembleGrid', () => {
  it('Dither look: square cells, cellW === cellH === max(scale × fh, 1)', () => {
    const r = R({ look: 'dither', cell: 0.02 })
    const g = assembleGrid(r, 1920, 1080, 1920, 1080)
    const { params } = assembleShaderParams(r, 1920, 1080)
    expect(g.cellH).toBeCloseTo(Math.max(params.scale * 1080, 1), 9)
    expect(g.cellW).toBe(g.cellH)
    expect(g.cols).toBe(Math.ceil(1920 / g.cellW))
    expect(g.rows).toBe(Math.ceil(1080 / g.cellH))
  })

  it('Dither look floors at 1px', () => {
    const g = assembleGrid(R({ look: 'dither', cell: 0.0001 }), 1920, 1080, 100, 100)
    expect(g.cellH).toBe(1)
    expect(g.cellW).toBe(1)
  })

  it('Characters look: cellH = max(cell × fh, 2); cellW = cellH for shapes outside 7–14', () => {
    const r = R({ look: 'characters', chars: 1, cell: 0.02 })
    const g = assembleGrid(r, 1920, 1080, 1920, 1080)
    const { params } = assembleShaderParams(r, 1920, 1080)
    expect(g.cellH).toBeCloseTo(Math.max(params.cell * 1080, 2), 9)
    expect(g.cellW).toBeCloseTo(g.cellH, 9)
  })

  it('Characters look: 2:3 cells (cellW = cellH × 2/3) for shapes 7–14', () => {
    for (const chars of [7, 10, 14]) {
      const g = assembleGrid(R({ look: 'characters', chars, cell: 0.02 }), 1920, 1080, 1920, 1080)
      expect(g.cellW).toBeCloseTo(g.cellH * (2 / 3), 9)
    }
    for (const chars of [0, 1, 6, 15, 19]) {
      const g = assembleGrid(R({ look: 'characters', chars, cell: 0.02 }), 1920, 1080, 1920, 1080)
      expect(g.cellW).toBeCloseTo(g.cellH, 9)
    }
  })

  it('Characters look floors at 2px', () => {
    const g = assembleGrid(R({ look: 'characters', cell: 0.0001 }), 1920, 1080, 100, 100)
    expect(g.cellH).toBe(2)
  })
})

describe('assembleShaderExtras — what makes the colours shimmer', () => {
  it('Dither look: the SHIMMER build, offset by the same whole-cell drift as the scatter order', async () => {
    const { assembleShaderExtras, revealParams } = await import('~/lib/motionx/reveal')
    const r = { ...revealParams({ style: 'assemble', drift: 6, angle: 0 }), amount: 0.5, elapsed: 0.5 }
    expect(assembleShaderExtras(r)).toEqual({ variant: 'SHIMMER', uniforms: { u_shimmerX: -3, u_shimmerY: 0 } })
    const down = { ...revealParams({ style: 'assemble', drift: 6, angle: 90 }), amount: 0.5, elapsed: 0.5 }
    expect(assembleShaderExtras(down).uniforms).toEqual({ u_shimmerX: 0, u_shimmerY: 3 })
  })
  it('Shimmer speed 0 is perfectly still, and never a negative zero', async () => {
    const { assembleShaderExtras, revealParams } = await import('~/lib/motionx/reveal')
    const still = assembleShaderExtras({ ...revealParams({ style: 'assemble', drift: 0 }), amount: 0.5, elapsed: 9 })
    expect(Object.is(still.uniforms.u_shimmerX, 0)).toBe(true); expect(Object.is(still.uniforms.u_shimmerY, 0)).toBe(true)
  })
  it('Characters look: the ASCII matte build', async () => {
    const { assembleShaderExtras, revealParams } = await import('~/lib/motionx/reveal')
    expect(assembleShaderExtras({ ...revealParams({ style: 'assemble', look: 'characters' }), amount: 0.5, elapsed: 1 }))
      .toEqual({ variant: 'MATTE', uniforms: { u_matte: 1 } })
  })
})

describe('travelAlong — the per-frame form of the travel projection', () => {
  it('agrees with alongTravel everywhere, in and out, at odd angles, on and off the frame', async () => {
    const { travelAlong, alongTravel } = await import('~/lib/motionx/reveal')
    const grid = { cols: 40, rows: 23 }
    for (const out of [false, true]) for (const angle of [0, 0.7, Math.PI / 2, 2.4, Math.PI, 5]) {
      const f = travelAlong(angle, out, grid)
      for (let y = -2; y < 26; y += 3) for (let x = -2; x < 43; x += 4) expect(f(x, y)).toBeCloseTo(alongTravel(angle, out, x, y, grid), 12)
    }
    expect(travelAlong(0, false, { cols: 0, rows: 0 })(3, 3)).toBe(0)
  })
})

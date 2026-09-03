/**
 * Vector Type — smart stretch, as the FRAME applies it.
 *
 * `stretch.ts` proves the geometry in isolation; this spec proves the seam.
 * The frame is the one place the dials become visible, so what it has to get
 * right is the ORDER: fit solves the width dial against the caller's box, the
 * `wdth` cascade spends the real axis before any geometry, damping trims what
 * is left, and only then does each glyph get its own remap on the font's shared
 * zones. `frame.stretch` reports what was actually applied, so a test can
 * assert the PATH ran rather than squinting at the picture.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as fontkit from 'fontkit'
import { describe, expect, it } from 'vitest'
import { vectorTypeFrame, VT_FIT_INSET } from '~/lib/vectortype/canvas'
import { DEFAULT_CONFIG, mergeConfig } from '~/lib/vectortype/config'
import { normaliseAxes } from '~/lib/vectortype/font'
import type { VtFont } from '~/lib/vectortype/font'

const FIXTURE = fileURLToPath(new URL('../fixtures/inter-subset-var.ttf', import.meta.url))
function loadFixtureFont(): VtFont {
  const raw: any = (fontkit as any).create(new Uint8Array(readFileSync(FIXTURE)))
  return { id: 'inter-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}
const font = loadFixtureFont()
const cfg = (over: Partial<typeof DEFAULT_CONFIG>) => mergeConfig({ ...DEFAULT_CONFIG, text: 'Sailor', ...over } as any)
const width = (f: ReturnType<typeof vectorTypeFrame>) => f.outlines.width
const commandCount = (f: ReturnType<typeof vectorTypeFrame>) => f.outlines.glyphs.reduce((n, g) => n + g.commands.length, 0)

describe('vectorTypeFrame — smart stretch', () => {
  it('stretch = 1 leaves the frame byte-identical to before', () => {
    const a = vectorTypeFrame(font, cfg({}), 0)
    expect(a.stretch).toEqual({ S: 1, SY: 1, damped: false, fitted: null, perGlyph: false })
    const b = vectorTypeFrame(font, cfg({ stretch: 1, stretchY: 1 }), 0)
    expect(b.outlines.glyphs.map(g => g.commands)).toEqual(a.outlines.glyphs.map(g => g.commands))
  })

  it('stretch widens the run, holds the l stem, keeps the command count', () => {
    const base = vectorTypeFrame(font, cfg({}), 0)
    const wide = vectorTypeFrame(font, cfg({ stretch: 1.8 }), 0)
    expect(width(wide)).toBeGreaterThan(width(base) * 1.3)
    expect(commandCount(wide)).toBe(commandCount(base))
    const l0 = base.outlines.glyphs[3]!, l1 = wide.outlines.glyphs[3]!   // 'S','a','i','l'
    expect(Math.abs((l1.bbox.maxX - l1.bbox.minX) - (l0.bbox.maxX - l0.bbox.minX))).toBeLessThan(0.05 * (l0.bbox.maxX - l0.bbox.minX))
    expect(wide.stretch.S).toBeCloseTo(1.8, 9)
  })

  it('height grows glyphs on a fixed baseline and never changes advances', () => {
    const base = vectorTypeFrame(font, cfg({}), 0)
    const tall = vectorTypeFrame(font, cfg({ stretchY: 2 }), 0)
    expect(width(tall)).toBeCloseTo(width(base), 3)
    expect(tall.outlines.bbox.maxY).toBeGreaterThan(base.outlines.bbox.maxY * 1.8)
    expect(tall.outlines.glyphs[3]!.bbox.minY).toBeCloseTo(base.outlines.glyphs[3]!.bbox.minY, 3)
  })

  it('a diagonal move is damped for the engine, and the frame says so', () => {
    const f = vectorTypeFrame(font, cfg({ stretch: 2, stretchY: 2 }), 0)
    expect(f.stretch.damped).toBe(true)
    expect(f.stretch.S).toBeCloseTo(1.5, 9)
    expect(f.stretch.SY).toBeCloseTo(1.5, 9)
  })

  // The clock, chosen so the assertion measures a WAVE rather than one moving
  // letter. The default duration is 4 s and the track is linear 1 → 1.8, so at
  // `delay: 0.5` and `t = 3` the six glyphs read t = 3.0 … 0.5 — every one of
  // them strictly inside the ramp, at S = 1.6, 1.5, 1.4, 1.3, 1.2, 1.1. (The
  // brief's `delay: 0.8` at `t = 0.5` puts glyphs 1–5 at a NEGATIVE time, i.e.
  // parked at S = 1: only the first letter moves, and the spread lands on 0.100
  // by luck rather than by measuring the thing the test is named after.)
  it('a staggered stretch track gives each glyph its own width (perGlyph path)', () => {
    const c = cfg({
      motion: {
        ...DEFAULT_CONFIG.motion,
        tracks: [{ path: 'stretch', from: 1, to: 1.8, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 }],
        stagger: { ...DEFAULT_CONFIG.motion.stagger, delay: 0.5 },
      },
    } as any)
    const f = vectorTypeFrame(font, c, 3)
    expect(f.stretch.perGlyph).toBe(true)
    const widths = f.outlines.glyphs.filter(g => g.commands.length).map(g => g.bbox.maxX - g.bbox.minX)
    const base = vectorTypeFrame(font, cfg({}), 0).outlines.glyphs.filter(g => g.commands.length).map(g => g.bbox.maxX - g.bbox.minX)
    const ratios = widths.map((w, i) => w / base[i]!)
    // Measured 1.60 1.50 1.00 1.00 1.20 1.10 — spread 0.60. The two 1.00s are
    // the `i` and the `l`, whose whole bbox IS a rigid stem and so does not
    // widen; that is the same invariant the second test pins, showing up here.
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeGreaterThan(0.1)   // the wave
  })

  it('fit: width solves stretch so the run fills the box (minus the inset), reported as fitted', () => {
    const c = cfg({ fit: 'width' })
    const base = vectorTypeFrame(font, cfg({}), 0)
    const pxPerUnit = c.size / base.outlines.unitsPerEm
    const targetUnits = base.outlines.width * 1.3
    const fitBoxWidth = (targetUnits * pxPerUnit) / (1 - 2 * VT_FIT_INSET)   // the box that leaves exactly targetUnits after the inset
    const f = vectorTypeFrame(font, c, 0, { fitBoxWidth })
    expect(f.stretch.fitted).not.toBeNull()
    expect(Math.abs(f.outlines.width - targetUnits) / targetUnits).toBeLessThan(0.02)
    // without a box width, fit is inert and the dial value rules
    const g = vectorTypeFrame(font, cfg({ fit: 'width', stretch: 1.2 }), 0)
    expect(g.stretch.fitted).toBeNull(); expect(g.stretch.S).toBeCloseTo(1.2, 9)
  })
})

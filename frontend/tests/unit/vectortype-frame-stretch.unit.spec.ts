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
import { describe, expect, it, vi } from 'vitest'
import { vectorTypeFrame, VT_FIT_INSET } from '~/lib/vectortype/canvas'
import { DEFAULT_CONFIG, mergeConfig, VT_STRETCH_MAX, VT_STRETCH_MIN } from '~/lib/vectortype/config'
import { normaliseAxes } from '~/lib/vectortype/font'
import type { VtFont } from '~/lib/vectortype/font'

// The fit solve is COUNTED, not stubbed: this wraps the real engine
// (`importOriginal`) and tallies every entry into `fitStretch`, which is the
// only honest way to prove the frame's memo is doing its job — timing an
// assertion would be flaky, and `vi.spyOn` cannot touch an ESM export here
// (vite's ssr transform gives the namespace getters, no setters). Everything
// else passes straight through, so the rest of this spec still measures the
// real engine.
const { fitCalls, planCalls } = vi.hoisted(() => ({ fitCalls: { n: 0 }, planCalls: { n: 0 } }))
vi.mock('~/lib/vectortype/stretch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/vectortype/stretch')>()
  return {
    ...actual,
    fitStretch: (...args: Parameters<typeof actual.fitStretch>) => {
      fitCalls.n++
      return actual.fitStretch(...args)
    },
    // `planStretch` is counted for the same reason and reads only the calls
    // `canvas.ts` makes: `fitStretch` reaches its own plan through the module's
    // internal binding, which this wrapper cannot see. That is what we want —
    // the memo under test is the frame's, not the solver's.
    planStretch: (...args: Parameters<typeof actual.planStretch>) => {
      planCalls.n++
      return actual.planStretch(...args)
    },
  }
})

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
    // Not just the drawing: the numbers every downstream consumer measures with.
    // A glyph that went round the engine and came back "equal" would still have
    // a re-derived bbox and a re-accumulated advance, so those are pinned too,
    // and `perGlyph` says on the record that no glyph took its own dial.
    expect(b.outlines.glyphs.map(g => g.bbox)).toEqual(a.outlines.glyphs.map(g => g.bbox))
    expect(b.outlines.glyphs.map(g => g.advance)).toEqual(a.outlines.glyphs.map(g => g.advance))
    expect(b.outlines.coords).toEqual(a.outlines.coords)
    expect(b.outlines.width).toBe(a.outlines.width)
    expect(b.stretch.perGlyph).toBe(false)
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

/** The box that leaves exactly `targetUnits` of run after the inset. */
function boxFor(targetUnits: number, size: number, upem: number): number {
  return (targetUnits * (size / upem)) / (1 - 2 * VT_FIT_INSET)
}
const inkOf = (f: ReturnType<typeof vectorTypeFrame>) => f.outlines.glyphs.filter(g => g.commands.length)

describe('vectorTypeFrame — the fit solve is paid for once, not every frame', () => {
  it('a second frame with the same fit inputs reuses the solved answer', () => {
    const c = cfg({ fit: 'width' })
    const base = vectorTypeFrame(font, cfg({}), 0)
    // A target no other test in this file uses, so the memo is cold here.
    const fitBoxWidth = boxFor(base.outlines.width * 1.37, c.size, base.outlines.unitsPerEm)
    const before = fitCalls.n
    const a = vectorTypeFrame(font, c, 0, { fitBoxWidth })
    const b = vectorTypeFrame(font, c, 0, { fitBoxWidth })
    expect(a.stretch.fitted).not.toBeNull()
    expect(b.stretch.fitted).toBe(a.stretch.fitted)
    expect(fitCalls.n - before).toBe(1)          // the second frame never entered the solver
    // …and the memo is a KEY, not a blanket skip: a different box re-solves.
    vectorTypeFrame(font, c, 0, { fitBoxWidth: fitBoxWidth * 1.19 })
    expect(fitCalls.n - before).toBe(2)
  })
})

describe('vectorTypeFrame — fit beats a per-glyph width wave', () => {
  // The controller's call: when the run was FITTED, the solver's promise is
  // that the run fills the box. A staggered `stretch` track would break that
  // promise letter by letter for a wave nobody can read against the box edge
  // it is fighting, so fit wins and the width track is ignored. Height is not
  // part of the promise, so `stretchY` still waves.
  const track = { path: 'stretch', from: 1, to: 1.8, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 }
  const waveOn = (path: string) => ({
    ...DEFAULT_CONFIG.motion,
    tracks: [{ ...track, path }],
    stagger: { ...DEFAULT_CONFIG.motion.stagger, delay: 0.5 },
  })

  it('every glyph takes the fitted run width, and the run still fills the box', () => {
    const plain = cfg({ fit: 'width' })
    const base = vectorTypeFrame(font, cfg({}), 0)
    const targetUnits = base.outlines.width * 1.42
    const fitBoxWidth = boxFor(targetUnits, plain.size, base.outlines.unitsPerEm)
    const still = vectorTypeFrame(font, plain, 3, { fitBoxWidth })
    const waved = vectorTypeFrame(font, cfg({ fit: 'width', motion: waveOn('stretch') } as any), 3, { fitBoxWidth })

    expect(waved.stretch.fitted).toBeCloseTo(still.stretch.fitted!, 9)
    expect(waved.stretch.perGlyph).toBe(false)   // no glyph took its own width
    const stillInk = inkOf(still)
    const ratios = inkOf(waved).map((g, i) => {
      const s = stillInk[i]!
      return (g.bbox.maxX - g.bbox.minX) / (s.bbox.maxX - s.bbox.minX)
    })
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(1e-6)
    expect(Math.abs(waved.outlines.width - targetUnits) / targetUnits).toBeLessThan(0.02)
  })

  it('a staggered stretchY track is still a wave under fit', () => {
    const base = vectorTypeFrame(font, cfg({}), 0)
    const c = cfg({ fit: 'width', motion: waveOn('stretchY') } as any)
    const targetUnits = base.outlines.width * 1.42
    const fitBoxWidth = boxFor(targetUnits, c.size, base.outlines.unitsPerEm)
    const f = vectorTypeFrame(font, c, 3, { fitBoxWidth })
    expect(f.stretch.fitted).not.toBeNull()
    expect(f.stretch.perGlyph).toBe(true)
    // The height wave must not cost the width its fit: like the sibling test
    // above, the run still has to fill the box (minus the inset) even though
    // every glyph is on its own `stretchY` clock.
    expect(Math.abs(f.outlines.width - targetUnits) / targetUnits).toBeLessThan(0.02)
  })
})

const ARCHIVO = fileURLToPath(new URL('../fixtures/archivo-subset-var.ttf', import.meta.url))
function loadArchivo(): VtFont {
  const raw: any = (fontkit as any).create(new Uint8Array(readFileSync(ARCHIVO)))
  return { id: 'archivo-subset', axes: normaliseAxes(raw?.variationAxes), unitsPerEm: Number(raw?.unitsPerEm) || 1000, raw }
}

describe('vectorTypeFrame — the wdth cascade, at the seam the studio uses', () => {
  // Inter (the fixture above) has no `wdth`, so every assertion up to here runs
  // the no-cascade path. Archivo carries wdth 62–125, which is the only way to
  // pin the ORDER at this seam: the real axis is spent first, it reaches the
  // frame's shaping as `outlines.coords`, and what the remap gets is the
  // RESIDUAL — never the dial, and never damped on the way.
  const archivo = loadArchivo()
  const wdth = archivo.axes.find(a => a.tag === 'wdth')!

  it('the fixture really carries a wdth axis', () => {
    expect(wdth).toBeDefined()
    expect(wdth.min).toBeLessThan(wdth.default)
    expect(wdth.max).toBeGreaterThan(wdth.default)
  })

  it('a small move is paid by the axis alone — the engine receives ~1', () => {
    const f = vectorTypeFrame(archivo, cfg({ stretch: 1.15 }), 0)
    expect(f.outlines.coords.wdth).toBeGreaterThan(wdth.default)
    expect(Math.abs(f.stretch.S - 1)).toBeLessThan(0.01)
  })

  it('a move past the axis spends it to the max and hands the rest to the remap', () => {
    const f = vectorTypeFrame(archivo, cfg({ stretch: 2.2 }), 0)
    expect(f.outlines.coords.wdth).toBeCloseTo(wdth.max, 9)
    expect(f.stretch.S).toBeGreaterThan(1.3)
  })
})

describe('vectorTypeFrame — a width wave is planned PER GLYPH', () => {
  // Archivo's wdth (62–125) is the only way to see this. When the run spends
  // real axis, the run's residual is SMALLER than the dial it came from — and
  // scaling every staggered glyph by that residual/dial ratio handed each one a
  // discount for an axis move it never received. A glyph asking for exactly 1
  // came out condensed. The fix is to plan each glyph on its OWN dial, so its
  // resting coords carry its own spent wdth and its residual is its own.
  const archivo = loadArchivo()
  const trackAt = (path: string, from: number, to: number) =>
    ({ path, from, to, easing: 'linear', loops: 1, hold: 0, cycleOffset: 0, delay: 0 })
  const inkW = (f: ReturnType<typeof vectorTypeFrame>, i: number) => {
    const g = f.outlines.glyphs[i]!
    return g.bbox.maxX - g.bbox.minX
  }

  it('the trough glyph is left at its resting width while the crest glyph widens', () => {
    // Duration is 4 s and the ramp is linear 1 → 1.8, so at `delay: 0.8` and
    // `t = 4` glyph i reads t = 4 − 0.8·i: glyph 0 sits at the END of the ramp
    // (dial 1.8, the crest) and glyph 5 at its START (dial 1, the trough).
    const wave = cfg({
      motion: {
        ...DEFAULT_CONFIG.motion,
        tracks: [trackAt('stretch', 1, 1.8)],
        stagger: { ...DEFAULT_CONFIG.motion.stagger, delay: 0.8 },
      },
    } as any)
    const f = vectorTypeFrame(archivo, wave, 4)
    const rest = vectorTypeFrame(archivo, cfg({}), 0)
    expect(f.stretch.perGlyph).toBe(true)
    // A dial of 1 must draw the glyph the font draws — same axis position, same
    // remap (none). Half a percent is float noise, not a stretch.
    expect(Math.abs(inkW(f, 5) - inkW(rest, 5)) / inkW(rest, 5)).toBeLessThan(0.005)
    expect(inkW(f, 0)).toBeGreaterThan(inkW(rest, 0) * 1.2)
  })

  it('a track that drives the dial outside the range is clamped at the frame', () => {
    // `applyMotion` writes raw track values — `mergeConfig`'s clamp is upstream
    // of it and cannot help. The frame is the last boundary before the engine.
    const wild = cfg({
      motion: { ...DEFAULT_CONFIG.motion, tracks: [trackAt('stretch', 0, 4)] },
    } as any)
    const ceiling = vectorTypeFrame(archivo, cfg({ stretch: VT_STRETCH_MAX }), 0)
    const floor = vectorTypeFrame(archivo, cfg({ stretch: VT_STRETCH_MIN }), 0)
    const hi = vectorTypeFrame(archivo, wild, 4)   // track reads 4
    const lo = vectorTypeFrame(archivo, wild, 0)   // track reads 0
    expect(hi.stretch.S).toBeCloseTo(ceiling.stretch.S, 9)
    expect(lo.stretch.S).toBeCloseTo(floor.stretch.S, 9)
    for (const f of [hi, lo]) {
      expect(Number.isFinite(f.outlines.width)).toBe(true)
      for (const g of f.outlines.glyphs) {
        for (const v of [g.bbox.minX, g.bbox.maxX, g.bbox.minY, g.bbox.maxY, g.advance]) {
          expect(Number.isFinite(v)).toBe(true)
        }
      }
    }
  })
})

describe('vectorTypeFrame — the wdth plan is paid for once, not every frame', () => {
  const archivo = loadArchivo()
  it('a second frame with the same plan inputs reuses the answer', () => {
    // A dial no other test in this file uses, so the memo is cold here.
    const c = cfg({ stretch: 1.47 })
    const before = planCalls.n
    const a = vectorTypeFrame(archivo, c, 0)
    const b = vectorTypeFrame(archivo, c, 0)
    expect(planCalls.n - before).toBe(1)
    expect(b.stretch.S).toBeCloseTo(a.stretch.S, 12)
    // …and it is a KEY, not a blanket skip: a different dial re-solves.
    vectorTypeFrame(archivo, cfg({ stretch: 1.53 }), 0)
    expect(planCalls.n - before).toBe(2)
  })
})

describe('vectorTypeFrame — fit solves against the DAMPED pipeline', () => {
  it('fit plus a tall stretchY still fills the box, and fitted reports the dial', () => {
    const base = vectorTypeFrame(font, cfg({}), 0)
    const c = cfg({ fit: 'width', stretchY: 2 })
    const targetUnits = base.outlines.width * 1.3
    const fitBoxWidth = boxFor(targetUnits, c.size, base.outlines.unitsPerEm)
    const f = vectorTypeFrame(font, c, 0, { fitBoxWidth })
    expect(Math.abs(f.outlines.width - targetUnits) / targetUnits).toBeLessThan(0.02)
    // `fitted` is the DIAL the read-only control shows; the ENGINE got the
    // damped value. On a diagonal move the two must differ — a `fitted` equal
    // to `S` here would mean the solve was answering a question the frame never
    // asked.
    expect(f.stretch.fitted!).toBeGreaterThan(f.stretch.S + 0.05)
    // With no vertical move there is nothing to damp, so they agree again.
    const flat = vectorTypeFrame(font, cfg({ fit: 'width' }), 0, { fitBoxWidth })
    expect(flat.stretch.fitted!).toBeCloseTo(flat.stretch.S, 9)
  })

  it('fit with empty text reports no solve at all', () => {
    const f = vectorTypeFrame(font, cfg({ fit: 'width', text: '' }), 0, { fitBoxWidth: 400 })
    expect(f.stretch.fitted).toBeNull()
  })
})

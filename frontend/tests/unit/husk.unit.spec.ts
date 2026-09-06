/**
 * Husk — the port of the playgrnd "Husk" generator, the Scatter element's third
 * style. Each case below pins ONE rule of the original as the captured reference
 * writes it (`playgrnd-husk-generator-reference.js`); the checklist heading
 * `app/lib/compositor/husk.ts` maps every rule to that file's line numbers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  defaultHusk, normalizeHusk, HUSK_LIMITS, HUSK_BITES, HUSK_FIELD_LONG,
  HUSK_PALETTE_PRESETS, HUSK_PRESET_NAMES, huskPresetPatch, huskPresetOf,
  huskRoles, huskFieldSize, huskShapes, huskDepthField, huskPixels,
  huskRefPx, huskGrainCellPx, huskCrumbleUnitPx, paintHusk,
  __resetHuskSheetCache,
  type HuskParams, type HuskShape,
} from '~/lib/compositor/husk'

const P = (over: Partial<HuskParams> = {}): HuskParams => ({ ...defaultHusk(), ...over })

// ── Params, palettes, dial ranges ────────────────────────────────────────────
describe('Husk params', () => {
  it('ships the tool\'s own defaults [ref 20-24]', () => {
    expect(defaultHusk()).toMatchObject({
      count: 30, size: 0.62, vary: 0.5, lump: 0.42,
      bite: 'crumble', eat: 0.55, tex: 0.45, grain: 0.3,
    })
    // The first table, in role order.
    expect(defaultHusk().inks).toEqual([...HUSK_PALETTE_PRESETS[HUSK_PRESET_NAMES[0]!].inks])
    expect(defaultHusk().inks).toHaveLength(3)
  })

  it('takes its dial ranges from the tool\'s own sliders', () => {
    expect(HUSK_LIMITS.count).toEqual([1, 70])
    for (const k of ['size', 'vary', 'lump', 'eat', 'tex', 'grain'] as const) {
      expect(HUSK_LIMITS[k]).toEqual([0, 1])
    }
  })

  it('normalizes garbage, partials and hand-edited saves onto the base', () => {
    const d = defaultHusk()
    expect(normalizeHusk(undefined)).toEqual(d)
    expect(normalizeHusk(null)).toEqual(d)
    expect(normalizeHusk('nope')).toEqual(d)
    expect(normalizeHusk({ count: 1e9 }).count).toBe(70)
    expect(normalizeHusk({ count: -4 }).count).toBe(1)
    expect(normalizeHusk({ count: 8.6 }).count).toBe(9)          // whole husks only
    expect(normalizeHusk({ lump: 5 }).lump).toBe(1)
    expect(normalizeHusk({ eat: Number.NaN }).eat).toBe(d.eat)
    expect(normalizeHusk({ bite: 'dots' }).bite).toBe('dots')
    expect(normalizeHusk({ bite: 'gnaw' }).bite).toBe(d.bite)
    expect(normalizeHusk({ inks: ['#ff0000', 'red', 7] as unknown }).inks).toEqual(['#ff0000'])
    expect(normalizeHusk({ inks: ['nope'] as unknown }).inks).toEqual(d.inks)
  })

  it('offers the tool\'s two ways of eating into the fill [ref 7]', () => {
    expect([...HUSK_BITES]).toEqual(['crumble', 'dots'])
  })

  it('names the five three-role tables in plain language [ref 11-17]', () => {
    expect(HUSK_PRESET_NAMES).toHaveLength(5)
    for (const n of HUSK_PRESET_NAMES) {
      expect(HUSK_PALETTE_PRESETS[n].inks).toHaveLength(3)
      expect(n).not.toMatch(/#/)
      expect(huskPresetOf(normalizeHusk({ ...defaultHusk(), ...huskPresetPatch(n) }))).toBe(n)
    }
  })

  it('reads the palette by role, and a short palette repeats the role before it [ref 121-123]', () => {
    expect(huskRoles(P({ inks: ['#111111', '#222222', '#333333'] })))
      .toEqual({ ground: '#111111', silhouette: '#222222', fill: '#333333' })
    expect(huskRoles(P({ inks: ['#111111'] })))
      .toEqual({ ground: '#111111', silhouette: '#111111', fill: '#111111' })
    expect(huskRoles(P({ inks: ['#111111', '#222222'] })))
      .toEqual({ ground: '#111111', silhouette: '#222222', fill: '#222222' })
  })
})

// ── The grid the picture is decided on ───────────────────────────────────────
describe('the depth grid [ref 72-73]', () => {
  it('hands the longer side 560 cells whichever way the box lies', () => {
    expect(huskFieldSize(800, 800)).toEqual({ fw: HUSK_FIELD_LONG, fh: HUSK_FIELD_LONG })
    expect(huskFieldSize(1200, 900)).toEqual({ fw: 560, fh: 420 })
    expect(huskFieldSize(900, 1200)).toEqual({ fw: 420, fh: 560 })
  })

  it('keeps the box\'s proportions, and holds every side at eight cells or more', () => {
    expect(huskFieldSize(4000, 20)).toEqual({ fw: 560, fh: 8 })
    expect(huskFieldSize(20, 4000)).toEqual({ fw: 8, fh: 1600 })
    expect(huskFieldSize(0, 0).fw).toBeGreaterThanOrEqual(8)
    expect(huskFieldSize(Number.NaN, 10).fh).toBeGreaterThanOrEqual(8)
  })

  it('does not move with the render size — one box aspect, one grid', () => {
    expect(huskFieldSize(300, 400)).toEqual(huskFieldSize(2400, 3200))
  })
})

// ── Rule A: what is thrown ───────────────────────────────────────────────────
describe('Rule A — the husks that are thrown [ref 84-92]', () => {
  const { fw, fh } = huskFieldSize(900, 1200)

  it('throws `count` of them, rounded, and never fewer than one [ref 76]', () => {
    expect(huskShapes(P({ count: 30 }), fw, fh, 7)).toHaveLength(30)
    expect(huskShapes(P({ count: 6.6 }), fw, fh, 7)).toHaveLength(7)
    expect(huskShapes(P({ count: 0 }), fw, fh, 7)).toHaveLength(1)
  })

  it('makes every one an oval: both axes drawn over 0.78..1.28, apart [ref 87]', () => {
    const shapes = huskShapes(P({ count: 70 }), fw, fh, 3)
    for (const k of shapes) {
      expect(k.ex).toBeGreaterThanOrEqual(0.78)
      expect(k.ex).toBeLessThan(1.28)
      expect(k.ey).toBeGreaterThanOrEqual(0.78)
      expect(k.ey).toBeLessThan(1.28)
    }
    // The two axes are separate draws, so most husks are wider one way than the other.
    expect(shapes.filter(k => Math.abs(k.ex - k.ey) > 0.08).length).toBeGreaterThan(30)
  })

  it('gives each one three harmonics of 2-3, 4-6 and 7-9 lobes [ref 90]', () => {
    const shapes = huskShapes(P({ count: 70 }), fw, fh, 11)
    for (const k of shapes) {
      expect(Number.isInteger(k.h1) && k.h1 >= 2 && k.h1 <= 3).toBe(true)
      expect(Number.isInteger(k.h2) && k.h2 >= 4 && k.h2 <= 6).toBe(true)
      expect(Number.isInteger(k.h3) && k.h3 >= 7 && k.h3 <= 9).toBe(true)
      for (const a of [k.a1, k.a2, k.a3]) {
        expect(a).toBeGreaterThanOrEqual(0)
        expect(a).toBeLessThan(Math.PI * 2)
      }
    }
    // All three counts are really rolled, not pinned to their lowest value.
    expect(new Set(shapes.map(k => k.h1)).size).toBe(2)
    expect(new Set(shapes.map(k => k.h2)).size).toBe(3)
    expect(new Set(shapes.map(k => k.h3)).size).toBe(3)
  })

  it('drops them across an apron reaching past all four edges [ref 85]', () => {
    const shapes = huskShapes(P({ count: 70 }), fw, fh, 5)
    for (const k of shapes) {
      expect(k.x).toBeGreaterThanOrEqual(-0.12 * fw)
      expect(k.x).toBeLessThanOrEqual(1.12 * fw)
      expect(k.y).toBeGreaterThanOrEqual(-0.12 * fh)
      expect(k.y).toBeLessThanOrEqual(1.12 * fh)
    }
    expect(shapes.some(k => k.x < 0 || k.y < 0 || k.x > fw || k.y > fh)).toBe(true)
  })

  it('scales them against √(grid area) [ref 81]', () => {
    const flat = P({ vary: 0, count: 4 })
    const land = huskFieldSize(1600, 900), port = huskFieldSize(900, 1600)
    const share = (f: { fw: number; fh: number }) =>
      huskShapes(flat, f.fw, f.fh, 5)[0]!.r / Math.sqrt(f.fw * f.fh)
    expect(share(land)).toBeCloseTo(share(port), 6)
    expect(share(land)).toBeCloseTo(0.045 + 0.62 * 0.115, 6)
  })

  it('spreads the radii by Size range, and holds one size at zero [ref 86]', () => {
    const one = huskShapes(P({ vary: 0, count: 40 }), fw, fh, 9).map(k => k.r)
    expect(new Set(one.map(r => r.toFixed(9))).size).toBe(1)
    const many = huskShapes(P({ vary: 1, count: 40 }), fw, fh, 9).map(k => k.r)
    const base = one[0]!
    expect(Math.min(...many)).toBeGreaterThanOrEqual(base * 0.3)
    expect(Math.max(...many)).toBeLessThanOrEqual(base * 1.7)
    expect(Math.max(...many) - Math.min(...many)).toBeGreaterThan(base * 0.5)
  })

  it('two variations are two throws [ref 75]', () => {
    const a = huskShapes(P(), fw, fh, 1), b = huskShapes(P(), fw, fh, 2)
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b))
    expect(JSON.stringify(huskShapes(P(), fw, fh, 1))).toEqual(JSON.stringify(a))
  })
})

// ── Rule A: the field they drop into ─────────────────────────────────────────
describe('Rule A — the depth field [ref 98-110]', () => {
  const shape = (over: Partial<HuskShape> = {}): HuskShape => ({
    x: 30, y: 30, r: 12, ex: 1, ey: 1, rot: 0,
    a1: 0, a2: 0, a3: 0, h1: 2, h2: 4, h3: 7, ...over,
  })
  const ROUND = P({ lump: 0 })
  const at = (f: Float32Array, w: number, x: number, y: number) => f[y * w + x]!

  it('reads zero where no husk lies and one under a centre [ref 109]', () => {
    const f = huskDepthField([shape()], 60, 60, ROUND)
    expect(at(f, 60, 30, 30)).toBeCloseTo(1, 6)
    expect(at(f, 60, 36, 30)).toBeCloseTo(0.5, 2)     // half way out, half the depth
    expect(at(f, 60, 55, 55)).toBe(0)
    expect(Math.max(...f)).toBeLessThanOrEqual(1)
    expect(Math.min(...f)).toBe(0)
  })

  it('keeps the larger of two numbers where husks overlap [ref 110]', () => {
    const a = shape({ x: 25, y: 30, r: 14 }), b = shape({ x: 38, y: 30, r: 8 })
    const fa = huskDepthField([a], 60, 60, ROUND)
    const fb = huskDepthField([b], 60, 60, ROUND)
    const both = huskDepthField([a, b], 60, 60, ROUND)
    let overlap = 0
    for (let i = 0; i < both.length; i++) {
      expect(both[i]).toBeCloseTo(Math.max(fa[i]!, fb[i]!), 6)
      if (fa[i]! > 0 && fb[i]! > 0) overlap++
    }
    expect(overlap).toBeGreaterThan(20)
    // Order of throw cannot change the result, which a paint-over would.
    const flipped = huskDepthField([b, a], 60, 60, ROUND)
    expect(Array.from(flipped)).toEqual(Array.from(both))
  })

  it('draws a clean oval rim at Lumpiness zero and a rolling one above [ref 106-107]', () => {
    const ray = (f: Float32Array, ang: number) => {
      let last = 0
      for (let d = 0.5; d < 28; d += 0.25) {
        const x = Math.round(30 + Math.cos(ang) * d), y = Math.round(30 + Math.sin(ang) * d)
        if (x < 0 || y < 0 || x > 59 || y > 59) break
        if (at(f, 60, x, y) > 0) last = d
      }
      return last
    }
    const angles = [0, 0.7, 1.4, 2.1, 2.8, 3.5, 4.2, 4.9, 5.6]
    const flat = huskDepthField([shape()], 60, 60, ROUND).slice()
    // A ray read off whole cells can only place the rim to within a cell, so R (12)
    // to within one is as tight as this measurement goes.
    for (const a of angles) expect(Math.abs(ray(flat, a) - 12)).toBeLessThanOrEqual(1)
    const lumpy = huskDepthField([shape({ a1: 1.1, a2: 2.2, a3: 0.3 })], 60, 60, P({ lump: 1 }))
    const wobbly = angles.map(a => ray(lumpy, a))
    expect(Math.max(...wobbly) - Math.min(...wobbly)).toBeGreaterThan(3)
  })

  it('never marks a cell past R·(1+lump) from a centre [ref 104]', () => {
    const p = P({ lump: 1 })
    const f = huskDepthField([shape({ ex: 1, ey: 1 })], 60, 60, p)
    const outer = 12 * (1 + 0.55)
    for (let y = 0; y < 60; y++) for (let x = 0; x < 60; x++) {
      if (at(f, 60, x, y) > 0) expect(Math.hypot(x - 30, y - 30)).toBeLessThanOrEqual(outer)
    }
  })

  it('squashes the husk along its own axes, turned by its own angle [ref 102]', () => {
    const f = huskDepthField([shape({ ex: 1.28, ey: 0.78 })], 60, 60, ROUND)
    let wide = 0, tall = 0
    for (let d = 1; d < 25; d++) {
      if (at(f, 60, 30 + d, 30) > 0) wide = d
      if (at(f, 60, 30, 30 + d) > 0) tall = d
    }
    expect(wide).toBeGreaterThan(tall)
    expect(wide / tall).toBeCloseTo(1.28 / 0.78, 1)
  })

  it('skips a husk whose box misses the grid altogether [ref 96]', () => {
    const f = huskDepthField([shape({ x: -400, y: -400 })], 60, 60, ROUND)
    expect(Math.max(...f)).toBe(0)
  })

  it('survives a single husk on a tiny grid', () => {
    expect(() => huskDepthField(huskShapes(P({ count: 1 }), 8, 8, 3), 8, 8, P())).not.toThrow()
  })
})

// ── Rule B: the print ────────────────────────────────────────────────────────
describe('Rule B — the print [ref 118-189]', () => {
  const INKS = ['#102030', '#405060', '#708090']
  const IP = (over: Partial<HuskParams> = {}) => P({ grain: 0, inks: INKS, ...over })
  const role = (px: Uint8ClampedArray, i: number): 'ground' | 'silhouette' | 'fill' =>
    px[i] === 0x10 ? 'ground' : px[i] === 0x40 ? 'silhouette' : 'fill'
  /** A field of one depth everywhere, so a rule can be read off the share of inks. */
  const flat = (fw: number, fh: number, d: number) => {
    const f = new Float32Array(fw * fh)
    f.fill(d)
    return f
  }
  // 300 px, not 160: at 160 the default Texture puts the screen on its three-pixel
  // floor, where two different dot radii round to the same four pixels of a cell.
  const fillShare = (p: HuskParams, dep: number, W = 300, seed = 3) => {
    const px = huskPixels(flat(40, 40, dep), 40, 40, W, W, p, seed)
    let n = 0
    for (let i = 0; i < px.length; i += 4) if (role(px, i) === 'fill') n++
    return n / (W * W)
  }

  it('leaves bare ground wherever no husk reached [ref 157]', () => {
    const px = huskPixels(flat(20, 20, 0), 20, 20, 40, 40, IP(), 1)
    for (let i = 0; i < px.length; i += 4) {
      expect([px[i], px[i + 1], px[i + 2], px[i + 3]]).toEqual([0x10, 0x20, 0x30, 255])
    }
  })

  it('crumble leaves the fill whole at Amount zero and bites it hard at one [ref 174]', () => {
    expect(fillShare(IP({ eat: 0 }), 0.5)).toBe(1)
    const hard = fillShare(IP({ eat: 1 }), 0.5)
    expect(hard).toBeLessThan(0.5)
    expect(hard).toBeGreaterThan(0)
  })

  it('crumble bites deepest where the husk is shallowest [ref 174]', () => {
    const p = IP({ eat: 1 })
    expect(fillShare(p, 0.9)).toBeGreaterThan(fillShare(p, 0.5))
    expect(fillShare(p, 0.5)).toBeGreaterThan(fillShare(p, 0.1))
  })

  it('lets the crumble bite a husk\'s interior, not only its outline [ref 173-174]', () => {
    // A steady depth over the whole sheet has no rim at all; the bite must still
    // land, or it is only ever an outline effect.
    const share = fillShare(IP({ eat: 0.55 }), 0.6)
    expect(share).toBeGreaterThan(0.05)
    expect(share).toBeLessThan(0.95)
  })

  it('swells a dot as the depth beneath it rises [ref 165-166]', () => {
    const p = IP({ bite: 'dots' })
    const shallow = fillShare(p, 0.2), mid = fillShare(p, 0.5), deep = fillShare(p, 0.95)
    expect(mid).toBeGreaterThan(shallow)
    expect(deep).toBeGreaterThan(mid)
    // A dot's area follows `v`, so the share tracks the depth rather than its root.
    expect(deep / mid).toBeGreaterThan(1.5)
  })

  it('dots shrink as Amount rises [ref 166]', () => {
    expect(fillShare(IP({ bite: 'dots', eat: 0 }), 0.8))
      .toBeGreaterThan(fillShare(IP({ bite: 'dots', eat: 1 }), 0.8))
  })

  it('dots hold a lattice of at least three pixels however small the sheet [ref 133]', () => {
    const px = huskPixels(flat(20, 20, 0.9), 20, 20, 24, 24, IP({ bite: 'dots', tex: 0 }), 1)
    let fill = 0
    for (let i = 0; i < px.length; i += 4) if (role(px, i) === 'fill') fill++
    expect(fill).toBeGreaterThan(0)
    expect(fill).toBeLessThan(24 * 24)
  })

  it('a dot screen is the same screen for every variation; the crumble is not [ref 162, 168]', () => {
    const dots = IP({ bite: 'dots' })
    const d1 = huskPixels(flat(20, 20, 0.6), 20, 20, 60, 60, dots, 1)
    const d2 = huskPixels(flat(20, 20, 0.6), 20, 20, 60, 60, dots, 2)
    expect(Array.from(d1)).toEqual(Array.from(d2))
    const c1 = huskPixels(flat(20, 20, 0.6), 20, 20, 60, 60, IP(), 1)
    const c2 = huskPixels(flat(20, 20, 0.6), 20, 20, 60, 60, IP(), 2)
    expect(Array.from(c1)).not.toEqual(Array.from(c2))
  })

  it('reads the field between cells, and holds the last row and column [ref 142-154]', () => {
    // A field that steps from empty to deep halfway across: the print must show a
    // graded band rather than a single hard column.
    const fw = 4, fh = 4
    const f = new Float32Array(fw * fh)
    for (let y = 0; y < fh; y++) for (let x = 0; x < fw; x++) f[y * fw + x] = x >= 2 ? 1 : 0
    const p = IP({ eat: 0 })
    const px = huskPixels(f, fw, fh, 64, 64, p, 1)
    const row = Array.from({ length: 64 }, (_, x) => role(px, (32 * 64 + x) * 4))
    expect(row[0]).toBe('ground')
    expect(row[63]).toBe('fill')
    // Cell 1 holds 0 and cell 2 holds 1, so the read ramps between them over
    // x = 16..32. A nearest-cell read would hold the ground all the way to 32; the
    // bilinear one lifts off 0.001 as soon as the ramp starts, at 17.
    expect(row.indexOf('fill')).toBeGreaterThan(16)
    expect(row.indexOf('fill')).toBeLessThan(24)
    // The right-hand column is sampled, not wrapped back to the left one.
    const deep = new Float32Array(fw * fh)
    for (let y = 0; y < fh; y++) deep[y * fw + (fw - 1)] = 1
    const edge = huskPixels(deep, fw, fh, 64, 64, p, 1)
    expect(role(edge, (32 * 64 + 63) * 4)).toBe('fill')
  })

  it('grains all three channels alike, and only once the ink is chosen [ref 179-182]', () => {
    const grey = P({ grain: 0, inks: ['#404040', '#404040', '#404040'] })
    const clean = huskPixels(flat(20, 20, 0.5), 20, 20, 60, 60, grey, 4)
    const grainy = huskPixels(flat(20, 20, 0.5), 20, 20, 60, 60, { ...grey, grain: 1 }, 4)
    expect(new Set(Array.from({ length: clean.length / 4 }, (_, k) => clean[k * 4]!)).size).toBe(1)
    const vals = new Set<number>()
    for (let i = 0; i < grainy.length; i += 4) {
      vals.add(grainy[i]!)
      expect(grainy[i]).toBe(grainy[i + 1])
      expect(grainy[i]).toBe(grainy[i + 2])
    }
    expect(vals.size).toBeGreaterThan(10)
  })

  it('prints every pixel opaque [ref 186]', () => {
    const px = huskPixels(flat(20, 20, 0.5), 20, 20, 40, 40, IP({ grain: 1 }), 1)
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255)
  })

  it('measures the crumble in the tool\'s own export pixels, so preview and bake agree', () => {
    // The same box at two render sizes: the bite covers the same share of it, which
    // is what a lattice tied to the raw pixel would not do.
    const p = IP({ eat: 1 })
    const shareAt = (W: number) => {
      const px = huskPixels(flat(40, 40, 0.5), 40, 40, W, W, p, 6, huskRefPx(1, W))
      let n = 0
      for (let i = 0; i < px.length; i += 4) if (role(px, i) === 'fill') n++
      return n / (W * W)
    }
    expect(shareAt(600)).toBeCloseTo(shareAt(1200), 1)
  })

  it('holds both lattices at 1/2400 of the box width, never finer than they can print', () => {
    expect(huskRefPx(1, 2400)).toBeCloseTo(1, 6)
    expect(huskRefPx(2, 4800)).toBeCloseTo(4, 6)
    expect(huskGrainCellPx(1, 300)).toBe(1)                 // floored at one device pixel
    expect(huskGrainCellPx(Number.NaN, Number.NaN)).toBe(1)
    // The crumble's own lattice is `nsc` of a reference pixel, so its floor is `nsc`.
    expect(huskCrumbleUnitPx(1, 0.45)).toBeCloseTo(1, 6)
    expect(huskCrumbleUnitPx(0.02, 0.45)).toBeCloseTo(1 / (2 + 0.45 * 18), 6)
    expect(huskCrumbleUnitPx(0.3, 0)).toBe(0.5)
    expect(huskCrumbleUnitPx(Number.NaN, 0.45)).toBe(1)
  })

  it('prints a one-ink palette as one colour, and a two-ink one as two [ref 121-123]', () => {
    const one = huskPixels(flat(20, 20, 0.6), 20, 20, 60, 60, P({ grain: 0, inks: ['#123456'] }), 5)
    for (let i = 0; i < one.length; i += 4) {
      expect([one[i], one[i + 1], one[i + 2]]).toEqual([0x12, 0x34, 0x56])
    }
    // Two inks: the sheet keeps the first, and the body and its fill share the second,
    // so a half-empty field prints in exactly those two colours.
    const half = new Float32Array(20 * 20)
    for (let y = 0; y < 20; y++) for (let x = 0; x < 10; x++) half[y * 20 + x] = 0.6
    const two = huskPixels(half, 20, 20, 60, 60, P({ grain: 0, inks: ['#123456', '#abcdef'] }), 5)
    const seen = new Set<string>()
    for (let i = 0; i < two.length; i += 4) seen.add(`${two[i]},${two[i + 1]},${two[i + 2]}`)
    expect([...seen].sort()).toEqual(['171,205,239', '18,52,86'])
  })

  it('survives a one-pixel sheet and a field smaller than one cell', () => {
    expect(() => huskPixels(new Float32Array(1), 1, 1, 1, 1, P(), 1)).not.toThrow()
    expect(() => huskPixels(new Float32Array(4), 2, 2, 7, 3, P(), 1)).not.toThrow()
  })
})

// ── Paint, inside a Frame layer ──────────────────────────────────────────────
describe('paintHusk — how it behaves inside a Frame layer', () => {
  const made: { width: number; height: number }[] = []
  const drawn: { x: number; y: number; w: number; h: number }[] = []
  function offscreenCtx() {
    return {
      fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
      fillRect() {}, save() {}, restore() {},
      createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      putImageData() {},
    }
  }
  beforeEach(() => {
    made.length = 0; drawn.length = 0
    __resetHuskSheetCache()
    vi.stubGlobal('document', {
      createElement: () => {
        const c: Record<string, unknown> = { width: 0, height: 0 }
        c.getContext = () => offscreenCtx()
        made.push(c as unknown as { width: number; height: number })
        return c
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const hostCtx = (scale = 1) => ({
    fillStyle: '', globalAlpha: 0.4, globalCompositeOperation: 'multiply',
    fillRect() {}, save() {}, restore() {},
    getTransform: () => ({ a: scale, b: 0 }),
    drawImage(_i: unknown, x = 0, y = 0, w = 0, h = 0) { drawn.push({ x, y, w, h }) },
  })

  it('leaves the layer\'s own opacity and blend exactly as it found them', () => {
    const ctx = hostCtx()
    paintHusk(ctx as never, P({ count: 3 }), 200, 300, 1)
    expect(ctx.globalAlpha).toBe(0.4)
    expect(ctx.globalCompositeOperation).toBe('multiply')
  })

  it('draws its sheet over the whole box at the box origin (the host clips it)', () => {
    paintHusk(hostCtx() as never, P({ count: 3 }), 300, 400, 1)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toEqual({ x: 0, y: 0, w: 300, h: 400 })
  })

  it('holds the per-pixel pass under 6 Mpx however big the box or the zoom', () => {
    paintHusk(hostCtx(8) as never, P({ count: 2, bite: 'dots', grain: 0 }), 4000, 3000, 1)
    expect(made).toHaveLength(1)                       // one sheet; a husk needs no mask
    const sheet = made[0]!
    expect(sheet.width * sheet.height).toBeLessThanOrEqual(6_000_000)
    expect(sheet.width * sheet.height).toBeGreaterThan(5_000_000)
    expect(sheet.width / sheet.height).toBeCloseTo(4000 / 3000, 2)
  })

  it('re-uses the sheet when nothing about its pixels changed (a drag is a cache hit)', () => {
    paintHusk(hostCtx() as never, P({ count: 3 }), 300, 400, 71)
    const first = made.length
    paintHusk(hostCtx() as never, P({ count: 3 }), 300, 400, 71)
    expect(made.length).toBe(first)
    paintHusk(hostCtx() as never, P({ count: 3 }), 300, 400, 72)
    expect(made.length).toBeGreaterThan(first)
  })

  it('falls back to the ground colour when there is no canvas to render into', () => {
    vi.unstubAllGlobals()
    const ctx = hostCtx() as unknown as { fillStyle: string }
    paintHusk(ctx as never, P({ inks: ['#123456', '#222222', '#333333'] }), 100, 100, 1)
    expect(ctx.fillStyle).toBe('#123456')
    expect(drawn).toHaveLength(0)
  })

  it('survives a tiny box, a portrait box and a nonsense box', () => {
    for (const [w, h] of [[1, 1], [0, 0], [3, 900], [900, 3], [Number.NaN, 10]] as const) {
      expect(() => paintHusk(hostCtx() as never, P({ count: 2 }), w as number, h as number, 1)).not.toThrow()
    }
  })

  it('paints both bites at both ends of Amount and Lumpiness without throwing', () => {
    for (const bite of HUSK_BITES) {
      for (const eat of [0, 1]) {
        for (const lump of [0, 1]) {
          expect(() => paintHusk(hostCtx() as never, P({ bite, eat, lump, count: 2 }), 120, 160, 4)).not.toThrow()
        }
      }
    }
  })

  it('paints a lone husk and a full throw alike', () => {
    expect(() => paintHusk(hostCtx() as never, P({ count: 1 }), 200, 200, 2)).not.toThrow()
    expect(() => paintHusk(hostCtx() as never, P({ count: 70 }), 200, 200, 2)).not.toThrow()
  })
})

// ── Translucent inks ──────────────────────────────────────────────────────────
describe('huskPixels honours each ink\'s alpha', () => {
  it('a transparent ground prints alpha 0; a full-depth cell prints the opaque fill at 255', async () => {
    const { huskPixels } = await import('~/lib/compositor/husk')
    const inks = ['#00000000', '#888888', '#ffffff'] // ground transparent, silhouette + fill opaque
    const groundOnly = huskPixels(new Float32Array(16 * 16).fill(0), 16, 16, 16, 16, P({ grain: 0, eat: 0, bite: 'noise' as never, inks }), 1)
    const fillOnly = huskPixels(new Float32Array(16 * 16).fill(1), 16, 16, 16, 16, P({ grain: 0, eat: 0, bite: 'noise' as never, inks }), 1)
    for (let q = 3; q < groundOnly.length; q += 4) expect(groundOnly[q]).toBe(0)
    for (let q = 3; q < fillOnly.length; q += 4) expect(fillOnly[q]).toBe(255)
  })
})

/**
 * Totem — the playgrnd "Totem" generator as the `totem` Mosaic style. Each block
 * below pins one rule from the checklist in lib/compositor/totem.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  TOTEM_MOTIFS, TOTEM_LIMITS, TOTEM_PALETTE_PRESETS, TOTEM_PRESET_NAMES, TOTEM_MAX_UNITS,
  defaultTotem, normalizeTotem, totemPresetPatch, totemPresetOf, totemInkPatch,
  totemRoles, totemUnit, totemMatField, totemCarve, totemKinds, totemDeal, totemMotifOn,
  totemMirror, totemCore, paintTotem,
  type TotemParams, type TotemCtx,
} from '~/lib/compositor/totem'
import { defaultGrid } from '~/lib/frame/grid'
import { dealVocabDrivesLook } from '~/lib/compositor/dealVocab'
import { applyCompositorCommand, describeCompositor, impliedDealFill, type CompositorState } from '~/lib/agent/surfaces/compositor'

const P = (over: Partial<TotemParams> = {}): TotemParams => ({ ...defaultTotem(), ...over })
const PAL = [...TOTEM_PALETTE_PRESETS.Arcade.inks]
/** A rand stub that hands back a fixed script, then repeats its last value. */
const feed = (vals: number[]) => { let i = 0; return () => vals[Math.min(i++, vals.length - 1)]! }

// ── Params, limits, palettes ─────────────────────────────────────────────────
describe('params and palettes', () => {
  it('ships the tool page\'s own slider ranges and starting values', () => {
    expect(TOTEM_LIMITS).toEqual({
      border: [0, 0.4], mat: [0, 0.7], matGrain: [1, 6], keyline: [0, 10],
      regions: [1, 30], grain: [16, 220], mirror: [0, 1], variety: [0, 1],
      core: [0, 0.6], coreRings: [0, 8],
    })
    const d = defaultTotem()
    expect(d).toMatchObject({
      border: 0.15, mat: 0.36, matGrain: 2, keyline: 3, regions: 14,
      grain: 110, mirror: 1, variety: 0.7, core: 0.22, coreRings: 3,
    })
    expect(d.inks).toEqual(PAL)
  })

  it('normalizeTotem clamps every dial, rounds the whole-number ones and drops junk inks', () => {
    const n = normalizeTotem({
      border: 9, mat: -3, matGrain: 4.7, keyline: 99, regions: 0,
      grain: 1e6, mirror: NaN, variety: 'x', core: 5, coreRings: -2,
      inks: ['#ABCDEF', 'nope', 42, '#112233ff'],
    })
    expect(n).toMatchObject({
      border: 0.4, mat: 0, matGrain: 5, keyline: 10, regions: 1,
      grain: 220, mirror: defaultTotem().mirror, variety: defaultTotem().variety,
      core: 0.6, coreRings: 0,
    })
    expect(n.inks).toEqual(['#ABCDEF', '#112233']) // alpha cut: an ink is opaque
    // Nothing sensible at all falls back to the defaults, inks included.
    expect(normalizeTotem(null)).toEqual(defaultTotem())
    expect(normalizeTotem({ inks: [] }).inks).toEqual(defaultTotem().inks)
  })

  it('offers six named palettes of five inks each, and every one round-trips', () => {
    expect(TOTEM_PRESET_NAMES.length).toBe(6)
    for (const name of TOTEM_PRESET_NAMES) {
      const inks = TOTEM_PALETTE_PRESETS[name].inks
      expect(inks.length).toBe(5)
      for (const c of inks) expect(c).toMatch(/^#[0-9A-Fa-f]{6}$/)
      expect(totemPresetOf(P(totemPresetPatch(name)))).toBe(name)
    }
    expect(totemPresetOf(P({ inks: ['#000000'] }))).toBeNull()
  })

  it('editing one swatch keeps the other four, in order, and drops the picker\'s alpha', () => {
    const p = P()
    const patch = totemInkPatch(p, 2, '#22C55Eff')!
    expect(patch.inks).toEqual([PAL[0], PAL[1], '#22C55E', PAL[3], PAL[4]])
    expect(totemInkPatch(p, 9, '#123456')).toBeNull()
    expect(totemInkPatch(p, 0, 'green')).toBeNull()
  })
})

// ── Rule A: ink roles ────────────────────────────────────────────────────────
describe('totemRoles — the jobs the five inks hold', () => {
  it('the least luminous ink takes the plate job from any position in the row', () => {
    const r = totemRoles(PAL)
    expect(r.dark).toBe(PAL[0])                       // Arcade's navy is its darkest
    expect(r.inks).toEqual([PAL[1], PAL[2], PAL[3], PAL[4]])
    expect(r.mat).toBe(PAL[1])
    expect(r.mark).toBe(PAL[3])                       // second from the end of the rest
    // Move the darkest into the middle: the roles move with the ORDER, not a sort.
    const shifted = [PAL[2], PAL[4], PAL[0], PAL[1], PAL[3]] as string[]
    const s = totemRoles(shifted)
    expect(s.dark).toBe(PAL[0])
    expect(s.inks).toEqual([PAL[2], PAL[4], PAL[1], PAL[3]])
    expect(s.mat).toBe(PAL[2])
    expect(s.mark).toBe(PAL[1])
  })

  it('weights the channels the way the source does (green counts most, blue least)', () => {
    // Pure green is brighter than pure red, which is brighter than pure blue, so a
    // blue is picked as the dark one out of the three.
    expect(totemRoles(['#00FF00', '#FF0000', '#0000FF']).dark).toBe('#0000FF')
    expect(totemRoles(['#0000FF', '#FF0000', '#00FF00']).dark).toBe('#0000FF')
  })

  it('a two-ink row makes the survivor both mat and mark; a one-ink row does every job', () => {
    const two = totemRoles(['#101010', '#EE4444'])
    expect(two.dark).toBe('#101010')
    expect(two.inks).toEqual(['#EE4444'])
    expect(two.mat).toBe('#EE4444')
    expect(two.mark).toBe('#101010')                 // only one left over, so the rule falls back
    const one = totemRoles(['#3366CC'])
    expect(one.dark).toBe('#3366CC')
    expect(one.mat).toBe('#3366CC')
    expect(one.mark).toBe('#3366CC')
    expect(one.inks).toEqual(['#3366CC'])
    // Nothing at all still yields a usable set rather than throwing.
    expect(() => totemRoles([])).not.toThrow()
    expect(totemRoles([]).inks.length).toBe(1)
  })
})

// ── Rule B: the grid unit ────────────────────────────────────────────────────
describe('totemUnit — one snap lattice for the whole picture', () => {
  it('is the short side over the detail dial, never under two', () => {
    expect(totemUnit(800, 600, 110)).toBe(5)
    expect(totemUnit(2400, 2400, 220)).toBe(11)
    expect(totemUnit(2400, 2400, 16)).toBe(150)
    expect(totemUnit(300, 300, 220)).toBe(2)          // the floor of two bites
    expect(totemUnit(40, 40, 220)).toBe(2)
  })

  it('the host\'s unit floor never fires at any size or ratio the tool itself can export', () => {
    // The page exports 600..6000 wide at ratios from 9:16 to 16:9; at every one of
    // those the short-side rule already gives a unit above the budget floor, so this
    // port draws the tool's own pictures untouched.
    for (const size of [600, 1200, 2400, 4000, 6000]) {
      for (const [rw, rh] of [[9, 16], [3, 4], [4, 5], [1, 1], [5, 4], [4, 3], [3, 2], [16, 9]]) {
        const W = size, H = Math.round(size * rh / rw)
        for (const grain of [16, 110, 220]) {
          expect(totemUnit(W, H, grain), `${W}x${H} @${grain}`).toBe(Math.max(2, Math.round(Math.min(W, H) / grain)))
        }
      }
    }
  })

  it('a long thin box is held to the unit budget instead of shredding into millions of cells', () => {
    const u = totemUnit(6000, 400, 220)
    expect(u).toBeGreaterThan(2)
    expect((6000 / u) * (400 / u)).toBeLessThanOrEqual(TOTEM_MAX_UNITS)
  })
})

// ── Rule C: the mat's speckled field ─────────────────────────────────────────
describe('totemMatField — a scatter put through two rounds of tidying', () => {
  it('lays cells down at the density given, and 0 / 1 are empty and full', () => {
    expect([...totemMatField(6, 6, 0, feed([0.9]))].every(v => v === 0)).toBe(true)
    expect([...totemMatField(6, 6, 1, feed([0.1]))].every(v => v === 1)).toBe(true)
    expect(totemMatField(7, 5, 0.5, feed([0.1])).length).toBe(35)
  })

  it('a cell off the edge is read as the cell being judged, so a lone full cell survives', () => {
    // A 1x1 field: all eight neighbours are outside, each counted as the centre, so
    // the tally reaches nine and the cell holds. Counting them as empty would give 1
    // and kill it.
    expect([...totemMatField(1, 1, 1, feed([0]))]).toEqual([1])
  })

  it('drops a speck standing on its own but holds a block together, ties included', () => {
    // Hand-built 5x5: only the middle 3x3 is set. Its centre tallies 9 and holds; a
    // corner of the block tallies exactly 4 — the tie, which changes nothing — so the
    // block comes through both passes whole, while the empty ring around it stays empty.
    const on = new Set([6, 7, 8, 11, 12, 13, 16, 17, 18])
    const rand = (() => { let i = 0; return () => (on.has(i++) ? 0 : 1) })()
    const block = totemMatField(5, 5, 0.5, rand)
    expect([...block]).toEqual([
      0, 0, 0, 0, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 0, 0, 0, 0,
    ])
    // One cell alone in a 5x5 has nothing to hold on to and is gone after a pass.
    const lone = (() => { let i = 0; return () => (i++ === 12 ? 0 : 1) })()
    expect([...totemMatField(5, 5, 0.5, lone)].every(v => v === 0)).toBe(true)
  })
})

// ── Rule D: carving the half ─────────────────────────────────────────────────
describe('totemCarve — the half split by taking the biggest each time', () => {
  const u = 10
  it('reaches the count asked for and tiles the half exactly, every edge on the lattice', () => {
    for (const n of [1, 2, 5, 14, 30]) {
      const rand = mulberryish(n * 7 + 1)
      const list = totemCarve(0, 0, 400, 600, n, u, rand)
      expect(list.length).toBeLessThanOrEqual(n)
      expect(list.reduce((s, g) => s + g.w * g.h, 0)).toBe(400 * 600)
      for (const g of list) {
        expect(g.x % u).toBe(0); expect(g.y % u).toBe(0)
        expect(g.w % u).toBe(0); expect(g.h % u).toBe(0)
        expect(g.w).toBeGreaterThanOrEqual(u * 2)
        expect(g.h).toBeGreaterThanOrEqual(u * 2)
      }
    }
  })

  it('one region is the untouched half', () => {
    expect(totemCarve(30, 40, 400, 600, 1, u, mulberryish(3))).toEqual([{ x: 30, y: 40, w: 400, h: 600 }])
  })

  it('needs six units of room on both sides of a cut, and stops when there is none', () => {
    // Under six units either way nothing can be cut, whatever the count asked for.
    expect(totemCarve(0, 0, u * 5, u * 5, 30, u, mulberryish(9)).length).toBe(1)
    // Given the room it keeps going, and it stops the moment the block holding the
    // most area is too tight to take a cut — not when every last block is.
    const tight = totemCarve(0, 0, u * 6, u * 6, 30, u, mulberryish(9))
    expect(tight.length).toBeGreaterThan(1)
    expect(tight.length).toBeLessThan(30)
    const biggest = tight.reduce((m, g) => (g.w * g.h > m.w * m.h ? g : m))
    expect(biggest.w < u * 6 && biggest.h < u * 6).toBe(true)
  })

  it('cuts across the wider way when the shape is clearly oblong, either way when it is square', () => {
    const wide = totemCarve(0, 0, u * 20, u * 6, 2, u, mulberryish(5))
    expect(wide.every(g => g.h === u * 6)).toBe(true)          // a vertical cut
    const tall = totemCarve(0, 0, u * 6, u * 20, 2, u, mulberryish(5))
    expect(tall.every(g => g.w === u * 6)).toBe(true)          // a horizontal cut
    // A square leaves it to the draw, so both orientations turn up across seeds.
    const orients = new Set<string>()
    for (let s = 1; s <= 40; s++) orients.add(totemCarve(0, 0, u * 10, u * 10, 2, u, mulberryish(s))[0]!.w === u * 10 ? 'h' : 'v')
    expect(orients.size).toBe(2)
  })

  it('is decided entirely by the stream it is handed', () => {
    const a = totemCarve(0, 0, 400, 600, 12, u, mulberryish(4))
    const b = totemCarve(0, 0, 400, 600, 12, u, mulberryish(4))
    const c = totemCarve(0, 0, 400, 600, 12, u, mulberryish(5))
    expect(a).toEqual(b)
    expect(a).not.toEqual(c)
  })
})

/** A throwaway stream for the pure-function tests (the module has its own). */
function mulberryish(seed: number): () => number {
  let a = (seed >>> 0) || 1
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// ── Rule E: the bag of cell rules ────────────────────────────────────────────
describe('totemKinds — how many rules are in play', () => {
  it('runs from two rules at the low end to all eleven at the top, drawn without repeats', () => {
    expect(totemKinds(0, mulberryish(1)).length).toBe(2)
    expect(totemKinds(1, mulberryish(1)).length).toBe(TOTEM_MOTIFS.length)
    expect(totemKinds(0.7, mulberryish(1)).length).toBe(8)
    for (const v of [0, 0.3, 0.7, 1]) {
      const bag = totemKinds(v, mulberryish(v * 100 + 1))
      expect(new Set(bag).size).toBe(bag.length)
      for (const k of bag) expect(TOTEM_MOTIFS).toContain(k)
    }
  })
})

describe('totemMotifOn — the eleven cell rules, pinned', () => {
  const on = (kind: string, i: number, j: number, w = 5, h = 5, p = 0) =>
    totemMotifOn(kind as never, i, j, w, h, p, () => 0.9)

  it('solid covers everything', () => {
    for (const [i, j] of [[0, 0], [3, 2], [4, 4]]) expect(on('solid', i!, j!)).toBe(true)
  })
  it('check alternates on the sum of the two indices, and the phase term flips it', () => {
    expect([on('check', 0, 0), on('check', 1, 0), on('check', 0, 1), on('check', 1, 1)]).toEqual([true, false, false, true])
    expect(on('check', 0, 0, 5, 5, 1)).toBe(false)
  })
  it('hline reads the row only, vline the column only', () => {
    expect([on('hline', 0, 0), on('hline', 3, 0), on('hline', 0, 1)]).toEqual([true, true, false])
    expect([on('vline', 0, 0), on('vline', 0, 3), on('vline', 1, 0)]).toEqual([true, true, false])
  })
  it('the two diagonals are two-on two-off bands running opposite ways, and a negative phase still wraps', () => {
    expect([0, 1, 2, 3, 4].map(i => on('diag', i, 0))).toEqual([true, true, false, false, true])
    expect([0, 1, 2, 3, 4].map(i => on('diagB', i, 0))).toEqual([true, true, false, false, true])
    expect([0, 1, 2, 3].map(j => on('diagB', 0, j))).toEqual([true, false, false, true])
  })
  it('brick offsets every other row by two columns', () => {
    expect([0, 1, 2, 3].map(i => on('brick', i, 0))).toEqual([true, true, false, false])
    expect([0, 1, 2, 3].map(i => on('brick', i, 1))).toEqual([false, false, true, true])
  })
  it('dash skips odd rows and marks two columns in three', () => {
    expect([0, 1, 2, 3].map(i => on('dash', i, 0))).toEqual([true, true, false, true])
    expect([0, 1, 2, 3].map(i => on('dash', i, 1))).toEqual([false, false, false, false])
  })
  it('grid keeps every third column and every third row', () => {
    expect([on('grid', 0, 5), on('grid', 5, 0), on('grid', 1, 1), on('grid', 3, 1)]).toEqual([true, true, false, true])
  })
  it('rings bands inward from whichever edge is nearest', () => {
    expect([on('rings', 0, 0), on('rings', 1, 1), on('rings', 2, 2), on('rings', 4, 4)]).toEqual([true, false, true, true])
    expect(on('rings', 1, 3, 5, 5)).toBe(false)
  })
  it('noise takes a coin from the stream', () => {
    expect(totemMotifOn('noise', 0, 0, 5, 5, 0, () => 0.2)).toBe(true)
    expect(totemMotifOn('noise', 0, 0, 5, 5, 0, () => 0.8)).toBe(false)
  })
})

// ── Rule F: dealing a region ─────────────────────────────────────────────────
describe('totemDeal — what one region is given', () => {
  const inks = ['#AA0000', '#00AA00', '#0000AA']
  const dark = '#111111'

  it('takes a rule from the bag, and a flat one gets a second draw a bit over half the time', () => {
    const kinds = ['solid', 'check'] as const
    // First draw lands on solid, the re-draw coin comes in under the threshold, the
    // second draw lands on check: the flat region is traded away.
    expect(totemDeal(kinds as never, inks, dark, 8, feed([0.1, 0.4, 0.9, 0, 0, 0.9])).kind).toBe('check')
    // Same first draw, but the coin misses the threshold: the flat one stands.
    expect(totemDeal(kinds as never, inks, dark, 8, feed([0.1, 0.7, 0, 0, 0.9])).kind).toBe('solid')
    // A re-draw can land on solid again — one extra draw, not a loop.
    expect(totemDeal(kinds as never, inks, dark, 8, feed([0.1, 0.4, 0.1, 0, 0, 0.9])).kind).toBe('solid')
  })

  it('the mark and the ground are never the same colour, and the dark is twice as likely a ground', () => {
    for (let s = 1; s <= 200; s++) {
      const d = totemDeal(['check'] as never, inks, dark, 8, mulberryish(s))
      expect(d.a).not.toBe(d.b)
      expect(inks).toContain(d.a)
      expect([...inks, dark]).toContain(d.b)
    }
    // Three inks plus the dark listed twice, less the one mark, leaves four entries —
    // two of them the dark, so the plate grounds about half the blocks.
    let darkGrounds = 0
    for (let s = 1; s <= 600; s++) if (totemDeal(['check'] as never, inks, dark, 8, mulberryish(s)).b === dark) darkGrounds++
    expect(darkGrounds / 600).toBeGreaterThan(0.44)
    expect(darkGrounds / 600).toBeLessThan(0.56)
  })

  it('falls back to the dark ground when nothing else is on offer', () => {
    expect(totemDeal(['check'] as never, ['#AA0000'], '#AA0000', 8, feed([0, 0, 0, 0.9])).b).toBe('#AA0000')
  })

  it('runs at the base cell most of the time and at double now and then', () => {
    expect(totemDeal(['check'] as never, inks, dark, 8, feed([0, 0, 0, 0.2])).cs).toBe(16)
    expect(totemDeal(['check'] as never, inks, dark, 8, feed([0, 0, 0, 0.5])).cs).toBe(8)
  })
})

// ── Rule G: the reflected twin ───────────────────────────────────────────────
describe('totemMirror — where the twin lands', () => {
  const cx = 100, cw = 600, halfW = 300
  it('reflects the region about the middle of the composition', () => {
    // Flush against the left edge comes back flush against the right.
    expect(totemMirror({ x: 100, y: 0, w: 80, h: 10 }, cx, cw, halfW).mx).toBe(620)
    // A region ending on the half line comes back starting from it.
    expect(totemMirror({ x: 300, y: 0, w: 100, h: 10 }, cx, cw, halfW).mx).toBe(400)
  })
  it('reports the width still inside the composition, so a twin off the edge is skipped', () => {
    const m = totemMirror({ x: 100, y: 0, w: 80, h: 10 }, cx, cw, halfW)
    expect(m.clipX).toBe(620)
    expect(m.tw).toBe(80)
    // A region wider than the half has its twin trimmed at the half line.
    const wide = totemMirror({ x: 100, y: 0, w: 600, h: 10 }, cx, cw, halfW)
    expect(wide.mx).toBe(100)
    expect(wide.clipX).toBe(400)
    expect(wide.tw).toBe(300)
  })
})

// ── Rule H: the core ─────────────────────────────────────────────────────────
describe('totemCore — the centre stack', () => {
  const roles = totemRoles(PAL)
  it('sits centred on the lattice, taller than it is wide by a factor the seed picks', () => {
    const c = totemCore(105, 105, 590, 390, P(), 5, 12, roles)!
    expect(c.rings.length).toBe(3)
    expect(c.rings[0]).toMatchObject({ x: 360, y: 240, w: 85, h: 120 })
    // Seeds 0..4 give five different heights off the same width.
    const heights = new Set([0, 1, 2, 3, 4].map(s => totemCore(105, 105, 590, 390, P(), 5, s, roles)!.rings[0]!.h))
    expect(heights.size).toBe(5)
  })

  it('alternates the dark plate with an ink stepped along the row', () => {
    const c = totemCore(105, 105, 590, 390, P({ coreRings: 5 }), 5, 12, roles)!
    expect(c.rings.map(r => r.color)).toEqual([
      roles.dark, roles.inks[2], roles.dark, roles.inks[0], roles.dark,
    ])
  })

  it('every ring steps in one unit on each side, and the motif fills whatever is left', () => {
    const c = totemCore(105, 105, 590, 390, P({ coreRings: 4 }), 5, 12, roles)!
    for (let i = 1; i < c.rings.length; i++) {
      expect(c.rings[i]!.x).toBe(c.rings[i - 1]!.x + 5)
      expect(c.rings[i]!.w).toBe(c.rings[i - 1]!.w - 10)
    }
    const last = c.rings[c.rings.length - 1]!
    expect(c.inner).toEqual({ x: last.x + 5, y: last.y + 5, w: last.w - 10, h: last.h - 10 })
  })

  it('no rings leaves the whole block for the motif; a size of nothing leaves no core at all', () => {
    const none = totemCore(105, 105, 590, 390, P({ coreRings: 0 }), 5, 12, roles)!
    expect(none.rings).toEqual([])
    expect(none.inner).toMatchObject({ x: 360, y: 240, w: 85, h: 120 })
    expect(totemCore(105, 105, 590, 390, P({ core: 0 }), 5, 12, roles)).toBeNull()
  })

  it('stops shrinking before the block runs out, however many rings were asked for', () => {
    const c = totemCore(0, 0, 200, 200, P({ core: 0.6, coreRings: 8 }), 10, 3, roles)!
    expect(c.rings.length).toBeLessThanOrEqual(8)
    expect(c.inner.w).toBeGreaterThanOrEqual(10)
    expect(c.inner.h).toBeGreaterThanOrEqual(10)
    // A core wider than the box is pulled back inside it.
    const big = totemCore(0, 0, 100, 100, P({ core: 0.6, coreRings: 2 }), 10, 3, roles)!
    expect(big.rings[0]!.w).toBeLessThanOrEqual(100 - 20)
    expect(big.rings[0]!.h).toBeLessThanOrEqual(100 - 20)
  })
})

// ── Paint ────────────────────────────────────────────────────────────────────
type Rect = { x: number; y: number; w: number; h: number; style: unknown; alpha: number }
function recorder() {
  const rects: Rect[] = []
  let t = { a: 1, d: 1, e: 0, f: 0 }
  const st: typeof t[] = []
  const ctx = {
    fillStyle: '' as unknown, globalAlpha: 1,
    save() { st.push({ ...t }) },
    restore() { if (st.length) t = st.pop()! },
    translate(x: number, y: number) { t.e += t.a * x; t.f += t.d * y },
    scale(sx: number, sy: number) { t.a *= sx; t.d *= sy },
    fillRect(x: number, y: number, w: number, h: number) {
      let x0 = t.a * x + t.e, x1 = t.a * (x + w) + t.e
      let y0 = t.d * y + t.f, y1 = t.d * (y + h) + t.f
      if (x1 < x0) { const q = x0; x0 = x1; x1 = q }
      if (y1 < y0) { const q = y0; y0 = y1; y1 = q }
      rects.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, style: ctx.fillStyle, alpha: ctx.globalAlpha })
    },
  }
  return { ctx: ctx as unknown as TotemCtx, rects, depth: () => st.length }
}

describe('paintTotem', () => {
  const W = 800, H = 600
  const roles = totemRoles(PAL)

  it('sheets the mat first, then prints the plate inside the border', () => {
    const rec = recorder()
    paintTotem(rec.ctx, P(), W, H, 12)
    expect(rec.rects[0]).toMatchObject({ x: 0, y: 0, w: W, h: H, style: roles.mat })
    const plate = rec.rects.find(r => r.w === 620 && r.h === 420)!
    expect(plate).toMatchObject({ x: 90, y: 90, style: roles.dark })
    expect(rec.depth()).toBe(0)                       // every save was matched
  })

  it('speckles only the border band, in the mark ink, and never when there is no border', () => {
    const rec = recorder()
    paintTotem(rec.ctx, P(), W, H, 12)
    // Everything before the plate rect is mat work; the composition comes after it.
    const plateAt = rec.rects.findIndex(r => r.w === 620 && r.h === 420)
    const flecks = rec.rects.slice(1, plateAt)
    expect(flecks.length).toBeGreaterThan(0)
    for (const f of flecks) expect(f).toMatchObject({ w: 10, h: 10, style: roles.mark })
    // The plate covers 90..710 x 90..510; no fleck may sit wholly inside it.
    for (const f of flecks) {
      const inside = f.x + f.w > 90 && f.x < 710 && f.y + f.h > 90 && f.y < 510
      expect(inside).toBe(false)
    }
    // No band at all, or the dial at nothing: the plate follows the sheet directly.
    for (const over of [{ border: 0 }, { mat: 0 }]) {
      const bare = recorder()
      paintTotem(bare.ctx, P(over), W, H, 12)
      expect(bare.rects[1]!.style).toBe(roles.dark)
    }
  })

  it('stops after the mat when the border has swallowed the plate', () => {
    const rec = recorder()
    // A 30x30 box at the widest border: the unit is 2 and the plate comes out six
    // across, under the four units the picture needs, so nothing further is printed.
    paintTotem(rec.ctx, P({ border: 0.4, grain: 220 }), 30, 30, 12)
    expect(rec.rects[0]).toMatchObject({ x: 0, y: 0, w: 30, h: 30, style: roles.mat })
    expect(rec.rects.some(r => r.style === roles.dark)).toBe(false)
  })

  it('mirrors the left half onto the right', () => {
    const rec = recorder()
    paintTotem(rec.ctx, P({ regions: 1, core: 0, mat: 0, mirror: 1, variety: 0 }), W, H, 12)
    // One region fills the left half (105..400); its twin lands at 400..695 with the
    // composition running to 695.
    const marks = rec.rects.filter(r => r.x >= 400 && r.style !== roles.mat && r.style !== roles.dark)
    expect(marks.length).toBeGreaterThan(0)
    expect(Math.max(...marks.map(r => r.x + r.w))).toBeLessThanOrEqual(695 + 1e-9)
  })

  it('never writes an absolute opacity or composite op — the layer\'s own ride through', () => {
    const rec = recorder()
    const writes: string[] = []
    const guarded = new Proxy(rec.ctx as unknown as Record<string, unknown>, {
      set(t, k, v) { if (k === 'globalAlpha' || k === 'globalCompositeOperation') writes.push(String(k)); t[k as string] = v; return true },
    }) as unknown as TotemCtx
    rec.ctx.globalAlpha = 0.35
    paintTotem(guarded, P(), W, H, 12)
    expect(writes).toEqual([])
    for (const r of rec.rects) expect(r.alpha).toBeCloseTo(0.35, 9)
  })

  it('two seeds are two pictures, and the same seed repeats exactly', () => {
    const a = recorder(), b = recorder(), c = recorder()
    paintTotem(a.ctx, P(), W, H, 1)
    paintTotem(b.ctx, P(), W, H, 2)
    paintTotem(c.ctx, P(), W, H, 1)
    expect(JSON.stringify(a.rects)).toBe(JSON.stringify(c.rects))
    expect(JSON.stringify(a.rects)).not.toBe(JSON.stringify(b.rects))
  })

  it('survives the awkward corners: one region, no rings, thin palettes, either way up', () => {
    for (const over of [
      { regions: 1 }, { regions: 30 }, { core: 0 }, { core: 0.6, coreRings: 8 },
      { coreRings: 0 }, { keyline: 0 }, { keyline: 10 }, { border: 0 }, { border: 0.4 },
      { grain: 16 }, { grain: 220 }, { mirror: 0 }, { variety: 0 }, { variety: 1 },
      { matGrain: 6 }, { inks: ['#123456'] }, { inks: ['#123456', '#EEAA00'] }, { inks: [] },
    ]) {
      for (const [bw, bh] of [[800, 600], [600, 800], [24, 18], [1600, 60]]) {
        const rec = recorder()
        expect(() => paintTotem(rec.ctx, P(over as Partial<TotemParams>), bw!, bh!, 7), JSON.stringify(over)).not.toThrow()
        expect(rec.rects.length).toBeGreaterThan(0)
        expect(rec.depth()).toBe(0)
        for (const r of rec.rects) { expect(Number.isFinite(r.x)).toBe(true); expect(r.w).toBeGreaterThanOrEqual(0) }
      }
    }
  })

  it('keeps a tiny box under a sane number of marks even at the finest detail', () => {
    const rec = recorder()
    paintTotem(rec.ctx, P({ grain: 220, regions: 30 }), 1600, 60, 7)
    expect(rec.rects.length).toBeLessThan(TOTEM_MAX_UNITS)
  })
})

// ── The deal branch routes cellFill:'totem' to paintTotem ────────────────────
describe('deal layer render with cellFill:totem (headless)', () => {
  const mainRects: { x: number; y: number; w: number; h: number }[] = []
  const translates: [number, number][] = []
  function recordingCtx(name: string) {
    return {
      canvas: { width: 400, height: 400 },
      globalCompositeOperation: 'source-over', globalAlpha: 1,
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
      getTransform: () => ({ a: 1, b: 0 }), setTransform() {}, save() {}, restore() {},
      translate(x: number, y: number) { if (name === 'main') translates.push([x, y]) }, rotate() {}, scale() {}, clip() {},
      beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, roundRect() {}, ellipse() {}, rect() {}, closePath() {}, setLineDash() {},
      fill() {}, stroke() {}, clearRect() {},
      fillRect(x: number, y: number, w: number, h: number) { if (name === 'main') mainRects.push({ x, y, w, h }) },
      putImageData() {}, createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      createRadialGradient() { return { addColorStop() {} } },
      createLinearGradient() { return { addColorStop() {} } },
      createPattern() { return {} },
      drawImage() {},
    } as unknown as CanvasRenderingContext2D
  }
  let seq = 0
  beforeEach(() => {
    mainRects.length = 0; seq = 0; translates.length = 0
    vi.stubGlobal('document', { createElement: () => { const c: any = { width: 0, height: 0 }; c.getContext = () => recordingCtx(`off-${++seq}`); return c } })
  })
  afterEach(() => vi.unstubAllGlobals())

  async function drawDeal(layer: any, W: number, H: number) {
    const { drawLocalLayer } = await import('~/composables/useCompositorLayers')
    drawLocalLayer(recordingCtx('main'), layer, W, H)
  }
  const dealLayer = (over: Record<string, unknown> = {}) => ({
    id: 'd1', kind: 'deal', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 1, h: 1,
    vocab: 'brand', density: 0.1, cellInset: 0.3,
    grid: { ...defaultGrid(), mode: 'explicit', columns: 5, rows: 4, margin: 0, gutter: 0, gen: { ...defaultGrid().gen, seed: 12 } },
    ...over,
  })

  it('paints the whole box, centred, and pays no attention to the grid dials', async () => {
    await drawDeal(dealLayer({ cellFill: 'totem', totem: defaultTotem() }), 400, 400)
    // The host walks to the layer's centre, then to the box's top-left corner, and
    // hands over; anything after that is the paint's own mirroring.
    expect(translates.slice(0, 2)).toEqual([[200, 200], [-200, -200]])
    expect(mainRects[0]).toEqual({ x: 0, y: 0, w: 400, h: 400 })
    expect(mainRects.length).toBeGreaterThan(10)
  })

  it('a half-written params object with no inks still paints instead of throwing', async () => {
    await drawDeal(dealLayer({ cellFill: 'totem', totem: { regions: 4 } }), 400, 400)
    expect(mainRects.length).toBeGreaterThan(0)
  })
})

// ── The Mosaic seams ─────────────────────────────────────────────────────────
describe('Totem as a Mosaic style', () => {
  const baseState = (extra: Partial<CompositorState> = {}): CompositorState => ({ layers: [], ...extra })
  const layerOf = (r: ReturnType<typeof applyCompositorCommand>) => (r as any).template.layers[0]

  it('brings its own five inks, so the vocabulary control stays hidden', () => {
    expect(dealVocabDrivesLook({ cellFill: 'totem' })).toBe(false)
  })

  it('style:"totem" creates a frame-filling totem at the source defaults', () => {
    const r = applyCompositorCommand(baseState({ aspect: 1.25 }), { op: 'mosaic', args: { id: 'm', style: 'totem', seed: 9 } })
    expect(r.ok).toBe(true)
    expect(layerOf(r)).toMatchObject({ kind: 'deal', cellFill: 'totem', w: 1, h: 1.25 })
    expect(layerOf(r).totem).toEqual(defaultTotem())
  })

  it('its tunables imply the style, last in the precedence order after carve', () => {
    expect(impliedDealFill({ totem: {} })).toBe('totem')
    expect(impliedDealFill({ totem: {}, carve: {} })).toBe('carve')
    expect(impliedDealFill({ palettePreset: 'lagoon' })).toBe('totem')
    const l = layerOf(applyCompositorCommand(baseState(), { op: 'mosaic', args: { id: 'm', totem: { regions: 22, core: 0.4 } } }))
    expect(l.cellFill).toBe('totem')
    expect(l.totem).toEqual({ ...defaultTotem(), regions: 22, core: 0.4 })
  })

  it('a palettePreset lands only on totem, and a name from another table is refused', () => {
    const l = layerOf(applyCompositorCommand(baseState(), { op: 'mosaic', args: { id: 'm', style: 'totem', palettePreset: 'harbour' } }))
    expect(l.totem.inks).toEqual([...TOTEM_PALETTE_PRESETS.Harbour.inks])
    const bad = applyCompositorCommand(baseState(), { op: 'mosaic', args: { style: 'totem', palettePreset: 'Riso' } })
    expect(bad.ok).toBe(false)
    expect((bad as any).detail).toMatch(/unknown palettePreset "Riso" for totem; options: Arcade/)
  })

  it('reads back as style "totem" with its palette name and dials, without the ink array', () => {
    const s = (applyCompositorCommand(baseState(), { op: 'mosaic', args: { id: 'm', style: 'totem', palettePreset: 'Neon', totem: { regions: 20 } } }) as any).template
    const cur = describeCompositor(s).objects.find(x => x.id === 'm')!.current as any
    expect(cur.style).toBe('totem')
    expect(cur.totem).toMatchObject({ palettePreset: 'Neon', regions: 20, mirror: 1 })
    expect(cur.totem).not.toHaveProperty('inks')
    expect(describeCompositor(baseState()).commands.find(c => c.op === 'mosaic')!.hint!).toContain('"totem"')
  })

  it('restyling to totem and back keeps the layer, its box and its variation', () => {
    const s1 = (applyCompositorCommand(baseState({ aspect: 0.5 }), { op: 'mosaic', args: { id: 'm', style: 'carve', seed: 7 } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'mosaic', target: 'm', args: { style: 'totem' } })
    expect(layerOf(r)).toMatchObject({ id: 'm', cellFill: 'totem', w: 1, h: 0.5 })
    expect(layerOf(r).grid.gen.seed).toBe(7)
    const back = applyCompositorCommand((r as any).template, { op: 'mosaic', target: 'm', args: { style: 'carve' } })
    expect(layerOf(back).cellFill).toBe('carve')
    expect(layerOf(back).totem).toEqual(defaultTotem())
  })
})

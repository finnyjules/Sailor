import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MOSH_KINDS, MOSH_LIMITS, MOSH_PALETTE_PRESETS, MOSH_PRESET_NAMES, defaultMosh, normalizeMosh, moshPresetPatch, moshPresetOf,
  moshHash, moshLuminance, moshRoles, moshPick, moshDeck, moshBands, moshColumns, moshBandSeed,
  moshConfettiRects, moshMosaicRects, moshMosaicTears, moshMosaicStep, moshTorn, moshSmearRects, moshSmearRows, moshScanRects,
  moshChevronSpec, moshChevronShift, moshChevronRects, moshRects, paintMosh,
  type MoshParams, type MoshCtx, type MoshRect,
} from '~/lib/compositor/mosh'
import { defaultGrid } from '~/lib/frame/grid'
import { applyCompositorCommand, type CompositorState } from '~/lib/agent/surfaces/compositor'

// Every rule below is the playgrnd Mosh generator's rule, restated as a test.
const P = (over: Partial<MoshParams> = {}): MoshParams => ({ ...defaultMosh(), ...over })
const CUBE = [...MOSH_PALETTE_PRESETS['Pure cube']]
const W = 960
const wrap = (i: number, N: number) => ((i % N) + N) % N
const runLen = (r: MoshRect) => r.i1 - r.i0
/** Group rects by row and check each row tiles [0, N) exactly: no gap, no overlap. */
function expectRowsTile(rects: MoshRect[], N: number) {
  const rows = new Map<number, MoshRect[]>()
  for (const r of rects) { const a = rows.get(r.j); if (a) a.push(r); else rows.set(r.j, [r]) }
  expect(rows.size).toBeGreaterThan(0)
  for (const row of rows.values()) {
    row.sort((a, b) => a.i0 - b.i0)
    expect(row[0]!.i0).toBe(0)
    for (let k = 1; k < row.length; k++) expect(row[k]!.i0).toBe(row[k - 1]!.i1)
    expect(row[row.length - 1]!.i1).toBe(N)
  }
  return rows
}

// ── Roles ────────────────────────────────────────────────────────────────────
describe('moshRoles', () => {
  it('dark is the lowest-luminance ink (r·.299 + g·.587 + b·.114); bright is inks[1]; inks is the palette', () => {
    expect(moshLuminance('#FF0000')).toBeCloseTo(255 * 0.299, 6)
    expect(moshLuminance('#00FF00')).toBeCloseTo(255 * 0.587, 6)
    expect(moshLuminance('#0000FF')).toBeCloseTo(255 * 0.114, 6)
    for (const name of MOSH_PRESET_NAMES) {
      const pal = [...MOSH_PALETTE_PRESETS[name]]
      const r = moshRoles(pal)
      const lums = pal.map(moshLuminance)
      expect(moshLuminance(r.dark)).toBe(Math.min(...lums))
      expect(r.bright).toBe(pal[1])
      expect(r.inks).toEqual(pal)
    }
    // Dark need not be first: it is found by luminance.
    const r = moshRoles(['#FFFFFF', '#FF0000', '#0000FF', '#101010'])
    expect(r.dark).toBe('#101010'); expect(r.bright).toBe('#FF0000')
  })
})

// ── Pick ─────────────────────────────────────────────────────────────────────
describe('moshPick', () => {
  const roles = moshRoles(CUBE)
  it('v < .16 ⇒ dark for any mix and bias (a sixth of everything is dead)', () => {
    for (const mix of [0, 0.3, 0.62, 1]) for (const bias of [0, 3, 11]) for (const v of [0, 0.05, 0.1, 0.1599]) {
      expect(moshPick(v, bias, roles, mix)).toBe(roles.dark)
    }
    expect(moshPick(0.16, 0, roles, 1)).not.toBe(undefined)
  })
  it('mix 0 ⇒ only round(len·.25) inks reachable; mix 1 ⇒ all 8; mix widens the draw', () => {
    const reach = (mix: number, bias = 0) => {
      const s = new Set<string>()
      for (let k = 0; k < 2000; k++) s.add(moshPick(0.16 + (k / 2000) * 0.84, bias, roles, mix))
      return s
    }
    expect(reach(0)).toEqual(new Set(CUBE.slice(0, Math.round(8 * 0.25))))
    // mix 1: n = 8, and ⌊v·8⌋ ≥ 1 for v ≥ .16 — index 0 comes only through the
    // dead-patch rule at bias 0; a bias of 1 rotates it back in. All 8 reachable.
    expect(reach(1)).toEqual(new Set(CUBE.slice(1)))
    expect(reach(1, 1)).toContain(CUBE[0])
    expect(new Set([...reach(1), ...reach(1, 1)])).toEqual(new Set(CUBE))
    expect(reach(0.5).size).toBe(Math.round(8 * (0.25 + 0.5 * 0.75)))
    // The rule itself: inks[(⌊v·n⌋ + bias) mod len].
    for (const [v, bias, mix] of [[0.5, 0, 1], [0.99, 2, 0.62], [0.3, 7, 0], [0.7, 13, 0.5]] as const) {
      const n = Math.max(1, Math.round(8 * (0.25 + mix * 0.75)))
      expect(moshPick(v, bias, roles, mix)).toBe(CUBE[(Math.floor(v * n) + bias) % 8])
    }
  })
  it('bias rotates the index through the palette; deterministic', () => {
    for (let k = 0; k < 50; k++) {
      const v = 0.16 + (k / 50) * 0.84
      const a = moshPick(v, 0, roles, 1)
      expect(moshPick(v, 1, roles, 1)).toBe(CUBE[(CUBE.indexOf(a) + 1) % 8])
      expect(moshPick(v, 8, roles, 1)).toBe(a)
      expect(moshPick(v, 3, roles, 0.62)).toBe(moshPick(v, 3, roles, 0.62))
    }
  })
})

// ── The hash ─────────────────────────────────────────────────────────────────
describe('moshHash', () => {
  it('is in [0,1), deterministic, and independent per salt / argument', () => {
    const vals: number[] = []
    for (let i = 0; i < 500; i++) { const v = moshHash(i, i * 7, 17); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); vals.push(v) }
    expect(new Set(vals).size).toBeGreaterThan(495)
    expect(moshHash(3, 4, 5)).toBe(moshHash(3, 4, 5))
    let diff = 0
    for (let i = 0; i < 100; i++) { if (moshHash(i, 2, 17) !== moshHash(i, 2, 19)) diff++; if (moshHash(i, 2, 17) !== moshHash(2, i, 17)) diff++ }
    expect(diff).toBeGreaterThan(195)
    const mean = vals.reduce((s, v) => s + v, 0) / vals.length
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.05)
  })
})

// ── Bands + the deck ─────────────────────────────────────────────────────────
describe('moshBands / moshDeck', () => {
  it('band edges are contiguous from 0 and the last snaps to H — heights sum exactly to H', () => {
    for (const seed of [1, 5, 23, 999]) for (const bands of [1, 3, 6, 8]) for (const H of [1200, 777, 100]) {
      const bs = moshBands(P({ bands }), H, seed)
      expect(bs.length).toBe(bands)
      expect(bs[0]!.y0).toBe(0)
      for (let k = 1; k < bs.length; k++) expect(bs[k]!.y0).toBe(bs[k - 1]!.y1)
      expect(bs[bs.length - 1]!.y1).toBe(H)
      expect(bs.reduce((s, b) => s + (b.y1 - b.y0), 0)).toBe(H)
      bs.forEach((b, k) => expect(b.b).toBe(k))
    }
  })
  it('heights are UNEVEN with weights in .4..2.0 — no band is more than 5× another (plus rounding)', () => {
    let uneven = 0
    for (let seed = 1; seed <= 30; seed++) {
      const bs = moshBands(P(), 1200, seed)
      const hs = bs.map(b => b.y1 - b.y0)
      expect(Math.max(...hs) / Math.min(...hs)).toBeLessThan(5.2)
      if (new Set(hs).size > 3) uneven++
    }
    expect(uneven).toBeGreaterThan(25)
  })
  it('the deck is a shuffled permutation of the five kinds; bands=5 ⇒ every kind once; bands=6 ⇒ the 6th repeats the first', () => {
    for (let seed = 1; seed <= 40; seed++) {
      expect([...moshDeck(seed)].sort()).toEqual([...MOSH_KINDS].sort())
      const five = moshBands(P({ bands: 5 }), 1000, seed).map(b => b.kind)
      expect([...five].sort()).toEqual([...MOSH_KINDS].sort())
      const six = moshBands(P({ bands: 6 }), 1000, seed).map(b => b.kind)
      expect(six.slice(0, 5)).toEqual(five)
      expect(six[5]).toBe(five[0])
      const eight = moshBands(P({ bands: 8 }), 1000, seed).map(b => b.kind)
      expect(eight.slice(5)).toEqual(five.slice(0, 3))
    }
  })
  it('deterministic in seed; different seeds reshuffle (and re-weight)', () => {
    expect(moshBands(P(), 1200, 5)).toEqual(moshBands(P(), 1200, 5))
    const orders = new Set<string>()
    for (let seed = 1; seed <= 40; seed++) orders.add(moshDeck(seed).join(','))
    expect(orders.size).toBeGreaterThan(10)
    expect(moshBands(P(), 1200, 1).map(b => b.y1)).not.toEqual(moshBands(P(), 1200, 2).map(b => b.y1))
  })
})

// ── Columns ──────────────────────────────────────────────────────────────────
describe('moshColumns', () => {
  it('N = max(6, cols), cw = W/N', () => {
    expect(moshColumns(P({ cols: 150 }), 960)).toEqual({ N: 150, cw: 6.4, W: 960 })
    expect(moshColumns(P({ cols: 2 }), 600).N).toBe(6)
  })
})

// ── confetti ─────────────────────────────────────────────────────────────────
describe('confetti', () => {
  const c = moshColumns(P(), W), roles = moshRoles(CUBE)
  it('runs are 1..3 cells, ~10% long in [5, 265]; runs tile every row exactly to N; rows one column tall', () => {
    let short = 0, long = 0, clipped = 0
    for (const seed of [1, 5, 23]) {
      const bs = moshBandSeed(seed, 0)
      const bh = 300
      const rects = moshConfettiRects(c, roles, 0.62, 100, bh, bs)
      const rows = expectRowsTile(rects, c.N)
      expect(rows.size).toBe(Math.max(1, Math.round(bh / c.cw)))
      for (const row of rows.values()) {
        for (let k = 0; k < row.length; k++) {
          const r = row[k]!, len = runLen(r)
          if (k === row.length - 1 && r.i1 === c.N && !(len <= 3 || len >= 5)) { clipped++; continue }  // the last run is clipped to N
          if (len <= 3) { expect(len).toBeGreaterThanOrEqual(1); short++ }
          else { expect(len).toBeGreaterThanOrEqual(5); expect(len).toBeLessThanOrEqual(265); long++ }
        }
      }
    }
    const frac = long / (short + long)
    expect(frac).toBeGreaterThan(0.06); expect(frac).toBeLessThan(0.15)
    expect(clipped).toBeLessThan(short + long)
  })
  it('the run rule and the colour rule per cell: run = long<.1 ? 5+⌊long·260⌋ : 1+⌊r·3⌋; colour = pick(h(i,j,bs+19), j)', () => {
    const bs = moshBandSeed(7, 2)
    const rects = moshConfettiRects(c, roles, 0.62, 0, 200, bs)
    for (const r of rects) {
      const w = wrap(r.i0, c.N)
      const rr = moshHash(w, r.j, bs + 17), lg = moshHash(w, r.j, bs + 101)
      const run = lg < 0.10 ? 5 + Math.floor(lg * 260) : 1 + Math.floor(rr * 3)
      expect(r.i1).toBe(Math.min(c.N, r.i0 + run))
      expect(r.col).toBe(moshPick(moshHash(w, r.j, bs + 19), r.j, roles, 0.62))
    }
  })
  it('rects are column-snapped and OVERSIZED by the +1 (ceil(rh)+1 tall) so rows never show seams', () => {
    const by = 100, bh = 300, rows = Math.round(bh / c.cw), rh = bh / rows
    for (const r of moshConfettiRects(c, roles, 0.62, by, bh, moshBandSeed(5, 0))) {
      expect(r.x).toBe(Math.round(r.i0 * c.cw))
      expect(r.w).toBe(Math.round(r.i1 * c.cw) - Math.round(r.i0 * c.cw))
      expect(r.y).toBe(Math.round(by + r.j * rh))
      expect(r.h).toBe(Math.ceil(rh) + 1)
      expect(r.h).toBeGreaterThan(rh)
    }
  })
})

// ── mosaic ───────────────────────────────────────────────────────────────────
describe('mosaic', () => {
  const c = moshColumns(P(), W), roles = moshRoles(CUBE)
  it('step is 4..9 columns (≥2); tears=0 ⇒ no tears and no torn blocks; tears>0 ⇒ ≥1 tear for every seed', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const b = seed % 6, bs = moshBandSeed(seed, b)
      const step = moshMosaicStep(b, bs)
      expect(step).toBeGreaterThanOrEqual(4); expect(step).toBeLessThanOrEqual(9)
      const none = moshMosaicRects(c, roles, { mix: 0.62, tears: 0 }, 0, 240, b, bs)
      expect(none.tears).toEqual([]); expect(none.torn.every(t => !t)).toBe(true)
      for (const tears of [0.01, 0.55, 1]) {
        const t = moshMosaicTears(b, bs, tears, 5, 20)
        expect(t.length).toBeGreaterThanOrEqual(1)
        expect(t.length).toBeLessThanOrEqual(1 + Math.floor(tears * 2.6))
      }
    }
  })
  it('tears>0 ⇒ SOME torn blocks across seeds, and torn blocks are mostly dark (≥ ~80%)', () => {
    let torn = 0, tornDark = 0, any = 0
    for (let seed = 1; seed <= 40; seed++) {
      const b = seed % 6, bs = moshBandSeed(seed, b)
      const m = moshMosaicRects(c, roles, { mix: 0.62, tears: 0.55 }, 0, 240, b, bs)
      const n = m.torn.filter(Boolean).length
      if (n > 0) any++
      torn += n
      m.rects.forEach((r, k) => { if (m.torn[k] && r.col === roles.dark) tornDark++ })
    }
    expect(any).toBeGreaterThan(20)
    expect(torn).toBeGreaterThan(100)
    expect(tornDark / torn).toBeGreaterThan(0.78)
  })
  it('a block is torn only where EVERY cut agrees: one cut = a half-plane, two opposing cuts = the wedge between (never the whole band)', () => {
    expect(moshTorn([], 3, 3)).toBe(false)
    // One cut, flat at row 2, keeping the side above: rows 0,1 torn, 2+ not.
    const up = { a: 2, k: 0, up: true }
    expect([0, 1, 2, 3].map(j => moshTorn([up], 0, j))).toEqual([true, true, false, false])
    // The opposite cut alone keeps the side below.
    const down = { a: 0.5, k: 0, up: false }
    expect([0, 1, 2, 3].map(j => moshTorn([down], 0, j))).toEqual([false, true, true, true])
    // Both: the intersection — only row 1 — NOT "whichever cut says so" (which would be every row).
    expect([0, 1, 2, 3].map(j => moshTorn([up, down], 0, j))).toEqual([false, true, false, false])
    // Two cuts with no overlap ⇒ nothing torn at all.
    expect([0, 1, 2, 3, 4].map(j => moshTorn([{ a: 1, k: 0, up: true }, { a: 3, k: 0, up: false }], 0, j))).toEqual([false, false, false, false, false])
    // A slope: the edge moves with the column.
    const diag = { a: 0, k: 1, up: false }        // edge = i; torn where j > i
    expect(moshTorn([diag], 0, 1)).toBe(true); expect(moshTorn([diag], 2, 1)).toBe(false)
  })
  it('the tear shapes: a ∈ [0,rows), k ∈ ±rows/cols2·1.8, up from a coin; the colour rule per block', () => {
    const rows = 5, cols2 = 20
    for (let seed = 1; seed <= 20; seed++) {
      const b = seed % 6, bs = moshBandSeed(seed, b)
      for (const t of moshMosaicTears(b, bs, 1, rows, cols2)) {
        expect(t.a).toBeGreaterThanOrEqual(0); expect(t.a).toBeLessThan(rows)
        expect(Math.abs(t.k)).toBeLessThanOrEqual(rows / cols2 * 1.8)
        expect(typeof t.up).toBe('boolean')
      }
      const m = moshMosaicRects(c, roles, { mix: 0.62, tears: 0.55 }, 50, 240, b, bs)
      expect(m.cols2).toBe(Math.ceil(c.N / m.step))
      expect(m.rects.length).toBe(m.rows * m.cols2)
      m.rects.forEach((r, k) => {
        const i = Math.floor(k % m.cols2), j = Math.floor(k / m.cols2)
        expect(r.i0).toBe(i * m.step); expect(r.i1).toBe(Math.min(c.N, (i + 1) * m.step)); expect(r.j).toBe(j)
        expect(m.torn[k]).toBe(moshTorn(m.tears, i, j))
        const v = moshHash(wrap(i * m.step, c.N), j, bs + 43)
        const want = m.torn[k] ? (v < 0.82 ? roles.dark : moshPick(v, b, roles, 0.62)) : moshPick(v, b + j, roles, 0.62)
        expect(r.col).toBe(want)                    // torn keeps its grid, loses its colour; untorn = pick(v, b+j)
        expect(r.h).toBe(Math.ceil(240 / m.rows) + 1)
      })
      expectRowsTile(m.rects, c.N)
    }
  })
})

// ── smear ────────────────────────────────────────────────────────────────────
describe('smear', () => {
  const c = moshColumns(P(), W), roles = moshRoles(CUBE)
  const meanRun = (runs: number, seed: number) => {
    const rects = moshSmearRects(c, roles, { mix: 0.62, runs, bright: 0.3 }, 0, 400, moshBandSeed(seed, 1))
    const inner = rects.filter(r => r.i1 < c.N)   // unclipped runs only
    return inner.reduce((s, r) => s + runLen(r), 0) / inner.length
  }
  it('mean run length increases with `runs` (long = 6 + runs·46)', () => {
    for (const seed of [1, 5, 23]) {
      const m = [0, 0.25, 0.5, 0.75, 1].map(r => meanRun(r, seed))
      for (let k = 1; k < m.length; k++) expect(m[k]!).toBeGreaterThan(m[k - 1]!)
      expect(m[0]!).toBeLessThan(10); expect(m[4]!).toBeGreaterThan(30)
    }
  })
  it('rows are THIN — max(2, cw·.6) px each, more rows than confetti gets for the same band', () => {
    const bh = 300
    expect(moshSmearRows(c, bh)).toBe(Math.max(2, Math.round(bh / Math.max(2, c.cw * 0.6))))
    expect(moshSmearRows(c, bh)).toBeGreaterThan(Math.round(bh / c.cw))
    const rects = moshSmearRects(c, roles, P(), 0, bh, moshBandSeed(5, 1))
    const rows = expectRowsTile(rects, c.N)
    expect(rows.size).toBe(moshSmearRows(c, bh))
  })
  it('the run and colour rules per cell; bright cells appear with frequency ≈ bright·.35 (0 ⇒ none)', () => {
    for (const bright of [0, 0.3, 1]) {
      let forced = 0, total = 0
      for (const seed of [1, 5, 23, 77]) {
        const bs = moshBandSeed(seed, 1), long = 6 + 0.5 * 46
        for (const r of moshSmearRects(c, roles, { mix: 0.62, runs: 0.5, bright }, 0, 1500, bs)) {
          const w = wrap(r.i0, c.N)
          const run = Math.max(1, Math.round(long * (0.25 + moshHash(w, r.j * 3, bs + 47) * 1.5)))
          expect(r.i1).toBe(Math.min(c.N, r.i0 + run))
          const isBright = moshHash(w, r.j, bs + 59) < bright * 0.35
          expect(r.col).toBe(isBright ? roles.bright : moshPick(moshHash(w, r.j, bs + 53), r.j, roles, 0.62))
          if (isBright) forced++
          total++
        }
      }
      expect(Math.abs(forced / total - bright * 0.35)).toBeLessThan(0.04)
    }
  })
})

// ── scan ─────────────────────────────────────────────────────────────────────
describe('scan', () => {
  const c = moshColumns(P(), W), roles = moshRoles(CUBE)
  it('rows are full-width, row heights cw·(.4..3.6) snapped, rows tile the band top to bottom; cuts follow', () => {
    const by = 120, bh = 600, bs = moshBandSeed(5, 3)
    const rects = moshScanRects(c, roles, { mix: 0.62, bright: 0.3 }, by, bh, bs)
    const rows = rects.filter(r => r.x === 0 && r.w === W)
    const cuts = rects.filter(r => !(r.x === 0 && r.w === W))
    expect(rows.length).toBeGreaterThan(5)
    expect(rows[0]!.y).toBe(by)
    let yy = by
    rows.forEach((r, j) => {
      expect(r.j).toBe(j)
      const rh = Math.max(1, Math.round(c.cw * (0.4 + moshHash(0, j, bs + 61) * 3.2)))
      const hh = Math.min(rh, by + bh - yy)
      expect(r.y).toBe(Math.round(yy)); expect(r.h).toBe(Math.ceil(hh) + 1)
      expect(r.col).toBe(moshPick(moshHash(1, j, bs + 67), j, roles, 0.62))
      expect(rh).toBeGreaterThanOrEqual(Math.round(c.cw * 0.4)); expect(rh).toBeLessThanOrEqual(Math.round(c.cw * 3.6))
      yy += hh
    })
    expect(yy).toBeGreaterThanOrEqual(by + bh)
    for (const cut of cuts) { expect(cut.col).toBe(roles.bright); expect(rows.some(r => r.y === cut.y && r.h === cut.h)).toBe(true) }
  })
  it('bright cut frequency ≈ bright·.8 (0 ⇒ none); cut width ∈ [8%, 58%] of W unless clipped at the right edge', () => {
    for (const bright of [0, 0.3, 1]) {
      let rows = 0, cuts = 0
      for (const seed of [1, 5, 23, 77]) {
        const bs = moshBandSeed(seed, 3)
        for (const r of moshScanRects(c, roles, { mix: 0.62, bright }, 0, 6000, bs)) {
          if (r.x === 0 && r.w === W) { rows++; continue }
          cuts++
          const j = r.j
          expect(moshHash(2, j, bs + 71)).toBeLessThan(bright * 0.8)
          const w = W * (0.08 + moshHash(3, j, bs + 73) * 0.5), x0 = W * moshHash(4, j, bs + 79) * (1 - 0.08)
          expect(r.x).toBe(Math.round(x0)); expect(r.w).toBe(Math.round(Math.min(w, W - x0)))
          expect(r.w).toBeLessThanOrEqual(Math.round(0.58 * W))
          expect(r.x + r.w).toBeLessThanOrEqual(W)
          if (x0 + w <= W) expect(r.w).toBeGreaterThanOrEqual(Math.round(0.08 * W) - 1)
        }
      }
      expect(Math.abs(cuts / rows - bright * 0.8)).toBeLessThan(0.06)
    }
  })
})

// ── chevron ──────────────────────────────────────────────────────────────────
describe('chevron', () => {
  const c = moshColumns(P(), W), roles = moshRoles(CUBE)
  it('per ∈ 3..14, amp ∈ 1..8; the shift is a triangle wave of period 2·per and amplitude amp', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const b = seed % 6, bs = moshBandSeed(seed, b)
      const { per, amp } = moshChevronSpec(b, bs)
      expect(per).toBeGreaterThanOrEqual(3); expect(per).toBeLessThanOrEqual(14)
      expect(amp).toBeGreaterThanOrEqual(1); expect(amp).toBeLessThanOrEqual(8)
      const wave = Array.from({ length: per * 6 }, (_, j) => moshChevronShift(j, per, amp))
      expect(wave[0]).toBe(0); expect(wave[per]).toBe(amp)
      expect(Math.max(...wave)).toBe(amp); expect(Math.min(...wave)).toBe(0)
      for (let j = 0; j < per * 4; j++) expect(wave[j + per * 2]).toBe(wave[j])                // period 2·per
      for (let t = 0; t <= per; t++) expect(wave[per - t]).toBe(wave[per + t])                 // symmetric about the peak
      for (let j = 1; j <= per; j++) expect(wave[j]!).toBeGreaterThanOrEqual(wave[j - 1]!)     // rising leg
      for (let j = per + 1; j <= per * 2; j++) expect(wave[j]!).toBeLessThanOrEqual(wave[j - 1]!) // falling leg
    }
  })
  it('the colour of (i, j) depends only on (wrap(i)+zz(j)) mod per: rows with equal zz match; each row repeats every per columns', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const b = seed % 6, bs = moshBandSeed(seed, b)
      const { per, amp } = moshChevronSpec(b, bs)
      const bh = c.cw * (per * 4 + 2)   // enough rows for two full periods
      const rects = moshChevronRects(c, roles, 0.62, 0, bh, b, bs)
      const rows = new Map<number, string[]>()
      for (const r of rects) { const a = rows.get(r.j) ?? []; a[r.i0] = r.col; rows.set(r.j, a) }
      const row = (j: number) => rows.get(j)!
      expect(rows.size).toBe(Math.max(1, Math.round(bh / c.cw)))
      expect(row(0).length).toBe(c.N)
      expect(row(0)).toEqual(row(per * 2))                                  // equal zz ⇒ identical sequence
      for (let t = 1; t < per; t++) expect(row(per - t)).toEqual(row(per + t))
      for (let i = 0; i + per < c.N; i++) expect(row(1)[i]).toBe(row(1)[i + per])   // the motif
      // The rule itself.
      for (const r of rects) {
        const zz = moshChevronShift(r.j, per, amp)
        expect(r.col).toBe(moshPick(moshHash((wrap(r.i0, c.N) + zz) % per, 0, bs + 97), b, roles, 0.62))
        expect(r.w).toBe(Math.ceil(c.cw) + 1); expect(r.i1).toBe(r.i0 + 1)
      }
      // Rows whose shift differs by a non-multiple of per differ (it is a
      // herringbone, not stripes): row 0 (zz 0) vs the peak row (zz amp).
      if (amp % per !== 0) expect(row(0)).not.toEqual(row(per))
    }
  })
})

// ── Params / presets ─────────────────────────────────────────────────────────
describe('params and presets', () => {
  it('defaults are the source defaults with the pure cube', () => {
    expect(defaultMosh()).toEqual({ bands: 6, cols: 150, mix: 0.62, tears: 0.55, runs: 0.5, bright: 0.3, inks: CUBE })
    expect(MOSH_LIMITS.bands).toEqual([1, 8]); expect(MOSH_LIMITS.cols).toEqual([24, 300])
    expect(MOSH_KINDS).toEqual(['confetti', 'mosaic', 'smear', 'scan', 'chevron'])
  })
  it('normalizeMosh clamps and falls back per field; inks must be ≥2 hex entries (bad ones fall back per index)', () => {
    const n = normalizeMosh({ bands: 99, cols: 3, mix: 2, tears: -1, runs: 'x', bright: 0.5, inks: ['#123456', 'nope', '#ABCDEF'] })
    expect(n).toEqual({ ...defaultMosh(), bands: 8, cols: 24, mix: 1, tears: 0, bright: 0.5, inks: ['#123456', '#FFFFFF', '#ABCDEF'] })
    expect(normalizeMosh({ inks: ['#000000'] }).inks).toEqual(CUBE)
    expect(normalizeMosh(undefined)).toEqual(defaultMosh())
    expect(normalizeMosh({ bands: 4.4 }).bands).toBe(4)
    expect(normalizeMosh({ mix: 0.9 }, P({ cols: 60 }))).toEqual(P({ cols: 60, mix: 0.9 }))
  })
  it('the 5 presets carry the source cubes in order; a preset patch round-trips through moshPresetOf', () => {
    expect(MOSH_PRESET_NAMES).toEqual(['Pure cube', 'Soft cube', 'Print cube', 'Warm cube', 'Cool cube'])
    expect(MOSH_PALETTE_PRESETS['Pure cube']).toEqual(['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#00FFFF', '#FF00FF', '#FFFF00'])
    expect(MOSH_PALETTE_PRESETS['Soft cube']).toEqual(['#050505', '#F2F2F2', '#FF1E3C', '#19E65A', '#1E3CFF', '#19E6E6', '#FF19C8', '#FFE619'])
    expect(MOSH_PALETTE_PRESETS['Print cube']).toEqual(['#000000', '#E8E8E8', '#E0202A', '#00A650', '#1B4FE0', '#00C8D2', '#EC1E79', '#F5D000'])
    expect(MOSH_PALETTE_PRESETS['Warm cube']).toEqual(['#0A0A0A', '#FFFFFF', '#FF4A00', '#7CE860', '#2B4FD8', '#41C6F0', '#F03C8C', '#F0D82C'])
    expect(MOSH_PALETTE_PRESETS['Cool cube']).toEqual(['#101010', '#FAFAF5', '#D6006E', '#12B074', '#3B4FE0', '#00E0E0', '#FF6B00', '#EFEF20'])
    for (const name of MOSH_PRESET_NAMES) {
      expect(MOSH_PALETTE_PRESETS[name].length).toBe(8)
      expect(moshPresetOf(normalizeMosh(moshPresetPatch(name)))).toBe(name)
    }
    expect(moshPresetOf(defaultMosh())).toBe('Pure cube')
    expect(moshPresetOf(P({ inks: [...CUBE.slice(0, 7), '#123456'] }))).toBe(null)
  })
})

// ── Headless render ──────────────────────────────────────────────────────────
type Rect = { x: number; y: number; w: number; h: number; style: unknown }
/** A ctx that records fillRect and REPORTS any other state write — Mosh may touch
 *  nothing but fillStyle (the layer's alpha and blend are already on the ctx). */
function recorder() {
  const rects: Rect[] = [], foreign: string[] = []
  const target: Record<string, unknown> = {
    fillStyle: '', globalAlpha: 0.5, globalCompositeOperation: 'multiply', strokeStyle: '', lineWidth: 1,
    fillRect(x: number, y: number, w: number, h: number) { rects.push({ x, y, w, h, style: target.fillStyle }) },
    stroke() { foreign.push('stroke()') }, fill() { foreign.push('fill()') }, beginPath() { foreign.push('beginPath()') },
    drawImage() { foreign.push('drawImage()') }, clearRect() { foreign.push('clearRect()') },
  }
  const ctx = new Proxy(target, {
    set(t, k, v) { if (k !== 'fillStyle') foreign.push(`set ${String(k)}`); t[k as string] = v; return true },
  })
  return { ctx: ctx as unknown as MoshCtx, rects, foreign, raw: target }
}

describe('paintMosh (headless)', () => {
  const H = 1200
  it('ONLY fillStyle + fillRect: no alpha / composite / stroke writes; one fillRect per rect in band order; no background', () => {
    for (const seed of [5, 23, 101]) {
      const rec = recorder()
      const layout = paintMosh(rec.ctx, P(), CUBE, W, H, seed)
      expect(rec.foreign).toEqual([])
      expect(rec.raw.globalAlpha).toBe(0.5); expect(rec.raw.globalCompositeOperation).toBe('multiply')
      const all = layout.rects.flat()
      expect(rec.rects.length).toBe(all.length)
      all.forEach((r, k) => expect(rec.rects[k]).toEqual({ x: r.x, y: r.y, w: r.w, h: r.h, style: r.col }))
      expect(rec.rects[0]).not.toMatchObject({ x: 0, y: 0, w: W, h: H })     // no full-box background fill
      expect(layout.bands.length).toBe(6)
      expect(new Set(layout.bands.map(b => b.kind)).size).toBe(5)               // all five failures on 6 bands
    }
  })
  it('every rect lies within its band (allowing the oversize) and the union of a band\'s rects covers the band with no gap', () => {
    for (const seed of [5, 23]) {
      const layout = moshRects(P(), CUBE, W, H, seed)
      const cover = new Uint8Array(W * H)
      layout.bands.forEach((band, k) => {
        for (const r of layout.rects[k]!) {
          expect(r.x).toBeGreaterThanOrEqual(0); expect(r.x + r.w).toBeLessThanOrEqual(W + 2)   // chevron cells are ceil(cw)+1 wide
          expect(r.y).toBeGreaterThanOrEqual(band.y0); expect(r.y + r.h).toBeLessThanOrEqual(band.y1 + 3)
          expect(r.w).toBeGreaterThan(0); expect(r.h).toBeGreaterThan(0)
          for (let y = r.y; y < Math.min(H, r.y + r.h); y++) cover.fill(1, y * W + r.x, y * W + Math.min(W, r.x + r.w))
        }
        // Band coverage: every pixel of the band is painted by that band's own rects.
        let missing = 0
        for (let y = band.y0; y < band.y1; y++) for (let x = 0; x < W; x++) if (!cover[y * W + x]) missing++
        expect(missing).toBe(0)
        cover.fill(0)
      })
    }
  })
  it('every rect colour is one of the 8 inks; the dark ink is plentiful (dead patches); deterministic in seed', () => {
    const a = moshRects(P(), CUBE, W, H, 5)
    const rects = a.rects.flat()
    for (const r of rects) expect(CUBE).toContain(r.col)
    // By rect count (scan rows and long smears are one rect each, so this sits
    // under the 16% pick rule); by area the render probe measured ~35% dark.
    const dark = rects.filter(r => r.col === a.roles.dark).length / rects.length
    expect(dark).toBeGreaterThan(0.08)
    expect(moshRects(P(), CUBE, W, H, 5)).toEqual(a)
    expect(moshRects(P(), CUBE, W, H, 6).rects.flat().length).not.toBe(rects.length)
  })
})

// ── The deal branch routes cellFill:'mosh' to paintMosh on the REAL ctx ──────
describe('deal layer render with cellFill:mosh (headless)', () => {
  const mainRects: { x: number; y: number; w: number; h: number }[] = []
  const mainDraws: number[] = []
  // Every alpha / blend write and every fillRect on the main ctx, in order: the
  // shared layer wrapper legitimately sets the LAYER's opacity + blend BEFORE the
  // content paints; Mosh itself must write none between its first and last rect.
  const mainEvents: string[] = []
  let translate: [number, number] = [0, 0]
  function recordingCtx(name: string) {
    const c: Record<string, unknown> = {
      canvas: { width: 400, height: 400 },
      globalCompositeOperation: 'screen', globalAlpha: 0.4,
      fillStyle: '', strokeStyle: '', lineWidth: 1, lineCap: '', lineJoin: '',
      getTransform: () => ({}), setTransform() {}, save() {}, restore() {},
      translate(x: number, y: number) { if (name === 'main') translate = [x, y] }, rotate() {}, scale() {}, clip() {},
      beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, roundRect() {}, ellipse() {}, rect() {}, closePath() {}, setLineDash() {},
      fill() {}, stroke() { if (name === 'main') mainEvents.push('stroke') }, clearRect() {},
      fillRect(x: number, y: number, w: number, h: number) { if (name === 'main') { mainRects.push({ x, y, w, h }); mainEvents.push('rect') } },
      putImageData() {}, createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      createRadialGradient() { return { addColorStop() {} } },
      createLinearGradient() { return { addColorStop() {} } },
      createPattern() { return {} },
      drawImage() { if (name === 'main') mainDraws.push(1) },
    }
    if (name !== 'main') return c as unknown as CanvasRenderingContext2D
    return new Proxy(c, {
      set(t, k, v) { if (k === 'globalAlpha' || k === 'globalCompositeOperation') mainEvents.push(`set ${String(k)}`); t[k as string] = v; return true },
    }) as unknown as CanvasRenderingContext2D
  }
  let seq = 0
  class FakeImageData {
    data: Uint8ClampedArray; width: number; height: number
    constructor(w: number, h: number) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(Math.max(1, w * h) * 4) }
  }
  beforeEach(() => {
    mainRects.length = 0; mainDraws.length = 0; mainEvents.length = 0; seq = 0; translate = [0, 0]
    vi.stubGlobal('ImageData', FakeImageData)
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
    grid: { ...defaultGrid(), mode: 'explicit', columns: 5, rows: 4, margin: 0, gutter: 0, gen: { ...defaultGrid().gen, seed: 9 } },
    ...over,
  })

  it('a Mosh deal paints its bands straight on the main ctx, centred, ignoring grid / density / inset (no tiles), touching no alpha / blend', async () => {
    await drawDeal(dealLayer({ cellFill: 'mosh', mosh: P() }), 400, 400)
    expect(mainDraws.length).toBe(0)                       // no per-cell tiles
    expect(translate).toEqual([-200, -200])                // box top-left at (-W/2, -H/2)
    // The layer's alpha / blend ride through untouched: no alpha / blend / stroke
    // event between Mosh's first and last rect (the wrapper's own writes precede it).
    const first = mainEvents.indexOf('rect'), last = mainEvents.lastIndexOf('rect')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(mainEvents.slice(first, last + 1).every(e => e === 'rect')).toBe(true)
    const layout = moshRects(P(), CUBE, 400, 400, 9)
    const all = layout.rects.flat()
    expect(mainRects.length).toBe(all.length)              // identical call sequence to the pure paint
    expect(mainRects).toEqual(all.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h })))
  })
  it('a Mosh deal without params uses the defaults', async () => {
    await drawDeal(dealLayer({ cellFill: 'mosh', h: 0.75 }), 400, 300)
    expect(mainDraws.length).toBe(0)
    expect(mainRects.length).toBe(moshRects(defaultMosh(), CUBE, 400, 300, 9).rects.flat().length)
  })
  it('cellFill:solid is unchanged (tiles via drawImage)', async () => {
    await drawDeal(dealLayer({ cellFill: 'solid', density: 1, cellInset: 0 }), 400, 400)
    expect(mainDraws.length).toBe(20)
    expect(mainEvents.filter(e => e === 'rect').length).toBe(0)
  })
})

// ── Agent op: dealGrid mosh ──────────────────────────────────────────────────
describe('agent dealGrid mosh', () => {
  const baseState = (): CompositorState => ({ layers: [] })

  it('creates with cellFill:mosh and mosh params merged onto the defaults', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1', mosh: { bands: 4 } } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.cellFill).toBe('mosh')
    expect(l.mosh).toEqual({ ...defaultMosh(), bands: 4 })
  })
  it('defaults: solid fill, mosh at the source defaults alongside the other fills', () => {
    const l = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1' } }) as any).template.layers[0]
    expect(l.cellFill).toBe('solid')
    expect(l.mosh).toEqual(defaultMosh())
    expect(l.parcel).toBeDefined(); expect(l.modular).toBeDefined(); expect(l.pane).toBeDefined()
  })
  it('a Mosh palettePreset sets the 8 inks (explicit mosh.inks win) and implies the Mosh fill; other presets keep their fills', () => {
    const r = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1', palettePreset: 'Print cube' } })
    const l = (r as any).template.layers[0]
    expect(l.cellFill).toBe('mosh')
    expect(l.mosh.inks).toEqual([...MOSH_PALETTE_PRESETS['Print cube']])
    const r2 = applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd2', palettePreset: 'Warm cube', mosh: { inks: ['#111111', '#EEEEEE', '#FF0000', '#00FF00', '#0000FF', '#00FFFF', '#FF00FF', '#FFFF00'] } } })
    expect((r2 as any).template.layers[0].mosh.inks[0]).toBe('#111111')
    const m = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd3', palettePreset: 'Riso' } }) as any).template.layers[0]
    expect(m.cellFill).toBe('modular')
    const p = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd4', palettePreset: 'Acid on black' } }) as any).template.layers[0]
    expect(p.cellFill).toBe('parcel')
  })
  it('reconfigure merges and clamps; an explicit cellFill:"parcel" alongside mosh keeps parcel', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd' } }) as any).template
    const r = applyCompositorCommand(s1, { op: 'dealGrid', target: 'dd', args: { mosh: { tears: 1, cols: 999, bright: 'no' } } })
    expect(r.ok).toBe(true)
    const l = (r as any).template.layers[0]
    expect(l.cellFill).toBe('mosh')
    expect(l.mosh).toEqual({ ...defaultMosh(), tears: 1, cols: 300 })
    const r2 = applyCompositorCommand((r as any).template, { op: 'dealGrid', target: 'dd', args: { palettePreset: 'Cool cube' } })
    expect((r2 as any).template.layers[0].mosh).toEqual({ ...defaultMosh(), tears: 1, cols: 300, inks: [...MOSH_PALETTE_PRESETS['Cool cube']] })
    const r3 = applyCompositorCommand((r2 as any).template, { op: 'dealGrid', target: 'dd', args: { cellFill: 'parcel', mosh: { bands: 2 } } })
    expect((r3 as any).template.layers[0].cellFill).toBe('parcel')
    expect((r3 as any).template.layers[0].mosh.bands).toBe(2)
    const r4 = applyCompositorCommand((r3 as any).template, { op: 'dealGrid', target: 'dd', args: { cellFill: 'mosh', parcel: { cells: 20 } } })
    expect((r4 as any).template.layers[0].cellFill).toBe('mosh')
    expect((r4 as any).template.layers[0].parcel.cells).toBe(20)
  })
  it('sending mosh:{} alone implies cellFill:"mosh" on create and reconfigure', () => {
    const l = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'd1', mosh: {} } }) as any).template.layers[0]
    expect(l.cellFill).toBe('mosh'); expect(l.mosh).toEqual(defaultMosh())
    const s = (applyCompositorCommand(baseState(), { op: 'dealGrid', args: { id: 'dd', cellFill: 'pane' } }) as any).template
    const r = applyCompositorCommand(s, { op: 'dealGrid', target: 'dd', args: { mosh: {} } })
    expect((r as any).template.layers[0].cellFill).toBe('mosh')
  })
})

/**
 * Strand — the port of the playgrnd "Strand" generator, the Scatter element's second
 * style. Each case below pins ONE rule of the original as it is written in the
 * captured reference (`playgrnd-strand-generator-reference.js`); the checklist at the
 * top of `app/lib/compositor/strand.ts` maps every rule to that file's line numbers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  defaultStrand, normalizeStrand, STRAND_LIMITS, STRAND_TEXTURES,
  STRAND_PALETTE_PRESETS, STRAND_PRESET_NAMES, strandPresetPatch, strandPresetOf,
  strandRoles, strandWalks, strandRodPath, strandMasks, strandPixels,
  strandGrainCellPx, paintStrand, ROD_CAP, ROD_STATIONS,
  __resetStrandSheetCache,
  type StrandParams,
} from '~/lib/compositor/strand'

const P = (over: Partial<StrandParams> = {}): StrandParams => ({ ...defaultStrand(), ...over })

// ── Params, palettes, dial ranges ────────────────────────────────────────────
describe('Strand params', () => {
  it('ships the tool\'s own defaults [ref 20-29]', () => {
    expect(defaultStrand()).toMatchObject({
      count: 8, len: 22, wander: 0.6, branch: 0.22,
      thick: 0.42, rod: 0.5, notch: 0.18, rough: 0.55,
      offset: 0.5, edge: 0.35, tex: 0.4, texKind: 'stipple', grain: 0.42,
    })
    // The first table, in role order (rule E2).
    expect(defaultStrand().inks).toEqual([...STRAND_PALETTE_PRESETS[STRAND_PRESET_NAMES[0]!].inks])
    expect(defaultStrand().inks).toHaveLength(3)
  })

  it('takes its dial ranges from the tool\'s own sliders', () => {
    expect(STRAND_LIMITS.count).toEqual([1, 40])
    expect(STRAND_LIMITS.len).toEqual([3, 90])
    for (const k of ['wander', 'branch', 'thick', 'rod', 'notch', 'rough', 'offset', 'edge', 'tex', 'grain'] as const) {
      expect(STRAND_LIMITS[k]).toEqual([0, 1])
    }
  })

  it('normalizes garbage, partials and hand-edited saves onto the base', () => {
    const d = defaultStrand()
    expect(normalizeStrand(undefined)).toEqual(d)
    expect(normalizeStrand(null)).toEqual(d)
    expect(normalizeStrand('nope')).toEqual(d)
    expect(normalizeStrand({ count: 1e9 }).count).toBe(40)
    expect(normalizeStrand({ count: -3 }).count).toBe(1)
    expect(normalizeStrand({ count: 7.6 }).count).toBe(8)         // whole chains only
    expect(normalizeStrand({ len: 1e9 }).len).toBe(90)
    expect(normalizeStrand({ len: 0 }).len).toBe(3)
    expect(normalizeStrand({ rough: 5 }).rough).toBe(1)
    expect(normalizeStrand({ rough: Number.NaN }).rough).toBe(d.rough)
    expect(normalizeStrand({ texKind: 'screen' }).texKind).toBe('screen')
    expect(normalizeStrand({ texKind: 'smudge' }).texKind).toBe(d.texKind)
    expect(normalizeStrand({ inks: ['#ff0000', 'red', 7] as unknown }).inks).toEqual(['#ff0000'])
    expect(normalizeStrand({ inks: ['nope'] as unknown }).inks).toEqual(d.inks)
  })

  it('carries the tool\'s three ink textures [ref 9]', () => {
    expect([...STRAND_TEXTURES]).toEqual(['stipple', 'drag', 'screen'])
  })

  it('names the five three-role tables in plain language [ref 11-18]', () => {
    expect(STRAND_PRESET_NAMES).toHaveLength(5)
    for (const n of STRAND_PRESET_NAMES) {
      expect(STRAND_PALETTE_PRESETS[n].inks).toHaveLength(3)
      expect(n).not.toMatch(/#/)
      expect(strandPresetOf(normalizeStrand({ ...defaultStrand(), ...strandPresetPatch(n) }))).toBe(n)
    }
  })

  it('reads the palette by role, and a short palette repeats the role before it [ref 165-168]', () => {
    expect(strandRoles(P({ inks: ['#111111', '#222222', '#333333'] })))
      .toEqual({ ground: '#111111', plate: '#222222', fill: '#333333' })
    const one = strandRoles(P({ inks: ['#111111'] }))
    expect(one).toEqual({ ground: '#111111', plate: '#111111', fill: '#111111' })
    const two = strandRoles(P({ inks: ['#111111', '#222222'] }))
    expect(two).toEqual({ ground: '#111111', plate: '#222222', fill: '#222222' })
  })
})

// ── Rule A: the walks ────────────────────────────────────────────────────────
describe('strandWalks — the chains [ref 61-111]', () => {
  it('lays `len` rods per chain when nothing branches [ref 78-86]', () => {
    const w = strandWalks(P({ count: 1, len: 12, branch: 0 }), 800, 1000, 3)
    expect(w.rods).toHaveLength(12)
    expect(strandWalks(P({ count: 5, len: 10, branch: 0 }), 800, 1000, 3).rods).toHaveLength(50)
    // The chain count is floored at one, whatever arrives.
    expect(strandWalks(P({ count: 0, len: 4, branch: 0 }), 800, 1000, 3).rods).toHaveLength(4)
  })

  it('stops at the rod ceiling however hard the dials are pushed [ref 61, 83, 86]', () => {
    expect(ROD_CAP).toBe(7000)
    const w = strandWalks(P({ count: 40, len: 90, branch: 1 }), 900, 1200, 5)
    expect(w.rods).toHaveLength(ROD_CAP)
  })

  it('never splits deeper than three arms from the trunk [ref 92-94]', () => {
    const w = strandWalks(P({ count: 12, len: 60, branch: 1 }), 900, 1200, 7)
    const depths = new Set(w.rods.map(r => r.depth))
    expect(Math.max(...depths)).toBe(3)
    expect(Math.min(...depths)).toBe(0)
  })

  it('branching off makes every rod trunk-deep; branching up makes arms [ref 92]', () => {
    const none = strandWalks(P({ count: 6, len: 30, branch: 0 }), 900, 1200, 4)
    expect(none.rods.every(r => r.depth === 0)).toBe(true)
    const some = strandWalks(P({ count: 6, len: 30, branch: 1 }), 900, 1200, 4)
    expect(some.rods.some(r => r.depth > 0)).toBe(true)
    expect(some.rods.length).toBeGreaterThan(none.rods.length)
  })

  it('strides by a rod, a cap and the notch, so the joints show [ref 73-75]', () => {
    const p = P({ count: 1, len: 6, branch: 0, wander: 0, thick: 0.42, rod: 0.5, notch: 0.18 })
    const w = strandWalks(p, 900, 1200, 11)
    const wid = 0.02 + p.thick * 0.09
    const seg = wid * (0.4 + p.rod * 2.2)
    const stride = seg + wid + p.notch * wid * 0.95
    expect(w.wide).toBeCloseTo(wid, 12)
    expect(w.rods[0]!.seg).toBeCloseTo(seg, 12)
    for (let i = 1; i < w.rods.length; i++) {
      const d = Math.hypot(w.rods[i]!.x - w.rods[i - 1]!.x, w.rods[i]!.y - w.rods[i - 1]!.y)
      expect(d).toBeCloseTo(stride, 10)
    }
  })

  it('at Notch zero the stride is exactly a rod plus its two caps — no gap left [ref 75]', () => {
    const p = P({ count: 1, len: 4, branch: 0, wander: 0, notch: 0 })
    const w = strandWalks(p, 900, 1200, 11)
    const wid = 0.02 + p.thick * 0.09
    const seg = wid * (0.4 + p.rod * 2.2)
    const d = Math.hypot(w.rods[1]!.x - w.rods[0]!.x, w.rods[1]!.y - w.rods[0]!.y)
    expect(d).toBeCloseTo(seg + wid, 10)
  })

  it('Rod length stretches the rod without touching its girth [ref 73-74]', () => {
    const thin = strandWalks(P({ rod: 0 }), 900, 1200, 2)
    const long = strandWalks(P({ rod: 1 }), 900, 1200, 2)
    expect(long.rods[0]!.seg).toBeGreaterThan(thin.rods[0]!.seg * 3)
    expect(long.wide).toBeCloseTo(thin.wide, 12)
  })

  it('quotes everything against √(box area), so a wider box spreads rather than crowds [ref 67]', () => {
    const square = strandWalks(P(), 1000, 1000, 6)
    const wide = strandWalks(P(), 2000, 500, 6)
    expect(square.fw).toBeCloseTo(1, 10)
    expect(square.fh).toBeCloseTo(1, 10)
    expect(wide.fw).toBeCloseTo(2, 10)
    expect(wide.fh).toBeCloseTo(0.5, 10)
    // Same rod dimensions in area units either way — only the paper's shape changed.
    expect(wide.wide).toBeCloseTo(square.wide, 12)
    expect(wide.rods[0]!.seg).toBeCloseTo(square.rods[0]!.seg, 12)
  })

  it('starts each chain inside a small apron around the paper [ref 80-81]', () => {
    const w = strandWalks(P({ count: 40, len: 3, branch: 0 }), 1000, 1000, 21)
    // One chain's first rod is its start; with len 3 the first of every three is one.
    const starts = w.rods.filter((_, i) => i % 3 === 0)
    for (const s of starts) {
      expect(s.x).toBeGreaterThanOrEqual(-0.12 * w.fw)
      expect(s.x).toBeLessThanOrEqual(1.12 * w.fw)
      expect(s.y).toBeGreaterThanOrEqual(-0.12 * w.fh)
      expect(s.y).toBeLessThanOrEqual(1.12 * w.fh)
    }
  })

  it('turns a chain that has left the paper back towards the middle [ref 99-104]', () => {
    // Wander off and no branching: the heading can only change where the steer acts.
    const p = P({ count: 1, len: 60, branch: 0, wander: 0 })
    const w = strandWalks(p, 1000, 1000, 3)
    const inside = (r: { x: number; y: number }) =>
      r.x >= -0.32 * w.fw && r.x <= 1.32 * w.fw && r.y >= -0.32 * w.fh && r.y <= 1.32 * w.fh
    let steered = 0
    for (let i = 1; i < w.rods.length; i++) {
      const prev = w.rods[i - 1]!, cur = w.rods[i]!
      const turn = Math.abs(cur.a - prev.a)
      if (inside({ x: prev.x + Math.cos(prev.a) * 0, y: prev.y })) { /* checked below */ }
      if (turn > 1e-12) steered++
      // Where it does turn, the turn is towards the paper's middle.
      if (turn > 1e-12) {
        const before = Math.hypot(w.fw * 0.5 - cur.x, w.fh * 0.5 - cur.y)
        const home = Math.atan2(w.fh * 0.5 - cur.y, w.fw * 0.5 - cur.x)
        const wrap = (v: number) => Math.atan2(Math.sin(v), Math.cos(v))
        expect(Math.abs(wrap(home - cur.a))).toBeLessThanOrEqual(Math.abs(wrap(home - prev.a)) + 1e-9)
        expect(before).toBeGreaterThan(0)
      }
    }
    expect(steered).toBeGreaterThan(0)
    // …and the chain is held near the paper rather than marching away for ever: a
    // straight 60-rod run would otherwise end many frames out.
    const far = Math.max(...w.rods.map(r => Math.max(Math.abs(r.x - w.fw * 0.5), Math.abs(r.y - w.fh * 0.5))))
    expect(far).toBeLessThan(2)
    // Rods keep landing on the paper late in the run, which is the whole point of
    // the steer: Length goes on meaning something past thirty.
    expect(w.rods.slice(40).some(inside)).toBe(true)
  })

  it('is deterministic in the seed, and two seeds are two pictures [ref 68]', () => {
    const a = strandWalks(P(), 900, 1200, 1)
    const b = strandWalks(P(), 900, 1200, 1)
    const c = strandWalks(P(), 900, 1200, 2)
    expect(a.rods).toEqual(b.rods)
    expect(a.rods.map(r => [r.x, r.y])).not.toEqual(c.rods.map(r => [r.x, r.y]))
  })

  it('gives every rod its own sub-seed, so no two wear the same outline [ref 88]', () => {
    const w = strandWalks(P({ count: 4, len: 20 }), 900, 1200, 8)
    const seeds = new Set(w.rods.map(r => r.sd))
    expect(seeds.size).toBeGreaterThan(w.rods.length * 0.5)
    for (const r of w.rods) {
      expect(Number.isInteger(r.sd)).toBe(true)
      expect(r.sd).toBeGreaterThanOrEqual(0)
      expect(r.sd).toBeLessThan(9973)
    }
  })

  it('Wander bends the chain; at Wander zero only the steer may turn it [ref 91, 99]', () => {
    const straight = strandWalks(P({ count: 1, len: 40, branch: 0, wander: 0 }), 1000, 1000, 15)
    let turns = 0
    for (let i = 1; i < straight.rods.length; i++) {
      const prev = straight.rods[i - 1]!, cur = straight.rods[i]!
      if (Math.abs(cur.a - prev.a) < 1e-12) continue
      turns++
      // The one thing that can change a heading here is the steer, and the steer only
      // fires on a rod laid beyond the apron.
      const out = cur.x < -0.32 * straight.fw || cur.x > 1.32 * straight.fw
        || cur.y < -0.32 * straight.fh || cur.y > 1.32 * straight.fh
      expect(out).toBe(true)
    }
    expect(turns).toBeLessThan(straight.rods.length - 1)
    const bent = strandWalks(P({ count: 1, len: 8, branch: 0, wander: 1 }), 1000, 1000, 15)
    expect(new Set(bent.rods.map(r => r.a.toFixed(9))).size).toBeGreaterThan(1)
  })
})

// ── Rule B: the rod outline ──────────────────────────────────────────────────
describe('strandRodPath — one rod\'s hand-drawn outline [ref 113-151]', () => {
  const ring = (over: Partial<{ x: number; y: number; a: number; seg: number; sd: number; wid: number; rough: number; grow: number }> = {}) => {
    const o = { x: 100, y: 60, a: 0.3, seg: 30, sd: 1234, wid: 12, rough: 0.55, grow: 0, ...over }
    return strandRodPath(o.x, o.y, o.a, o.seg, o.sd, o.wid, o.rough, o.grow)
  }

  it('closes one ring: every station down one edge, the same back up the other [ref 147-150]', () => {
    expect(ROD_STATIONS).toBe(18)
    const pts = ring()
    expect(pts).toHaveLength((ROD_STATIONS + 1) * 2)
    for (const [px, py] of pts) { expect(Number.isFinite(px)).toBe(true); expect(Number.isFinite(py)).toBe(true) }
  })

  it('adds a cap at both ends, giving a drawn length of seg + wid [ref 127, 141]', () => {
    // With Roughness off the outline is exactly the axis-aligned capsule, so its reach
    // along the axis is the rod's whole drawn length.
    const pts = ring({ a: 0, rough: 0, seg: 30, wid: 12 })
    const xs = pts.map(p => p[0])
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(30 + 12, 6)
    expect(Math.min(...xs)).toBeCloseTo(100 - 6, 6)
  })

  it('Roughness zero leaves a symmetric capsule: both edges mirror the axis [ref 120, 124, 138-140]', () => {
    const a = 0.7
    const pts = ring({ a, rough: 0 })
    const n = ROD_STATIONS + 1
    const nx = -Math.sin(a), ny = Math.cos(a)
    for (let i = 0; i < n; i++) {
      const l = pts[i]!, r = pts[pts.length - 1 - i]!         // the ring runs back up
      const midx = (l[0] + r[0]) / 2, midy = (l[1] + r[1]) / 2
      // The two edges sit the same distance either side of the same centre point.
      const dl = (l[0] - midx) * nx + (l[1] - midy) * ny
      const dr = (r[0] - midx) * nx + (r[1] - midy) * ny
      expect(dl).toBeCloseTo(-dr, 9)
      // …and that centre point is on the rod's own axis (no sideways drift).
      const across = (midx - 100) * nx + (midy - 60) * ny
      expect(across).toBeCloseTo(0, 9)
    }
  })

  it('Roughness up leaves the outline lopsided about its own tip-to-tip line [ref 124, 138-140]', () => {
    /**
     * One number for "how far from a stroke this is". Take the line joining the two
     * tips, and add up how far each edge falls on its own side of it. A stroked line —
     * one width, shared by both sides, laid on a straight centre — cancels to zero.
     * Three of the rules break that cancellation together: the two edges read separate
     * noises, every station slides sideways, and the whole rod is tilted.
     */
    const lopsidedness = (pts: [number, number][]) => {
      const n = ROD_STATIONS + 1
      const tip = (i: number): [number, number] => {
        const l = pts[i]!, r = pts[pts.length - 1 - i]!
        return [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2]
      }
      const A = tip(0), B = tip(n - 1)
      const ux = B[0] - A[0], uy = B[1] - A[1]
      const len = Math.hypot(ux, uy)
      const side = (q: [number, number]) => ((q[0] - A[0]) * uy - (q[1] - A[1]) * ux) / len
      let sum = 0
      for (let i = 0; i < n; i++) sum += side(pts[i]!) + side(pts[pts.length - 1 - i]!)
      return Math.abs(sum) / n
    }
    expect(lopsidedness(ring({ rough: 0 }))).toBeCloseTo(0, 9)
    expect(lopsidedness(ring({ rough: 1 }))).toBeGreaterThan(0.2)
    // …and the same rod at two roughnesses is not the same rod.
    expect(ring({ rough: 1 })).not.toEqual(ring({ rough: 0 }))
  })

  it('opens out at different rates at the two ends [ref 131-136]', () => {
    // Roughness up: the two end ramps are drawn from separate hashes, so the rod is
    // stubbed at one end and drawn out at the other.
    const a = 0
    const pts = ring({ a, rough: 1, sd: 77 })
    const n = ROD_STATIONS + 1
    const half = (i: number) => {
      const l = pts[i]!, r = pts[pts.length - 1 - i]!
      return Math.hypot(l[0] - r[0], l[1] - r[1]) / 2
    }
    expect(half(1)).not.toBeCloseTo(half(n - 2), 3)
  })

  it('an eroded core keeps a positive half-width instead of turning inside out [ref 128-129]', () => {
    const wid = 12
    const pts = ring({ rough: 0, wid, grow: -wid })     // eaten past its own centre
    const n = ROD_STATIONS + 1
    const mid = Math.floor(n / 2)
    const l = pts[mid]!, r = pts[pts.length - 1 - mid]!
    const width = Math.hypot(l[0] - r[0], l[1] - r[1])
    expect(width).toBeGreaterThan(0)
    expect(width).toBeCloseTo(2 * wid * 0.05, 6)
  })

  it('a grown outline is fatter than the plain one at every station [ref 129, 204]', () => {
    const plain = ring({ rough: 0 })
    const fat = ring({ rough: 0, grow: 3 })
    const n = ROD_STATIONS + 1
    for (let i = 1; i < n - 1; i++) {
      const wp = Math.hypot(plain[i]![0] - plain[plain.length - 1 - i]![0], plain[i]![1] - plain[plain.length - 1 - i]![1])
      const wf = Math.hypot(fat[i]![0] - fat[fat.length - 1 - i]![0], fat[i]![1] - fat[fat.length - 1 - i]![1])
      expect(wf).toBeGreaterThan(wp)
    }
  })

  it('two rods with different sub-seeds wear different outlines [ref 124, 131-140]', () => {
    expect(ring({ sd: 1 })).not.toEqual(ring({ sd: 2 }))
    expect(ring({ sd: 1 })).toEqual(ring({ sd: 1 }))
  })
})

// ── Rule C: the three mask passes ────────────────────────────────────────────
describe('strandMasks — plate, fill and depth [ref 191-240]', () => {
  /** Records each filled path with the colour it was filled in. */
  function pathCtx() {
    const paths: { fill: string; op: string; filter: string; pts: [number, number][] }[] = []
    const rects: number[][] = []
    let cur: [number, number][] = []
    const ctx = {
      fillStyle: '', globalCompositeOperation: 'source-over', filter: 'none',
      fillRect(x = 0, y = 0, w = 0, h = 0) { rects.push([x, y, w, h]) },
      beginPath() { cur = [] },
      moveTo(x: number, y: number) { cur.push([x, y]) },
      lineTo(x: number, y: number) { cur.push([x, y]) },
      closePath() {},
      fill() { paths.push({ fill: String(ctx.fillStyle), op: String(ctx.globalCompositeOperation), filter: String(ctx.filter), pts: cur }) },
    }
    return { ctx: ctx as never, paths, rects, raw: ctx }
  }
  const centroid = (pts: [number, number][]) => {
    let x = 0, y = 0
    for (const p of pts) { x += p[0]; y += p[1] }
    return { x: x / pts.length, y: y / pts.length }
  }

  it('lays bare ground over the whole sheet first [ref 196]', () => {
    const { ctx, rects } = pathCtx()
    strandMasks(ctx, P({ count: 1, len: 3 }), 200, 260, 1)
    expect(rects[0]).toEqual([0, 0, 200, 260])
  })

  it('is three passes, in three channels, each one path and one fill [ref 205-237]', () => {
    const { ctx, paths } = pathCtx()
    strandMasks(ctx, P({ count: 2, len: 5, tex: 0.4 }), 200, 260, 1)
    expect(paths.map(p => p.fill.toLowerCase())).toEqual(['#f00', '#0f0', '#00f'])
  })

  it('skips the depth pass when there is no ink texture to measure [ref 225]', () => {
    const { ctx, paths } = pathCtx()
    strandMasks(ctx, P({ count: 2, len: 5, tex: 0 }), 200, 260, 1)
    expect(paths.map(p => p.fill.toLowerCase())).toEqual(['#f00', '#0f0'])
  })

  it('slides the plate down and to the left, by Off-register [ref 181-183]', () => {
    const { ctx, paths } = pathCtx()
    const p = P({ count: 1, len: 4, rough: 0, offset: 1, tex: 0 })
    const mw = 200, mh = 260
    strandMasks(ctx, p, mw, mh, 1)
    const a = centroid(paths[0]!.pts), b = centroid(paths[1]!.pts)
    const off = p.offset * 0.055 * Math.sqrt(mw * mh)
    expect(a.x - b.x).toBeCloseTo(Math.cos(Math.PI * 0.75) * off, 6)
    expect(a.y - b.y).toBeCloseTo(Math.sin(Math.PI * 0.75) * off, 6)
    expect(a.x).toBeLessThan(b.x)     // left…
    expect(a.y).toBeGreaterThan(b.y)  // …and down
  })

  it('Off-register zero puts the plate exactly under the fill [ref 182-183]', () => {
    const { ctx, paths } = pathCtx()
    strandMasks(ctx, P({ count: 1, len: 4, rough: 0, offset: 0, edge: 0, tex: 0 }), 200, 260, 1)
    expect(paths[0]!.pts).toEqual(paths[1]!.pts)
  })

  it('Plate spread makes the plate fatter than the fill it sits behind [ref 184, 204]', () => {
    const { ctx, paths } = pathCtx()
    const p = P({ count: 1, len: 3, rough: 0, offset: 0, edge: 1, tex: 0 })
    strandMasks(ctx, p, 200, 260, 1)
    const span = (pts: [number, number][]) => {
      const xs = pts.map(q => q[0]), ys = pts.map(q => q[1])
      return (Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys))
    }
    expect(span(paths[0]!.pts)).toBeGreaterThan(span(paths[1]!.pts))
    const flat = pathCtx()
    strandMasks(flat.ctx, P({ ...p, edge: 0 }), 200, 260, 1)
    expect(flat.paths[0]!.pts).toEqual(flat.paths[1]!.pts)
  })

  it('eats the depth pass in from the rim and blurs it, then puts the context back [ref 226-239]', () => {
    const { ctx, paths, raw } = pathCtx()
    const p = P({ count: 1, len: 3, rough: 0, tex: 1 })
    const mw = 200, mh = 260
    strandMasks(ctx, p, mw, mh, 1)
    const depth = paths[2]!
    expect(depth.op).toBe('lighter')
    expect(depth.filter).toMatch(/^blur\(/)
    // The core really is narrower than the fill it measures — read across the first
    // rod's middle station, where the end ramps are out of the way.
    const perRod = (ROD_STATIONS + 1) * 2
    const midWidth = (pts: [number, number][]) => {
      const rod = pts.slice(0, perRod)
      const i = Math.floor((ROD_STATIONS + 1) / 2)
      const l = rod[i]!, r = rod[perRod - 1 - i]!
      return Math.hypot(l[0] - r[0], l[1] - r[1])
    }
    const eat = (0.02 + p.thick * 0.09) * Math.sqrt(mw * mh) * 0.5 * 0.38
    expect(midWidth(depth.pts)).toBeCloseTo(midWidth(paths[1]!.pts) - 2 * eat, 6)
    // The mask context is handed back the way it was found.
    expect(raw.globalCompositeOperation).toBe('source-over')
    expect(raw.filter).toBe('none')
  })

  it('two seeds draw two different sheets [ref 64, 68]', () => {
    const a = pathCtx(); strandMasks(a.ctx, P({ count: 3, len: 8 }), 200, 260, 1)
    const b = pathCtx(); strandMasks(b.ctx, P({ count: 3, len: 8 }), 200, 260, 2)
    expect(a.paths[1]!.pts).not.toEqual(b.paths[1]!.pts)
  })
})

// ── Rule D: the print ────────────────────────────────────────────────────────
describe('strandPixels — the threshold, the dropout and the three roles [ref 242-313]', () => {
  const INKS = ['#000000', '#808080', '#ffffff']       // ground / plate / fill, told apart by value

  /**
   * A mask standing in for the three passes: a plate band, a narrower fill band
   * inside it, and a depth ramp that peaks in the fill's middle.
   */
  function bandMask(mw: number, mh: number) {
    const d = new Uint8ClampedArray(mw * mh * 4)
    for (let y = 0; y < mh; y++) {
      for (let x = 0; x < mw; x++) {
        const i = (y * mw + x) * 4
        const inPlate = x >= mw * 0.2 && x < mw * 0.8
        const inFill = x >= mw * 0.3 && x < mw * 0.7
        d[i] = inPlate ? 255 : 0
        d[i + 1] = inFill ? 255 : 0
        // 0 at the fill's rim, 255 down its middle.
        const t = inFill ? 1 - Math.abs((x / mw - 0.5) / 0.2) : 0
        d[i + 2] = Math.round(255 * Math.max(0, t))
        d[i + 3] = 255
      }
    }
    return d
  }
  const role = (px: Uint8ClampedArray, i: number) => px[i]! < 64 ? 'ground' : px[i]! > 192 ? 'fill' : 'plate'
  const counts = (px: Uint8ClampedArray) => {
    const c = { ground: 0, plate: 0, fill: 0 }
    for (let i = 0; i < px.length; i += 4) c[role(px, i)]++
    return c
  }

  it('prints three roles: the fill on the plate on the ground [ref 298-301]', () => {
    const mw = 60, mh = 60, W = 120, H = 120
    const px = strandPixels(bandMask(mw, mh), mw, mh, W, H, P({ grain: 0, tex: 0, inks: INKS }), 1)
    const c = counts(px)
    expect(c.fill).toBeGreaterThan(0)
    expect(c.plate).toBeGreaterThan(0)
    expect(c.ground).toBeGreaterThan(0)
    // A row reads ground · plate · fill · plate · ground, left to right.
    const row = (y: number) => Array.from({ length: W }, (_, x) => role(px, (y * W + x) * 4))
    const r = row(60)
    expect(r[2]).toBe('ground')
    expect(r[30]).toBe('plate')
    expect(r[60]).toBe('fill')
    expect(r[W - 3]).toBe('ground')
  })

  it('every pixel is opaque — a strand sheet is a printed rectangle [ref 310]', () => {
    const mw = 20, mh = 20
    const px = strandPixels(bandMask(mw, mh), mw, mh, 40, 40, P({ inks: INKS }), 1)
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255)
  })

  it('the ink texture only ever takes fill away — it never adds any [ref 275, 296]', () => {
    const mw = 60, mh = 60, W = 120, H = 120
    const base = P({ grain: 0, tex: 0, inks: INKS })
    const clean = strandPixels(bandMask(mw, mh), mw, mh, W, H, base, 1)
    for (const texKind of STRAND_TEXTURES) {
      const worn = strandPixels(bandMask(mw, mh), mw, mh, W, H, { ...base, tex: 1, texKind }, 1)
      let lost = 0
      for (let i = 0; i < clean.length; i += 4) {
        const before = role(clean, i), after = role(worn, i)
        if (before !== 'fill') expect(after).toBe(before)     // outside the fill: untouched
        else if (after !== 'fill') lost++
      }
      expect(lost).toBeGreaterThan(0)                          // …and inside, ink does fail
    }
  })

  it('measures the dropout against the depth channel, so ink pools in the core [ref 276-279]', () => {
    const mw = 80, mh = 80, W = 160, H = 160
    const p = P({ grain: 0, tex: 0.7, texKind: 'stipple', inks: INKS })
    const px = strandPixels(bandMask(mw, mh), mw, mh, W, H, p, 5)
    const clean = strandPixels(bandMask(mw, mh), mw, mh, W, H, { ...p, tex: 0 }, 5)
    // Split the fill band into its rim and its core and count what survived in each.
    let rimKept = 0, rimAll = 0, coreKept = 0, coreAll = 0
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4
        if (role(clean, i) !== 'fill') continue
        const core = Math.abs(x / W - 0.5) < 0.06
        const rim = Math.abs(x / W - 0.5) > 0.14
        if (core) { coreAll++; if (role(px, i) === 'fill') coreKept++ }
        else if (rim) { rimAll++; if (role(px, i) === 'fill') rimKept++ }
      }
    }
    expect(coreAll).toBeGreaterThan(50)
    expect(rimAll).toBeGreaterThan(50)
    expect(coreKept / coreAll).toBeGreaterThan(rimKept / rimAll + 0.15)
  })

  it('each ink texture wears the fill in its own pattern [ref 281-292]', () => {
    const mw = 60, mh = 60, W = 120, H = 120
    const base = P({ grain: 0, tex: 0.6, inks: INKS })
    const shot = (texKind: typeof STRAND_TEXTURES[number]) =>
      Array.from(strandPixels(bandMask(mw, mh), mw, mh, W, H, { ...base, texKind }, 3)).join(',')
    expect(shot('stipple')).not.toEqual(shot('drag'))
    expect(shot('drag')).not.toEqual(shot('screen'))
    expect(shot('screen')).not.toEqual(shot('stipple'))
  })

  it('the drag\'s missing ink comes in long streaks, the stipple\'s in specks [ref 288-292]', () => {
    const mw = 100, mh = 100, W = 200, H = 200
    const solid = new Uint8ClampedArray(mw * mh * 4)
    for (let i = 0; i < solid.length; i += 4) { solid[i] = 255; solid[i + 1] = 255; solid[i + 2] = 128; solid[i + 3] = 255 }
    /** The average length of an unbroken stretch of missing ink read down a column.
     *  Column-wise because the drag's own axis sits 1.75 rad off horizontal, which
     *  leaves its streaks running very nearly straight down the picture. */
    const meanGapRun = (texKind: typeof STRAND_TEXTURES[number]) => {
      const px = strandPixels(solid, mw, mh, W, H, P({ grain: 0, tex: 0.5, texKind, inks: INKS }), 2)
      let runs = 0, total = 0, run = 0
      for (let x = 0; x < W; x++) {
        run = 0
        for (let y = 0; y < H; y++) {
          if (role(px, (y * W + x) * 4) !== 'fill') { run++; total++ }
          else if (run) { runs++; run = 0 }
        }
        if (run) runs++
      }
      return total / Math.max(1, runs)
    }
    expect(meanGapRun('drag')).toBeGreaterThan(meanGapRun('stipple') * 2)
  })

  it('Coverage zero prints a clean fill with nothing knocked out [ref 253, 275]', () => {
    const mw = 60, mh = 60, W = 120, H = 120
    const px = strandPixels(bandMask(mw, mh), mw, mh, W, H, P({ grain: 0, tex: 0, inks: INKS }), 1)
    const row = Array.from({ length: W }, (_, x) => role(px, (60 * W + x) * 4))
    const fillRun = row.slice(row.indexOf('fill'), row.lastIndexOf('fill') + 1)
    expect(fillRun.every(v => v === 'fill')).toBe(true)
  })

  it('grain jitters every pixel of all three roles, and only at the end [ref 303-306]', () => {
    const mw = 40, mh = 40, W = 80, H = 80
    const flat = P({ grain: 0, tex: 0, inks: ['#404040', '#404040', '#404040'] })
    const clean = strandPixels(bandMask(mw, mh), mw, mh, W, H, flat, 1)
    const grainy = strandPixels(bandMask(mw, mh), mw, mh, W, H, { ...flat, grain: 1 }, 1)
    const vals = new Set<number>()
    for (let i = 0; i < grainy.length; i += 4) vals.add(grainy[i]!)
    expect(vals.size).toBeGreaterThan(10)
    expect(new Set(Array.from({ length: clean.length / 4 }, (_, k) => clean[k * 4]!)).size).toBe(1)
    // The jitter is the same on all three channels — it lightens and darkens, it
    // never tints.
    for (let i = 0; i < grainy.length; i += 4) {
      expect(grainy[i]).toBe(grainy[i + 1])
      expect(grainy[i]).toBe(grainy[i + 2])
    }
  })

  it('roughens the ink edge on a lattice tied to the sheet\'s area, not to the pixel [ref 246, 250, 273]', () => {
    // The same mask rendered at two resolutions keeps the same proportions of each
    // role: one drawing at two sizes, rather than two drawings.
    const mask = (m: number) => bandMask(m, m)
    const share = (m: number, W: number) => {
      const px = strandPixels(mask(m), m, m, W, W, P({ grain: 0.42, tex: 0, inks: INKS }), 4)
      const c = counts(px)
      return c.fill / (W * W)
    }
    expect(share(50, 100)).toBeCloseTo(share(200, 400), 1)
  })

  it('two seeds are two prints [ref 244, 273]', () => {
    const mw = 40, mh = 40, W = 80, H = 80
    const a = strandPixels(bandMask(mw, mh), mw, mh, W, H, P({ inks: INKS }), 1)
    const b = strandPixels(bandMask(mw, mh), mw, mh, W, H, P({ inks: INKS }), 2)
    expect(Array.from(a).join(',')).not.toEqual(Array.from(b).join(','))
  })

  it('holds the grain lattice at 1/2400 of the box width, never finer than a device pixel', () => {
    expect(strandGrainCellPx(1, 2400)).toBeCloseTo(1, 6)
    expect(strandGrainCellPx(2, 4800)).toBeCloseTo(4, 6)
    expect(strandGrainCellPx(1, 300)).toBe(1)          // floored at one device pixel
    expect(strandGrainCellPx(Number.NaN, Number.NaN)).toBe(1)
  })

  it('survives a one-pixel sheet and a mask smaller than one cell', () => {
    expect(() => strandPixels(new Uint8ClampedArray(4), 1, 1, 1, 1, P(), 1)).not.toThrow()
    expect(() => strandPixels(new Uint8ClampedArray(16), 2, 2, 7, 3, P(), 1)).not.toThrow()
  })
})

// ── Paint, inside a Frame layer ──────────────────────────────────────────────
describe('paintStrand — how it behaves inside a Frame layer', () => {
  const made: { width: number; height: number }[] = []
  const drawn: { x: number; y: number; w: number; h: number }[] = []
  function offscreenCtx() {
    return {
      fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over', filter: 'none',
      fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {},
      save() {}, restore() {}, setTransform() {},
      createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      putImageData() {},
    }
  }
  beforeEach(() => {
    made.length = 0; drawn.length = 0
    __resetStrandSheetCache()
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
    paintStrand(ctx as never, P(), 300, 400, 1)
    expect(ctx.globalAlpha).toBe(0.4)
    expect(ctx.globalCompositeOperation).toBe('multiply')
  })

  it('draws its sheet over the whole box at the box origin (the host clips it)', () => {
    paintStrand(hostCtx() as never, P(), 300, 400, 1)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toEqual({ x: 0, y: 0, w: 300, h: 400 })
  })

  it('holds the per-pixel pass under 6 Mpx however big the box or the zoom', () => {
    paintStrand(hostCtx(8) as never, P(), 4000, 3000, 1)
    expect(made).toHaveLength(2)                       // the half-size mask, then the sheet
    const mask = made[0]!, sheet = made[1]!
    expect(sheet.width * sheet.height).toBeLessThanOrEqual(6_000_000)
    expect(sheet.width * sheet.height).toBeGreaterThan(5_000_000)
    expect(sheet.width / sheet.height).toBeCloseTo(4000 / 3000, 2)
    expect(mask.width).toBe(Math.round(sheet.width * 0.5))
    expect(mask.height).toBe(Math.round(sheet.height * 0.5))
  })

  it('re-uses the sheet when nothing about its pixels changed (a drag is a cache hit)', () => {
    paintStrand(hostCtx() as never, P({ count: 3 }), 300, 400, 71)
    const first = made.length
    paintStrand(hostCtx() as never, P({ count: 3 }), 300, 400, 71)
    expect(made.length).toBe(first)
    paintStrand(hostCtx() as never, P({ count: 3 }), 300, 400, 72)
    expect(made.length).toBeGreaterThan(first)
  })

  it('falls back to the ground colour when there is no canvas to render into', () => {
    vi.unstubAllGlobals()
    const ctx = hostCtx() as unknown as { fillStyle: string }
    paintStrand(ctx as never, P({ inks: ['#123456', '#222222', '#333333'] }), 100, 100, 1)
    expect(ctx.fillStyle).toBe('#123456')
    expect(drawn).toHaveLength(0)
  })

  it('survives a tiny box, a portrait box and a nonsense box', () => {
    for (const [w, h] of [[1, 1], [0, 0], [3, 900], [900, 3], [Number.NaN, 10]] as const) {
      expect(() => paintStrand(hostCtx() as never, P(), w as number, h as number, 1)).not.toThrow()
    }
  })

  it('paints every ink texture and both ends of Roughness without throwing', () => {
    for (const texKind of STRAND_TEXTURES) {
      for (const rough of [0, 1]) {
        expect(() => paintStrand(hostCtx() as never, P({ texKind, rough }), 200, 300, 4)).not.toThrow()
      }
    }
  })
})

// ── Translucent inks ──────────────────────────────────────────────────────────
describe('strandPixels honours each ink\'s alpha', () => {
  const flat = (mw: number, mh: number, r: number, g: number) => {
    const d = new Uint8ClampedArray(mw * mh * 4)
    for (let i = 0; i < mw * mh; i++) { d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 3] = 255 }
    return d
  }
  it('a transparent ground prints alpha 0; the opaque fill prints 255', async () => {
    const { strandPixels } = await import('~/lib/compositor/strand')
    const inks = ['#00000000', '#888888', '#ffffff'] // ground transparent, plate + fill opaque
    const groundOnly = strandPixels(flat(24, 24, 0, 0), 24, 24, 24, 24, P({ grain: 0, tex: 0, inks }), 1)
    const fillOnly = strandPixels(flat(24, 24, 0, 255), 24, 24, 24, 24, P({ grain: 0, tex: 0, inks }), 1)
    for (let q = 3; q < groundOnly.length; q += 4) expect(groundOnly[q]).toBe(0)
    for (let q = 3; q < fillOnly.length; q += 4) expect(fillOnly[q]).toBe(255)
  })
})

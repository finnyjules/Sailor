/**
 * Chaff — the port of the playgrnd "Chaff" generator (the Scatter element's first
 * style). Every test here pins a RULE of the original, read off the captured
 * reference (`playgrnd-chaff-generator-reference.js`); the rule checklist in
 * `app/lib/compositor/chaff.ts` maps each one to the reference's line numbers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  defaultChaff, normalizeChaff, CHAFF_LIMITS, CHAFF_PALETTE_PRESETS, CHAFF_PRESET_NAMES,
  chaffPresetPatch, chaffPresetOf, chaffBlades, chaffProfile, chaffBladeOutline,
  chaffMask, chaffPixels, chaffGrainCellPx, paintChaff, CHAFF_SHAPES, BLADE_STATIONS,
  type ChaffParams,
} from '~/lib/compositor/chaff'

const P = (over: Partial<ChaffParams> = {}): ChaffParams => ({ ...defaultChaff(), ...over })

// ── Defaults and normalisation ───────────────────────────────────────────────
describe('Chaff params', () => {
  it('ships the tool\'s own defaults [ref 20-28]', () => {
    const d = defaultChaff()
    expect(d).toMatchObject({
      count: 40, size: 0.5, vary: 0.55, apart: 0,
      shape: 'crescent', curve: 0.7, taper: 0.3, slim: 0.45,
      mottle: 0.62, coarse: 0.4, grain: 0.3,
    })
    // Ordered by role: entry 0 the sheet, entry 1 the mark laid on it [ref 11-18].
    expect(d.inks).toEqual([...CHAFF_PALETTE_PRESETS[CHAFF_PRESET_NAMES[0]!].inks])
    expect(d.inks).toHaveLength(2)
  })

  it('the dial ranges are the tool\'s own slider ranges', () => {
    expect(CHAFF_LIMITS.count).toEqual([4, 400])
    for (const k of ['size', 'vary', 'apart', 'curve', 'taper', 'slim', 'mottle', 'coarse', 'grain'] as const) {
      expect(CHAFF_LIMITS[k]).toEqual([0, 1])
    }
  })

  it('normalizes garbage, partials and hand-edited saves onto the base', () => {
    const d = defaultChaff()
    expect(normalizeChaff(undefined)).toEqual(d)
    expect(normalizeChaff(null)).toEqual(d)
    expect(normalizeChaff('nope')).toEqual(d)
    expect(normalizeChaff({ count: 1e9 }).count).toBe(400)
    expect(normalizeChaff({ count: -5 }).count).toBe(4)
    expect(normalizeChaff({ count: 40.6 }).count).toBe(41)     // integer dial
    expect(normalizeChaff({ mottle: 5 }).mottle).toBe(1)
    expect(normalizeChaff({ mottle: Number.NaN }).mottle).toBe(d.mottle)
    expect(normalizeChaff({ shape: 'bar' }).shape).toBe('bar')
    expect(normalizeChaff({ shape: 'wobble' }).shape).toBe(d.shape)
    // Only real hexes survive; an empty result falls back to the base's inks.
    expect(normalizeChaff({ inks: ['#ff0000', 'red', 5] as unknown }).inks).toEqual(['#ff0000'])
    expect(normalizeChaff({ inks: ['nope'] as unknown }).inks).toEqual(d.inks)
  })

  it('the five palettes are the tool\'s tables, named in plain language', () => {
    expect(CHAFF_PRESET_NAMES).toHaveLength(5)
    for (const n of CHAFF_PRESET_NAMES) {
      expect(CHAFF_PALETTE_PRESETS[n].inks).toHaveLength(2)
      expect(n).not.toMatch(/#/)
      // A preset applies, then reads back as itself.
      expect(chaffPresetOf(P(chaffPresetPatch(n)))).toBe(n)
    }
    expect(chaffPresetOf(P({ inks: ['#000000', '#ffffff'] }))).toBeNull()
  })
})

// ── Rule A: the blades ───────────────────────────────────────────────────────
describe('chaffBlades', () => {
  it('throws `count` blades, capped and floored [ref 69]', () => {
    expect(chaffBlades(P({ count: 4 }), 400, 400, 1)).toHaveLength(4)
    expect(chaffBlades(P({ count: 400 }), 400, 400, 1)).toHaveLength(400)
    // A raw, hand-edited count is clamped by the dial's own floor/ceiling.
    expect(chaffBlades(P({ count: 1 }), 400, 400, 1)).toHaveLength(4)
    expect(chaffBlades(P({ count: 99999 }), 400, 400, 1)).toHaveLength(400)
  })

  it('is deterministic in the seed, and two seeds are two pictures [ref 67]', () => {
    const a = chaffBlades(P(), 400, 500, 7)
    expect(JSON.stringify(a)).toBe(JSON.stringify(chaffBlades(P(), 400, 500, 7)))
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(chaffBlades(P(), 400, 500, 8)))
  })

  it('sorts by descending length, so later blades lie on top of longer ones [ref 87]', () => {
    const bs = chaffBlades(P({ count: 60 }), 400, 500, 3)
    for (let i = 1; i < bs.length; i++) expect(bs[i]!.L).toBeLessThanOrEqual(bs[i - 1]!.L)
  })

  it('squares the size roll: a low bulk with a long tail above it [ref 72-75]', () => {
    const bs = chaffBlades(P({ count: 400, vary: 1 }), 400, 400, 11)
    const Ls = bs.map(b => b.L)
    const median = Ls[Math.floor(Ls.length / 2)]!        // the list is sorted descending
    const lo = Math.min(...Ls), hi = Math.max(...Ls)
    // A squared roll has a long tail: the longest runs well past the pack's middle…
    expect(hi / median).toBeGreaterThan(2)
    // …and the pack sits LOW in its own range. Because P(k ≤ x) = √x, the median lands
    // about 25 % up the range where a linear roll would leave it at 50 %. That gap IS
    // the rule: it keeps the lengths continuous instead of splitting them into groups.
    expect((median - lo) / (hi - lo)).toBeLessThan(0.35)
    expect((median - lo) / (hi - lo)).toBeGreaterThan(0.1)
  })

  it('never lets a blade collapse: L is floored at 0.12 of the base [ref 80]', () => {
    // vary 1 would otherwise push k to 1 - 0.5 = 0.5 … and below at the bottom of the roll.
    const bs = chaffBlades(P({ count: 400, vary: 1, size: 0 }), 400, 400, 5)
    const base = 0.06                                     // size 0 ⇒ base = 0.06 + 0·0.38
    for (const b of bs) expect(b.L).toBeGreaterThanOrEqual(base * 0.12 - 1e-9)
  })

  it('vary 0 makes every blade the same size [ref 74]', () => {
    const bs = chaffBlades(P({ count: 30, vary: 0 }), 400, 400, 2)
    for (const b of bs) expect(b.L).toBeCloseTo(bs[0]!.L, 10)
  })

  it('places spots across a quarter-frame apron, so the frame edge cuts blades [ref 77-78]', () => {
    const bs = chaffBlades(P({ count: 400 }), 400, 400, 9)
    const fw = 1, fh = 1                                  // a square box: fw = fh = 1
    expect(bs.some(b => b.x < 0 || b.y < 0)).toBe(true)
    expect(bs.some(b => b.x > fw || b.y > fh)).toBe(true)
    for (const b of bs) {
      expect(b.x).toBeGreaterThanOrEqual(-0.25 * fw)
      expect(b.x).toBeLessThanOrEqual(1.25 * fw)
      expect(b.y).toBeGreaterThanOrEqual(-0.25 * fh)
      expect(b.y).toBeLessThanOrEqual(1.25 * fh)
    }
  })

  it('quotes lengths against √(box area), so a wider box spreads rather than crowds [ref 55-58, 66]', () => {
    // Same area, two shapes. Blade LENGTHS in pixels (L · √(boxW·boxH)) must match.
    const wide = chaffBlades(P(), 800, 200, 4)
    const tall = chaffBlades(P(), 200, 800, 4)
    const U = Math.sqrt(800 * 200)
    for (let i = 0; i < wide.length; i++) {
      expect(wide[i]!.L * U).toBeCloseTo(tall[i]!.L * U, 9)
    }
    // …but the SPOTS follow the box: x spans 1/√aspect, y spans √aspect [ref 66, 77-78].
    expect(Math.max(...wide.map(b => b.x))).toBeGreaterThan(Math.max(...tall.map(b => b.x)))
    expect(Math.max(...wide.map(b => b.y))).toBeLessThan(Math.max(...tall.map(b => b.y)))
  })

  it('draws a per-blade heading, turn direction and wobble sub-seed [ref 79-82]', () => {
    const bs = chaffBlades(P({ count: 200 }), 400, 400, 6)
    expect(bs.some(b => b.turn === 1)).toBe(true)
    expect(bs.some(b => b.turn === -1)).toBe(true)
    for (const b of bs) {
      expect(b.a).toBeGreaterThanOrEqual(0)
      expect(b.a).toBeLessThanOrEqual(Math.PI * 2)
      expect(Number.isInteger(b.sd)).toBe(true)
    }
    expect(new Set(bs.map(b => b.sd)).size).toBeGreaterThan(50)   // not one shared wobble
  })
})

// ── Rule B: the width profile ────────────────────────────────────────────────
describe('chaffProfile — one blade\'s width profile [ref 92-106]', () => {
  it('offers exactly the tool\'s three shapes', () => {
    expect([...CHAFF_SHAPES]).toEqual(['crescent', 'leaf', 'bar'])
  })

  it('crescent is a spindle: fattest dead centre, nothing at either tip [ref 105]', () => {
    expect(chaffProfile(0, 'crescent', 0.3)).toBeCloseTo(0, 6)
    expect(chaffProfile(1, 'crescent', 0.3)).toBeCloseTo(0, 6)
    expect(chaffProfile(0.5, 'crescent', 0.3)).toBeCloseTo(1, 6)
    // Symmetric about the middle.
    expect(chaffProfile(0.25, 'crescent', 0.3)).toBeCloseTo(chaffProfile(0.75, 'crescent', 0.3), 10)
  })

  it('leaf reaches full width almost at once, then falls away to a tip [ref 100-104]', () => {
    const leaf = (t: number) => chaffProfile(t, 'leaf', 0.3)
    expect(leaf(0)).toBeCloseTo(0, 6)
    expect(leaf(1)).toBeCloseTo(0, 6)
    // The head ramp is very short: full width inside the first few percent of the run…
    expect(leaf(0.08)).toBeGreaterThan(0.8)
    // …and the fat part sits before the middle, unlike the crescent's dead centre.
    let peak = 0, at = 0
    for (let t = 0; t <= 1; t += 0.001) { const v = leaf(t); if (v > peak) { peak = v; at = t } }
    expect(at).toBeLessThan(0.4)
  })

  it('bar is flat-topped: one width held across the middle of the run [ref 95-99]', () => {
    const bar = (t: number) => chaffProfile(t, 'bar', 0.3)
    expect(bar(0)).toBeCloseTo(0, 6)
    expect(bar(1)).toBeCloseTo(0, 6)
    for (let t = 0.3; t <= 0.7; t += 0.05) expect(bar(t)).toBeCloseTo(1, 9)
  })

  it('taper sharpens the crescent and blunts the bar\'s ends [ref 95, 105]', () => {
    // Crescent: a higher exponent pulls the shoulders in.
    expect(chaffProfile(0.25, 'crescent', 1)).toBeLessThan(chaffProfile(0.25, 'crescent', 0))
    expect(chaffProfile(0.5, 'crescent', 1)).toBeCloseTo(chaffProfile(0.5, 'crescent', 0), 9)
    // Bar: taper lengthens the end ramps, so a point near an end comes out thinner.
    expect(chaffProfile(0.03, 'bar', 1)).toBeLessThan(chaffProfile(0.03, 'bar', 0))
  })

  it('never returns a negative width for any shape, taper or t', () => {
    for (const s of CHAFF_SHAPES) {
      for (let tp = 0; tp <= 1; tp += 0.25) {
        for (let t = 0; t <= 1; t += 0.02) {
          const v = chaffProfile(t, s, tp)
          expect(v).toBeGreaterThanOrEqual(0)
          expect(Number.isFinite(v)).toBe(true)
        }
      }
    }
  })
})

// ── Rule C: the centre line and the two edges ────────────────────────────────
describe('chaffBladeOutline — the arc and its edges [ref 113-147]', () => {
  const blade = (over: Record<string, number> = {}) =>
    ({ x: 0.5, y: 0.5, a: 0, L: 0.3, turn: 1 as const, sd: 17, ...over })

  it('is one closed ring: every station down one edge, the same stations back up the other [ref 143-146]', () => {
    // A straight blade heading along +x, so the normal is (0, 1) and the two edges of
    // a station share an x — which makes the pairing checkable exactly.
    const pts = chaffBladeOutline(blade(), P({ curve: 0 }), 400, 400)
    const n = BLADE_STATIONS + 1
    expect(pts.length).toBe(2 * n)
    const down = pts.slice(0, n), back = pts.slice(n)
    for (let i = 0; i < n; i++) {
      const l = down[i]!, r = back[n - 1 - i]!
      expect(l[0]).toBeCloseTo(r[0], 9)                  // the same station…
      const mid = (l[1] + r[1]) / 2
      expect(l[1] - mid).toBeCloseTo(-(r[1] - mid), 9)   // …stepped off both ways from it
    }
    // The second half is that walk REVERSED: it starts at the tail and ends at the head.
    expect(back[0]![0]).toBeCloseTo(down[n - 1]![0], 9)
    expect(back[n - 1]![0]).toBeCloseTo(down[0]![0], 9)
    expect(down[n - 1]![0]).toBeGreaterThan(down[0]![0])
    expect(back[n - 1]![0]).toBeLessThan(back[0]![0])
  })

  it('curve 0 walks a straight centre line; curve up bends it into an arc [ref 108-112]', () => {
    const straight = chaffBladeOutline(blade(), P({ curve: 0, slim: 0 }), 400, 400)
    // slim 0 still leaves 10% width, so take the ring's mid-line: point i and its mirror.
    const n = straight.length / 2
    const mid = (pts: [number, number][], i: number): [number, number] => {
      const l = pts[i]!, r = pts[straight.length - 1 - i]!
      return [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2]
    }
    // A straight blade's centre stations are collinear: cross product ≈ 0.
    const a = mid(straight, 0), b = mid(straight, n - 1), c = mid(straight, Math.floor(n / 2))
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    expect(Math.abs(cross)).toBeLessThan(1e-6)
    // With curve up, the same stations bow off that line.
    const bent = chaffBladeOutline(blade(), P({ curve: 1, slim: 0 }), 400, 400)
    const a2 = mid(bent, 0), b2 = mid(bent, n - 1), c2 = mid(bent, Math.floor(n / 2))
    const cross2 = (b2[0] - a2[0]) * (c2[1] - a2[1]) - (b2[1] - a2[1]) * (c2[0] - a2[0])
    expect(Math.abs(cross2)).toBeGreaterThan(100)
  })

  it('sets the spine\'s mean on the spot, so Curve bends without relocating [ref 128-130]', () => {
    const spotOf = (curve: number) => {
      const pts = chaffBladeOutline(blade(), P({ curve, slim: 0.4 }), 400, 400)
      const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length
      const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length
      return [cx, cy]
    }
    const [x0, y0] = spotOf(0), [x1, y1] = spotOf(1)
    // The blade's spot is (0.5, 0.5) of a square box = (200, 200) px; a straight and a
    // strongly-curved blade both sit there (within a fraction of the blade's length).
    const L = 0.3 * 400
    expect(Math.hypot(x0! - 200, y0! - 200)).toBeLessThan(L * 0.2)
    expect(Math.hypot(x1! - x0!, y1! - y0!)).toBeLessThan(L * 0.25)
  })

  it('turn decides which way the arc sweeps [ref 116]', () => {
    const l = chaffBladeOutline(blade({ turn: -1 }), P({ curve: 1 }), 400, 400)
    const r = chaffBladeOutline(blade({ turn: 1 }), P({ curve: 1 }), 400, 400)
    expect(JSON.stringify(l)).not.toBe(JSON.stringify(r))
  })

  it('Width (slim) scales the blade\'s girth, not its length [ref 117]', () => {
    const spanOf = (pts: [number, number][], axis: 0 | 1) =>
      Math.max(...pts.map(p => p[axis])) - Math.min(...pts.map(p => p[axis]))
    // A straight blade heading along +x: x span is its length, y span its width.
    const thin = chaffBladeOutline(blade(), P({ slim: 0, curve: 0 }), 400, 400)
    const fat = chaffBladeOutline(blade(), P({ slim: 1, curve: 0 }), 400, 400)
    expect(spanOf(fat, 1)).toBeGreaterThan(spanOf(thin, 1) * 3)
    expect(spanOf(fat, 0)).toBeCloseTo(spanOf(thin, 0), 5)
  })

  it('reads its wobble from the blade\'s sub-seed, so outlines are not one template [ref 136-137]', () => {
    const a = chaffBladeOutline(blade({ sd: 1 }), P(), 400, 400)
    const b = chaffBladeOutline(blade({ sd: 2 }), P(), 400, 400)
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('scales with √(box area), not with either side alone [ref 117]', () => {
    const spanOf = (pts: [number, number][]) =>
      Math.max(...pts.map(p => p[0])) - Math.min(...pts.map(p => p[0]))
    const wide = chaffBladeOutline(blade(), P({ curve: 0 }), 800, 200)
    const tall = chaffBladeOutline(blade(), P({ curve: 0 }), 200, 800)
    expect(spanOf(wide)).toBeCloseTo(spanOf(tall), 6)
  })
})

// ── Rule D: the mask ─────────────────────────────────────────────────────────
describe('chaffMask — the half-size silhouette sheet [ref 149-215]', () => {
  function recordingCtx() {
    const calls: { fills: string[]; rects: number[][]; paths: number; fillCount: number } =
      { fills: [], rects: [], paths: 0, fillCount: 0 }
    const ctx = {
      fillStyle: '',
      fillRect(x = 0, y = 0, w = 0, h = 0) { calls.rects.push([x, y, w, h]) },
      beginPath() { calls.paths++ },
      moveTo() {}, lineTo() {}, closePath() {},
      fill() { calls.fillCount++; calls.fills.push(String(ctx.fillStyle)) },
      save() {}, restore() {}, setTransform() {},
    }
    return { ctx: ctx as never, calls }
  }

  /** Same stub, but keeping the POINTS of each path so an outline can be compared. */
  function pathRecordingCtx() {
    const paths: { fill: string; pts: [number, number][] }[] = []
    let cur: [number, number][] = []
    const ctx = {
      fillStyle: '',
      fillRect() {},
      beginPath() { cur = [] },
      moveTo(x: number, y: number) { cur.push([x, y]) },
      lineTo(x: number, y: number) { cur.push([x, y]) },
      closePath() {},
      fill() { paths.push({ fill: String(ctx.fillStyle), pts: cur }) },
    }
    return { ctx: ctx as never, paths }
  }

  it('starts from bare ground over the whole sheet [ref 184]', () => {
    const { ctx, calls } = recordingCtx()
    chaffMask(ctx, P({ count: 4 }), 100, 120, 1)
    expect(calls.rects[0]).toEqual([0, 0, 100, 120])
  })

  it('apart 0 collapses the whole throw into a single path and a single fill [ref 208-215]', () => {
    const { ctx, calls } = recordingCtx()
    chaffMask(ctx, P({ count: 40, apart: 0 }), 100, 100, 1)
    expect(calls.fillCount).toBe(1)
  })

  it('apart up erases before it prints: an enlarged copy, then the blade [ref 196-207]', () => {
    const { ctx, calls } = recordingCtx()
    chaffMask(ctx, P({ count: 6, apart: 1 }), 100, 100, 1)
    expect(calls.fillCount).toBe(12)                       // 2 per blade
    // …alternating ground, ink, ground, ink — the erase, then the blade inside it.
    for (let i = 0; i < 12; i += 2) expect(calls.fills[i]).not.toBe(calls.fills[i + 1])
    expect(new Set(calls.fills).size).toBe(2)
  })

  it('the erased copy runs both longer and wider than the blade printed in it [ref 197, 201-205]', () => {
    // pad = 1 + apart·0.5 multiplies the length and the width alike.
    const b = { x: 0.5, y: 0.5, a: 0, L: 0.3, turn: 1 as const, sd: 5 }
    const plain = chaffBladeOutline(b, P({ curve: 0 }), 400, 400)
    const pad = chaffBladeOutline(b, P({ curve: 0 }), 400, 400, { pad: 1.5 })
    const span = (pts: [number, number][], axis: 0 | 1) =>
      Math.max(...pts.map(p => p[axis])) - Math.min(...pts.map(p => p[axis]))
    expect(span(pad, 0)).toBeGreaterThan(span(plain, 0) * 1.4)
    expect(span(pad, 1)).toBeGreaterThan(span(plain, 1) * 1.4)
  })

  it('lets the knockout width run past 0.52·L — the source clamps nothing [ref 117, 201]', () => {
    // The source hands `slim·pad` straight into `wide = L·(0.10 + slim·0.42)`. A
    // `min(1, slim·pad)` in that expression would cap the cleared copy at L·0.52 and
    // rob Separation of most of its margin at a high Width; at Width 1 / Separation 1
    // the real rule gives L·(0.10 + 1.5·0.42) = L·0.73, before the ±17 % wobble.
    const b = { x: 0.5, y: 0.5, a: 0, L: 0.3, turn: 1 as const, sd: 5 }
    const pad = 1 + 1 * 0.5
    const pts = chaffBladeOutline(b, P({ slim: 1, curve: 0, taper: 0 }), 400, 400, { pad })
    const n = BLADE_STATIONS + 1
    let widest = 0
    for (let i = 0; i < n; i++) {
      const l = pts[i]!, r = pts[pts.length - 1 - i]!
      widest = Math.max(widest, Math.hypot(l[0] - r[0], l[1] - r[1]))
    }
    const L = b.L * pad * Math.sqrt(400 * 400)
    expect(widest).toBeGreaterThan(L * (0.10 + 0.42))            // the clamped ceiling
    const unclamped = L * (0.10 + pad * 0.42)
    expect(widest).toBeGreaterThan(unclamped * 0.82)             // …and inside the
    expect(widest).toBeLessThan(unclamped * 1.18)                // wobble band around it
  })

  it('pins the knockout pad at 1 + apart·0.5 [ref 197, 201-205]', () => {
    const { ctx, paths } = pathRecordingCtx()
    const p = P({ count: 4, apart: 1 })
    chaffMask(ctx, p, 100, 120, 3)
    const blades = chaffBlades(p, 100, 120, 3)
    // The first blade's two fills, exactly: what it clears is the pad-1.5 outline and
    // the print inside it is the unpadded one. Move the 0.5 and this fails.
    expect(paths[0]!.pts).toEqual(chaffBladeOutline(blades[0]!, p, 100, 120, { pad: 1.5 }))
    expect(paths[1]!.pts).toEqual(chaffBladeOutline(blades[0]!, p, 100, 120))
    expect(paths[0]!.fill).not.toBe(paths[1]!.fill)
  })

  it('a nothing-ish separation stays on the cheap single-path branch [ref 196]', () => {
    const { ctx, calls } = recordingCtx()
    chaffMask(ctx, P({ count: 6, apart: 0.004 }), 100, 100, 1)
    expect(calls.fillCount).toBe(1)
  })
})

// ── Rule E: the print (mottle, threshold, grain) ─────────────────────────────
describe('chaffPixels — the two-scale mottle and the threshold [ref 217-261]', () => {
  /** An RGBA mask of `mw × mh` whose GREEN channel is `cov(x, y)` in 0..255. */
  const maskOf = (mw: number, mh: number, cov: (x: number, y: number) => number) => {
    const d = new Uint8ClampedArray(mw * mh * 4)
    for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) { d[(y * mw + x) * 4 + 1] = cov(x, y); d[(y * mw + x) * 4 + 3] = 255 }
    return d
  }
  const rgbAt = (px: Uint8ClampedArray, w: number, x: number, y: number) => {
    const i = (y * w + x) * 4
    return [px[i], px[i + 1], px[i + 2], px[i + 3]]
  }
  const GROUND = [1, 2, 3] as const
  const INK = [250, 251, 252] as const
  const inks = ['#010203', '#fafbfc']

  it('mottle 0 is a clean threshold: inside a blade is ink, outside is ground [ref 249]', () => {
    const w = 32, h = 32
    const mask = maskOf(16, 16, x => (x < 8 ? 255 : 0))
    const px = chaffPixels(mask, 16, 16, w, h, P({ mottle: 0, grain: 0, inks }), 1)
    expect(rgbAt(px, w, 2, 5).slice(0, 3)).toEqual([...INK])
    expect(rgbAt(px, w, 29, 5).slice(0, 3)).toEqual([...GROUND])
    expect(rgbAt(px, w, 2, 5)[3]).toBe(255)               // always opaque [ref 258]
  })

  it('mottle 1 leaves the 0..1 band both ways: specks of each ink in the other [ref 224-231, 249]', () => {
    const w = 96, h = 96
    const solid = chaffPixels(maskOf(48, 48, () => 255), 48, 48, w, h, P({ mottle: 1, grain: 0, inks }), 3)
    const empty = chaffPixels(maskOf(48, 48, () => 0), 48, 48, w, h, P({ mottle: 1, grain: 0, inks }), 3)
    const countGround = (px: Uint8ClampedArray) => {
      let n = 0
      for (let i = 0; i < w * h; i++) if (px[i * 4] === GROUND[0]) n++
      return n
    }
    expect(countGround(solid)).toBeGreaterThan(0)          // dark specks inside the ink
    expect(countGround(solid)).toBeLessThan(w * h)         // …but it is still mostly ink
    expect(countGround(empty)).toBeLessThan(w * h)         // ink specks on empty ground
    expect(countGround(empty)).toBeGreaterThan(0)
    // With the dial at 0 that same area prints as one colour: the overshoot is the cause.
    const flat = chaffPixels(maskOf(48, 48, () => 255), 48, 48, w, h, P({ mottle: 0, grain: 0, inks }), 3)
    expect(countGround(flat)).toBe(0)
  })

  it('mottle rides on two scales, the coarse one 7.5× the fine [ref 224-225]', () => {
    // Coarseness widens BOTH lattices, so the flecks come in bigger clumps: count the
    // colour flips along one row through open ground. (At a realistic print size —
    // the tool's own export is 2400px — the fine lattice is a few pixels across; at a
    // toy 100px it would fall under one pixel and both settings would be white noise.)
    const w = 600, h = 600
    const flipsAt = (coarse: number) => {
      const px = chaffPixels(maskOf(300, 300, () => 0), 300, 300, w, h, P({ mottle: 1, coarse, grain: 0, inks }), 4)
      let flips = 0
      const row = 300
      for (let x = 1; x < w; x++) if (px[(row * w + x) * 4] !== px[(row * w + x - 1) * 4]) flips++
      return flips
    }
    expect(flipsAt(1)).toBeLessThan(flipsAt(0) / 2)        // coarser ⇒ far bigger clumps
  })

  it('holds one layout at any resolution — fleck size follows the sheet\'s area [ref 221-224]', () => {
    const cov = (mw: number) => maskOf(mw, mw, (x, y) => ((x / mw) < 0.5 && (y / mw) < 0.5 ? 255 : 0))
    const small = chaffPixels(cov(100), 100, 100, 200, 200, P({ mottle: 1, grain: 0, inks }), 8)
    const big = chaffPixels(cov(300), 300, 300, 600, 600, P({ mottle: 1, grain: 0, inks }), 8)
    // Sample the SAME spot in both — pixel (3i, 3j) of the big render is pixel (i, j)
    // of the small one — and they must agree almost everywhere.
    let same = 0, n = 0
    for (let i = 1; i < 200; i++) for (let j = 1; j < 200; j++) {
      if (rgbAt(small, 200, i, j)[0] === rgbAt(big, 600, i * 3, j * 3)[0]) same++
      n++
    }
    expect(same / n).toBeGreaterThan(0.97)
  })

  it('grain adds a per-pixel jitter on top of the two inks, and only then [ref 250-254]', () => {
    const w = 40, h = 40
    const mask = maskOf(20, 20, () => 255)
    const none = chaffPixels(mask, 20, 20, w, h, P({ mottle: 0, grain: 0, inks }), 2)
    const some = chaffPixels(mask, 20, 20, w, h, P({ mottle: 0, grain: 1, inks }), 2)
    const distinct = (px: Uint8ClampedArray) => new Set(Array.from({ length: w * h }, (_, i) => px[i * 4])).size
    expect(distinct(none)).toBe(1)
    expect(distinct(some)).toBeGreaterThan(10)
    // …and it stays inside the byte range (the source clamps).
    for (let i = 0; i < w * h; i++) { expect(some[i * 4]).toBeGreaterThanOrEqual(0); expect(some[i * 4]).toBeLessThanOrEqual(255) }
  })

  it('two seeds are two prints [ref 219, 247-248]', () => {
    const mask = maskOf(20, 20, () => 128)
    const a = chaffPixels(mask, 20, 20, 40, 40, P({ inks }), 1)
    const b = chaffPixels(mask, 20, 20, 40, 40, P({ inks }), 2)
    expect(Array.from(a).join()).not.toBe(Array.from(b).join())
  })

  it('reads the palette by role: entry 0 the sheet, entry 1 the mark on it [ref 162-163]', () => {
    const px = chaffPixels(maskOf(4, 4, x => (x < 2 ? 255 : 0)), 4, 4, 8, 8, P({ mottle: 0, grain: 0, inks: ['#010203', '#fafbfc'] }), 1)
    expect(rgbAt(px, 8, 1, 1).slice(0, 3)).toEqual([...INK])
    expect(rgbAt(px, 8, 7, 1).slice(0, 3)).toEqual([...GROUND])
    // With only one entry, both roles resolve to it and the sheet prints flat [ref 163].
    const one = chaffPixels(maskOf(4, 4, () => 255), 4, 4, 8, 8, P({ mottle: 0, grain: 0, inks: ['#010203'] }), 1)
    expect(rgbAt(one, 8, 1, 1).slice(0, 3)).toEqual([...GROUND])
  })

  it('holds the grain lattice at 1/2400 of the box width, never finer than a device pixel', () => {
    expect(chaffGrainCellPx(1, 2400)).toBeCloseTo(1)
    expect(chaffGrainCellPx(2, 2400)).toBeCloseTo(2)       // a 2× device scale ⇒ a 2px tooth
    expect(chaffGrainCellPx(1, 4800)).toBeCloseTo(2)
    expect(chaffGrainCellPx(1, 300)).toBe(1)               // floored: never sub-pixel
    expect(chaffGrainCellPx(0, 0)).toBe(1)
  })

  it('a coarser grain tooth means fewer distinct grain values across the same pixels', () => {
    const w = 60, h = 60
    const mask = maskOf(30, 30, () => 255)
    const fine = chaffPixels(mask, 30, 30, w, h, P({ mottle: 0, grain: 1, inks }), 1, 1)
    const chunky = chaffPixels(mask, 30, 30, w, h, P({ mottle: 0, grain: 1, inks }), 1, 6)
    let fineFlips = 0, chunkyFlips = 0
    for (let i = 1; i < w * h; i++) {
      if (fine[i * 4] !== fine[(i - 1) * 4]) fineFlips++
      if (chunky[i * 4] !== chunky[(i - 1) * 4]) chunkyFlips++
    }
    expect(chunkyFlips).toBeLessThan(fineFlips / 2)
  })
})

// ── Host integration ─────────────────────────────────────────────────────────
describe('paintChaff — how it behaves inside a Frame layer', () => {
  const made: { w: number; h: number }[] = []
  const drawn: { x: number; y: number; w: number; h: number }[] = []
  function offscreenCtx() {
    return {
      fillStyle: '', globalAlpha: 1, globalCompositeOperation: 'source-over',
      fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {},
      save() {}, restore() {}, setTransform() {},
      createImageData(w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      getImageData(_x = 0, _y = 0, w = 1, h = 1) { return { data: new Uint8ClampedArray(Math.max(1, w * h) * 4), width: w, height: h } },
      putImageData() {},
    }
  }
  beforeEach(() => {
    made.length = 0; drawn.length = 0
    vi.stubGlobal('document', {
      createElement: () => {
        const c: Record<string, unknown> = { width: 0, height: 0 }
        c.getContext = () => offscreenCtx()
        made.push(c as unknown as { w: number; h: number })
        return c
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const hostCtx = (scale = 1) => ({
    fillStyle: '', globalAlpha: 0.5, globalCompositeOperation: 'multiply',
    fillRect() {}, save() {}, restore() {},
    getTransform: () => ({ a: scale, b: 0 }),
    drawImage(_i: unknown, x = 0, y = 0, w = 0, h = 0) { drawn.push({ x, y, w, h }) },
  })

  it('never writes an absolute opacity or composite op — the layer\'s own ride through', () => {
    const ctx = hostCtx()
    paintChaff(ctx as never, P(), 300, 400, 1)
    expect(ctx.globalAlpha).toBe(0.5)
    expect(ctx.globalCompositeOperation).toBe('multiply')
  })

  it('draws its sheet over the whole box at the box origin (the host clips it)', () => {
    paintChaff(hostCtx() as never, P(), 300, 400, 1)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]).toEqual({ x: 0, y: 0, w: 300, h: 400 })
  })

  it('caps the per-pixel pass at 6 Mpx however big the box or the zoom', () => {
    paintChaff(hostCtx(8) as never, P(), 4000, 3000, 1)
    // Two canvases per sheet: the coverage buffer at half resolution (D1), then the print.
    expect(made).toHaveLength(2)
    const mask = made[0] as unknown as { width: number; height: number }
    const sheet = made[1] as unknown as { width: number; height: number }
    expect(sheet.width * sheet.height).toBeLessThanOrEqual(6_000_000)
    expect(sheet.width * sheet.height).toBeGreaterThan(5_000_000)
    // …and it keeps the box's aspect.
    expect(sheet.width / sheet.height).toBeCloseTo(4000 / 3000, 2)
    // The mask really is half the print in each direction.
    expect(mask.width).toBe(Math.round(sheet.width * 0.5))
    expect(mask.height).toBe(Math.round(sheet.height * 0.5))
  })

  it('re-uses the sheet when nothing about the pixels changed (a drag is a cache hit)', () => {
    paintChaff(hostCtx() as never, P({ count: 9 }), 300, 400, 55)
    const first = made.length
    paintChaff(hostCtx() as never, P({ count: 9 }), 300, 400, 55)
    expect(made.length).toBe(first)                        // nothing new allocated
    paintChaff(hostCtx() as never, P({ count: 9 }), 300, 400, 56)
    expect(made.length).toBeGreaterThan(first)             // a new seed is a new sheet
  })

  it('survives a tiny box, a portrait box and a nonsense box', () => {
    for (const [w, h] of [[1, 1], [0, 0], [3, 900], [900, 3], [Number.NaN, 10]] as const) {
      expect(() => paintChaff(hostCtx() as never, P(), w as number, h as number, 1)).not.toThrow()
    }
  })
})

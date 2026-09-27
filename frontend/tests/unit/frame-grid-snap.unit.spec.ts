import { describe, it, expect } from 'vitest'
import { textSnapY, baselineRoundDy, resnapReach } from '~/lib/frame/gridSnap'
import { spanOf, placeOnSpan, tracksFromLength, lengthFromTracks, type ResolvedLayoutGrid } from '~/lib/frame/layoutGrid'

// A hand-made grid: 4 columns and 4 rows of 190 with 20 gaps from 100; unit 10; margins 100/900.
const tracks = [100, 310, 520, 730].map(a => ({ a, w: 190 }))
const R: ResolvedLayoutGrid = { W: 1000, H: 1000, unit: 10, cols: tracks, rows: tracks, margin: 100, top: 100, bottom: 900, xs: [], ys: [] }
const R0: ResolvedLayoutGrid = { ...R, rows: [] }   // rows off

describe('textSnapY — capitals, last baseline, else the baseline grid', () => {
  it('capitals within reach go to the nearest row top', () => {
    expect(textSnapY({ capTop: 305, baselines: [330] }, R, 12)).toEqual({ dy: 5, guide: 310 })
  })
  it('the last baseline within reach goes to the nearest row bottom', () => {
    expect(textSnapY({ capTop: 330, baselines: [360, 496] }, R, 12)).toEqual({ dy: 4, guide: 500 })
  })
  it('when both are within reach, the nearer one wins', () => {
    expect(textSnapY({ capTop: 306, baselines: [340, 497] }, R, 12)).toEqual({ dy: 3, guide: 500 })
  })
  it('otherwise the first baseline rounds to the baseline grid, with no guide', () => {
    const r = textSnapY({ capTop: 350, baselines: [373] }, R, 12)
    expect(r.dy).toBeCloseTo(-3, 9)
    expect(r.guide).toBeNull()
  })
  it('with rows off, the margins are the only row top and bottom', () => {
    expect(textSnapY({ capTop: 104, baselines: [130] }, R0, 12)).toEqual({ dy: -4, guide: 100 })
    expect(textSnapY({ capTop: 850, baselines: [896] }, R0, 12)).toEqual({ dy: 4, guide: 900 })
  })
})

describe('baselineRoundDy and resnapReach', () => {
  it('rounds a top to the nearest unit', () => {
    expect(baselineRoundDy(403, 10)).toBeCloseTo(-3, 9)
    expect(baselineRoundDy(406, 10)).toBeCloseTo(4, 9)
    expect(baselineRoundDy(400, 10)).toBe(0)
  })
  it('re-snap reaches half a row pitch with rows, one line without', () => {
    expect(resnapReach(R)).toBe(105)
    expect(resnapReach(R0)).toBe(20)
  })
})

describe('spanOf / placeOnSpan', () => {
  it('a box on columns 1–2 of row 1', () => {
    expect(spanOf({ x: 100, y: 100, w: 400, h: 190 }, R)).toEqual({ col: 1, cols: 2, row: 1, rows: 1 })
  })
  it('a small box in the right half of column 2 covers column 2, not 3', () => {
    expect(spanOf({ x: 420, y: 330, w: 60, h: 20 }, R)).toEqual({ col: 2, cols: 1, row: 2, rows: 1 })
  })
  it('rows off → no row', () => {
    expect(spanOf({ x: 100, y: 100, w: 400, h: 190 }, R0)).toEqual({ col: 1, cols: 2, row: null, rows: null })
  })
  it('a box wholly inside a gutter covers the single nearest track (tie → lower index)', () => {
    // Tracks 0 (100-290) and 1 (310-500), gutter 290-310. Box [295, 305] is equidistant
    // from both track centres (195 and 405): the tie goes to the lower index.
    expect(spanOf({ x: 295, y: 400, w: 10, h: 10 }, R)).toEqual({ col: 1, cols: 1, row: 2, rows: 1 })
  })
  it('a box straddling a gutter into both tracks still covers two', () => {
    // [150, 450] reaches well past the gutter into the interior of both track 0 (100-290)
    // and track 1 (310-500) — not the gutter-only case above.
    expect(spanOf({ x: 150, y: 100, w: 300, h: 190 }, R)).toEqual({ col: 1, cols: 2, row: 1, rows: 1 })
  })
  it('a box straddling a column edge covers the track it overlaps more', () => {
    // Tracks 0 (100-290) and 1 (310-500). [250, 330] overlaps track 0 by 40 and track 1 by 20.
    expect(spanOf({ x: 250, y: 400, w: 80, h: 10 }, R)).toEqual({ col: 1, cols: 1, row: 2, rows: 1 })
    // [270, 360] overlaps track 0 by 20 and track 1 by 50.
    expect(spanOf({ x: 270, y: 400, w: 90, h: 10 }, R)).toEqual({ col: 2, cols: 1, row: 2, rows: 1 })
  })
  it('places a span on the grid and clamps it inside', () => {
    expect(placeOnSpan({ col: 2, cols: 2, row: 3, rows: 2 }, R)).toEqual({ x: 310, w: 400, y: 520, h: 400 })
    expect(placeOnSpan({ col: 9, cols: 5, row: null, rows: null }, R)).toEqual({ x: 730, w: 190, y: null, h: null })
    expect(placeOnSpan({ col: 1, cols: 1, row: 2, rows: 1 }, R0)).toEqual({ x: 100, w: 190, y: null, h: null })
  })
  it('round-trips: the span of a placed span is that span', () => {
    const p = placeOnSpan({ col: 2, cols: 3, row: 1, rows: 2 }, R)
    expect(spanOf({ x: p.x, y: p.y!, w: p.w, h: p.h! }, R)).toEqual({ col: 2, cols: 3, row: 1, rows: 2 })
  })
})

describe('the "col" unit — n tracks are n pitches less one gap', () => {
  it('a box four columns wide reads exactly 4, and 4 gives that width back', () => {
    const w4 = tracks[3]!.a + tracks[3]!.w - tracks[0]!.a       // 820
    expect(tracksFromLength(tracks, w4)).toBeCloseTo(4, 9)
    expect(lengthFromTracks(tracks, 4)).toBeCloseTo(w4, 9)
    expect(lengthFromTracks(tracks, 1)).toBeCloseTo(190, 9)
  })
  it('a single track has no gap: its own width per step', () => {
    const one = [{ a: 0, w: 300 }]
    expect(tracksFromLength(one, 600)).toBeCloseTo(2, 9)
    expect(lengthFromTracks(one, 3)).toBeCloseTo(900, 9)
  })
})

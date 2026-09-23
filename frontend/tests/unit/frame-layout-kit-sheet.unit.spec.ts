import { describe, it, expect } from 'vitest'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { makeStubMeasure, makeCanvasMeasure } from '~/lib/frame/patterns/kit/measure'

const measure = makeStubMeasure()
const sheet = (frameW: number, frameH: number, extra: Record<string, unknown> = {}) =>
  makeSheet({ frameW, frameH, measure, ...extra })

describe('layout kit — sheet grid', () => {
  it('portrait poster, grid off: 12 columns, 4-unit margin, size unit 1', () => {
    const S = sheet(895, 1280)
    expect(S.NC).toBe(12)
    expect(S.M).toBe(4)
    expect(S.X(1)).toBe(4)
    expect(S.XR(12)).toBeCloseTo(96, 9)
    expect(S.L(16)).toBeCloseTo(S.H - 4, 9)
    expect(S.B).toBeCloseTo(1, 9)
    expect(S.W).toBe(100)
    expect(S.H).toBeCloseTo(100 * 1280 / 895, 9)
  })

  it('landscape uses 16 columns and a banner 20; design columns still span margin to margin', () => {
    for (const [w, h, nc] of [[1280, 720, 16], [1280, 400, 20]] as const) {
      const S = sheet(w, h)
      expect(S.NC).toBe(nc)
      expect(S.X(1)).toBe(S.M)
      expect(S.XR(12)).toBeCloseTo(S.W - S.M, 9)
      expect(S.Xr(S.NC) + S.CW).toBeCloseTo(S.W - S.M, 9)
    }
  })

  it('an explicit grid sets margin, gutter and columns', () => {
    const S = sheet(895, 1280, { grid: { mode: 'explicit', margin: 0.05, gutter: 0.02, columns: 6 } })
    expect(S.M).toBe(5)
    expect(S.G).toBe(2)
    expect(S.NC).toBe(6)
    expect(S.XR(12)).toBeCloseTo(95, 9)
  })

  it('colRange makes a sub-sheet: design column 12 ends on real column 8', () => {
    const S = sheet(1280, 720, { colRange: [1, 8] })
    expect(S.NC).toBe(16)
    expect(S.XR(12)).toBeCloseTo(S.Xr(8) + S.CW, 9)
    expect(S.X(1)).toBe(S.Xr(1))
  })
})

describe('layout kit — sizing', () => {
  it('fitSize: the stub measures 0.55 em per character plus letter spacing per gap', () => {
    const S = sheet(895, 1280)
    // 4 × 55 + 3 × (−5) = 205 at size 100
    expect(S.w100('AAAA')).toBeCloseTo(205, 9)
    expect(S.fitSize(['AAAA'], 22)).toBeCloseTo(22 * 100 / 205, 9)
  })

  it('sizeFor respects the height, and scale multiplies the result', () => {
    const S = sheet(895, 1280)
    const lines = ['AAAA', 'BB']
    const wide = S.sizeFor(lines, 1000, 20)
    // height-bound: 20 / ((2 − 1) × 0.9 + CAP)
    expect(wide).toBeCloseTo(20 / (0.9 + S.CAP), 9)
    expect(S.blockH(2, wide, S.DISPLAY.lh)).toBeCloseTo(20, 9)
    const narrow = S.sizeFor(lines, 22, 1000)
    expect(narrow).toBeCloseTo(S.fitSize(lines, 22), 9)

    const S8 = sheet(895, 1280, { scale: 0.8 })
    expect(S8.sizeFor(lines, 1000, 20)).toBeCloseTo(wide * 0.8, 9)
    expect(S8.sizeFor(lines, 22, 1000)).toBeCloseTo(narrow * 0.8, 9)
  })

  it('CAP comes from the measure', () => {
    expect(sheet(895, 1280).CAP).toBeCloseTo(0.7, 9)
  })

  it('countLines uses the measure’s own wrap, paragraph by paragraph', () => {
    const S = sheet(895, 1280)
    // at size 10, each character is 5.5 units wide: "aa bb" = 27.5, "aa" = 11
    expect(S.countLines('aa bb', 30, S.INFO, 10)).toBe(1)
    expect(S.countLines('aa bb', 20, S.INFO, 10)).toBe(2)
    expect(S.countLines('aa bb\ncc', 20, S.INFO, 10)).toBe(3)
  })
})

describe('layout kit — photo', () => {
  it('photoIn picks the largest whole-column 4:5 photo that fits the zone', () => {
    const S = sheet(895, 1280)
    const p = S.photoIn({ c1: 1, c2: 12, top: 10, bottom: 30 })
    expect(p.k).toBe('p')
    if (p.k !== 'p') return
    expect(p.h).toBeLessThanOrEqual(20)
    let n = 12
    while (n >= 2 && S.SPAN(1, n) * S.PHOTO_ASPECT > 20) n--
    expect(p.w).toBeCloseTo(S.SPAN(1, n), 9)
    // right-aligned by default, top-anchored
    expect(p.x + p.w).toBeCloseTo(S.XR(12), 9)
    expect(p.y).toBe(10)
  })

  it('flip swaps the horizontal anchor', () => {
    const S = sheet(895, 1280, { flip: true })
    const p = S.photoIn({ c1: 1, c2: 12, top: 10, bottom: 30 })
    expect(p.k).toBe('p')
    if (p.k === 'p') expect(p.x).toBe(S.X(1))
  })

  it('photoIn is missing when the zone is shorter than a two-column photo', () => {
    const S = sheet(895, 1280)
    const tooShort = S.SPAN(1, 2) * S.PHOTO_ASPECT * 0.9
    expect(S.photoIn({ c1: 1, c2: 12, top: 10, bottom: 10 + tooShort })).toEqual({ k: 'missing' })
  })
})

describe('layout kit — builders', () => {
  it('disp, sec and info carry the Swiss styles', () => {
    const S = sheet(895, 1280)
    expect(S.disp('A', { size: 10, x: 4 })).toMatchObject({ k: 't', s: 'A', role: 'title', pre: true, wt: 600, ls: -0.05, lh: 0.9 })
    expect(S.sec('B', { x: 4 })).toMatchObject({ role: 'details', size: 4.4 * S.B, wt: 500 })
    expect(S.info('C', { x: 4 })).toMatchObject({ role: 'info', size: 1.95 * S.B, wt: 400, lh: 1.3 })
  })

  it('infoRow on the foot shares one baseline; stackBottom ends at its bottom', () => {
    const S = sheet(895, 1280)
    const c = { title: 'T', details: 'Details', date: 'May 1', caption: 'Somewhere' }
    const row = S.infoRow(c, S.FOOT3, 'foot')
    expect(row.els).toHaveLength(3)
    expect(row.els.every(e => e.base === S.L(16))).toBe(true)
    expect(row.bottom).toBe(S.L(16))
    const st = S.stackBottom([{ s: 'a' }, { s: 'b' }], 1, 4, 50)
    const last = st.els[st.els.length - 1]!
    expect(last.top! + S.blockH(1, S.INFO.size, S.INFO.lh)).toBeCloseTo(50, 9)
  })
})

describe('layout kit — canvas measure', () => {
  it('falls back to the stub when there is no DOM', () => {
    expect(typeof document).toBe('undefined')
    const m = makeCanvasMeasure({})
    const stub = makeStubMeasure()
    expect(m.w100('AAAA', 'title', -0.05)).toBeCloseTo(stub.w100('AAAA', 'title', -0.05), 9)
    expect(m.lines('aa bb', 'caption', 10, 0, 20)).toEqual(['aa', 'bb'])
    expect(m.capAbove('title')).toBeCloseTo(0.35, 9)
  })
})

describe('layout kit — sheet takes a format (Stage 2)', () => {
  const STAGE1_FRAMES: readonly [number, number][] = [[895, 1280], [1080, 1080], [1280, 720], [1280, 400]]
  const NUMERIC_FIELDS = ['W', 'H', 'M', 'G', 'NC', 'CW', 'RH', 'GAP', 'CAP', 'B'] as const

  it('no format, no composeH: every exported number is byte-identical to a Stage 1 sheet', () => {
    for (const [w, h] of STAGE1_FRAMES) {
      const stage1 = sheet(w, h)
      const withEmptyOpts = makeSheet({ frameW: w, frameH: h, measure, format: undefined, composeH: undefined })
      for (const f of NUMERIC_FIELDS) expect(withEmptyOpts[f]).toBe(stage1[f])
      expect(withEmptyOpts.DISPLAY).toEqual(stage1.DISPLAY)
      expect(withEmptyOpts.SECOND).toEqual(stage1.SECOND)
      expect(withEmptyOpts.INFO).toEqual(stage1.INFO)
    }
  })

  it('format.view raises the INFO/SECOND floor', () => {
    const S = sheet(1280, 720, { format: { view: 170 } })
    expect(S.INFO.size).toBeCloseTo(900 / 170, 3)
    expect(S.SECOND.size).toBeCloseTo(1.6 * (900 / 170), 3)
  })

  it('without format.view, SECOND stays the exact Stage 1 value even with other format fields set', () => {
    const stage1 = sheet(1280, 720)
    const S = sheet(1280, 720, { format: { nc: 24 } })
    expect(S.INFO.size).toBe(stage1.INFO.size)
    expect(S.SECOND.size).toBe(stage1.SECOND.size)
  })

  it('format.nc overrides the column count', () => {
    const S = sheet(728, 90, { format: { nc: 24 } })
    expect(S.NC).toBe(24)
  })

  it('format.keepSide raises the margin', () => {
    const S = sheet(1280, 720, { format: { keepSide: 0.06 } })
    expect(S.M).toBe(6)
  })

  it('composeH composes on a band, but B still comes from the full height', () => {
    const full = sheet(1080, 1920)
    const S = sheet(1080, 1920, { composeH: 50 })
    expect(S.H).toBe(50)
    expect(S.B).toBeCloseTo(full.B, 9)
    expect(S.L(16)).toBeCloseTo(50 - S.M, 9)
  })
})

describe('layout kit — Stage 3 pieces (the prototype’s builders, maths verbatim)', () => {
  const S = sheet(895, 1280)
  const P = sheet(895, 1280, { style: 'performance' })
  const E = sheet(895, 1280, { style: 'editorial' })
  const St = sheet(895, 1280, { style: 'street' })

  it('spacing: gapBelow, groupGap, inset, logoH and clear', () => {
    expect(S.gapBelow(10)).toBeCloseTo(Math.max(4, S.INFO.size * 1.1), 9)
    expect(S.gapBelow(1)).toBeCloseTo(S.INFO.size * 1.1, 9)
    expect(S.groupGap()).toBeCloseTo(Math.max(S.RH * 1.4, S.INFO.size * 3.4), 9)
    expect(S.inset()).toBeCloseTo(Math.max(S.M, S.INFO.size * 2.4), 9)
    expect(S.logoH()).toBeCloseTo(Math.max(S.INFO.size * 1.9, S.RH * 0.5), 9)
    expect(S.clear({ h: 2 })).toBeCloseTo(Math.max(S.GAP * 1.5, 1), 9)
    expect(S.clear({ h: 40 })).toBe(20)
  })

  it('band: a top band runs 0..to + gap + 1.6 rows, solid up to the text', () => {
    const b = P.band('top', 0, 30)
    const h = 30 + P.GAP + P.RH * 1.6
    expect(b).toEqual({ k: 'band', side: 'top', y: 0, h, solid: (30 + P.GAP) / h, role: 'band', ok: true, bleed: true })
    // Capped at the page height.
    expect(P.band('top', 0, P.H).h).toBe(P.H)
  })

  it('band: a bottom band runs from above the text to the foot', () => {
    const b = P.band('bottom', 100, P.H)
    const y = 100 - P.GAP - P.RH * 1.6, h = P.H - y
    expect(b).toEqual({ k: 'band', side: 'bottom', y, h, solid: (P.H - 100 + P.GAP) / h, role: 'band', ok: true, bleed: true })
    expect(P.band('bottom', 1, P.H).y).toBe(0)
  })

  it('button: a pill that grows with its label; the label is the action text on it', () => {
    const size = Math.max(P.INFO.size * 1.3, P.SECOND.size * 0.5)
    const tw = measure.w100('Shop now', 'caption', 0) / 100 * size
    const w = tw + size * 2.6, h = size * 2.8
    const { btn, text } = P.button('Shop now', 10, 50)
    expect(btn).toEqual({ k: 'btn', shape: 'pill', x: 10, y: 50, w, h, size, role: 'btn', bg: 'ink' })
    expect(text).toMatchObject({ k: 't', s: 'Shop now', role: 'action', over: ['btn'], size, wt: 600, ls: 0, lh: 1, x: 10, w, align: 'center', color: 'field', inside: 'btn' })
    // Cap-centred in the button.
    expect(text.top! + 0.7 * size / 2).toBeCloseTo(50 + h / 2, 9)
    // align centre / right place the box.
    expect(P.button('Shop now', 50, 0, { align: 'center' }).btn.x).toBeCloseTo(50 - w / 2, 9)
    expect(P.button('Shop now', 50, 0, { align: 'right' }).btn.x).toBeCloseTo(50 - w, 9)
    expect(P.button('Shop now', 50, 0, { bg: 'accent', fg: 'ink' })).toMatchObject({ btn: { bg: 'accent' }, text: { color: 'ink' } })
  })

  it('button: Street draws a box in capitals with its own spacing', () => {
    const size = Math.max(St.INFO.size * 1.3, St.SECOND.size * 0.5)
    const tw = measure.w100('Shop now', 'caption', 0.06, true) / 100 * size
    const { btn, text } = St.button('Shop now', 10, 50)
    expect(btn.shape).toBe('box')
    expect(btn.w).toBeCloseTo(tw + size * 2.6, 9)
    expect(text).toMatchObject({ upper: true, ls: 0.06, wt: 700 })
  })

  it('button: Editorial draws an underlined link as wide as its text', () => {
    const size = Math.max(E.INFO.size * 1.3, E.SECOND.size * 0.5)
    const tw = measure.w100('Shop now', 'caption', 0.16, true) / 100 * size
    const { btn, text } = E.button('Shop now', 10, 50)
    expect(btn).toEqual({ k: 'btn', shape: 'link', x: 10, y: 50, w: tw, h: size * 1.7, size, role: 'btn' })
    expect(text).toMatchObject({ role: 'action', over: ['btn'], align: 'left', x: 10, color: 'ink', upper: true })
    expect(text.inside).toBeUndefined()
  })

  it('button: a sheet with no style draws the prototype’s default pill', () => {
    expect(S.button('Go', 0, 0).btn.shape).toBe('pill')
  })

  it('logo: the kit logo at its own aspect (h = w × aspect)', () => {
    expect(S.logo(10, 5, 6, { aspect: 0.3 })).toEqual({ k: 'logo', x: 10, y: 5, w: 20, h: 6, role: 'logo' })
    expect(S.logo(50, 5, 6, { aspect: 0.3, align: 'center' }).x).toBeCloseTo(40, 9)
    expect(S.logo(50, 5, 6, { aspect: 0.3, align: 'right' }).x).toBeCloseTo(30, 9)
  })
})

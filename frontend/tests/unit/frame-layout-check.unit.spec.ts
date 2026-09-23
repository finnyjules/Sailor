import { describe, it, expect } from 'vitest'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { boxOf, checkPlan } from '~/lib/frame/patterns/kit/check'
import type { El, TextEl, PhotoEl } from '~/lib/frame/patterns/kit/types'

const measure = makeStubMeasure()
const S = makeSheet({ frameW: 1000, frameH: 1000, measure })

// A short single-line text, well inside the page, well above the minimum size.
const title = (o: Partial<TextEl> = {}): TextEl =>
  ({ k: 't', s: 'Hello', x: 10, w: 40, top: 10, size: 8, wt: 600, ls: 0, lh: 1, role: 'title', ...o })

describe('layout kit — checker', () => {
  it('a passing plan produces no reasons', () => {
    const els: El[] = [
      title({ role: 'title', x: 5, top: 5, w: 40 }),
      { k: 't', s: 'A date', x: 5, top: 30, w: 40, size: S.INFO.size, wt: 400, ls: 0, lh: 1, role: 'date' },
    ]
    expect(checkPlan(els, S)).toEqual([])
  })

  // Rule 1
  it('a missing element reports its own reason, or the default', () => {
    expect(checkPlan([{ k: 'missing', why: 'no clean crop for this photo' }], S))
      .toEqual(['no clean crop for this photo'])
    expect(checkPlan([{ k: 'missing' }], S)).toEqual(['no room for the image'])
  })

  // Rule 2
  it('text under the minimum size fails', () => {
    const els: El[] = [title({ role: 'caption', size: 1, top: 5, x: 5, w: 20 })]
    expect(checkPlan(els, S)).toEqual(['caption: below minimum size'])
  })

  // Rule 3
  it('a photo placed off the page without bleed fails', () => {
    const els: El[] = [{ k: 'p', x: -10, y: 5, w: 20, h: 20, role: 'photo' }]
    expect(checkPlan(els, S)).toEqual(['photo: off the page'])
  })

  it('the same photo passes when it bleeds', () => {
    const els: El[] = [{ k: 'p', x: -10, y: 5, w: 20, h: 20, role: 'photo', bleed: true }]
    expect(checkPlan(els, S)).toEqual([])
  })

  // Rule 4
  it('two overlapping text elements report the overlap, in element order', () => {
    const els: El[] = [
      title({ role: 'title', x: 5, top: 5, w: 40 }),
      title({ role: 'date', x: 5, top: 6, w: 40 }),
    ]
    expect(checkPlan(els, S)).toEqual(['title overlaps date'])
  })

  it('the same pair passes when one element lists the other in `over`', () => {
    const els: El[] = [
      title({ role: 'title', x: 5, top: 5, w: 40, over: ['date'] }),
      title({ role: 'date', x: 5, top: 6, w: 40 }),
    ]
    expect(checkPlan(els, S)).toEqual([])
  })

  // Rule 5
  it('text set to sit inside a circle, wider than the circle, does not fit', () => {
    const els: El[] = [
      { k: 'c', cx: 50, cy: 50, r: 8, role: 'sticker' },
      title({ role: 'date', s: 'A very long number here', x: 30, top: 46, w: 40, size: 6, align: 'center', inside: 'sticker' }),
    ]
    const reasons = checkPlan(els, S)
    expect(reasons).toContain('date does not fit inside its sticker')
  })

  it('text sized to fit inside the circle passes', () => {
    const els: El[] = [
      { k: 'c', cx: 50, cy: 50, r: 20, role: 'sticker', ok: true },
      title({ role: 'date', s: '12', x: 45, top: 47, w: 10, size: 4, align: 'center', inside: 'sticker', ok: true }),
    ]
    expect(checkPlan(els, S)).toEqual([])
  })

  // Rule 6
  it('text centred too close to the edge of its panel fails', () => {
    const els: El[] = [
      { k: 'r', x: 10, y: 10, w: 40, h: 40, role: 'panel', ok: true },
      title({ role: 'caption', x: 10.2, top: 10.2, w: 10, size: S.INFO.size, ok: true }),
    ]
    expect(checkPlan(els, S)).toEqual(['too close to the edge of its panel'])
  })

  it('text with room inside its panel passes', () => {
    const els: El[] = [
      { k: 'r', x: 0, y: 0, w: 90, h: 90, role: 'panel', ok: true },
      title({ role: 'caption', x: 30, top: 30, w: 10, size: S.INFO.size, ok: true }),
    ]
    expect(checkPlan(els, S)).toEqual([])
  })

  // Rule 7 — premise
  it('an overlap premise broken by disjoint boxes reports the broken promise', () => {
    const els: El[] = [
      title({ role: 'title', x: 5, top: 5, w: 20 }),
      { k: 'p', x: 60, y: 60, w: 20, h: 20, role: 'photo' },
    ]
    expect(checkPlan(els, S, { overlap: [['title', 'photo']] }))
      .toEqual(['promise broken: title should overlap photo'])
  })

  it('an overlap premise kept by intersecting boxes passes', () => {
    const els: El[] = [
      title({ role: 'title', x: 5, top: 5, w: 30, over: ['photo'] }),
      { k: 'p', x: 10, y: 5, w: 20, h: 20, role: 'photo' },
    ]
    expect(checkPlan(els, S, { overlap: [['title', 'photo']] })).toEqual([])
  })

  it('a bleed premise broken by a box fully on the page reports the broken promise', () => {
    const els: El[] = [{ k: 'p', x: 10, y: 10, w: 20, h: 20, role: 'photo' }]
    expect(checkPlan(els, S, { bleed: ['photo'] }))
      .toEqual(['promise broken: photo should run off the page'])
  })

  it('a bleed premise kept by a box running off the page passes', () => {
    const els: El[] = [{ k: 'p', x: -5, y: 10, w: 20, h: 20, role: 'photo', bleed: true }]
    expect(checkPlan(els, S, { bleed: ['photo'] })).toEqual([])
  })

  it('a rotated premise broken by rot=0 (or missing) reports the broken promise', () => {
    const els: El[] = [{ k: 'r', x: 10, y: 10, w: 20, h: 20, role: 'card' }]
    expect(checkPlan(els, S, { rotated: ['card'] }))
      .toEqual(['promise broken: card should be rotated'])
  })

  it('a rotated premise kept by rot != 0 passes', () => {
    const els: El[] = [{ k: 'r', x: 10, y: 10, w: 20, h: 20, role: 'card', rot: 8 }]
    expect(checkPlan(els, S, { rotated: ['card'] })).toEqual([])
  })
})

describe('layout kit — boxOf', () => {
  it('a photo box is x,y,w,h', () => {
    const e: PhotoEl = { k: 'p', x: 1, y: 2, w: 10, h: 20, role: 'photo' }
    expect(boxOf(e, S)).toEqual({ x0: 1, y0: 2, x1: 11, y1: 22 })
  })

  it('a circle box is cx±r', () => {
    expect(boxOf({ k: 'c', cx: 10, cy: 10, r: 5, role: 'sticker' }, S)).toEqual({ x0: 5, y0: 5, x1: 15, y1: 15 })
  })

  it('a rule box is x..x+w, top at y, 0.16 thick', () => {
    expect(boxOf({ k: 'l', x: 1, y: 5, w: 10, role: 'rule' }, S)).toEqual({ x0: 1, y0: 5, x1: 11, y1: 5.16 })
  })

  it('a ring box is cx±(R+size/2)', () => {
    const box = boxOf({ k: 'ring', cx: 50, cy: 50, R: 10, size: 4, s: 'text', role: 'ring' }, S)!
    expect(box.x0).toBeCloseTo(38, 9)
    expect(box.x1).toBeCloseTo(62, 9)
  })

  it('a missing element has no box', () => {
    expect(boxOf({ k: 'missing' }, S)).toBeNull()
  })

  it('a rotated rect returns its rotated bounding box, about its centre', () => {
    const box = boxOf({ k: 'r', x: 0, y: 0, w: 10, h: 10, role: 'card', rot: 45 }, S)!
    // a 10×10 square rotated 45° about its own centre has a bbox side of 10√2
    expect(box.x1 - box.x0).toBeCloseTo(10 * Math.SQRT2, 6)
    expect(box.y1 - box.y0).toBeCloseTo(10 * Math.SQRT2, 6)
  })
})

describe('text box model (matches the prototype and toOps)', () => {
  // stub: 'Hello' at size 8, ls 0 → 5 × 0.55 × 8 = 22 units wide; cap = 0.7 × 8 = 5.6
  it('x is the left edge of a box w wide; align places the ink inside it', () => {
    const l = boxOf(title({ x: 10, w: 40 }), S)!
    const c = boxOf(title({ x: 10, w: 40, align: 'center' }), S)!
    const r = boxOf(title({ x: 10, w: 40, align: 'right' }), S)!
    expect(l.x0).toBeCloseTo(10); expect(l.x1).toBeCloseTo(32)
    expect(c.x0).toBeCloseTo(19); expect(c.x1).toBeCloseTo(41)
    expect(r.x0).toBeCloseTo(28); expect(r.x1).toBeCloseTo(50)
  })

  it('top is the cap top; base is the last baseline', () => {
    const t = boxOf(title({ top: 10 }), S)!
    expect(t.y0).toBeCloseTo(10); expect(t.y1).toBeCloseTo(15.6)
    const b = boxOf(title({ top: undefined, base: 20 }), S)!
    expect(b.y1).toBeCloseTo(20); expect(b.y0).toBeCloseTo(14.4)
  })
})

describe('checker — named-risk coverage', () => {
  const date = (o: Partial<TextEl> = {}): TextEl =>
    ({ k: 't', s: 'Hello', x: 10, w: 40, top: 10, size: 8, wt: 400, ls: 0, lh: 1, role: 'date', ...o })

  it('over works in both directions and ignores trailing digits on roles', () => {
    expect(checkPlan([title({ role: 'title3' }), date()], S)).toEqual(['title3 overlaps date'])
    expect(checkPlan([title({ role: 'title3' }), date({ over: ['title'] })], S)).toEqual([])
    expect(checkPlan([title({ over: ['date'] }), date({ role: 'date2' })], S)).toEqual([])
  })

  it('panel padding measures from the page edge when the panel bleeds', () => {
    const panel = { k: 'r', x: -10, y: 10, w: 50, h: 40, role: 'panel' } as El
    const near = date({ x: 2, top: 20, over: ['panel'] })
    expect(checkPlan([panel, near], S)).toContain('too close to the edge of its panel')
    expect(checkPlan([panel, date({ x: 6, top: 20, over: ['panel'] })], S)).not.toContain('too close to the edge of its panel')
  })

  it('rotated text turns about its centre only when origin is centre', () => {
    const c = boxOf(title({ rot: 90, origin: 'center' }), S)!
    expect((c.x0 + c.x1) / 2).toBeCloseTo(21); expect((c.y0 + c.y1) / 2).toBeCloseTo(12.8)
    expect(c.x1 - c.x0).toBeCloseTo(5.6); expect(c.y1 - c.y0).toBeCloseTo(22)
    const d = boxOf(title({ rot: 90 }), S)!
    expect((d.x0 + d.x1) / 2).not.toBeCloseTo(21)
  })
})

describe('checker — an unbreakable word wider than its box counts (real ink)', () => {
  // "19.09.–15.11.2026": 17 chars × 0.55 em at size 4 = 37.4 wide, in a box 10 wide.
  const date = (o: Partial<TextEl>): TextEl =>
    ({ k: 't', s: '19.09.–15.11.2026', x: 0, w: 10, top: 20, size: 4, wt: 400, ls: 0, lh: 1.3, role: 'date', ...o })

  it('rule 3: the spill runs off the page', () => {
    // Box ends at 98 (inside); the ink ends at 88 + 37.4 = 125.4.
    expect(checkPlan([date({ x: 88 })], S)).toContain('date: off the page')
  })

  it('rule 4: the spill runs into a neighbour beside the box', () => {
    const els: El[] = [date({ x: 5 }), title({ role: 'caption', s: 'Basel', x: 25, w: 20, top: 20, size: 4 })]
    // Boxes 5..15 and 25..45 do not touch; the date's ink 5..42.4 does.
    expect(checkPlan(els, S)).toContain('date overlaps caption')
  })

  it('a word that fits its box is measured as before', () => {
    expect(checkPlan([date({ s: '2026', x: 88 })], S)).toEqual([])
  })
})

describe('checker rule 8 — text under the app\'s interface (a format\'s keep-clear areas)', () => {
  // meta-story: 1080×1920, top 14%, bottom 35%, sides 6%. Full height 177.78; band 24.9..115.6.
  const fullH = 100 * 1920 / 1080
  const keep = { top: 0.14, bottom: 0.35, left: 0.06, right: 0.06 }
  const Sst = makeSheet({ frameW: 1080, frameH: 1920, measure })
  const inBand = (o: Partial<TextEl> = {}) => title({ x: 10, w: 40, top: 40, ...o })

  it('text inside the uncovered band passes', () => {
    expect(checkPlan([inBand()], Sst, undefined, { keep, fullH })).toEqual([])
  })

  it('negative control: the same text at top 1 is under the app\'s interface', () => {
    expect(checkPlan([inBand({ top: 1 })], Sst, undefined, { keep, fullH })).toEqual(['title: under the app\'s interface'])
  })

  it('without keep-clear areas the same text passes (the rule is the format\'s alone)', () => {
    expect(checkPlan([inBand({ top: 1 })], Sst)).toEqual([])
  })

  it('the bottom and side areas count too', () => {
    const c = (o: Partial<TextEl>) => checkPlan([inBand(o)], Sst, undefined, { keep, fullH })
    expect(c({ top: 120 })).toEqual(['title: under the app\'s interface'])
    expect(c({ x: 2 })).toEqual(['title: under the app\'s interface'])
    expect(c({ x: 90, w: 9 })).toContain('title: under the app\'s interface')
  })

  it('only text: an image and a panel under the bars pass', () => {
    const els: El[] = [
      { k: 'p', x: 0, y: 0, w: 100, h: fullH, role: 'photo', ok: true },
      { k: 'r', x: 0, y: 0, w: 100, h: 10, role: 'band', ok: true },
    ]
    expect(checkPlan(els, Sst, undefined, { keep, fullH })).toEqual([])
  })
})

describe('layout kit — checker, Stage 3 pieces (rules 9 and 10)', () => {
  const info = (o: Partial<TextEl>): TextEl =>
    ({ k: 't', s: 'Shop', x: 10, w: 30, top: 10, size: S.INFO.size, wt: 500, ls: 0, lh: 1.3, role: 'caption', ...o })
  // The stub's info text is capH = 0.7 × size tall.
  const capH = 0.7 * S.INFO.size

  it('boxOf: a band spans the page width over its height; a button and a logo are their rects', () => {
    expect(boxOf({ k: 'band', side: 'bottom', y: 60, h: 40, solid: 0.5 }, S)).toEqual({ x0: 0, y0: 60, x1: S.W, y1: 100 })
    expect(boxOf({ k: 'btn', shape: 'pill', x: 5, y: 6, w: 20, h: 8, size: 3 }, S)).toEqual({ x0: 5, y0: 6, x1: 25, y1: 14 })
    expect(boxOf({ k: 'logo', x: 5, y: 6, w: 20, h: 6 }, S)).toEqual({ x0: 5, y0: 6, x1: 25, y1: 12 })
  })

  // Rule 9 — with its negative control.
  it('text closer to the logo than 0.35 × its height fails; just outside passes', () => {
    const logo = { k: 'logo' as const, x: 10, y: 10, w: 20, h: 10, role: 'logo' }
    const near = info({ top: 10 + 10 + 3 })          // 3 < 3.5 below the logo
    const far = info({ top: 10 + 10 + 3.6 })         // 3.6 > 3.5
    expect(checkPlan([logo, near], S)).toEqual(['logo: needs clear space'])
    expect(checkPlan([logo, far], S)).toEqual([])
    // Sideways too.
    expect(checkPlan([logo, info({ x: 30 + 3, top: 12 })], S)).toEqual(['logo: needs clear space'])
    expect(checkPlan([logo, info({ x: 30 + 3.6, top: 12 })], S)).toEqual([])
    // A full-bleed image (`ok`) and a piece set over the logo on purpose are exempt.
    expect(checkPlan([{ k: 'p', x: 0, y: 0, w: 100, h: 100, role: 'photo', ok: true, bleed: true }, logo], S)).toEqual([])
    expect(checkPlan([logo, info({ top: 23, over: ['logo'] })], S)).toEqual([])
  })

  // Rule 10 — with its negative controls.
  describe('rule 10: text never sits on a raw image (styles with textOffImage)', () => {
    const photo: PhotoEl = { k: 'p', x: 0, y: 0, w: 100, h: 100, role: 'photo', ok: true, bleed: true }
    const text = info({ top: 80, role: 'caption' })
    const band = { k: 'band' as const, side: 'bottom' as const, y: 70, h: 30, solid: 0.6, role: 'band', ok: true, bleed: true }

    it('text on the raw image fails in Performance and Street', () => {
      expect(checkPlan([photo, text], S, undefined, { style: 'performance' })).toEqual(['caption: sits on the raw image'])
      expect(checkPlan([photo, text], S, undefined, { style: 'street' })).toEqual(['caption: sits on the raw image'])
    })

    it('Swiss and Editorial (no textOffImage) and no style are unchanged', () => {
      expect(checkPlan([photo, text], S)).toEqual([])
      expect(checkPlan([photo, text], S, undefined, { style: 'swiss' })).toEqual([])
      expect(checkPlan([photo, text], S, undefined, { style: 'editorial' })).toEqual([])
    })

    it('text inside a band above the image passes; the same band BELOW the image does not', () => {
      expect(checkPlan([photo, band, text], S, undefined, { style: 'performance' })).toEqual([])
      expect(checkPlan([band, photo, text], S, undefined, { style: 'performance' })).toEqual(['caption: sits on the raw image'])
    })

    it('text that runs past its card fails; inside the union of a card and a panel passes', () => {
      const card = { k: 'r' as const, x: 5, y: 75, w: 20, h: 15, role: 'card', color: 'field' as const }
      const t = info({ x: 15, w: 30, top: 80, s: 'Shop now today only', over: ['card', 'panel'] })   // runs past the card
      // (Rule 6, the card's padding, is not this rule's business.)
      const raw = (els: El[]) => checkPlan(els, S, undefined, { style: 'performance' }).filter(i => !i.includes('panel'))
      expect(raw([photo, card, t])).toEqual(['caption: sits on the raw image'])
      const panel = { k: 'r' as const, x: 25, y: 75, w: 30, h: 15, role: 'panel', color: 'field' as const }
      expect(raw([photo, card, panel, t])).toEqual([])
    })

    it('text held by a sticker (a circle above the image) passes', () => {
      const sticker = { k: 'c' as const, cx: 30, cy: 50, r: 15, role: 'sticker', color: 'accent' as const }
      const t = info({ x: 22, w: 16, top: 50 - capH / 2, s: '–30%', role: 'date', over: ['sticker'] })
      expect(checkPlan([photo, sticker, t], S, undefined, { style: 'performance' })).toEqual([])
      expect(checkPlan([photo, t], S, undefined, { style: 'performance' })).toEqual(['date: sits on the raw image'])
    })

    it('a drawn button covers its own label; a link-style action on the image does not', () => {
      const P = makeSheet({ frameW: 1000, frameH: 1000, measure, style: 'performance' })
      const E = makeSheet({ frameW: 1000, frameH: 1000, measure, style: 'editorial' })
      const pill = P.button('Shop now', 10, 50)
      expect(checkPlan([photo, pill.btn, pill.text], P, undefined, { style: 'performance' })).toEqual([])
      // Rule 10 runs for Street (textOffImage); Editorial's look is a link: no shape, no cover.
      const link = E.button('Shop now', 10, 50)
      expect(checkPlan([photo, link.btn, link.text], E, undefined, { style: 'street' })).toEqual(['action: sits on the raw image'])
      // A button below the image covers nothing.
      expect(checkPlan([pill.btn, photo, pill.text], P, undefined, { style: 'performance' })).toEqual(['action: sits on the raw image'])
      // A text not set over the button (no `over: ['btn']`) is not its label.
      expect(checkPlan([photo, pill.btn, { ...pill.text, role: 'caption', over: [] }], P, undefined, { style: 'performance' }))
        .toEqual(expect.arrayContaining(['caption: sits on the raw image']))
    })

    it('text that only brushes the image (≤ 0.25) is not on it', () => {
      const small: PhotoEl = { k: 'p', x: 50, y: 0, w: 50, h: 50, role: 'photo' }
      const t = info({ x: 10, w: 40.2, top: 60 })
      expect(checkPlan([small, t], S, undefined, { style: 'performance' })).toEqual([])
    })
  })
})

// ═══════════════════════ Stage 4 Task 2: the new kit pieces ═══════════════════════

describe('layout kit — checker, Stage 4 pieces', () => {
  it('owned text is measured as lines in the caption face: its box is the text box of the same words', () => {
    const o = S.own('Before', { x: 10, top: 20, size: 4, role: 'label' })
    const as: TextEl = { k: 't', s: 'Before', x: 10, top: 20, size: 4, wt: o.wt, ls: 0, lh: 1, role: 'caption', pre: true }
    expect(boxOf(o, S)).toEqual(boxOf(as, S))
  })

  it('owned text off the page fails; the same words on the page pass (negative control)', () => {
    expect(checkPlan([S.own('After', { x: 96, top: 20, role: 'label' })], S)).toEqual(['label: off the page'])
    expect(checkPlan([S.own('After', { x: 5, top: 20, role: 'label' })], S)).toEqual([])
  })

  it('owned text below the minimum size fails; at the minimum it passes (negative control)', () => {
    expect(checkPlan([S.own('✓', { x: 10, top: 20, size: S.INFO.size * 0.8, role: 'tick' })], S)).toEqual(['tick: below minimum size'])
    expect(checkPlan([S.own('✓', { x: 10, top: 20, size: S.INFO.size, role: 'tick' })], S)).toEqual([])
  })

  it('owned text collides like text', () => {
    const t = title({ x: 5, top: 10, w: 40 })
    expect(checkPlan([t, S.own('Before', { x: 6, top: 11, size: 4, role: 'label' })], S)).toEqual(['title overlaps label'])
    expect(checkPlan([t, S.own('Before', { x: 6, top: 40, size: 4, role: 'label' })], S)).toEqual([])
  })

  it('owned text under the app\'s interface fails (rule 8)', () => {
    const keep = { top: 0.1, bottom: 0.2, left: 0, right: 0 }
    expect(checkPlan([S.own('Done', { x: 10, top: 2, role: 'ui' })], S, undefined, { keep })).toEqual(['ui: under the app\'s interface'])
    expect(checkPlan([S.own('Done', { x: 10, top: 30, role: 'ui' })], S, undefined, { keep })).toEqual([])
  })

  it('a leader line never collides; a rect in its place does (negative control)', () => {
    const t = title({ x: 5, top: 10, w: 40 })
    const ln = S.leader(0, 12, 60, 12)
    expect(boxOf(ln, S)).toEqual({ x0: -0.1, y0: 11.9, x1: 60.1, y1: 12.1 })
    expect(checkPlan([t, ln], S)).toEqual([])
    expect(checkPlan([t, { k: 'r', x: 0, y: 11.9, w: 60, h: 0.4, role: 'bar' }], S)).toEqual(['title overlaps bar'])
    // …but it still stays on the page.
    expect(checkPlan([S.leader(50, 50, 120, 50)], S)).toEqual(['leader: off the page'])
  })

  it('stars: five `size` squares 0.08 × size apart; they collide and stay on the page like any piece', () => {
    const st = S.stars(4.5, 10, 50, 5)
    expect(boxOf(st, S)).toEqual({ x0: 10, y0: 50, x1: 10 + 5 * 5.32, y1: 55 })
    expect(checkPlan([st], S)).toEqual([])
    expect(checkPlan([st, title({ x: 12, top: 51, w: 20 })], S)).toEqual(['stars overlaps title'])
    expect(checkPlan([S.stars(4.5, 80, 50, 5)], S)).toEqual(['stars: off the page'])
  })

  it('list items are measured as placed lines (ruling R5), never re-wrapped to their box', () => {
    const long = 'A long list item that would wrap'
    const item: TextEl = { k: 't', s: long, x: 10, w: 10, top: 20, size: 3, wt: 500, ls: 0, lh: 1.2, role: 'list1' }
    const b = boxOf(item, S)!
    expect(b.y1 - b.y0).toBeCloseTo(0.7 * 3, 9)                                  // one line
    // Negative control: the same element as a caption wraps to its box.
    const c = boxOf({ ...item, role: 'caption' }, S)!
    expect(c.y1 - c.y0).toBeGreaterThan(0.7 * 3 + 1)
  })
})

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

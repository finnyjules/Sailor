import { describe, it, expect } from 'vitest'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import type { Sheet } from '~/lib/frame/patterns/kit/sheet'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { STYLES } from '~/lib/frame/patterns/kit/styles'
import type { StyleId } from '~/lib/frame/patterns/kit/styles'
import { boxOf } from '~/lib/frame/patterns/kit/check'
import { elementsToOps } from '~/lib/frame/patterns/kit/toOps'
import { applyPlacement } from '~/lib/frame/patterns/apply'
import { LAYOUTS } from '~/lib/frame/patterns/layouts/catalog'
import type { Content, Kind } from '~/lib/frame/patterns/kit/types'
import type { FrameElements, PatternPlacement } from '~/lib/frame/patterns/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { KIND_TITLES, TEXTS } from './helpers/frameLayoutFixtures'

// Stage 3, Task 1: the style table; the sheet, toOps and apply take a style.

const measure = makeStubMeasure()
const FRAMES: [number, number][] = [[895, 1280], [1080, 1080], [1280, 720], [1280, 400]]
const IDS: StyleId[] = ['swiss', 'performance', 'editorial', 'street']

describe('the style table', () => {
  it('holds the prototype values verbatim', () => {
    expect(STYLES.swiss).toEqual({
      id: 'swiss', label: 'Swiss',
      display: { wt: 600, ls: -0.05, lh: 0.9 }, info: { wt: 400, ls: 0, lh: 1.3 },
      levels: ['title', 'details', 'date', 'action', 'caption'],
    })
    expect(STYLES.performance).toEqual({
      id: 'performance', label: 'Performance',
      display: { wt: 700, ls: -0.035, lh: 0.94 }, info: { wt: 500, ls: 0, lh: 1.3 },
      button: { shape: 'pill', wt: 600, ls: 0 },
      levels: ['title', 'date', 'details', 'action', 'caption'],
      textOffImage: true,
      check: expect.any(Function), rank: expect.any(Function),
    })
    expect(STYLES.editorial).toEqual({
      id: 'editorial', label: 'Editorial',
      display: { wt: 400, ls: -0.015, lh: 1.04 }, info: { wt: 500, ls: 0.16, lh: 1.6, upper: true },
      button: { shape: 'link', wt: 500, ls: 0.16 },
      levels: ['title', 'details', 'date', 'action', 'caption'],
      face: { family: 'Instrument Serif', wt: 400, ls: -0.01, note: 'A serif for the title' },
      rank: expect.any(Function),
    })
    expect(STYLES.street).toEqual({
      id: 'street', label: 'Street',
      display: { wt: 700, ls: -0.045, lh: 0.84, upper: true }, info: { wt: 600, ls: 0.04, lh: 1.25, upper: true },
      button: { shape: 'box', wt: 700, ls: 0.06 },
      levels: ['title', 'details', 'date', 'action', 'caption'],
      face: { family: 'Anton', wt: 400, ls: 0, note: 'A heavy condensed face for the title' },
      textOffImage: true,
      rank: expect.any(Function),
    })
  })
})

// Stage 3, Task 4: per-style checks and ranks.

describe('performance visibility check', () => {
  const size = { W: 100, H: 100 }
  const photo = { k: 'p' as const, x: 0, y: 0, w: 100, h: 100, role: 'photo' }

  it('passes at 50% solid cover (a card)', () => {
    const card = { k: 'r' as const, x: 0, y: 0, w: 100, h: 50, role: 'card' }
    expect(STYLES.performance.check!([photo, card], size)).toEqual([])
  })

  it('fails at 60% solid cover', () => {
    const card = { k: 'r' as const, x: 0, y: 0, w: 100, h: 60, role: 'card' }
    expect(STYLES.performance.check!([photo, card], size)).toEqual(['the image is mostly hidden'])
  })

  it('counts a band\'s fade at 0.35 — a fade over the whole photo alone does not fail', () => {
    // A top band whose solid part is 0 and whose fade covers the entire photo: covered =
    // 100 × (0 + 100 × 0.35) = 3500, area = 10000 → 0.35, well under the 0.55 floor.
    const band = { k: 'band' as const, side: 'top' as const, y: 0, h: 100, solid: 0, role: 'band' }
    expect(STYLES.performance.check!([photo, band], size)).toEqual([])
    // A band that is ALSO 60% solid does fail (solid + 0.35× the rest exceeds 0.55).
    const solidBand = { k: 'band' as const, side: 'top' as const, y: 0, h: 100, solid: 0.6, role: 'band' }
    expect(STYLES.performance.check!([photo, solidBand], size)).toEqual(['the image is mostly hidden'])
  })

  it('only what people can see counts — clipped to the format\'s keep-clear band', () => {
    // A card covering the top 60% of the page sits entirely inside a platform bar the format
    // keeps clear (keep.top = 0.7): nothing visible is covered.
    const card = { k: 'r' as const, x: 0, y: 0, w: 100, h: 60, role: 'card' }
    expect(STYLES.performance.check!([photo, card], size, { top: 0.7, bottom: 0, left: 0, right: 0 })).toEqual([])
  })

  it('no photo: nothing to check', () => {
    expect(STYLES.performance.check!([], size)).toEqual([])
  })
})

describe('style ranks order candidates as the prototype would', () => {
  const ctx = { infoSize: 5, W: 100, H: 100 }

  it('performance: a bigger offer (date role) and a button both rank higher', () => {
    const plain = { els: [{ k: 't' as const, s: '', x: 0, top: 0, size: 5, wt: 600, ls: 0, lh: 1, role: 'title' }], did: '' }
    const bigOffer = { els: [{ k: 't' as const, s: '', x: 0, top: 0, size: 20, wt: 600, ls: 0, lh: 1, role: 'date' }], did: '' }
    const withButton = { els: [{ k: 'btn' as const, x: 0, y: 0, w: 10, h: 10, size: 5, shape: 'pill' as const, role: 'action' }], did: '' }
    expect(STYLES.performance.rank!(bigOffer, ctx)).toBeGreaterThan(STYLES.performance.rank!(plain, ctx))
    expect(STYLES.performance.rank!(withButton, ctx)).toBeGreaterThan(STYLES.performance.rank!(plain, ctx))
  })

  it('editorial: less text share ranks higher; more than 3 distinct sizes ranks lower', () => {
    const t = (size: number) => ({ k: 't' as const, s: '', x: 0, top: 0, size, wt: 400, ls: 0, lh: 1, role: 'title' })
    const boxes = new Map<object, { x0: number; y0: number; x1: number; y1: number }>()
    const small = { els: [t(10)], did: '' }
    boxes.set(small.els[0]!, { x0: 0, y0: 0, x1: 10, y1: 10 })
    const big = { els: [t(10)], did: '' }
    boxes.set(big.els[0]!, { x0: 0, y0: 0, x1: 90, y1: 90 })
    const boxOf = (e: object) => boxes.get(e) ?? null
    expect(STYLES.editorial.rank!(small, { ...ctx, boxOf })).toBeGreaterThan(STYLES.editorial.rank!(big, { ...ctx, boxOf }))

    const fewSizes = { els: [t(10), t(10), t(12)], did: '' }
    const manySizes = { els: [t(10), t(12), t(14), t(16), t(18)], did: '' }
    expect(STYLES.editorial.rank!(fewSizes, ctx)).toBeGreaterThan(STYLES.editorial.rank!(manySizes, ctx))
  })

  it('street: a bigger title and more elements set over something both rank higher', () => {
    const small = { els: [{ k: 't' as const, s: '', x: 0, top: 0, size: 10, wt: 700, ls: 0, lh: 1, role: 'title' }], did: '' }
    const big = { els: [{ k: 't' as const, s: '', x: 0, top: 0, size: 40, wt: 700, ls: 0, lh: 1, role: 'title' }], did: '' }
    expect(STYLES.street.rank!(big, ctx)).toBeGreaterThan(STYLES.street.rank!(small, ctx))

    const bare = { els: [{ k: 't' as const, s: '', x: 0, top: 0, size: 10, wt: 700, ls: 0, lh: 1, role: 'title' }], did: '' }
    const layered = { els: [...bare.els, { k: 'p' as const, x: 0, y: 0, w: 10, h: 10, role: 'photo', over: ['title'] }], did: '' }
    expect(STYLES.street.rank!(layered, ctx)).toBeGreaterThan(STYLES.street.rank!(bare, ctx))
  })
})

describe('the sheet takes a style', () => {
  it.each(IDS)('%s: DISPLAY and INFO come from the table; SECOND keeps its Swiss values', id => {
    const S = makeSheet({ frameW: 895, frameH: 1280, measure, style: id })
    const st = STYLES[id]
    expect(S.DISPLAY).toMatchObject({ role: 'title', wt: st.display.wt, ls: st.display.ls, lh: st.display.lh })
    expect(S.INFO).toMatchObject({ role: 'caption', wt: st.info.wt, ls: st.info.ls, lh: st.info.lh })
    expect(!!S.DISPLAY.upper).toBe(!!st.display.upper)
    expect(!!S.INFO.upper).toBe(!!st.info.upper)
    expect(S.SECOND).toMatchObject({ role: 'details', wt: 500, ls: -0.02, lh: 1.04 })
  })

  /** Everything a sheet is, as data: its numbers and styles plus what every Swiss layout draws. */
  const snapshot = (S: Sheet) => {
    const kinds: Kind[] = ['word', 'phrase', 'sentence']
    const drawn = LAYOUTS.flatMap(def => def.fits.filter(k => kinds.includes(k)).flatMap(kind =>
      [false, true].map(ph => {
        const c: Content = { title: KIND_TITLES[kind], ...TEXTS }
        let seed = 7
        const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
        const words = c.title.split(' ')
        try {
          return def.fn(S, { c, kind, ph, r, words, lines: [c.title], arr: 0 })
        } catch (e) {
          return { threw: String(e) }
        }
      })))
    const { M, G, NC, CW, RH, GAP, CAP, B, W, H, DISPLAY, SECOND, INFO } = S
    return { M, G, NC, CW, RH, GAP, CAP, B, W, H, DISPLAY, SECOND, INFO, drawn }
  }

  it.each(FRAMES)('a swiss or style-less sheet is exactly today\'s sheet (%i×%i)', (w, h) => {
    const none = makeSheet({ frameW: w, frameH: h, measure })
    const swiss = makeSheet({ frameW: w, frameH: h, measure, style: 'swiss' })
    // Today's literal Stage 1 styles, pinned (no `upper` key at all).
    expect(none.DISPLAY).toStrictEqual({ role: 'title', wt: 600, ls: -0.05, lh: 0.9 })
    expect(none.INFO).toStrictEqual({ role: 'caption', size: none.INFO.size, wt: 400, ls: 0, lh: 1.3 })
    const snap = snapshot(none)
    // Not vacuous: the Swiss layouts really drew (a few may refuse a frame by throwing, alike on both).
    expect(snap.drawn.filter(d => 'els' in d).length).toBeGreaterThan(100)
    expect(snapshot(swiss)).toStrictEqual(snap)
    // Swiss elements never carry `upper`.
    expect(JSON.stringify(snap.drawn)).not.toContain('"upper":')
  })
})

describe('letter case', () => {
  const frame = { w: 1000, h: 1250 }
  const targets = { title: 't', details: 'd', date: 'dt', caption: 'c' }

  it('the stub measures capitals wider only when `upper` is set', () => {
    expect(measure.w100('Echoes', 'title', 0)).toBe(6 * 55)
    expect(measure.w100('ECHOES', 'title', 0)).toBe(6 * 55)       // unchanged without the flag
    expect(measure.w100('Echoes', 'title', 0, true)).toBe(6 * 70)
    expect(measure.w100('1-2', 'title', 0, true)).toBe(3 * 55)     // no letters, no change
    expect(measure.lines('ab cd', 'caption', 10, 0, 100, true)).toEqual(['AB CD'])
  })

  it('an upper display element measures wider and its op carries textTransform uppercase', () => {
    const street = makeSheet({ frameW: frame.w, frameH: frame.h, measure, style: 'street' })
    const swiss = makeSheet({ frameW: frame.w, frameH: frame.h, measure })
    const up = street.disp('Echoes', { x: 10, top: 10, size: 10 })
    const plain = swiss.disp('Echoes', { x: 10, top: 10, size: 10, ls: street.DISPLAY.ls, lh: street.DISPLAY.lh })
    expect(up.upper).toBe(true)
    expect('upper' in plain).toBe(false)
    // The sheet sizes it as capitals: a smaller fitted size for the same width.
    expect(street.fitSize(['Echoes'], 50)).toBeLessThan(street.fitSize(['Echoes'], 50, { ...street.DISPLAY, upper: false }))
    // The checker's box is wider.
    const bu = boxOf(up, street)!, bp = boxOf(plain, swiss)!
    expect(bu.x1 - bu.x0).toBeGreaterThan(bp.x1 - bp.x0)
    const { ops } = elementsToOps([up], street, targets, frame)
    expect(ops[0]!.textTransform).toBe('uppercase')
    const { ops: plainOps } = elementsToOps([plain], swiss, targets, frame)
    expect('textTransform' in plainOps[0]!).toBe(false)
  })

  it('an upper info (flow) element carries textTransform uppercase and wraps as capitals', () => {
    const ed = makeSheet({ frameW: frame.w, frameH: frame.h, measure, style: 'editorial' })
    const e = ed.info(TEXTS.details, { x: 10, top: 10, w: 40, role: 'details' })
    expect(e.upper).toBe(true)
    const { ops } = elementsToOps([e], ed, targets, frame)
    expect(ops[0]!.textTransform).toBe('uppercase')
    expect(ops[0]!.runs).toBeUndefined()
    // Display in Editorial is not upper.
    expect('upper' in ed.disp('Echoes', { x: 0, top: 0, size: 10 })).toBe(false)
  })
})

describe('apply tracks textTransform', () => {
  const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
  const layer = (over: Record<string, unknown> = {}): LocalLayer => ({
    id: 't', kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'Echoes',
    fontFamily: 'Inter', fontWeight: 700, fontSize: 0.08, color: '#000000', align: 'center',
    lineHeight: 1.2, strokeColor: '#000', strokeWidth: 0, ...over,
  }) as any
  const elements = { title: { role: 'title', id: 't', text: 'Echoes', words: ['Echoes'] } } as unknown as FrameElements
  const upOp: PatternPlacement = { did: 'x', ops: [{ target: 'title', kind: 'text', x: 0.2, y: 0.3, fontSize: 0.1, textTransform: 'uppercase' }] }
  const plainOp: PatternPlacement = { did: 'y', ops: [{ target: 'title', kind: 'text', x: 0.4, y: 0.3, fontSize: 0.1 }] }

  it('no case of its own: set, then removed when a later op leaves it unset', () => {
    const a = applyPlacement([layer()], upOp, elements, palette)[0] as any
    expect(a.textTransform).toBe('uppercase')
    const b = applyPlacement([a], plainOp, elements, palette)[0] as any
    expect('textTransform' in b).toBe(false)
    expect(b.layoutPrev).toBeUndefined()
  })

  it('the user\'s own lowercase comes back', () => {
    const a = applyPlacement([layer({ textTransform: 'lowercase' })], upOp, elements, palette)[0] as any
    expect(a.textTransform).toBe('uppercase')
    const b = applyPlacement([a], plainOp, elements, palette)[0] as any
    expect(b.textTransform).toBe('lowercase')
  })

  it('a case the user changed while the layout held is kept', () => {
    const a = applyPlacement([layer()], upOp, elements, palette)[0] as any
    const edited = { ...a, textTransform: 'capitalize' }
    const b = applyPlacement([edited], plainOp, elements, palette)[0] as any
    expect(b.textTransform).toBe('capitalize')
  })
})

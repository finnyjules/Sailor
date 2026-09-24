import { describe, it, expect } from 'vitest'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { STYLES } from '~/lib/frame/patterns/kit/styles'
import { boxOf } from '~/lib/frame/patterns/kit/check'
import { elementsToOps } from '~/lib/frame/patterns/kit/toOps'
import { applyPlacement } from '~/lib/frame/patterns/apply'
import { candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { El, TextEl } from '~/lib/frame/patterns/kit/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
import { AD_LOGO, adFrameLayers, frameLayers, palette } from './helpers/frameLayoutFixtures'

// Frame layout decisions, Task 3: small banners and long dates.

const measure = makeStubMeasure()

describe('Performance on a small format: the image may be up to 70% hidden', () => {
  const check = STYLES.performance.check!
  const H = 100 * 250 / 300
  /** The photo over the whole frame, and a card hiding `share` of it. */
  const els = (share: number): El[] => [
    { k: 'p', x: 0, y: 0, w: 100, h: H, role: 'photo' },
    { k: 'r', x: 0, y: 0, w: 100, h: H * share, role: 'card' },
  ]

  it('under 336 px of design width, up to 70% may be hidden', () => {
    expect(check(els(0.62), { W: 100, H, designW: 300 })).toEqual([])
    expect(check(els(0.69), { W: 100, H, designW: 320 })).toEqual([])
    expect(check(els(0.72), { W: 100, H, designW: 300 })).toEqual(['the image is mostly hidden'])
  })

  it('336 px and wider, or with no design width, the limit stays 55%', () => {
    expect(check(els(0.62), { W: 100, H, designW: 336 })).toEqual(['the image is mostly hidden'])
    expect(check(els(0.62), { W: 100, H, designW: 1080 })).toEqual(['the image is mostly hidden'])
    expect(check(els(0.62), { W: 100, H })).toEqual(['the image is mostly hidden'])
    expect(check(els(0.5), { W: 100, H })).toEqual([])
  })

  const perf = (preset: string, w: number, h: number, layoutId: string, o: { action: boolean; logo: boolean; kind?: 'word' | 'phrase' | 'sentence' }) =>
    candidatesForFrame({
      props: { sailor_localLayers: adFrameLayers(o.kind ?? 'phrase', { image: true, action: o.action }), sailor_frame: { preset } },
      frameW: w, frameH: h, layoutId, palette, connectedSlots: [], measure, style: 'performance',
      ...(o.logo ? { brandLogo: { ...AD_LOGO } } : {}),
    })

  it('300×250 with a button and a logo: Card (66.7–68.9% hidden) is offered, and every candidate plans cleanly', () => {
    const cands = perf('ad-300x250', 300, 250, 'perfCard', { action: true, logo: true })
    expect(cands.length).toBeGreaterThan(0)
    for (const c of cands) {
      const plan = planLayout({
        props: { sailor_localLayers: adFrameLayers('phrase', { image: true, action: true }), sailor_frame: { preset: 'ad-300x250' } },
        frameW: 300, frameH: 250, layoutId: 'perfCard', palette, connectedSlots: [], measure, style: 'performance',
        brandLogo: { ...AD_LOGO }, choice: c.choice,
      })!
      expect(plan.issues).toEqual([])
    }
  })

  it('the same pieces on a wider design keep the 55% limit', () => {
    const [c] = perf('ad-300x250', 300, 250, 'perfCard', { action: true, logo: true })
    const els = c!.out.els
    expect(check(els, { W: 100, H, designW: 300 })).toEqual([])
    expect(check(els, { W: 100, H, designW: 1080 })).toEqual(['the image is mostly hidden'])
    expect(check(els, { W: 100, H })).toEqual(['the image is mostly hidden'])
  })

  it('320×50: nothing new — only Strip, as before (the others fail on type size, not the image)', () => {
    // Measured when Task 3 landed: Offer, Card, Centred and Price tag set the title and "–30%"
    // below the 2.81 floor; Sticker's "–30%" is too small for its sticker; Offer first has no
    // room for the image; Post-it runs off the page. Strip passes for the word and the phrase;
    // the sentence's title is below the floor even there.
    for (const kind of ['word', 'phrase', 'sentence'] as const) for (const action of [false, true]) for (const logo of [false, true]) {
      const offered = layoutsForStyle('performance').filter(d => perf('ad-320x50', 320, 50, d.id, { action, logo, kind }).length).map(d => d.id)
      expect(offered, `${kind} ${action} ${logo}`).toEqual(kind === 'sentence' ? [] : ['perfStrip'])
    }
  })

  it('the planner passes the format\'s own width, not the Frame\'s size on screen', () => {
    // A 300×250 banner stored at twice its size (600×500): still a 300 px design.
    const base = { palette, connectedSlots: [], measure, style: 'performance' as const, layoutId: 'perfCard' }
    const props = (preset?: string) => ({
      sailor_localLayers: frameLayers('word', { image: true, shape: false, date: '–30%' }),
      ...(preset ? { sailor_frame: { preset } } : {}),
    })
    const at2x = candidatesForFrame({ ...base, props: props('ad-300x250'), frameW: 600, frameH: 500 })
    const at1x = candidatesForFrame({ ...base, props: props('ad-300x250'), frameW: 300, frameH: 250 })
    expect(at2x.map(c => JSON.stringify(c.choice))).toEqual(at1x.map(c => JSON.stringify(c.choice)))
  })
})

describe('a date range may break after its dash', () => {
  const S = makeSheet({ frameW: 1000, frameH: 1500, measure, format: { view: 236 }, breakDates: true })
  const st = { role: 'date' as const, ls: 0, lh: 1.3 }
  const size = S.INFO.size
  const one = (s: string) => measure.w100(s, 'date', 0) * size / 100

  it('breaks "19.09.–15.11.2026" after the en dash when it does not fit, and nowhere else', () => {
    const w = one('19.09.–15.11.2026') - 1
    expect(S.countLines('19.09.–15.11.2026', w, st, size)).toBe(2)
    const e = S.info('19.09.–15.11.2026', { x: 0, w, top: 0, role: 'date' })
    expect(e.pre).toBe(true)
    expect(e.s).toBe('19.09.–\n15.11.2026')
    // The user's characters, unchanged: only a line break between them.
    expect(e.s.replace('\n', '')).toBe('19.09.–15.11.2026')
  })

  it('breaks after a hyphen between two dates', () => {
    const s = '19.09.-15.11.2026'
    const e = S.info(s, { x: 0, w: one(s) - 1, top: 0, role: 'date' })
    expect(e.s).toBe('19.09.-\n15.11.2026')
  })

  it('a date that fits stays one flowing line, exactly as before', () => {
    const w = one('19.09.–15.11.2026') + 1
    expect(S.countLines('19.09.–15.11.2026', w, st, size)).toBe(1)
    const e = S.info('19.09.–15.11.2026', { x: 0, w, top: 0, role: 'date' })
    expect(e.pre).toBeUndefined()
    expect(e.s).toBe('19.09.–15.11.2026')
  })

  it('a sheet without `breakDates` never breaks a date — every line wraps as the renderer does', () => {
    const plain = makeSheet({ frameW: 1000, frameH: 1500, measure, format: { view: 236 } })
    const w = one('19.09.–15.11.2026') - 1
    expect(plain.countLines('19.09.–15.11.2026', w, st, size)).toBe(1)
    const e = plain.info('19.09.–15.11.2026', { x: 0, w, top: 0, role: 'date' })
    expect(e.pre).toBeUndefined()
    expect(e.s).toBe('19.09.–15.11.2026')
  })

  it('never breaks at a dash that is not between two dates, nor outside the date line', () => {
    for (const s of ['–30%', '2026-09-19', 'Jean-Luc', '19.09.2026', 'Sept–Nov']) {
      const e = S.info(s, { x: 0, w: 1, top: 0, role: 'date' })
      expect(e.pre, s).toBeUndefined()
      expect(e.s, s).toBe(s)
    }
    const cap = S.info('19.09.–15.11.2026', { x: 0, w: 1, top: 0, role: 'caption' })
    expect(cap.s).toBe('19.09.–15.11.2026')
    expect(S.countLines('19.09.–15.11.2026', 1, { ...st, role: 'caption' }, size)).toBe(1)
  })

  it('what is measured is what is drawn: the op carries the two lines, the layer keeps its text', () => {
    const w = one('19.09.–15.11.2026') - 1
    const e = S.info('19.09.–15.11.2026', { x: 10, w, top: 20, role: 'date' }) as TextEl
    const box = boxOf(e, S)!
    expect(box.y1 - box.y0).toBeCloseTo((1 * e.lh + 0.7) * e.size, 9)
    expect(box.x1 - box.x0).toBeCloseTo(one('15.11.2026'), 9)
    const { ops } = elementsToOps([e], S, { date: 'dt' }, { w: 1000, h: 1500 })
    expect(ops[0]!.runs!.map(r => r.text)).toEqual(['19.09.–', '15.11.2026'])
    const layer = { id: 'dt', kind: 'text', text: '19.09.–15.11.2026', fontSize: 0.03, x: 0.5, y: 0.5 } as unknown as LocalLayer
    const [next] = applyPlacement([layer], { ops } as never, { date: { id: 'dt' } } as never, palette as never)
    expect((next as { text: string }).text).toBe('19.09.–15.11.2026')
  })

  it('Pinterest with the long date: a layout that was refused for the date now plans cleanly', () => {
    const a = {
      props: { sailor_localLayers: frameLayers('phrase', { image: false, shape: false }), sailor_frame: { preset: 'pinterest-2x3' } },
      frameW: 1000, frameH: 1500, layoutId: 'statement', palette, connectedSlots: [], measure,
    }
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    // Statement was not offered here before Task 3 (only Index, Tilt and Number behind were).
    const plan = planLayout({ ...a, choice: cands[0]!.choice })!
    expect(plan.issues).toEqual([])
    const dt = plan.layers.find(l => l.id === 'dt') as { text: string; runs?: { text: string }[] }
    expect(dt.text).toBe('19.09.–15.11.2026')
    expect(dt.runs?.map(r => r.text)).toEqual(['19.09.–', '15.11.2026'])
  })
})

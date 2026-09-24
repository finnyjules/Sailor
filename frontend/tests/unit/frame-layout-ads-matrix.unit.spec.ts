import { describe, it, expect } from 'vitest'
import { candidatesForFrame, contentForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { boxOf } from '~/lib/frame/patterns/kit/check'
import { CATALOG, layoutById, layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import type { El } from '~/lib/frame/patterns/kit/types'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import { createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer, TextLayer } from '~/composables/useCompositorLayers'
import { adFrameLayers, palette } from './helpers/frameLayoutFixtures'

// ═══════════════════════ the ad content matrix (Stage 4, Task 4) ═══════════════════════
// The four layouts built around ad content — Offer first (a number), Stat (a stat), Review (a
// review), Us vs them (a comparison) — × five frames (portrait, square, story, feed 4:5, 300×250)
// × with an image × {with action, without}, on the full ad fixture (every kind of content at once),
// through the real planner with Performance asked for. For every candidate: no checker issues;
// every text — the user's and the layout's own words — at least the floor; the platform's own
// button only beside a drawn one (R11/R11b); every line placed shows and every line not placed is
// hidden; no owned text on the raw image. Each layout is offered at least once per combination
// unless EXPECTED_THIN names it with its measured reason. A Frame without the content a layout is
// built around never offers it.

type Frame = { id: string; w: number; h: number; preset?: string }
const fmt = (id: string): Frame => { const f = FRAME_FORMATS.find(x => x.id === id)!; return { id, w: f.w, h: f.h, preset: id } }
const FRAMES: Frame[] = [
  { id: 'portrait', w: 895, h: 1280 },
  { id: 'square', w: 1080, h: 1080 },
  fmt('meta-story'),
  fmt('meta-feed-4x5'),
  fmt('ad-300x250'),
]
const ADS = ['perfOfferFirst', 'perfStat', 'perfReview', 'perfVersus'] as const
type AdId = typeof ADS[number]

/** The ad fixture's lines: id, text, font size. Sizes keep inference unambiguous: the title the
 *  largest, the stat's line the next-smaller text after the stat (ruling R2). */
const LINES = {
  t: ['Run lighter.', 0.12],
  s: ['198 g', 0.06],
  sl: ['Our lightest trail shoe yet.', 0.045],
  d: ['Halden Trail 2', 0.04],
  q: ['“Lightest shoe I have ever raced in.”', 0.035],
  dt: ['–30%', 0.03],
  a: ['Shop now', 0.025],
  r: ['4.7 ★', 0.022],
  l: ['Carbon plate for push-off\n198 g per shoe\nGrips on wet rock\nFree returns for 60 days', 0.022],
  c: ['Offer ends 12 October. While stocks last.', 0.02],
  v: ['vs a typical trail shoe', 0.02],
  b: ['— Maya R., verified buyer', 0.018],
} as const
type LineId = keyof typeof LINES

/** The full ad Frame; `without` leaves lines out, `action: false` the action line. */
function fullAdLayers(o: { action: boolean; without?: LineId[] }): LocalLayer[] {
  const out: LocalLayer[] = []
  for (const [id, [text, fontSize]] of Object.entries(LINES) as [LineId, readonly [string, number]][]) {
    if (id === 'a' && !o.action) continue
    if (o.without?.includes(id)) continue
    out.push(createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer)
  }
  out.push(createImageLayer('x.png', 1.25, { id: 'img', w: 0.5, h: 0.625 }) as LocalLayer)
  return out
}

const argsFor = (id: string, f: Frame, layers: LocalLayer[]): Omit<LayoutPlanArgs, 'choice'> => ({
  props: { sailor_localLayers: layers, ...(f.preset ? { sailor_frame: { preset: f.preset } } : {}) },
  frameW: f.w, frameH: f.h, layoutId: id, palette, connectedSlots: [], measure: makeStubMeasure(), style: 'performance',
})

type Combo = { frame: string; action: boolean }
/** Layouts allowed to be offered nothing on a combination, with the reason measured when written. */
// Measured with the stub measure, every choice (both line breaks, full and quieter):
const EXPECTED_THIN: { layout: AdId; frame: string; action?: boolean; reason: string }[] = [
  // The story shows only 90.7 of its 177.8 height. With a button the foot band hides 58.6–62.8% of
  // the image under the panel (limit 55%); the platform's own button would pass (31.6–33.9%), but it
  // is an alternative, never a rescue (ruling R11) — as Stage 3's Offer with a logo on the story.
  { layout: 'perfOfferFirst', frame: 'meta-story', action: true,
    reason: 'story with a button: the foot band hides 58.6–62.8% of the image (limit 55%); native would pass but never rescues (R11)' },
  // 300×250 (H 83.3): the panel leaves the image 35.8–38.1 tall; with a button the foot band over it
  // hides 74.9–79.8% (without one, 32.4–34.5% — offered).
  { layout: 'perfOfferFirst', frame: 'ad-300x250', action: true,
    reason: '300×250 with a button: the foot band hides 74.9–79.8% of the image (limit 55%)' },
  // 300×250: under the stat (24.2 / 22.6) and its line, the image gets 15.0–16.5 without a button
  // (offered; the minimum is 3 rows, 14.13); the button's row takes 16.2 more, leaving none.
  { layout: 'perfStat', frame: 'ad-300x250', action: true,
    reason: '300×250 with a button: the button\'s row leaves the image less than 3 rows (14.13; 15.0–16.5 without it)' },
  // 300×250: headline, the product image, headings and four rows end at 90.9–92.6 on a page 83.3
  // tall, before the offer — the table alone overruns the banner.
  { layout: 'perfVersus', frame: 'ad-300x250',
    reason: '300×250: the table alone ends at 90.9–92.6 on a page 83.3 tall' },
  // The story composes in the 90.7 its bars leave uncovered: the table ends 88.5–90.3 into that
  // band, and the offer (fine print, number, button) has no room under it; its last rows run into
  // the number and the fine print.
  { layout: 'perfVersus', frame: 'meta-story',
    reason: 'story: the table ends 88.5–90.3 into the 90.7 the bars leave uncovered; no room for the offer' },
]
const thinFor = (id: AdId, c: Combo) => EXPECTED_THIN.find(e => e.layout === id && e.frame === c.frame && (e.action === undefined || e.action === c.action))

const combos: Combo[] = FRAMES.flatMap(f => [false, true].map(action => ({ frame: f.id, action })))

describe('the ad content is read as the layouts expect', () => {
  it('the full fixture reads as a review, a list, a comparison and a stat, and keeps its base roles', () => {
    const read = contentForFrame({ props: { sailor_localLayers: fullAdLayers({ action: true }) }, frameW: 1080, frameH: 1080 })
    expect(read.roles).toMatchObject({ title: 't', details: 'd', date: 'dt', caption: 'c', action: 'a', quote: 'q', by: 'b', rating: 'r', list: 'l', stat: 's', statline: 'sl', them: 'v' })
    expect(read.review).toEqual({ stars: 4.7, quote: LINES.q[0], by: LINES.b[0] })
    expect(read.stat).toEqual({ value: '198 g', line: 'Our lightest trail shoe yet.' })
    expect(read.compare?.them).toBe('a typical trail shoe')
    expect(read.compare?.rows).toHaveLength(4)
  })
})

describe('ad content matrix — the four layouts through the real planner', () => {
  let checked = 0
  let natives = 0
  it.each(combos.map(c => [`${c.frame} · ${c.action ? 'action' : 'no action'}`, c] as const))('%s', (_label, c) => {
    const f = FRAMES.find(x => x.id === c.frame)!
    const format = f.preset ? FRAME_FORMATS.find(x => x.id === f.preset)! : null
    const S = makeSheet({ frameW: f.w, frameH: f.h, measure: makeStubMeasure(), style: 'performance', ...(format ? { format: { view: format.view, nc: format.nc } } : {}) })
    const floor = (format ? 900 / format.view! : S.INFO.size) - 0.01
    const layers = fullAdLayers({ action: c.action })
    const read = contentForFrame({ props: argsFor('perfStat', f, layers).props, frameW: f.w, frameH: f.h })
    const roleOfId = new Map(Object.entries(read.roles).filter(([r]) => r !== 'image2').map(([r, id]) => [id!, r]))
    for (const id of ADS) {
      const a = argsFor(id, f, layers)
      const cands = candidatesForFrame(a)
      const thin = thinFor(id, c)
      if (thin) expect(cands.length, `EXPECTED_THIN ${id} (${thin.reason})`).toBe(0)
      else expect(cands.length, `${id}: not offered`).toBeGreaterThan(0)
      if (!cands.length) continue
      // Rulings R11 / R11b: a drawn candidate passes, and the first one is drawn.
      expect.soft(cands.some(cd => (cd.choice.cta ?? 'drawn') === 'drawn'), `${id}: every candidate is native`).toBe(true)
      expect.soft(cands[0]!.choice.cta ?? 'drawn', `${id}: first candidate`).toBe('drawn')
      for (const cand of cands) {
        const label = `${id} ${JSON.stringify(cand.choice)}`
        const plan = planLayout({ ...a, choice: cand.choice })!
        expect.soft(plan, label).not.toBeNull()
        expect.soft(plan.issues, label).toEqual([])
        const els = cand.out.els
        // The floor: the user's text and the layout's own words alike.
        for (const e of els) {
          if (e.k !== 't' && e.k !== 'ring' && e.k !== 'own') continue
          expect.soft(e.size, `${e.role} size · ${label}`).toBeGreaterThanOrEqual(floor)
        }
        // The platform's own button draws none and hides the action line.
        if (cand.choice.cta === 'native') {
          natives++
          expect.soft(els.some(e => e.k === 'btn'), `native draws a button · ${label}`).toBe(false)
          expect.soft(plan.notPlaced.map(n => n.role), label).toContain('action')
        }
        if (!c.action) expect.soft(els.some(e => e.k === 'btn'), `button without an action · ${label}`).toBe(false)
        // Every line placed shows; every line not placed is hidden (and named).
        const placed = new Set(els.filter(e => e.k === 't' || e.k === 'ring').map(e => (e.role ?? '').replace(/\d+$/, '')))
        for (const l of plan.layers) {
          if (l.kind !== 'text' || (l as { owner?: unknown }).owner) continue
          const role = roleOfId.get(l.id)
          if (!role) continue
          const hidden = !placed.has(role) || !!plan.format?.hidden.includes(role as never)
          expect.soft((l as { visible?: boolean }).visible === false, `${l.id} (${role}) ${hidden ? 'not hidden' : 'hidden though placed'} · ${label}`).toBe(hidden)
        }
        expect.soft(plan.notPlaced.every(n => !placed.has(n.role)), label).toBe(true)
        // Carried over from Task 2: owned text never sits on the raw image (rule 10 checks only the
        // user's text) — none of these four lays its own words over the image at all.
        const photos = els.filter(e => e.k === 'p').map(e => boxOf(e, S)!)
        for (const e of els) {
          if (e.k !== 'own') continue
          const b = boxOf(e, S)!
          for (const p of photos) {
            const over = Math.min(b.x1, p.x1) - Math.max(b.x0, p.x0) > 0.25 && Math.min(b.y1, p.y1) - Math.max(b.y0, p.y0) > 0.25
            expect.soft(over, `${e.role} on the image · ${label}`).toBe(false)
          }
        }
        checked++
      }
    }
  })

  it('checks a real number of candidates', () => {
    expect(checked).toBeGreaterThan(combos.length * ADS.length)
    // The platform's own button reaches these layouts too (the feed and the story draw their own).
    expect(natives).toBeGreaterThan(0)
  })

  it('every EXPECTED_THIN entry names a frame and a layout of the matrix', () => {
    for (const e of EXPECTED_THIN) {
      expect(FRAMES.some(f => f.id === e.frame), e.frame).toBe(true)
      expect(ADS as readonly string[]).toContain(e.layout)
    }
  })
})

describe('what each layout places (rulings R4, R5, R10)', () => {
  const square = FRAMES[1]!
  const first = (id: AdId, layers = fullAdLayers({ action: true })) => {
    const a = argsFor(id, square, layers)
    const cand = candidatesForFrame(a)[0]!
    return { cand, plan: planLayout({ ...a, choice: cand.choice })! }
  }
  const textOf = (els: El[], role: string) => els.filter(e => e.k === 't' && (e.role ?? '').replace(/\d+$/, '') === role)

  it('Review places the quote as written (no quote marks added), the stars as owned shapes and the user\'s rating line', () => {
    const { cand, plan } = first('perfReview')
    const q = textOf(cand.out.els, 'quote')
    expect(q).toHaveLength(1)
    expect(q[0]!.k === 't' && q[0]!.s.replace(/\n/g, ' ')).toBe(LINES.q[0])
    expect(textOf(cand.out.els, 'by').map(e => e.k === 't' && e.s)).toEqual([LINES.b[0]])
    expect(textOf(cand.out.els, 'rating').map(e => e.k === 't' && e.s)).toEqual([LINES.r[0]])
    expect(plan.layers.filter(l => (l as { owner?: { key: string } }).owner?.key.startsWith('stars-'))).toHaveLength(5)
  })

  it('Us vs them places the list as runs of the one list layer, ✓/✕ as owned text, and the user\'s "vs" line', () => {
    const { cand, plan } = first('perfVersus')
    expect(textOf(cand.out.els, 'list')).toHaveLength(4)
    const list = plan.layers.find(l => l.id === 'l') as TextLayer
    expect(list.text).toBe(LINES.l[0])                          // the user's text is untouched
    expect(list.runs?.map(r => r.text)).toEqual(LINES.l[0].split('\n'))
    expect(textOf(cand.out.els, 'them').map(e => e.k === 't' && e.s)).toEqual([LINES.v[0]])
    expect(textOf(cand.out.els, 'details').map(e => e.k === 't' && e.s)).toEqual([LINES.d[0]])
    const own = plan.layers.filter(l => (l as { owner?: { key: string } }).owner?.key.startsWith('own-')) as TextLayer[]
    expect(own.map(l => l.text).sort()).toEqual(['✓', '✓', '✓', '✓', '✕', '✕', '✕', '✕'])
    // Ruling R10: the caption layer's family and weight.
    for (const l of own) expect([l.fontFamily, l.fontWeight]).toEqual(['Inter', 600])
  })

  it('Us vs them keeps the user\'s markers (ruling R5) and draws a "both" row ticked twice', () => {
    const layers = fullAdLayers({ action: true }).map(l => l.id === 'l'
      ? { ...l, text: '• Carbon plate\n• Under 200 g\n• Free returns ✓✓' } as LocalLayer : l)
    const { cand } = first('perfVersus', layers)
    expect(textOf(cand.out.els, 'list').map(e => e.k === 't' && e.s)).toEqual(['• Carbon plate', '• Under 200 g', '• Free returns'])
    const glyphs = cand.out.els.filter(e => e.k === 'own' && /^th\d/.test(e.role)).map(e => e.k === 'own' && e.s)
    expect(glyphs).toEqual(['✕', '✕', '✓'])
  })

  it('Offer first sets the number, headline and fine print on an owned panel whose fill the contrast picker chose', () => {
    const { cand, plan } = first('perfOfferFirst')
    const panel = cand.out.els.find(e => e.k === 'r' && e.role === 'panel')
    expect(panel).toBeDefined()
    expect(plan.layers.some(l => (l as { owner?: { key: string } }).owner?.key === 'panel-0')).toBe(true)
    for (const role of ['date', 'title', 'caption']) expect(textOf(cand.out.els, role), role).toHaveLength(1)
    // The content lines it does not place are hidden and named, not left where they were.
    expect(plan.notPlaced.map(n => n.role).sort()).toEqual(['by', 'list', 'quote', 'rating', 'stat', 'statline', 'them'])
  })

  it('Offer first\'s panel prefers the accent (ruling R12): accent when the text reads on it, else the picker\'s own order', () => {
    const panelFill = (pal: typeof palette) => {
      const a = { ...argsFor('perfOfferFirst', square, fullAdLayers({ action: true })), palette: pal }
      const cand = candidatesForFrame(a)[0]!
      const plan = planLayout({ ...a, choice: cand.choice })!
      return (plan.layers.find(l => (l as { owner?: { key: string } }).owner?.key === 'panel-0') as { fill?: unknown }).fill
    }
    // #111111 on #dd2200 reads (3.8:1): the preferred accent holds.
    expect(panelFill(palette)).toBe(palette.accent)
    // A dark accent does not carry #111111: the picker falls through to its own order (field first).
    const dark = { ...palette, accent: '#2a2a2a' }
    expect(panelFill(dark)).toBe(dark.field)
  })

  it('Stat places the stat and its line; the number is left to the figure', () => {
    const { cand } = first('perfStat')
    expect(textOf(cand.out.els, 'stat').map(e => e.k === 't' && e.s)).toEqual(['198 g'])
    expect(textOf(cand.out.els, 'statline').map(e => e.k === 't' && e.s)).toEqual([LINES.sl[0]])
  })
})

describe('a Frame without the content never offers the layout', () => {
  const MISSING: Record<AdId, LineId[]> = {
    perfOfferFirst: ['dt'],
    perfStat: ['s'],
    perfReview: ['q'],
    perfVersus: ['v'],
  }
  it.each(ADS)('%s', id => {
    for (const f of FRAMES) for (const action of [false, true]) {
      const layers = fullAdLayers({ action, without: MISSING[id] })
      expect(candidatesForFrame(argsFor(id, f, layers)), `${id} ${f.id} ${action}`).toEqual([])
    }
  })

  it('the Stage 3 ad Frame offers Offer first (it has a number) and none of the other three', () => {
    for (const f of FRAMES) {
      const layers = adFrameLayers('phrase', { image: true, action: true })
      for (const id of ['perfStat', 'perfReview', 'perfVersus']) expect(candidatesForFrame(argsFor(id, f, layers)), `${id} ${f.id}`).toEqual([])
    }
    expect(candidatesForFrame(argsFor('perfOfferFirst', FRAMES[0]!, adFrameLayers('phrase', { image: true, action: true }))).length).toBeGreaterThan(0)
  })

  it('never to another style', () => {
    const layers = fullAdLayers({ action: true })
    for (const id of ADS) for (const style of [undefined, 'swiss', 'editorial', 'street'] as const) {
      const { style: _s, ...a } = argsFor(id, FRAMES[1]!, layers)
      expect(candidatesForFrame({ ...a, ...(style ? { style } : {}) }), `${id} ${style}`).toEqual([])
    }
  })
})

describe('the catalog (seed order)', () => {
  it('the four are appended after Street, as Performance layouts with one line first', () => {
    expect(CATALOG.slice(57).map(l => l.id)).toEqual([...ADS])
    expect(layoutsForStyle('performance').slice(6).map(l => l.id)).toEqual([...ADS])
    for (const id of ADS) {
      const def = layoutById(id)!
      expect(def.style, id).toBe('performance')
      expect(def.oneLineFirst, id).toBe(true)
      expect(def.needsContent?.length, id).toBe(1)
    }
    // Every earlier layout reads the base view: none declares `needsContent`.
    expect(CATALOG.slice(0, 57).filter(l => l.needsContent)).toEqual([])
  })
})

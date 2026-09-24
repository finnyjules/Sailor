import { describe, it, expect } from 'vitest'
import { candidatesForFrame, contentForFrame, planLayout, EXTRA_MIN_TILE } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { boxOf, freeRects, inkBoxOf } from '~/lib/frame/patterns/kit/check'
import { CATALOG, layoutById, layoutsForStyle } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { pieceFills } from '~/lib/frame/patterns/kit/contrast'
import type { El } from '~/lib/frame/patterns/kit/types'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import { createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer, TextLayer } from '~/composables/useCompositorLayers'
import { adFrameLayers, palette } from './helpers/frameLayoutFixtures'

// ═══════════════════════ the ad content matrix (Stage 4, Tasks 4–5) ═══════════════════════
// The nine layouts built around ad content — Offer first (a number), Stat (a stat), Review (a
// review), Us vs them (a comparison), Before / after (a second image), Feature callouts, Reasons
// why and Notes app (a list), Post-it (no extra content) — × five frames (portrait, square, story, feed 4:5, 300×250)
// × with an image × {with action, without}, on the full ad fixture (every kind of content at once),
// through the real planner with Performance asked for. For every candidate: no checker issues;
// every text — the user's and the layout's own words — at least the floor; the platform's own
// button only beside a drawn one (R11/R11b); every line placed shows and every line not placed is
// hidden; owned text over an image only on a covering piece. Each layout is offered at least once per combination
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
const ADS = ['perfOfferFirst', 'perfStat', 'perfReview', 'perfVersus',
  'perfBeforeAfter', 'perfCallouts', 'perfListicle', 'perfNotes', 'perfPostit'] as const
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

/** The full ad Frame; `without` leaves lines out, `action: false` the action line; `image2` adds a
 *  second image after the first (Before / after). */
function fullAdLayers(o: { action: boolean; without?: LineId[]; image2?: boolean; colour?: string }): LocalLayer[] {
  const out: LocalLayer[] = []
  for (const [id, [text, fontSize]] of Object.entries(LINES) as [LineId, readonly [string, number]][]) {
    if (id === 'a' && !o.action) continue
    if (o.without?.includes(id)) continue
    out.push(createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: o.colour ?? '#111111' }) as LocalLayer)
  }
  out.push(createImageLayer('x.png', 1.25, { id: 'img', w: 0.5, h: 0.625 }) as LocalLayer)
  if (o.image2) out.push(createImageLayer('y.png', 1.25, { id: 'img2', w: 0.5, h: 0.625 }) as LocalLayer)
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
  // 300×250 (H 83.3; since Task 1 of the layout decisions the image sits below the table): the
  // headline, the headings and four rows end at 72.5–74.2, below where the offer at the foot begins
  // (59.2 with a button, 60.9 without) — the last rows run into the offer, and under the table there
  // is no room for the image (it needs a group gap, 10.2, then more than two rows).
  { layout: 'perfVersus', frame: 'ad-300x250',
    reason: '300×250: the table ends at 72.5–74.2, past the offer (from 59.2–60.9); no room for the image below it' },
  // The story composes in the 90.7 its bars leave uncovered: the table ends 88.5–90.3 into that
  // band, and the offer (fine print, number, button) has no room under it; its last rows run into
  // the number and the fine print.
  { layout: 'perfVersus', frame: 'meta-story',
    reason: 'story: the table ends 88.5–90.3 into the 90.7 the bars leave uncovered; no room for the offer' },
  // Task 5. 300×250 (H 83.3): between the headline (ends 21.4–23.1 with its group gap) and the offer
  // (starts 45.6 with a button, 48.9 without), each of the four reasons gets a slot of 5.60–6.90;
  // the prototype's minimum is three information sizes (9.00).
  { layout: 'perfListicle', frame: 'ad-300x250',
    reason: '300×250: each of the four reasons gets 5.60–6.90 (the minimum slot is 3 × the information size, 9.00)' },
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

describe('ad content matrix — the nine layouts through the real planner', () => {
  let checked = 0
  let natives = 0
  it.each(combos.map(c => [`${c.frame} · ${c.action ? 'action' : 'no action'}`, c] as const))('%s', (_label, c) => {
    const f = FRAMES.find(x => x.id === c.frame)!
    const format = f.preset ? FRAME_FORMATS.find(x => x.id === f.preset)! : null
    const S = makeSheet({ frameW: f.w, frameH: f.h, measure: makeStubMeasure(), style: 'performance', ...(format ? { format: { view: format.view, nc: format.nc } } : {}) })
    const floor = (format ? 900 / format.view! : S.INFO.size) - 0.01
    const layers = fullAdLayers({ action: c.action })
    // Before / after runs on the Frame with a second image; the other eight on the one-image Frame.
    const layers2 = fullAdLayers({ action: c.action, image2: true })
    const read = contentForFrame({ props: argsFor('perfStat', f, layers).props, frameW: f.w, frameH: f.h })
    const roleOfId = new Map(Object.entries(read.roles).filter(([r]) => r !== 'image2').map(([r, id]) => [id!, r]))
    for (const id of ADS) {
      const a = argsFor(id, f, id === 'perfBeforeAfter' ? layers2 : layers)
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
        // user's text) — over an image it lies inside a covering piece (a card, panel, sticker or
        // tag) drawn above that image (Before / after's labels on their cards).
        const COVERS = ['card', 'panel', 'sticker', 'tag']
        els.forEach((p, pi) => {
          if (p.k !== 'p') return
          const pb = boxOf(p, S)!
          const covers = els.slice(pi + 1).filter(e => e.k === 'r' && COVERS.includes(e.role ?? '')).map(e => boxOf(e, S)!)
          for (const e of els) {
            if (e.k !== 'own') continue
            const b = boxOf(e, S)!
            const over = Math.min(b.x1, pb.x1) - Math.max(b.x0, pb.x0) > 0.25 && Math.min(b.y1, pb.y1) - Math.max(b.y0, pb.y0) > 0.25
            if (!over) continue
            const covered = covers.some(k => b.x0 >= k.x0 - 0.05 && b.x1 <= k.x1 + 0.05 && b.y0 >= k.y0 - 0.05 && b.y1 <= k.y1 + 0.05)
            expect.soft(covered, `${e.role} on the raw image · ${label}`).toBe(true)
          }
        })
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

  it('Review places the quote as written (no quote marks added) and the user\'s rating line', () => {
    const { cand, plan } = first('perfReview')
    const q = textOf(cand.out.els, 'quote')
    expect(q).toHaveLength(1)
    expect(q[0]!.k === 't' && q[0]!.s.replace(/\n/g, ' ')).toBe(LINES.q[0])
    expect(textOf(cand.out.els, 'by').map(e => e.k === 't' && e.s)).toEqual([LINES.b[0]])
    expect(textOf(cand.out.els, 'rating').map(e => e.k === 't' && e.s)).toEqual([LINES.r[0]])
    // The fixture's rating ("4.7 ★") already shows a star glyph — Review draws no owned stars on
    // top of it (they would double up).
    expect(plan.layers.filter(l => (l as { owner?: { key: string } }).owner?.key.startsWith('stars-'))).toHaveLength(0)
  })

  it('Review draws its own stars only when the rating line carries no star glyph of its own; "did" says "stars" either way', () => {
    const glyphLayers = fullAdLayers({ action: true })
    const plain = fullAdLayers({ action: true }).map(l => l.id === 'r' ? { ...l, text: '4.7 out of 5' } as LocalLayer : l)
    const withGlyph = first('perfReview', glyphLayers)
    const withoutGlyph = first('perfReview', plain)
    expect(withGlyph.plan.layers.filter(l => (l as { owner?: { key: string } }).owner?.key.startsWith('stars-'))).toHaveLength(0)
    expect(withoutGlyph.plan.layers.filter(l => (l as { owner?: { key: string } }).owner?.key.startsWith('stars-'))).toHaveLength(5)
    expect(textOf(withoutGlyph.cand.out.els, 'rating').map(e => e.k === 't' && e.s)).toEqual(['4.7 out of 5'])
    expect(withGlyph.cand.out.did).toMatch(/stars and the quote/)
    expect(withoutGlyph.cand.out.did).toMatch(/stars and the quote/)
    // ☆ (an empty star) inside an already-recognised rating counts as a glyph too.
    const outline = fullAdLayers({ action: true }).map(l => l.id === 'r' ? { ...l, text: '★★★★☆' } as LocalLayer : l)
    expect(first('perfReview', outline).plan.layers.filter(l => (l as { owner?: { key: string } }).owner?.key.startsWith('stars-'))).toHaveLength(0)
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

  it('Us vs them: the product image sits below the table, full content width, filling what is left above the foot', () => {
    const { cand } = first('perfVersus')
    const S = makeSheet({ frameW: square.w, frameH: square.h, measure: makeStubMeasure(), style: 'performance' })
    const photo = cand.out.els.find(e => e.k === 'p')!
    expect(photo.role).toBe('photo')
    // Full content width (was a small column beside the headings in the prototype).
    expect(photo.k === 'p' && photo.x).toBeCloseTo(S.X(1), 1)
    expect(photo.k === 'p' && photo.w).toBeCloseTo(S.SPAN(1, 12), 1)
    // Below the table's last rule, not above the headings.
    const lastRuleY = Math.max(...cand.out.els.filter((e): e is El & { k: 'l' } => e.k === 'l').map(e => e.y))
    expect(photo.k === 'p' && photo.y).toBeGreaterThan(lastRuleY)
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

  // ── Task 5 ──
  const ownedOf = (plan: { layers: LocalLayer[] }, prefix: string) =>
    plan.layers.filter(l => (l as { owner?: { key: string } }).owner?.key.startsWith(prefix))
  const withList = (text: string, extra: Partial<Record<string, string>> = {}) => fullAdLayers({ action: true }).map(l => l.id === 'l'
    ? { ...l, text } as LocalLayer : extra[l.id] ? { ...l, color: extra[l.id] } as LocalLayer : l)

  it('Before / after: the first image left and the second right, no filter on either; "Before" / "After" are owned words on owned cards', () => {
    const { cand, plan } = first('perfBeforeAfter', fullAdLayers({ action: true, image2: true }))
    const photos = cand.out.els.filter(e => e.k === 'p')
    expect(photos.map(e => e.role)).toEqual(['photo', 'photo2'])
    for (const p of photos) expect(p.k === 'p' && p.filter, p.role).toBeFalsy()
    const img = plan.layers.find(l => l.id === 'img')!, img2 = plan.layers.find(l => l.id === 'img2')!
    expect(img.x).toBeLessThan(0.5)
    expect(img2.x).toBeGreaterThan(0.5)
    const own = ownedOf(plan, 'own-') as TextLayer[]
    expect(own.map(l => l.text)).toEqual(['Before', 'After'])
    // Ruling R10: the labels take the caption layer's family AND weight — a caption in Georgia 400
    // (not the kit's 600, not the other lines' Inter) tells R10 from the kit's own weight.
    const georgia = fullAdLayers({ action: true, image2: true }).map(l => l.id === 'c'
      ? { ...l, fontFamily: 'Georgia', fontWeight: 400 } as LocalLayer : l)
    const g = ownedOf(first('perfBeforeAfter', georgia).plan, 'own-') as TextLayer[]
    expect(g.map(l => [l.text, l.fontFamily, l.fontWeight])).toEqual([['Before', 'Georgia', 400], ['After', 'Georgia', 400]])
    // Each label on its own card, filled by the picker (the page colour carries ink here).
    expect(ownedOf(plan, 'card-').map(l => (l as { fill?: unknown }).fill)).toEqual([palette.field, palette.field])
    // Its content lines left out are hidden and named.
    expect(plan.notPlaced.map(n => n.role).sort()).toEqual(['by', 'list', 'quote', 'rating', 'stat', 'statline', 'them'])
  })

  it('Feature callouts: every list line is a run of the one list layer, each with an owned leader line and dot', () => {
    const { cand, plan } = first('perfCallouts')
    expect(textOf(cand.out.els, 'list')).toHaveLength(4)
    const list = plan.layers.find(l => l.id === 'l') as TextLayer
    expect(list.text).toBe(LINES.l[0])
    expect(list.runs?.map(r => r.text).join(' ')).toBe(LINES.l[0].replace(/\n/g, ' '))
    expect(ownedOf(plan, 'leader-')).toHaveLength(4)
    expect(ownedOf(plan, 'dot-')).toHaveLength(4)
  })

  it('Feature callouts: a list longer than four is not pointed at (no line of it is dropped)', () => {
    const a = argsFor('perfCallouts', square, withList('One\nTwo\nThree\nFour\nFive'))
    expect(candidatesForFrame(a)).toEqual([])
  })

  it('Reasons why: owned numbers 1–4 beside the user\'s lines; with markers of their own, the user\'s markers lead and no number is drawn (R5)', () => {
    const { cand, plan } = first('perfListicle')
    expect(cand.out.els.filter(e => e.k === 'own').map(e => e.k === 'own' && e.s)).toEqual(['1', '2', '3', '4'])
    expect((ownedOf(plan, 'own-') as TextLayer[]).map(l => l.color)).toEqual(Array(4).fill(palette.accent))
    const marked = '1. Carbon plate\n2. Under 200 g\n3. Free returns'
    const m = first('perfListicle', withList(marked))
    expect(m.cand.out.els.filter(e => e.k === 'own')).toEqual([])
    expect(textOf(m.cand.out.els, 'list').map(e => e.k === 't' && e.s)).toEqual(marked.split('\n'))
    expect((m.plan.layers.find(l => l.id === 'l') as TextLayer).text).toBe(marked)
    // Partial markers (some lines start with a number, some don't, ruling R9's new hint): the
    // user's markers still lead and no owned number is drawn for any line.
    const partial = '1. Carbon plate\nUnder 200 g\nFree returns'
    const p = first('perfListicle', withList(partial))
    expect(p.cand.out.els.filter(e => e.k === 'own')).toEqual([])
    expect(textOf(p.cand.out.els, 'list').map(e => e.k === 't' && e.s)).toEqual(partial.split('\n'))
  })

  it('Notes app: the paper and chrome in their fixed colours, owned bullets, the user\'s text in its own colour; with markers, no bullets', () => {
    const { cand, plan } = first('perfNotes')
    expect(ownedOf(plan, 'paper-').map(l => (l as { fill?: unknown }).fill)).toEqual(['#fbf8f1'])
    const own = ownedOf(plan, 'own-') as TextLayer[]
    expect(own.filter(l => l.text === '‹ Notes' || l.text === 'Done').map(l => l.color)).toEqual(['#d49a1a', '#d49a1a'])
    expect(own.filter(l => l.text === '•')).toHaveLength(4)
    expect(textOf(cand.out.els, 'list')).toHaveLength(4)
    // No logo, no button: the action line is hidden and named.
    expect(cand.out.els.some(e => e.k === 'btn' || e.k === 'logo')).toBe(false)
    expect(plan.notPlaced.map(n => n.role)).toContain('action')
    // The user's title keeps its own colour (recolour off): the layout sets none.
    expect((plan.layers.find(l => l.id === 't') as TextLayer).color).toBe('#111111')
    const m = first('perfNotes', withList('• Carbon plate\n• Under 200 g\n• Free returns'))
    expect(m.cand.out.els.filter(e => e.k === 'own').map(e => e.k === 'own' && e.s)).toEqual(['‹ Notes', 'Done'])
  })

  it('Notes app is refused when the user\'s text does not read on its paper (ruling R6)', () => {
    const pale = fullAdLayers({ action: true, colour: '#f4f0e6' })
    expect(candidatesForFrame(argsFor('perfNotes', square, pale))).toEqual([])
    const plan = planLayout({ ...argsFor('perfNotes', square, pale), choice: { lines: 0, arr: 0, scale: 'full', side: 'right' } })!
    expect(plan.issues.some(i => /unreadable on its paper/.test(i))).toBe(true)
  })

  it('Post-it: a fixed yellow note turned -4°, the headline and the number on it in the user\'s own face', () => {
    const { cand, plan } = first('perfPostit')
    const note = ownedOf(plan, 'sticker-')
    expect(note.map(l => (l as { fill?: unknown }).fill)).toEqual(['#ffe45c'])
    expect(note[0]!.rotation).toBe(-4)
    const title = plan.layers.find(l => l.id === 't') as TextLayer
    expect([title.fontFamily, title.fontWeight, title.color]).toEqual(['Inter', 600, '#111111'])
    expect(title.rotation).toBe(-4)
    expect(textOf(cand.out.els, 'date').map(e => e.k === 't' && e.s)).toEqual([LINES.dt[0]])
    // The product name is left out (as the prototype), hidden and named.
    expect(plan.notPlaced.map(n => n.role)).toContain('details')
  })

  it('Post-it\'s description names the button only when one is drawn', () => {
    expect(first('perfPostit').cand.out.did).toMatch(/the button sits on a band/)
    const noAction = first('perfPostit', fullAdLayers({ action: false })).cand.out.did
    expect(noAction).not.toMatch(/button/)
    expect(noAction).toMatch(/the fine print sits on a band/)
    // The platform's own button (story): no button drawn, none described.
    const story = FRAMES.find(f => f.id === 'meta-story')!
    const native = candidatesForFrame(argsFor('perfPostit', story, fullAdLayers({ action: true }))).find(c => c.choice.cta === 'native')!
    expect(native.out.did).not.toMatch(/button/)
  })

  it('a fixed colour that is not a plain hex refuses the variation (ruling R6), never passes unchecked', () => {
    const S = makeSheet({ frameW: 1080, frameH: 1080, measure: makeStubMeasure(), style: 'performance' })
    const ctx = { palette, hasAction: false, layerColour: (r: string) => (r === 'title' ? '#111111' : undefined) }
    const els = (hex: string): El[] => [
      { k: 'r', x: 10, y: 10, w: 60, h: 40, hex, role: 'sticker' },
      { k: 't', s: 'Run lighter.', x: 15, top: 20, size: 6, ls: 0, lh: 1, pre: true, role: 'title', over: ['sticker'] },
    ]
    expect(pieceFills(els('#ffe45c'), S, ctx).issues).toEqual([])
    expect(pieceFills(els('not-a-colour'), S, ctx).issues).toEqual(['title is unreadable on its sticker'])
    expect(pieceFills(els('rgb(255, 228, 92)'), S, ctx).issues).toEqual(['title is unreadable on its sticker'])
  })

  it('Post-it is refused when the user\'s text does not read on the note (ruling R6)', () => {
    // Only the headline and the number are pale: the offer on the band still reads.
    const pale = fullAdLayers({ action: true }).map(l => l.id === 't' || l.id === 'dt' ? { ...l, color: '#fff6c8' } as LocalLayer : l)
    expect(candidatesForFrame(argsFor('perfPostit', square, pale))).toEqual([])
    const plan = planLayout({ ...argsFor('perfPostit', square, pale), choice: { lines: 0, arr: 0, scale: 'full', side: 'right' } })!
    expect(plan.issues).toEqual(['title is unreadable on its sticker'])
  })
})

describe('a Frame without the content never offers the layout', () => {
  // Post-it needs nothing beyond the image (ruling C2: `needsContent: []`); Before / after's missing
  // content is the second image, which `fullAdLayers` leaves out unless asked.
  const MISSING: Record<Exclude<AdId, 'perfPostit'>, LineId[]> = {
    perfOfferFirst: ['dt'],
    perfStat: ['s'],
    perfReview: ['q'],
    perfVersus: ['v'],
    perfBeforeAfter: [],
    perfCallouts: ['l'],
    perfListicle: ['l'],
    perfNotes: ['l'],
  }
  it.each(ADS.filter(id => id !== 'perfPostit') as Exclude<AdId, 'perfPostit'>[])('%s', id => {
    for (const f of FRAMES) for (const action of [false, true]) {
      const layers = fullAdLayers({ action, without: MISSING[id] })
      expect(candidatesForFrame(argsFor(id, f, layers)), `${id} ${f.id} ${action}`).toEqual([])
    }
  })

  it('the Stage 3 ad Frame offers Offer first (it has a number) and Post-it (it needs nothing), none of the other seven', () => {
    for (const f of FRAMES) {
      const layers = adFrameLayers('phrase', { image: true, action: true })
      for (const id of ADS.filter(x => x !== 'perfOfferFirst' && x !== 'perfPostit')) expect(candidatesForFrame(argsFor(id, f, layers)), `${id} ${f.id}`).toEqual([])
    }
    for (const id of ['perfOfferFirst', 'perfPostit']) expect(candidatesForFrame(argsFor(id, FRAMES[0]!, adFrameLayers('phrase', { image: true, action: true }))).length, id).toBeGreaterThan(0)
  })

  it('Post-it needs only a headline and an image', () => {
    const layers = [createTextLayer({ id: 't', text: 'Run lighter.', fontSize: 0.12, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer,
      createImageLayer('x.png', 1.25, { id: 'img', w: 0.5, h: 0.625 }) as LocalLayer]
    for (const f of FRAMES) expect(candidatesForFrame(argsFor('perfPostit', f, layers)).length, f.id).toBeGreaterThan(0)
    // …but an image: without one it is not offered.
    expect(candidatesForFrame(argsFor('perfPostit', FRAMES[1]!, layers.slice(0, 1)))).toEqual([])
  })

  it('never to another style', () => {
    const layers = fullAdLayers({ action: true, image2: true })
    for (const id of ADS) for (const style of [undefined, 'swiss', 'editorial', 'street'] as const) {
      const { style: _s, ...a } = argsFor(id, FRAMES[1]!, layers)
      expect(candidatesForFrame({ ...a, ...(style ? { style } : {}) }), `${id} ${style}`).toEqual([])
    }
  })
})

describe('the catalog (seed order)', () => {
  it('the nine are appended after Street, as Performance layouts with one line first', () => {
    expect(CATALOG.slice(57).map(l => l.id)).toEqual([...ADS])
    expect(layoutsForStyle('performance').slice(6).map(l => l.id)).toEqual([...ADS])
    for (const id of ADS) {
      const def = layoutById(id)!
      expect(def.style, id).toBe('performance')
      expect(def.oneLineFirst, id).toBe(true)
      // Post-it reads the content view without being gated on any content (ruling C2).
      expect(def.needsContent, id).toEqual(id === 'perfPostit' ? [] : [expect.any(String)])
    }
    expect(layoutById('perfBeforeAfter')!.needsContent).toEqual(['image2'])
    for (const id of ['perfCallouts', 'perfListicle', 'perfNotes']) expect(layoutById(id)!.needsContent, id).toEqual(['list'])
    // Every earlier layout reads the base view: none declares `needsContent`.
    expect(CATALOG.slice(0, 57).filter(l => l.needsContent)).toEqual([])
  })
})

// Task 7 of the layout decisions: every layout places the Frame's extra images, or is refused ("no
// room for the other images"). The ad Frame with a second image (Before / after's fixture) through
// the other eight layouts, pinned: Stat, Review, Us vs them, Feature callouts and Reasons why tile it
// and keep every variation; Offer first, Notes app and Post-it lose everything they offer with one
// image. Measured: on every one of their one-image variations no free room of 12 × 12 (the minimum
// tile) is left in the content area — Post-it bleeds its image over the whole page (the note and the
// offer band on it), Notes app sets its paper over the whole page, and Offer first fills the page with
// its panel and the image under it.
describe('a second image (Task 7): what the ad Frame keeps', () => {
  const KEPT = ['perfStat', 'perfReview', 'perfVersus', 'perfCallouts', 'perfListicle']
  const LOST = ['perfOfferFirst', 'perfNotes', 'perfPostit']
  it.each(combos.map(c => [`${c.frame} · ${c.action ? 'action' : 'no action'}`, c] as const))('%s', (_label, c) => {
    const f = FRAMES.find(x => x.id === c.frame)!
    const format = f.preset ? FRAME_FORMATS.find(x => x.id === f.preset)! : null
    const S = makeSheet({ frameW: f.w, frameH: f.h, measure: makeStubMeasure(), style: 'performance', ...(format ? { format: { view: format.view, nc: format.nc, ...(format.keep ? { keepSide: Math.max(format.keep.left, format.keep.right) } : {}) } } : {}) })
    const keep = format?.keep
    const area = { x0: S.M, x1: 100 - S.M, y0: (keep ? S.H * keep.top : 0) + S.M, y1: (keep ? S.H * (1 - keep.bottom) : S.H) - S.M }
    for (const id of ADS) {
      if (id === 'perfBeforeAfter') continue
      const one = candidatesForFrame(argsFor(id, f, fullAdLayers({ action: c.action })))
      const two = candidatesForFrame(argsFor(id, f, fullAdLayers({ action: c.action, image2: true })))
      if (KEPT.includes(id)) {
        // Every variation kept, each with the second image as a tile.
        expect(two.map(x => x.choice), id).toEqual(one.map(x => x.choice))
        for (const x of two) expect(x.out.els.filter(e => e.k === 'p' && e.extra === 0), id).toHaveLength(1)
      } else {
        expect(LOST, id).toContain(id)
        expect(two, id).toEqual([])
        for (const x of one) {
          const taken = x.out.els.map(e => inkBoxOf(e, S)).filter((b): b is NonNullable<typeof b> => b != null)
          expect(freeRects(area, taken, S.GAP, EXTRA_MIN_TILE), `${id} ${JSON.stringify(x.choice)}`).toEqual([])
        }
      }
    }
  })
})

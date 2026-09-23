import { describe, it, expect } from 'vitest'
import { candidatesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { pickFill, pickPlain, pieceFills, textsOn } from '~/lib/frame/patterns/kit/contrast'
import { paletteFromFrame } from '~/lib/frame/patterns/framePalette'
import { contrastRatio } from '~/lib/frame/patterns/palette'
import { STYLES } from '~/lib/frame/patterns/kit/styles'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import type { El } from '~/lib/frame/patterns/kit/types'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { adFrameLayers, eventFrameLayers, frameLayers, palette } from './helpers/frameLayoutFixtures'

// ═══════════════════════ fix wave: text readable on its piece (ruling R6, R8) ═══════════════════════

/** The lab's palette: a paper page, and ink = accent = the user's own near-black (the Frame has no
 *  shape colour — before ruling R7 the accent collapsed onto the ink). */
const LAB = { field: '#f2f0ef', ink: '#111111', accent: '#111111' }

const recolourText = (layers: LocalLayer[], ids: string[], color: string) =>
  layers.map(l => (ids.includes(l.id) ? { ...l, color } : l)) as LocalLayer[]
const owned = (layers: LocalLayer[], key: string) => layers.find(l => (l as { owner?: { key: string } }).owner?.key === key) as Record<string, any> | undefined
const base = { frameW: 895, frameH: 1280, connectedSlots: [], measure: makeStubMeasure() }

describe('the contrast picker', () => {
  it('takes the first role in the piece\'s order that every text reads on (3:1), and stands out when asked (1.5:1)', () => {
    // Dark text on the lab palette: the accent and the ink are the text's own colour (1.0:1); the
    // page reads (16.3:1) but is the page itself (1.0:1) — a tag has nothing left.
    expect(pickFill(['accent', 'ink', 'field'], ['#111111'], LAB, true)).toBeNull()
    // A band need not stand out: the page colour is its first choice and it reads.
    expect(pickFill(['field', 'ink', 'accent'], ['#111111'], LAB, false)).toBe('field')
    // White text on a band: the page fails (1.1:1), the ink reads (18.9:1).
    expect(pickFill(['field', 'ink', 'accent'], ['#ffffff'], LAB, false)).toBe('ink')
    // Every text on the piece must read: one failing text rules the role out.
    expect(pickFill(['field', 'ink', 'accent'], ['#111111', '#ffffff'], LAB, false)).toBeNull()
  })

  it('negative control: the fixture palette keeps every layout colour (accent tag, page-colour band)', () => {
    // #111111 on #dd2200 is 3.87:1; #dd2200 against the page 4.30:1.
    expect(contrastRatio('#111111', palette.accent)).toBeGreaterThan(3)
    expect(pickFill(['accent', 'ink', 'field'], ['#111111'], palette, true)).toBe('accent')
    expect(pickFill(['field', 'ink', 'accent'], ['#111111'], palette, false)).toBe('field')
  })

  it('reads text drawn above a piece, not text the piece is drawn over (Street\'s title under its tag)', () => {
    const S = makeSheet({ frameW: 895, frameH: 1280, measure: makeStubMeasure(), style: 'street' })
    const a = { ...base, palette, style: 'street' as const, props: { sailor_localLayers: eventFrameLayers('phrase', { image: false, action: true }) }, layoutId: 'stFill' }
    const els = candidatesForFrame(a)[0]!.out.els
    const i = els.findIndex(e => e.k === 'r' && e.role === 'tag')
    // The title names the tag in `over` and crosses it, but lies under it: only the tag's own line sits on it.
    expect(els.some(e => e.k === 't' && e.role === 'title' && e.over?.includes('tag'))).toBe(true)
    expect(textsOn(els, i, S).map(t => t.role)).toEqual(['date'])
  })
})

describe('ruling R6 through the planner: a tag, a sticker, a band', () => {
  it('a tag on the lab palette with dark text: no role reads and stands out — the candidate is refused', () => {
    const a = { ...base, palette: LAB, style: 'street' as const, props: { sailor_localLayers: eventFrameLayers('phrase', { image: false, action: true }) }, layoutId: 'stFill' }
    const choice = candidatesForFrame({ ...a, palette })[0]!.choice
    expect(planLayout({ ...a, choice })!.issues).toContain('date is unreadable on its tag')
    // Every Fill draws the tag with the date on it: none is offered.
    expect(candidatesForFrame(a)).toEqual([])
  })

  it('a tag picks the next readable role: white text on a pale accent takes the ink', () => {
    const pale = { field: '#f2f0ef', ink: '#111111', accent: '#f5f5f5' }
    const layers = recolourText(eventFrameLayers('phrase', { image: false, action: true }), ['dt'], '#ffffff')
    const a = { ...base, palette: pale, style: 'street' as const, props: { sailor_localLayers: layers }, layoutId: 'stFill' }
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    const plan = planLayout({ ...a, choice: cands[0]!.choice })!
    expect(plan.issues).toEqual([])
    expect(owned(plan.layers, 'tag-0')!.fill).toBe(pale.ink)
  })

  it('negative control: the same tag with the fixture palette stays the accent', () => {
    const a = { ...base, palette, style: 'street' as const, props: { sailor_localLayers: eventFrameLayers('phrase', { image: false, action: true }) }, layoutId: 'stFill' }
    const plan = planLayout({ ...a, choice: candidatesForFrame(a)[0]!.choice })!
    expect(plan.issues).toEqual([])
    expect(owned(plan.layers, 'tag-0')!.fill).toBe(palette.accent)
  })

  it('a sticker on the lab palette with dark text is refused; white text reads on the accent', () => {
    const a = (layers: LocalLayer[]): Omit<LayoutPlanArgs, 'choice'> => ({ ...base, palette: LAB, style: 'performance', props: { sailor_localLayers: layers }, layoutId: 'perfSticker' })
    const dark = adFrameLayers('word', { image: true, action: false })
    const choice = candidatesForFrame({ ...a(dark), palette })[0]!.choice
    expect(planLayout({ ...a(dark), choice })!.issues).toContain('date is unreadable on its sticker')
    expect(candidatesForFrame(a(dark))).toEqual([])
    const white = recolourText(dark, ['dt'], '#ffffff')
    const plan = planLayout({ ...a(white), choice })!
    expect(plan.issues).toEqual([])
    expect(owned(plan.layers, 'sticker-0')!.fill).toBe(LAB.accent)
  })

  it('a band under white text takes the ink; the check and the drawing agree', () => {
    const layers = recolourText(adFrameLayers('word', { image: true, action: false }), ['t', 'd', 'dt', 'c'], '#ffffff')
    const a = { ...base, palette, style: 'performance' as const, props: { sailor_localLayers: layers }, layoutId: 'perfOffer' }
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    const plan = planLayout({ ...a, choice: cands[0]!.choice })!
    expect(plan.issues).toEqual([])
    // #121212 at 94%, where the page colour would give white text 1.1:1.
    for (const key of ['band-0', 'band-1']) expect(owned(plan.layers, key)!.fill.stops[0].color).toBe('rgba(18, 18, 18, 0.94)')
  })

  it('negative control: dark text keeps the band in the page colour', () => {
    const a = { ...base, palette, style: 'performance' as const, props: { sailor_localLayers: adFrameLayers('word', { image: true, action: false }) }, layoutId: 'perfOffer' }
    const plan = planLayout({ ...a, choice: candidatesForFrame(a)[0]!.choice })!
    expect(plan.issues).toEqual([])
    expect(owned(plan.layers, 'band-0')!.fill.stops[0].color).toBe('rgba(242, 240, 239, 0.94)')
  })

  it('a band no role can carry refuses the candidate', () => {
    // White details and number, dark fine print on the foot band, with ink = accent: the page fails
    // the white lines (1.1:1), the ink and the accent the dark one (1.0:1).
    const layers = recolourText(adFrameLayers('word', { image: true, action: false }), ['t', 'd', 'dt'], '#ffffff')
    const a = { ...base, palette: { ...palette, accent: palette.ink }, style: 'performance' as const, props: { sailor_localLayers: layers }, layoutId: 'perfOffer' }
    const choice = candidatesForFrame({ ...a, props: { sailor_localLayers: adFrameLayers('word', { image: true, action: false }) } })[0]!.choice
    const issues = planLayout({ ...a, choice })!.issues
    expect(issues.some(i => / is unreadable on its band$/.test(i))).toBe(true)
  })
})

describe('ruling R6 in Swiss: Badge and Knockout', () => {
  const swiss = (layers: LocalLayer[], layoutId: string, extra: Partial<LayoutPlanArgs> = {}) =>
    ({ ...base, palette, props: { sailor_localLayers: layers }, layoutId, ...extra })
  const withShape = (fill: string) => frameLayers('phrase', { image: false, shape: true }).map(l => (l.id === 'shp' ? { ...l, fill } : l)) as LocalLayer[]

  it('Knockout: the title on the user\'s own dark shape is refused; the fixture\'s red shape reads (5.0:1)', () => {
    const ok = swiss(withShape('#ef4444'), 'knockout')
    const cands = candidatesForFrame(ok)
    expect(cands.length).toBeGreaterThan(0)
    const dark = swiss(withShape('#1a1a1a'), 'knockout')
    expect(planLayout({ ...dark, choice: cands[0]!.choice })!.issues).toContain('title is unreadable on its shape')
    expect(candidatesForFrame(dark)).toEqual([])
    // Geometry is unchanged: the same choices, the same elements, on the readable shape.
    expect(planLayout({ ...ok, choice: cands[0]!.choice })!.issues).toEqual([])
  })

  it('Badge: the date on the user\'s own dark shape is refused', () => {
    const ok = swiss(withShape('#ef4444'), 'badge')
    const cands = candidatesForFrame(ok)
    expect(cands.length).toBeGreaterThan(0)
    expect(planLayout({ ...swiss(withShape('#1a1a1a'), 'badge'), choice: cands[0]!.choice })!.issues).toContain('date is unreadable on its shape')
  })

  it('with recolour on the shape takes a role colour: the reversed title (page colour) keeps the ink band', () => {
    const a = swiss(withShape('#1a1a1a'), 'knockout', { recolour: true })
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    const plan = planLayout({ ...a, choice: cands[0]!.choice })!
    expect(plan.issues).toEqual([])
    expect((plan.layers.find(l => l.id === 'shp') as { fill: string }).fill).toBe(palette.ink)
  })
})

describe('ruling R8: a button that can\'t stand out is an outline; the rank counts drawn buttons', () => {
  it('an outline has no fill and a stroke in the label colour, 0.08 × the button size', () => {
    // The lab palette: the page reads under the dark label (16.3:1) but is the page itself; the ink
    // and the accent are the label's own colour. The label then sits on the foot band (page colour).
    const a = { ...base, palette: LAB, style: 'performance' as const, props: { sailor_localLayers: adFrameLayers('word', { image: true, action: true }) }, layoutId: 'perfOffer' }
    const cand = candidatesForFrame(a)[0]!
    const plan = planLayout({ ...a, choice: cand.choice })!
    expect(plan.issues).toEqual([])
    const btn = cand.out.els.find(e => e.k === 'btn') as { size: number }
    const b = owned(plan.layers, 'button-0')!
    expect([b.fill, b.stroke]).toEqual(['none', '#111111'])
    expect(b.strokeWidth).toBeCloseTo(0.08 * btn.size / 100, 9)
    expect((plan.layers.find(l => l.id === 'a') as { underline?: boolean }).underline).toBeUndefined()
  })

  it('Performance\'s rank adds the button only when it is drawn', () => {
    const els: El[] = [{ k: 'btn', x: 0, y: 0, w: 10, h: 4, size: 2, shape: 'pill', role: 'btn' }]
    const ctx = { infoSize: 2, W: 100, H: 100 }
    const rank = STYLES.performance.rank!
    expect(rank({ els, did: '' }, ctx) - rank({ els, did: '' }, { ...ctx, drawn: () => false })).toBeCloseTo(0.5, 9)
    expect(rank({ els, did: '' }, { ...ctx, drawn: () => true })).toBeCloseTo(rank({ els, did: '' }, ctx), 9)
    // Through the planner: a label of unknown colour (a gradient) draws a link — no button — so
    // the same choice scores 0.5 less than with a readable label.
    const at = (color: unknown) => {
      const layers = adFrameLayers('word', { image: true, action: true }).map(l => (l.id === 'a' ? { ...l, color } : l)) as LocalLayer[]
      return candidatesForFrame({ ...base, palette, style: 'performance', props: { sailor_localLayers: layers }, layoutId: 'perfOffer' })
    }
    const filled = at('#111111'), link = at({ type: 'linear', angle: 0, stops: [] })
    let compared = 0
    for (const c of filled) {
      const l = link.find(x => JSON.stringify(x.choice) === JSON.stringify(c.choice))
      if (!l) continue
      expect(c.score - l.score, JSON.stringify(c.choice)).toBeCloseTo(0.5, 9)
      compared++
    }
    expect(compared).toBeGreaterThan(0)
  })

  it('pieceFills: an outline or a link never refuses the candidate', () => {
    const S = makeSheet({ frameW: 895, frameH: 1280, measure: makeStubMeasure(), style: 'performance' })
    const { btn, text } = S.button('Shop now', 10, 50)
    const ctx = { palette: { field: '#777777', ink: '#808080', accent: '#707070' }, hasAction: true, layerColour: () => '#7a7a7a' }
    // Grey page: no role stands out, but plain white does (4.3:1 with the label, 4.5:1 against the page — R12).
    expect(pieceFills([btn, text], S, ctx).fills.get(btn)).toEqual({ plain: '#ffffff' })
    // Paper page, dark label: no role and no plain colour — an outline.
    const out = pieceFills([btn, text], S, { ...ctx, palette: LAB, layerColour: () => '#111111' })
    expect(out.issues).toEqual([])
    expect(out.fills.get(btn)).toEqual({ outline: '#111111' })
    expect(pieceFills([btn, text], S, { ...ctx, layerColour: () => ({ type: 'linear' }) }).fills.get(btn)).toBeNull()
  })
})

// ═══════════════════════ follow-up R12: plain paper before refusing ═══════════════════════
describe('ruling R12: a tag, sticker or button no role can carry tries plain paper first', () => {
  /** The lab Frame in the browser: a pink page, near-black text, no shape — its own palette. */
  const pinkLayers = (layers: LocalLayer[]) => recolourText(layers, ['t', 'd', 'dt', 'c', 'a'], '#121212')
  const pinkPalette = (layers: LocalLayer[]) => paletteFromFrame({ sailor_localBg: '#ee7fb0', sailor_localLayers: layers })

  it('the pink page: no role reads under the dark text and stands out from the page', () => {
    const P = pinkPalette(pinkLayers(eventFrameLayers('phrase', { image: false, action: true })))
    expect(P.field).toBe('#ee7fb0')
    expect(pickFill(['accent', 'ink', 'field'], ['#121212'], P, true)).toBeNull()
    // White: 18.4:1 with the text, 2.6:1 against the page.
    expect(pickPlain(['#121212'], P)).toBe('#ffffff')
  })

  it('Street Fill on the pink page: the tag is plain white and the candidate is offered', () => {
    const layers = pinkLayers(eventFrameLayers('phrase', { image: false, action: true }))
    const a = { ...base, palette: pinkPalette(layers), style: 'street' as const, props: { sailor_localLayers: layers, sailor_localBg: '#ee7fb0' }, layoutId: 'stFill' }
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    const plan = planLayout({ ...a, choice: cands[0]!.choice })!
    expect(plan.issues).toEqual([])
    expect(owned(plan.layers, 'tag-0')!.fill).toBe('#ffffff')
    const els = cands[0]!.out.els
    const S = makeSheet({ frameW: 895, frameH: 1280, measure: makeStubMeasure(), style: 'street' })
    const tag = els.find(e => e.k === 'r' && e.role === 'tag')!
    expect(pieceFills(els, S, { palette: a.palette, hasAction: true, layerColour: () => '#121212' }).fills.get(tag)).toEqual({ plain: '#ffffff' })
  })

  it('a sticker on the pink page is plain white, and offered', () => {
    const layers = pinkLayers(adFrameLayers('word', { image: true, action: false }))
    const a = { ...base, palette: pinkPalette(layers), style: 'performance' as const, props: { sailor_localLayers: layers, sailor_localBg: '#ee7fb0' }, layoutId: 'perfSticker' }
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    const plan = planLayout({ ...a, choice: cands[0]!.choice })!
    expect(plan.issues).toEqual([])
    expect(owned(plan.layers, 'sticker-0')!.fill).toBe('#ffffff')
  })

  it('a button on the pink page is plain white, not an outline', () => {
    const layers = pinkLayers(adFrameLayers('word', { image: true, action: true }))
    const a = { ...base, palette: pinkPalette(layers), style: 'performance' as const, props: { sailor_localLayers: layers, sailor_localBg: '#ee7fb0' }, layoutId: 'perfOffer' }
    const cands = candidatesForFrame(a)
    expect(cands.length).toBeGreaterThan(0)
    const b = owned(planLayout({ ...a, choice: cands[0]!.choice })!.layers, 'button-0')!
    expect(b.fill).toBe('#ffffff')
    expect(b.stroke).toBe('')
  })

  it('negative control: the lab-like paper palette is unchanged — white does not stand out from paper (1.1:1), near-black is the text', () => {
    expect(pickPlain(['#111111'], LAB)).toBeNull()
    const a = { ...base, palette: LAB, style: 'street' as const, props: { sailor_localLayers: eventFrameLayers('phrase', { image: false, action: true }) }, layoutId: 'stFill' }
    expect(candidatesForFrame(a)).toEqual([])
  })

  it('bands stay role-only: a band no role can carry is still refused, never plain', () => {
    const P = { ...palette, accent: palette.ink }
    const els = candidatesForFrame({ ...base, palette, style: 'performance', props: { sailor_localLayers: adFrameLayers('word', { image: true, action: false }) }, layoutId: 'perfOffer' })[0]!.out.els
    const S = makeSheet({ frameW: 895, frameH: 1280, measure: makeStubMeasure(), style: 'performance' })
    const colour = (r: string) => (r === 'caption' ? '#111111' : '#ffffff')
    const out = pieceFills(els, S, { palette: P, hasAction: false, layerColour: colour })
    expect(out.issues.some(i => / is unreadable on its band$/.test(i))).toBe(true)
    for (const f of out.fills.values()) expect(f && typeof f === 'object' && 'plain' in f).toBe(false)
  })
})

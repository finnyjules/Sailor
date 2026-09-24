// The Stage 4 final fix wave (rulings R14, R15; review findings C1, I1, I2, minors): switching
// away from a Stage 4 layout never loses a line without naming it; the format's "Not shown"
// quotes what the plan really hid; each content line is measured in its own layer's face; a
// second image a Stage 4 layout does not place is hidden and named; owned text is held to rule 10;
// every layout's description says only what it drew.
import { describe, it, expect, vi, afterEach } from 'vitest'
vi.mock('~/lib/frame/patterns/kit/measure', async (importOriginal) => {
  const m = await importOriginal<typeof import('~/lib/frame/patterns/kit/measure')>()
  return { ...m, makeCanvasMeasure: vi.fn(m.makeCanvasMeasure) }
})
import { candidatesForFrame, hiddenLinesForFrame, planLayout } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlan, LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { checkPlan } from '~/lib/frame/patterns/kit/check'
import { makeSheet } from '~/lib/frame/patterns/kit/sheet'
import { makeCanvasMeasure, makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { faceOf } from '~/lib/frame/patterns/kit/types'
import type { El, TextEl } from '~/lib/frame/patterns/kit/types'
import type { StyleId } from '~/lib/frame/patterns/kit/styles'
import { restoreFormatHiddenLines } from '~/lib/frame/frameSize'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import { createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { AD_LOGO, palette } from './helpers/frameLayoutFixtures'

const tl = (id: string, text: string, fontSize: number, o: Record<string, unknown> = {}) =>
  createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111', ...o }) as LocalLayer
const img = (id: string, o: Record<string, unknown> = {}) =>
  createImageLayer(`${id}.png`, 1.25, { id, w: 0.5, h: 0.625, ...o }) as LocalLayer

/** A review ad: headline, product name, a quote, the offer, the button, a rating, the fine print
 *  and the reviewer — the reviewer's final probe Frame. */
const reviewAd = (): LocalLayer[] => [
  tl('t', 'Run lighter.', 0.1), tl('d', 'Halden Trail 2', 0.045), tl('q', '“Lightest shoe I have ever raced in.”', 0.035),
  tl('dt', '–30%', 0.04), tl('a', 'Shop now', 0.025), tl('r', '4.7 ★', 0.022), tl('c', 'Offer ends 12 October.', 0.02),
  tl('b', '— Maya R., verified buyer', 0.018), img('img'),
]

const W = 895, H = 1280
const args = (props: Record<string, unknown>, layoutId: string, style: StyleId, o: Partial<LayoutPlanArgs> = {}): Omit<LayoutPlanArgs, 'choice'> =>
  ({ props, frameW: W, frameH: H, layoutId, palette, connectedSlots: [], measure: makeStubMeasure(), style, ...o })

/** Plan a layout's first variation and write it onto the props, as the Layout tab's apply does. */
function apply(props: Record<string, unknown>, layoutId: string, style: StyleId, o: Partial<LayoutPlanArgs> = {}): { plan: LayoutPlan; props: Record<string, unknown> } {
  const a = args(props, layoutId, style, o)
  const cand = candidatesForFrame(a)[0]
  expect(cand, `${layoutId} is offered`).toBeTruthy()
  const plan = planLayout({ ...a, choice: cand!.choice })!
  expect(plan.issues, layoutId).toEqual([])
  const st = { ...(props.sailor_posterState as object | undefined), ...plan.posterState, style }
  return { plan, props: { ...props, sailor_localLayers: plan.layers, sailor_posterState: st } }
}
const layerOf = (p: LayoutPlan, id: string) => p.layers.find(l => l.id === id) as LocalLayer & { visible?: boolean }
const named = (p: LayoutPlan) => p.notPlaced.map(n => n.text)

describe('C1 / R15: switching away from a Stage 4 layout names every line it leaves out', () => {
  it('Review then Run-off: the fine print, the quote and the rating stay hidden and are named', () => {
    const review = apply({ sailor_localLayers: reviewAd() }, 'perfReview', 'performance')
    // Review places the quote and the rating, and hides the fine print (it has no foot for it).
    expect(layerOf(review.plan, 'q').visible).not.toBe(false)
    expect(layerOf(review.plan, 'r').visible).not.toBe(false)
    expect(layerOf(review.plan, 'c').visible).toBe(false)
    const runoff = apply(review.props, 'runoff', 'swiss').plan
    // The fine print Review hid: still hidden, and named with its own text.
    expect(layerOf(runoff, 'c').visible).toBe(false)
    expect(named(runoff)).toContain('Offer ends 12 October.')
    // The quote and the rating Review MOVED: Run-off does not place them, so they are hidden and
    // named — never left stranded over the new layout.
    expect(layerOf(runoff, 'q').visible).toBe(false)
    expect(layerOf(runoff, 'r').visible).toBe(false)
    expect(named(runoff)).toEqual(expect.arrayContaining(['“Lightest shoe I have ever raced in.”', '4.7 ★']))
    // The lines Run-off places show; the action is named as before (ruling R9).
    for (const id of ['t', 'd', 'dt', 'b']) expect(layerOf(runoff, id).visible, id).not.toBe(false)
    expect(runoff.notPlaced[0]).toEqual({ role: 'action', text: 'Shop now' })
    // Each line is named once.
    expect(new Set(named(runoff)).size).toBe(runoff.notPlaced.length)
  })

  it('Offer first, then Offer: the quote and the rating Offer first hid stay hidden and are named', () => {
    const first = apply({ sailor_localLayers: reviewAd() }, 'perfOfferFirst', 'performance')
    expect(layerOf(first.plan, 'q').visible).toBe(false)
    expect(layerOf(first.plan, 'r').visible).toBe(false)
    const offer = apply(first.props, 'perfOffer', 'performance').plan
    expect(layerOf(offer, 'q').visible).toBe(false)
    expect(layerOf(offer, 'r').visible).toBe(false)
    expect(named(offer)).toEqual(expect.arrayContaining(['“Lightest shoe I have ever raced in.”', '4.7 ★']))
  })

  it('Post-it, then Offer: the quote and the rating are named; the fine print Post-it placed is not stranded', () => {
    const postit = apply({ sailor_localLayers: reviewAd() }, 'perfPostit', 'performance')
    expect(layerOf(postit.plan, 'c').visible).not.toBe(false)            // Post-it's foot holds the fine print
    const offer = apply(postit.props, 'perfOffer', 'performance').plan
    expect(named(offer)).toEqual(expect.arrayContaining(['“Lightest shoe I have ever raced in.”', '4.7 ★']))
    // Offer reads the reviewer as the fine print (the base view): the fine print Post-it moved is
    // placed by nothing now — hidden and named rather than left on top of Offer.
    expect(layerOf(offer, 'c').visible).toBe(false)
    expect(named(offer)).toContain('Offer ends 12 October.')
  })

  it('a line a later layout places shows again and is not named', () => {
    const review = apply({ sailor_localLayers: reviewAd() }, 'perfReview', 'performance')
    expect(layerOf(review.plan, 't').visible).toBe(false)                 // Review hides the headline
    const runoff = apply(review.props, 'runoff', 'swiss').plan
    expect(layerOf(runoff, 't').visible).not.toBe(false)
    expect(named(runoff)).not.toContain('Run lighter.')
  })

  it('a line the user hid by hand is theirs: not named', () => {
    const layers = reviewAd().map(l => (l.id === 'c' ? { ...l, visible: false } as LocalLayer : l))
    const plan = apply({ sailor_localLayers: layers }, 'runoff', 'swiss').plan
    expect(named(plan)).not.toContain('Offer ends 12 October.')
  })
})

describe('R14: a Stage 4 layout hides a second image it does not place, and names it', () => {
  it('Offer first hides the recognised second image, named "Image 2"; Run-off keeps it hidden and named', () => {
    const first = apply({ sailor_localLayers: [...reviewAd(), img('img2')] }, 'perfOfferFirst', 'performance')
    expect(layerOf(first.plan, 'img2').visible).toBe(false)
    expect(first.plan.notPlaced).toContainEqual({ role: 'image2', text: 'Image 2', image: true })
    const runoff = apply(first.props, 'runoff', 'swiss').plan
    expect(layerOf(runoff, 'img2').visible).toBe(false)
    expect(runoff.notPlaced).toContainEqual({ role: 'image2', text: 'Image 2', image: true })
  })

  it('named by its own name when it has one', () => {
    const first = apply({ sailor_localLayers: [...reviewAd(), img('img2', { name: 'Worn trail shoe' })] }, 'perfOfferFirst', 'performance')
    expect(first.plan.notPlaced).toContainEqual({ role: 'image2', text: 'Worn trail shoe', image: true })
  })

  it('Before / after places it; switching to Run-off hides it and names it', () => {
    const layers = [tl('t', 'Run lighter.', 0.1), tl('dt', '–30%', 0.04), tl('c', 'Offer ends 12 October.', 0.02), img('img'), img('img2')]
    const ba = apply({ sailor_localLayers: layers }, 'perfBeforeAfter', 'performance')
    expect(layerOf(ba.plan, 'img2').visible).not.toBe(false)
    expect(ba.plan.notPlaced.map(n => n.role)).not.toContain('image2')
    const runoff = apply(ba.props, 'runoff', 'swiss').plan
    expect(layerOf(runoff, 'img2').visible).toBe(false)
    expect(runoff.notPlaced).toContainEqual({ role: 'image2', text: 'Image 2', image: true })
  })

  it('a Swiss layout on a fresh Frame leaves a second image exactly as before (no Stage 4 layout ran)', () => {
    const layers = [...reviewAd(), img('img2')]
    const plan = apply({ sailor_localLayers: layers }, 'runoff', 'swiss').plan
    expect(layerOf(plan, 'img2')).toEqual(layers.find(l => l.id === 'img2'))
    expect(plan.notPlaced.map(n => n.role)).not.toContain('image2')
  })
})

describe('I1: the format\'s "Not shown" quotes what the plan hid', () => {
  const fmt = (id: string) => { const f = FRAME_FORMATS.find(x => x.id === id)!; return { w: f.w, h: f.h } }

  it('Offer first on a video thumbnail: the content view\'s fine print, not the reviewer', () => {
    const { w, h } = fmt('video-thumb')
    const props = { sailor_localLayers: reviewAd(), sailor_frame: { preset: 'video-thumb' } }
    const a = { ...args(props, 'perfOfferFirst', 'performance'), frameW: w, frameH: h }
    const plan = planLayout({ ...a, choice: candidatesForFrame(a)[0]!.choice })!
    expect(plan.format!.hidden).toEqual(['details', 'action', 'caption'])
    expect(plan.format!.lines).toEqual(['Halden Trail 2', 'Shop now', 'Offer ends 12 October.'])
    // Worked out from the Frame alone, for the layout it is about: the same lines.
    expect(hiddenLinesForFrame({ props, frameW: w, frameH: h, style: 'performance', layoutId: 'perfOfferFirst' }))
      .toEqual(['Halden Trail 2', 'Shop now', 'Offer ends 12 October.'])
    // A base-view layout (and no layout at all) reads the reviewer as the fine print, as before.
    expect(hiddenLinesForFrame({ props, frameW: w, frameH: h, style: 'performance' }))
      .toEqual(['Halden Trail 2', 'Shop now', '— Maya R., verified buyer'])
  })

  it('a size change keeps hidden what the Stage 4 layout\'s own format still hides (the content view)', () => {
    const thumb = fmt('video-thumb')
    const props0 = { sailor_localLayers: reviewAd(), sailor_frame: { preset: 'video-thumb' } }
    const a = { ...args(props0, 'perfOfferFirst', 'performance'), frameW: thumb.w, frameH: thumb.h }
    const plan = planLayout({ ...a, choice: candidatesForFrame(a)[0]!.choice })!
    const tall = fmt('ad-300x600')
    const data = {
      widgetDefs: [{ name: 'width' }, { name: 'height' }], widgetsValues: [tall.w, tall.h],
      properties: { sailor_localLayers: plan.layers, sailor_frame: { preset: 'ad-300x600' },
        sailor_posterState: { ...plan.posterState, style: 'performance' } } as Record<string, any>,
    }
    restoreFormatHiddenLines(data)
    const vis = (id: string) => (data.properties.sailor_localLayers as { id: string; visible?: boolean }[]).find(l => l.id === id)!.visible
    // 300×600 carries one more level: the product name shows again; the button and the fine
    // print (the content view's caption) stay hidden.
    expect(vis('d')).not.toBe(false)
    expect(vis('a')).toBe(false)
    expect(vis('c')).toBe(false)
  })
})

// A canvas that measures: every character 0.5 em, and a face named "Wide" twice as wide.
function fakeCanvasDocument() {
  const ctx = {
    font: '', textBaseline: 'alphabetic',
    measureText(t: string) {
      const px = parseFloat(/(\d+(?:\.\d+)?)px/.exec(this.font)?.[1] ?? '10')
      const k = /Wide/.test(this.font) ? 2 : 1
      return { width: [...t].length * 0.5 * px * k, actualBoundingBoxAscent: 0.35 * px, actualBoundingBoxDescent: 0.35 * px } as TextMetrics
    },
  }
  return { createElement: () => ({ getContext: () => ctx }) }
}

describe('I2: each content line is measured in its own layer\'s face', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  /** Review's quote and reviewer elements, with the real (canvas) measure over the Frame's layers. */
  const reviewEls = (face: { quote?: string; by?: string }) => {
    const layers = reviewAd().map(l => (l.id === 'q' && face.quote ? { ...l, fontFamily: face.quote }
      : l.id === 'b' && face.by ? { ...l, fontFamily: face.by } : l) as LocalLayer)
    const a = { ...args({ sailor_localLayers: layers }, 'perfReview', 'performance'), measure: undefined }
    const els = candidatesForFrame(a)[0]!.out.els
    return { quote: els.find(e => e.k === 't' && e.role === 'quote') as TextEl, by: els.find(e => e.k === 't' && e.role === 'by') as TextEl }
  }

  it('a quote in a wider face than the product name is broken and sized in its own face', () => {
    vi.stubGlobal('document', fakeCanvasDocument())
    const same = reviewEls({})
    const wide = reviewEls({ quote: 'Wide' })
    // Measured in its own (twice as wide) face, the quote needs more lines or a smaller size.
    expect(wide.quote.s.split('\n').length > same.quote.s.split('\n').length || wide.quote.size < same.quote.size).toBe(true)
  })

  it('the planner hands the measure each content line\'s own layer, and faceOf names it', () => {
    vi.mocked(makeCanvasMeasure).mockClear()
    candidatesForFrame({ ...args({ sailor_localLayers: reviewAd() }, 'perfReview', 'performance'), measure: undefined })
    const roles = vi.mocked(makeCanvasMeasure).mock.calls.at(-1)![0]
    expect(roles.quote?.id).toBe('q')
    expect(roles.by?.id).toBe('b')
    expect(roles.rating?.id).toBe('r')
    // Owned text keeps ruling R10: the caption face is the fine print's layer.
    expect(roles.caption?.id).toBe('c')
    expect(roles.details?.id).toBe('d')
    for (const r of ['quote', 'by', 'rating', 'list', 'stat', 'statline', 'them'] as const) expect(faceOf(r)).toBe(r)
    expect(faceOf('list2')).toBe('list')
    expect(faceOf('before')).toBe('caption')
  })

  it('a content role with no layer of its own is measured as before (quote, stat: the details face; the rest: the caption face)', () => {
    vi.stubGlobal('document', fakeCanvasDocument())
    const layer = (o: Record<string, unknown>) => tl('x', 'x', 0.03, o) as never
    const m = makeCanvasMeasure({ details: layer({ fontFamily: 'Wide' }), caption: layer({}) })
    expect(m.w100('abc', 'quote', 0)).toBeCloseTo(m.w100('abc', 'details', 0), 9)
    expect(m.w100('abc', 'stat', 0)).toBeCloseTo(m.w100('abc', 'details', 0), 9)
    expect(m.w100('abc', 'by', 0)).toBeCloseTo(m.w100('abc', 'caption', 0), 9)
    expect(m.w100('abc', 'details', 0)).toBeCloseTo(2 * m.w100('abc', 'caption', 0), 9)
  })
})

describe('rule 10 covers the layout\'s own words and its stars', () => {
  const S = makeSheet({ frameW: 1000, frameH: 1000, measure: makeStubMeasure(), style: 'performance' })
  const photo: El = { k: 'p', x: 0, y: 0, w: 100, h: 100, role: 'photo', ok: true, bleed: true }

  it('owned text on the raw image fails; on a card above the image passes', () => {
    const own: El = { k: 'own', s: 'Before', x: 10, top: 10, size: 4, wt: 600, ls: 0, lh: 1, role: 'before' }
    expect(checkPlan([photo, own], S, undefined, { style: 'performance' })).toEqual(['before: sits on the raw image'])
    const card: El = { k: 'r', x: 8, y: 8, w: 30, h: 8, color: 'field', role: 'card', ok: true }
    expect(checkPlan([photo, card, own], S, undefined, { style: 'performance' })).toEqual([])
    // Swiss (no textOffImage): unchanged.
    expect(checkPlan([photo, own], S)).toEqual([])
  })

  it('stars on the raw image fail; on a band above it pass', () => {
    const stars: El = { k: 'stars', x: 10, y: 80, size: 3, value: 4.5, role: 'stars' }
    expect(checkPlan([photo, stars], S, undefined, { style: 'performance' })).toEqual(['stars: sits on the raw image'])
    const band: El = { k: 'band', side: 'bottom', y: 70, h: 30, solid: 0.6, role: 'band', ok: true, bleed: true }
    expect(checkPlan([photo, band, stars], S, undefined, { style: 'performance' })).toEqual([])
  })
})

describe('the descriptions say only what was drawn', () => {
  it('Review with no rating, no logo and no action line: no stars, no logo, no button', () => {
    const layers = [tl('t', 'Run lighter.', 0.1), tl('q', '“Lightest shoe I have ever raced in.”', 0.035), tl('b', '— Maya R., verified buyer', 0.018), img('img')]
    const did = candidatesForFrame(args({ sailor_localLayers: layers }, 'perfReview', 'performance'))[0]!.out.did
    expect(did).not.toMatch(/stars|logo|button/)
    expect(did).toMatch(/quote/)
  })

  it('Review with stars, a logo and a button names all three', () => {
    const did = candidatesForFrame({ ...args({ sailor_localLayers: reviewAd() }, 'perfReview', 'performance'), brandLogo: { ...AD_LOGO } })[0]!.out.did
    expect(did).toMatch(/stars/)
    expect(did).toMatch(/logo/)
    expect(did).toMatch(/button/)
  })

  it('Offer first with the platform\'s own button: no button described', () => {
    const f = FRAME_FORMATS.find(x => x.id === 'meta-feed-4x5')!
    const props = { sailor_localLayers: reviewAd(), sailor_frame: { preset: 'meta-feed-4x5' } }
    const cands = candidatesForFrame({ ...args(props, 'perfOfferFirst', 'performance'), frameW: f.w, frameH: f.h })
    const native = cands.find(c => c.choice.cta === 'native')
    const drawn = cands.find(c => (c.choice.cta ?? 'drawn') === 'drawn')!
    expect(drawn.out.did).toMatch(/button/)
    expect(native, 'a native variation is offered on the feed').toBeTruthy()
    expect(native!.out.did).not.toMatch(/button/)
  })

  it('Reasons why with the user\'s own markers: not "numbered"', () => {
    const list = (text: string) => [tl('t', 'Run lighter.', 0.1), tl('l', text, 0.022), tl('dt', '–30%', 0.04), img('img')]
    const own = candidatesForFrame(args({ sailor_localLayers: list('1. Carbon plate\n2. 198 g per shoe\n3. Grips on wet rock') }, 'perfListicle', 'performance'))[0]!.out.did
    expect(own).not.toMatch(/numbered/)
    const plain = candidatesForFrame(args({ sailor_localLayers: list('Carbon plate\n198 g per shoe\nGrips on wet rock') }, 'perfListicle', 'performance'))[0]!.out.did
    expect(plain).toMatch(/numbered/)
  })
})

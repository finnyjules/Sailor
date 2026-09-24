import { afterEach, describe, expect, it } from 'vitest'
import { reactive } from 'vue'
import {
  compareRows, contentHints, elementsOf, isByText, isListText, isQuoteText, isStatText, listItems, ratingOf, readContent, themOf,
} from '~/lib/frame/patterns/kit/content'
import type { ContentTags } from '~/lib/frame/patterns/kit/content'
import { __setRecognitionForTest } from '~/lib/frame/patterns/kit/content'
import { candidatesForFrame, contentForFrame, planLayout, roleIdsForFrame } from '~/lib/frame/patterns/kit/plan'
import type { LayoutPlanArgs } from '~/lib/frame/patterns/kit/plan'
import { faceOf } from '~/lib/frame/patterns/kit/types'
import type { Content, LayoutDef } from '~/lib/frame/patterns/kit/types'
import { inferElements } from '~/lib/frame/patterns/hierarchy'
import { posterLayerViews } from '~/lib/frame/patterns/frameContext'
import { __registerLayoutForTest, LAYOUTS } from '~/lib/frame/patterns/layouts/catalog'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { DEFAULT_CHOICE } from '~/lib/frame/patterns/kit/vary'
import { createImageLayer, createRectLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'
import { AD_LOGO, adFrameLayers, palette } from './helpers/frameLayoutFixtures'

const tl = (id: string, text: string, fontSize: number) =>
  createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer
const img = (id: string) => createImageLayer('x.png', 1.25, { id, w: 0.5, h: 0.625 }) as LocalLayer
const infer = (layers: LocalLayer[]) => inferElements(posterLayerViews({ sailor_localLayers: layers }))
const read = (layers: LocalLayer[], tags?: ContentTags) => readContent(layers, infer(layers), tags)

describe('R2 recognition — the rules one by one', () => {
  it('rating: "4.7 ★", "★★★★☆", "5/5" (and friends); "4.7 million" is not a rating', () => {
    expect(ratingOf('4.7 ★')).toBe(4.7)
    expect(ratingOf('★★★★☆')).toBe(4)
    expect(ratingOf('5/5')).toBe(5)
    expect(ratingOf('4,5 out of 5')).toBe(4.5)
    expect(ratingOf('4 stars')).toBe(4)
    expect(ratingOf('4.7 million')).toBeUndefined()
    // Fix round 2: a bare 0–5 is not a rating without a marker (unless tagged: `bare`).
    expect(ratingOf('3')).toBeUndefined()
    expect(ratingOf('4.7')).toBeUndefined()
    expect(ratingOf('3', true)).toBe(3)
    expect(ratingOf('6/5')).toBeUndefined()
    expect(ratingOf('★★★★★★')).toBeUndefined()
    expect(ratingOf('Great ★')).toBeUndefined()
  })
  it('quote: opens with a quote mark and is at least three words', () => {
    expect(isQuoteText('“Lightest shoe I have ever raced in.”')).toBe(true)
    expect(isQuoteText('"Lightest shoe ever"')).toBe(true)
    expect(isQuoteText('„Leichtester Schuh überhaupt“')).toBe(true)
    expect(isQuoteText('“Wow”')).toBe(false)
    expect(isQuoteText('Lightest shoe I have ever raced in.')).toBe(false)
  })
  it('by: opens with a dash, at most eight words, not number-like', () => {
    expect(isByText('— Maya R., verified buyer')).toBe(true)
    expect(isByText('– Maya R.')).toBe(true)
    expect(isByText('- Maya R.')).toBe(true)
    expect(isByText('–30%')).toBe(false)
    expect(isByText('— one two three four five six seven eight nine')).toBe(false)
    expect(isByText('Maya R., verified buyer')).toBe(false)
  })
  it('list: a 4-line list; marked lines; a 2-line caption with a long line is NOT a list', () => {
    expect(isListText('Carbon plate for push-off\n198 g per shoe\nGrips on wet rock\nFree returns for 60 days')).toBe(true)
    expect(isListText('• Carbon plate\n• Recycled upper')).toBe(true)
    expect(isListText('1. Carbon plate\n2) Recycled upper')).toBe(true)
    expect(isListText('Offer ends 12 October.\nWhile stocks last, in every store we run across the country.')).toBe(false)
    // Two short unmarked lines are an address, not a list (ruling R1: only when unambiguous).
    expect(isListText('Kunstraum Lenz\nLenzgasse 14, 4056 Basel')).toBe(false)
    expect(isListText('One line only')).toBe(false)
    expect(listItems('• Carbon plate\n- Recycled upper\n3. Free returns\n· Grips')).toEqual(['Carbon plate', 'Recycled upper', 'Free returns', 'Grips'])
  })
  it('stat: "198 g" is a stat; "–30%", "19.09.2026", a price and a time are not', () => {
    expect(isStatText('198 g')).toBe(true)
    expect(isStatText('5000 mAh')).toBe(true)
    expect(isStatText('12 h')).toBe(true)
    expect(isStatText('–30%')).toBe(false)
    expect(isStatText('19.09.2026')).toBe(false)
    expect(isStatText('€ 129')).toBe(false)
    expect(isStatText('18–23h')).toBe(false)
    expect(isStatText('12 Oct')).toBe(false)
    expect(isStatText('Room 101')).toBe(false)
    expect(isStatText('Halden Trail 2')).toBe(false)
  })
  it('them: "vs a typical trail shoe" → "a typical trail shoe"', () => {
    expect(themOf('vs a typical trail shoe')).toBe('a typical trail shoe')
    expect(themOf('VS. the rest')).toBe('the rest')
    expect(themOf('Versus last year')).toBe('last year')
    expect(themOf('vsco filters')).toBeUndefined()
  })
  it('compare rows: ours ✓ theirs ✕ unless the line ends in " ✓✓" or " (both)"', () => {
    expect(compareRows(['Carbon plate', 'Free returns ✓✓', 'Recycled upper (both)'])).toEqual([
      { label: 'Carbon plate', us: true, them: false },
      { label: 'Free returns', us: true, them: true },
      { label: 'Recycled upper', us: true, them: true },
    ])
  })
  // Final review I2: each content line is drawn by its own layer, so it is measured in that layer's
  // face (the measure falls back to the details / caption face when there is none).
  it('faceOf: each content role measures in its own face (list2 in the list\'s)', () => {
    for (const r of ['quote', 'stat', 'by', 'rating', 'list', 'statline', 'them']) expect(faceOf(r)).toBe(r)
    expect(faceOf('list2')).toBe('list')
    expect(faceOf('title2')).toBe('title')
    expect(faceOf('action')).toBe('action')
  })
})

describe('readContent — on a Frame', () => {
  const review = () => [
    tl('t', 'Run lighter.', 0.12), tl('q', '“Lightest shoe I have ever raced in.”', 0.05),
    tl('r', '4.7 ★', 0.04), tl('b', '— Maya R., verified buyer', 0.02), tl('a', 'Shop now', 0.03),
  ]
  it('a review: quote, rating and by — the title and the action stay', () => {
    const got = read(review())
    expect(got.roles).toEqual({ title: 't', action: 'a', quote: 'q', rating: 'r', by: 'b' })
    expect(got.review).toEqual({ stars: 4.7, quote: '“Lightest shoe I have ever raced in.”', by: '— Maya R., verified buyer' })
    expect(got.list).toBeUndefined()
  })
  it('a list and a comparison', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('l', 'Carbon plate\nUnder 200 g\nFree returns ✓✓', 0.03), tl('v', 'vs a typical trail shoe', 0.02)]
    const got = read(layers)
    expect(got.roles).toMatchObject({ title: 't', list: 'l', them: 'v' })
    expect(got.list).toEqual(['Carbon plate', 'Under 200 g', 'Free returns ✓✓'])
    expect(got.compare).toEqual({ them: 'a typical trail shoe', rows: [
      { label: 'Carbon plate', us: true, them: false }, { label: 'Under 200 g', us: true, them: false }, { label: 'Free returns', us: true, them: true },
    ] })
  })
  it('a stat and its line: the next-smaller unclaimed text', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('s', '198 g', 0.06), tl('sl', 'Our lightest trail shoe yet.', 0.03), tl('c', 'Offer ends 12 October.', 0.015)]
    const got = read(layers)
    expect(got.roles).toEqual({ title: 't', stat: 's', statline: 'sl', caption: 'c' })
    expect(got.stat).toEqual({ value: '198 g', line: 'Our lightest trail shoe yet.' })
  })
  it('the title is never re-read: a large "198 g" title stays the title', () => {
    const got = read([tl('t', '198 g', 0.2), tl('d', 'Our lightest trail shoe yet.', 0.03)])
    expect(got.roles).toEqual({ title: 't', caption: 'd' })
    expect(got.stat).toBeUndefined()
  })
  it('image2: the second image in document order', () => {
    const got = read([tl('t', 'Before and after', 0.12), img('i1'), img('i2'), img('i3')])
    expect(got.roles.image2).toBe('i2')
    expect(read([tl('t', 'One', 0.12), img('i1')]).roles.image2).toBeUndefined()
  })
  it('a tag overrides recognition and a stored role', () => {
    const layers = review()
    // The rating line tagged as the caption: it is no longer read as a rating.
    const got = read(layers, { r: 'caption' })
    expect(got.roles.caption).toBe('r')
    expect(got.roles.rating).toBeUndefined()
    expect(got.review).toEqual({ quote: '“Lightest shoe I have ever raced in.”', by: '— Maya R., verified buyer' })
    // A plain line tagged as a quote; the stored role (details) gives way.
    const plain = [tl('t', 'Run lighter.', 0.12), tl('d', 'Best shoe ever made', 0.04), tl('c', 'Free returns', 0.02)]
    const stored = { sailor_localLayers: plain, sailor_posterState: { roles: { title: 't', details: 'd', caption: 'c' }, tags: { d: 'quote' } } }
    const c = contentForFrame({ props: stored, frameW: 1000, frameH: 1000 })
    expect(c.roles).toEqual({ title: 't', caption: 'c', quote: 'd' })
    expect(c.review).toEqual({ quote: 'Best shoe ever made' })
    // Ruling C2: a new-content tag applies to the content view only; the base view is unchanged.
    expect(roleIdsForFrame({ props: stored, frameW: 1000, frameH: 1000 })).toEqual({ title: 't', details: 'd', caption: 'c' })
  })
  it('tagging the largest line as a quote makes the next one the title', () => {
    const layers = [tl('q', 'Best shoe I ever ran in', 0.12), tl('t', 'Halden Trail 2', 0.05), tl('c', 'Free returns', 0.02)]
    const c = contentForFrame({ props: { sailor_localLayers: layers, sailor_posterState: { tags: { q: 'quote' } } }, frameW: 1000, frameH: 1000 })
    expect(c.roles).toEqual({ title: 't', caption: 'c', quote: 'q' })
  })
  it("'unused' removes a layer from every role", () => {
    const layers = review()
    for (const id of ['t', 'q', 'r', 'b', 'a']) {
      const c = contentForFrame({ props: { sailor_localLayers: layers, sailor_posterState: { tags: { [id]: 'unused' } } }, frameW: 1000, frameH: 1000 })
      expect(Object.values(c.roles)).not.toContain(id)
    }
    // An unused title: the next largest line is the title.
    const c = contentForFrame({ props: { sailor_localLayers: layers, sailor_posterState: { tags: { t: 'unused' } } }, frameW: 1000, frameH: 1000 })
    expect(c.roles.title).toBe('q')
    // Directly: a stored/inferred role on an unused layer is dropped too.
    expect(Object.values(read(layers, { a: 'unused' }).roles)).not.toContain('a')
    // An unused image is not the second image.
    const im = [tl('t', 'Before and after', 0.12), img('i1'), img('i2'), img('i3')]
    expect(read(im, { i2: 'unused' }).roles.image2).toBe('i3')
  })
  it('a tag that does not fit its layer is ignored (image2 on text, a text role on an image)', () => {
    const layers = [tl('t', 'Before and after', 0.12), tl('c', 'Free returns', 0.02), img('i1'), img('i2')]
    const got = read(layers, { c: 'image2', i1: 'quote' })
    expect(got.roles).toEqual({ title: 't', caption: 'c', image2: 'i2' })
  })
})

// ── A Frame without the new content reads exactly as Stage 3 ────────────────────
// Every Stage 1–3 fixture content (the plan/format/style matrices' texts, the prototype's content
// sets without their Stage 4 extras, the hierarchy fixtures): readContent adds nothing, and the
// elements it leaves deep-equal the Stage 3 reading.
const FIXTURES: LocalLayer[][] = [
  [tl('t', 'Weather Report', 0.12), tl('d', 'Ines Vollmer', 0.04), tl('dt', '19.09.–15.11.2026', 0.03), tl('c', 'Kunstraum Lenz\nLenzgasse 14, 4056 Basel', 0.02)],
  [tl('t', 'Weather Report', 0.12), tl('d', 'Ines Vollmer', 0.04), tl('dt', '19.09.–15.11.2026', 0.03), tl('c', 'Kunstraum Lenz\nLenzgasse 14, 4056 Basel', 0.02), tl('a', 'Book tickets', 0.025)],
  [tl('t', 'Run lighter.', 0.12), tl('d', 'Halden Trail 2', 0.04), tl('dt', '–30%', 0.05), tl('c', 'Offer ends 12 October. While stocks last.', 0.015), tl('a', 'Shop now', 0.03)],
  [tl('t', 'Open Studio', 0.12), tl('d', 'Mara Lind and guests', 0.04), tl('dt', 'Sat 4.10., 18–23h', 0.03), tl('c', 'Werkhof 3, Zürich\nFree entry', 0.02), tl('a', 'Get tickets', 0.025)],
  [tl('t', 'Make the thing you wish existed.', 0.1), tl('d', 'Ada Moreau', 0.04), tl('dt', 'Studio talk No. 12', 0.03), tl('c', '@slowmade', 0.02)],
  [tl('t', 'Exhibition', 0.2), tl('dt', '19.09.–15.11.2026', 0.05), tl('d', 'Group show', 0.05), tl('c', 'Free entry', 0.018)],
  [tl('t', 'Exhibition', 0.2), tl('dt', 'Save the date: December', 0.05), tl('d', 'Group show', 0.05), tl('c', 'Free entry', 0.018)],
  [tl('t', 'Sale', 0.2), tl('d', '50% off', 0.04), tl('c', 'Kunstraum Lenz\nLenzgasse 14', 0.02)],
  [tl('t', 'Weather', 0.2)],
  [tl('t', 'Weather Report', 0.12), tl('c', 'Kunstraum', 0.02), img('i1'), createRectLayer({ id: 'sh' }) as LocalLayer],
]

describe('a Frame without the new content reads exactly as Stage 3', () => {
  it('readContent adds no role and no shape; elementsOf deep-equals the Stage 3 reading', () => {
    for (const layers of FIXTURES) {
      const inferred = infer(layers)
      const got = readContent(layers, inferred, undefined)
      const base: Record<string, string> = {}
      for (const r of ['title', 'details', 'date', 'caption', 'action'] as const) if (inferred[r]) base[r] = inferred[r]!.id
      expect(got.roles).toEqual(base)
      expect(got.review ?? got.list ?? got.compare ?? got.stat).toBeUndefined()
      expect(elementsOf(got, inferred, layers)).toEqual(inferred)
      // Empty tags read the same.
      expect(readContent(layers, inferred, {}).roles).toEqual(base)
    }
  })
  it('the planner reads the same roles with stored roles too (roleIdsForFrame, contentForFrame)', () => {
    for (const layers of FIXTURES) {
      const inferred = infer(layers)
      const base: Record<string, string> = {}
      for (const r of ['title', 'details', 'date', 'caption', 'action'] as const) if (inferred[r]) base[r] = inferred[r]!.id
      const a = { props: { sailor_localLayers: layers }, frameW: 895, frameH: 1280 }
      expect(roleIdsForFrame(a)).toEqual(base)
      expect(contentForFrame(a).roles).toEqual(base)
      const withStored = { ...a, props: { ...a.props, sailor_posterState: { roles: base, tags: {} } } }
      expect(roleIdsForFrame(withStored)).toEqual(base)
    }
  })
})

// ── The planner hands the content to the layout ──────────────────────────────
let unregister: (() => void)[] = []
afterEach(() => { unregister.forEach(f => f()); unregister = [] })

describe('planLayout — the content shapes reach the layout', () => {
  const capture = (): { def: LayoutDef; seen: Content[] } => {
    const seen: Content[] = []
    return {
      seen,
      def: {
        id: 't-content', name: 't-content', fits: ['word', 'phrase', 'sentence'], needsContent: [],
        fn(S, { c }) {
          seen.push(c)
          return { els: [S.disp(c.title, { size: S.fitSize([c.title], S.SPAN(1, 12)), x: S.X(1), top: S.L(1) })], did: 'content' }
        },
      },
    }
  }
  const args = (layers: LocalLayer[], extra: Record<string, unknown> = {}): LayoutPlanArgs => ({
    props: { sailor_localLayers: layers, ...extra }, frameW: 895, frameH: 1280, layoutId: 't-content', choice: { ...DEFAULT_CHOICE },
    palette: { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }, connectedSlots: [], measure: makeStubMeasure(),
  })
  it('a review Frame: content.review, and the quote is not the details', () => {
    const { def, seen } = capture()
    unregister.push(__registerLayoutForTest(def))
    const plan = planLayout(args([tl('t', 'Run lighter.', 0.12), tl('q', '“Lightest shoe I have ever raced in.”', 0.05), tl('r', '★★★★☆', 0.04), tl('b', '— Maya R.', 0.02)]))
    expect(plan).not.toBeNull()
    expect(seen[0]!.review).toEqual({ stars: 4, quote: '“Lightest shoe I have ever raced in.”', by: '— Maya R.' })
    expect(seen[0]!.details).toBeUndefined()
    // posterState stores the BASE view's roles (ruling C2), so the other layouts read the Frame as before.
    expect(plan!.posterState.roles).toEqual({ title: 't', details: 'q', caption: 'b' })
  })
  it('a plain Frame: no content shape keys at all', () => {
    const { def, seen } = capture()
    unregister.push(__registerLayoutForTest(def))
    planLayout(args(FIXTURES[0]!))
    expect(Object.keys(seen[0]!).sort()).toEqual(['caption', 'date', 'details', 'title'])
  })
})

// ── Undo restores tags ──────────────────────────────────────────────────────
describe('undo / redo restore the content tags', () => {
  it('an undo of a tag change puts back the previous tags; a redo brings them back', () => {
    const node = reactive({ data: { widgetDefs: [], widgetsValues: [], properties: { sailor_localLayers: [createRectLayer({ id: 'r' })] } as Record<string, any> } })
    const ed = useLocalLayerEditor({ node: () => node as any, dims: () => ({ w: 1024, h: 1024 }), getRect: () => null })
    const props = node.data.properties
    props.sailor_posterState = { patternId: 'runoff', seed: 1, index: 0, tags: { q: 'quote' } }
    ed.recordHistory()
    ed.commit([createRectLayer({ id: 'r', x: 0.2 })])
    props.sailor_posterState = { ...props.sailor_posterState, tags: { q: 'quote', r: 'rating', x: 'unused' } }
    ed.undo()
    expect(props.sailor_posterState.tags).toEqual({ q: 'quote' })
    ed.redo()
    expect(props.sailor_posterState.tags).toEqual({ q: 'quote', r: 'rating', x: 'unused' })
  })
})

// ── Ruling C2: two views ────────────────────────────────────────────────────
describe('ruling C2 — the base view and the content view', () => {
  // A quote-like line that Stage 3 reads as the details; a five-line Frame so the content view
  // can re-infer the details from another line.
  const quoteFrame = () => [
    tl('t', 'Run lighter.', 0.12), tl('q', '“Lightest shoe I have ever raced in.”', 0.05),
    tl('d', 'Halden Trail 2', 0.04), tl('dt', '–30%', 0.035), tl('c', 'Offer ends 12 October.', 0.015),
  ]
  const palette = { field: '#f2f0ef', ink: '#121212', accent: '#dd2200' }
  const planArgs = (layoutId: string, style: LayoutPlanArgs['style'], props: Record<string, unknown>): LayoutPlanArgs => ({
    props, frameW: 895, frameH: 1280, layoutId, choice: { ...DEFAULT_CHOICE },
    palette, connectedSlots: [], measure: makeStubMeasure(), ...(style ? { style } : {}),
  })

  it('every layout without needsContent plans exactly as with recognition disabled (Swiss, Editorial, Street, Performance)', () => {
    const props = { sailor_localLayers: quoteFrame() }
    const defs = LAYOUTS.filter(d => d.needsContent == null)
    expect(defs.filter(d => (d.style ?? 'swiss') === 'swiss').length).toBeGreaterThan(30)
    let planned = 0
    for (const d of defs) {
      const style = d.style
      const on = planLayout(planArgs(d.id, style, props))
      const on2 = candidatesForFrame(planArgs(d.id, style, props)).map(c => c.choice)
      const undo = __setRecognitionForTest(false)
      try {
        expect(planLayout(planArgs(d.id, style, props))).toEqual(on)
        expect(candidatesForFrame(planArgs(d.id, style, props)).map(c => c.choice)).toEqual(on2)
      } finally { undo() }
      if (on) planned++
    }
    expect(planned).toBeGreaterThan(20)
  })

  it('the base view keeps the quote-like line as the details', () => {
    const props = { sailor_localLayers: quoteFrame() }
    expect(roleIdsForFrame({ props, frameW: 895, frameH: 1280 })).toEqual({ title: 't', details: 'q', date: 'dt', caption: 'c' })
    const plan = planLayout(planArgs('runoff', undefined, props))!
    expect(plan.posterState.roles).toEqual({ title: 't', details: 'q', date: 'dt', caption: 'c' })
  })

  it('in the content view the same Frame has the quote, and the details re-inferred from the rest', () => {
    const c = contentForFrame({ props: { sailor_localLayers: quoteFrame() }, frameW: 895, frameH: 1280 })
    expect(c.roles).toEqual({ title: 't', details: 'd', date: 'dt', caption: 'c', quote: 'q' })
    expect(c.review).toEqual({ quote: '“Lightest shoe I have ever raced in.”' })
    // …and a layout that declares needsContent is handed that view.
    const seen: Content[] = []
    unregister.push(__registerLayoutForTest({
      id: 't-c2', name: 't-c2', fits: ['word', 'phrase', 'sentence'], needsContent: ['review'],
      fn(S, { c }) {
        seen.push(c)
        return { els: [S.disp(c.title, { size: S.fitSize([c.title], S.SPAN(1, 12)), x: S.X(1), top: S.L(1) })], did: 'c2' }
      },
    }))
    const plan = planLayout(planArgs('t-c2', undefined, { sailor_localLayers: quoteFrame() }))!
    expect(seen[0]).toMatchObject({ title: 'Run lighter.', details: 'Halden Trail 2', date: '–30%', caption: 'Offer ends 12 October.' })
    expect(seen[0]!.review).toEqual({ quote: '“Lightest shoe I have ever raced in.”' })
    expect(plan.posterState.roles).toEqual({ title: 't', details: 'q', date: 'dt', caption: 'c' })
  })

  it('tags: a new-content tag applies to the content view only; a base-role tag and unused apply to both', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('d', 'Best shoe ever made', 0.04), tl('x', 'Halden Trail 2', 0.03), tl('c', 'Free returns', 0.02)]
    const at = (tags: ContentTags) => ({ props: { sailor_localLayers: layers, sailor_posterState: { tags } }, frameW: 895, frameH: 1280 })
    // New-content tag: base view as if untagged; content view re-infers without the tagged line.
    expect(roleIdsForFrame(at({ d: 'quote' }))).toEqual(roleIdsForFrame(at({})))
    expect(contentForFrame(at({ d: 'quote' })).roles).toEqual({ title: 't', details: 'x', caption: 'c', quote: 'd' })
    // Base-role tag: both views.
    expect(roleIdsForFrame(at({ c: 'details' }))).toMatchObject({ details: 'c' })
    expect(contentForFrame(at({ c: 'details' })).roles).toMatchObject({ details: 'c' })
    // Unused: gone from both.
    expect(Object.values(roleIdsForFrame(at({ x: 'unused' })))).not.toContain('x')
    expect(Object.values(contentForFrame(at({ x: 'unused' })).roles)).not.toContain('x')
  })
})

// ── Fix round 2: a bare digit is not a rating; unshaped claims go back ─────
describe('fix round 2 — explicit rating markers, unshaped content goes back to its base role', () => {
  const at = (layers: LocalLayer[], tags?: ContentTags) =>
    ({ props: { sailor_localLayers: layers, ...(tags ? { sailor_posterState: { tags } } : {}) }, frameW: 895, frameH: 1280 })

  it('a lone "3" with no ★ keeps its caption role in both views', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('d', 'Halden Trail 2', 0.04), tl('c', '3', 0.02)]
    expect(roleIdsForFrame(at(layers))).toEqual({ title: 't', details: 'd', caption: 'c' })
    const c = contentForFrame(at(layers))
    expect(c.roles).toEqual({ title: 't', details: 'd', caption: 'c' })
    expect(c.review).toBeUndefined()
  })

  it('"4.5 ★" with no quote goes back to its base role in the content view', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('d', 'Halden Trail 2', 0.04), tl('r', '4.5 ★', 0.03), tl('c', 'Free returns', 0.02)]
    const base = roleIdsForFrame(at(layers))
    expect(base).toEqual({ title: 't', details: 'd', date: 'r', caption: 'c' })
    expect(contentForFrame(at(layers)).roles).toEqual(base)
    // Directly (no re-inference) too.
    expect(read(layers).roles).toEqual(base)
    // …and alongside other content that does claim lines (so the base roles are re-inferred).
    const withStat = [...layers, tl('s', '198 g', 0.05)]
    const c = contentForFrame(at(withStat))
    expect(c.roles.rating).toBeUndefined()
    expect(Object.values(c.roles)).toContain('r')
  })

  it('a reviewer without a quote, "vs …" without a list: back to their base roles', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('b', '— Maya R.', 0.04), tl('v', 'vs a typical trail shoe', 0.02)]
    const c = contentForFrame(at(layers))
    // ("— Maya R." reads as the date in Stage 3 — "May" — and goes back to exactly that.)
    expect(c.roles).toEqual(roleIdsForFrame(at(layers)))
    expect(c.roles).toMatchObject({ title: 't', caption: 'v' })
    expect(Object.values(c.roles)).toContain('b')
    expect(c.compare).toBeUndefined()
  })

  it('a tagged rating without a quote stays a rating (even a bare digit)', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('d', 'Halden Trail 2', 0.04), tl('c', '3', 0.02)]
    const c = contentForFrame(at(layers, { c: 'rating' }))
    expect(c.roles.rating).toBe('c')
    // The tagged line leaves the base roles; they are re-inferred from the rest (ruling C2).
    expect(c.roles).toEqual({ title: 't', caption: 'd', rating: 'c' })
    expect(c.review).toBeUndefined()
    // With a quote, the tagged bare digit is the stars.
    const q = [...layers, tl('q', '“Lightest shoe I have ever raced in.”', 0.03)]
    expect(contentForFrame(at(q, { c: 'rating' })).review).toEqual({ stars: 3, quote: '“Lightest shoe I have ever raced in.”' })
  })
})

// ═══════════════════════ Stage 4, Task 3 — the platform button choice (ruling R7) ═══════════════════════
describe('the platform button choice reaches the real planner (ruling R7)', () => {
  const metaStoryArgs = (o: { action: boolean; image?: boolean }, layoutId: string, style: LayoutPlanArgs['style']): Omit<LayoutPlanArgs, 'choice'> => ({
    props: { sailor_localLayers: adFrameLayers('phrase', { image: o.image ?? true, action: o.action }), sailor_frame: { preset: 'meta-story' } },
    frameW: 1080, frameH: 1920, layoutId, palette, connectedSlots: [], measure: makeStubMeasure(), style,
  })
  // A plain, custom-size Frame: no format at all, so `platformButton` is never true — the
  // control for "no platform button" (as opposed to meta-story's "no action line").
  const plainArgs = (o: { action: boolean }, layoutId: string, style: LayoutPlanArgs['style']): Omit<LayoutPlanArgs, 'choice'> => ({
    props: { sailor_localLayers: adFrameLayers('phrase', { image: true, action: o.action }) },
    frameW: 1280, frameH: 720, layoutId, palette, connectedSlots: [], measure: makeStubMeasure(), style,
  })

  it('offered only on a platformButton format with an action line (Performance\'s Offer layout)', () => {
    // meta-story has platformButton; with an action line, `cta: 'native'` candidates appear.
    const withAction = candidatesForFrame(metaStoryArgs({ action: true }, 'perfOffer', 'performance'))
    expect(withAction.length).toBeGreaterThan(0)
    expect(withAction.some(c => c.choice.cta === 'native')).toBe(true)
    // No action line: nothing to hide, so the axis is never offered — no candidate carries `cta`.
    const noAction = candidatesForFrame(metaStoryArgs({ action: false }, 'perfOffer', 'performance'))
    expect(noAction.length).toBeGreaterThan(0)
    expect(noAction.every(c => !('cta' in c.choice))).toBe(true)
    // No format at all (so no platformButton), even with an action line: never offered.
    const noPlatformButton = candidatesForFrame(plainArgs({ action: true }, 'perfOffer', 'performance'))
    expect(noPlatformButton.length).toBeGreaterThan(0)
    expect(noPlatformButton.every(c => !('cta' in c.choice))).toBe(true)
  })

  it("'native' hides the action, draws no button, and lists it in notPlaced", () => {
    const cands = candidatesForFrame(metaStoryArgs({ action: true }, 'perfOffer', 'performance'))
    const native = cands.find(c => c.choice.cta === 'native')!
    expect(native).toBeDefined()
    expect(native.out.els.some(e => e.k === 'btn')).toBe(false)
    expect(native.out.els.some(e => e.k === 't' && e.role === 'action')).toBe(false)
    const plan = planLayout({ ...metaStoryArgs({ action: true }, 'perfOffer', 'performance'), choice: native.choice })!
    expect(plan.issues).toEqual([])
    expect(plan.notPlaced).toEqual([{ role: 'action', text: 'Shop now' }])
    const actionLayer = plan.layers.find(l => l.id === 'a') as { visible?: boolean } | undefined
    expect(actionLayer?.visible).toBe(false)
    // The drawn ('cta: drawn', the default) choice still draws the button, action shown.
    const drawn = cands.find(c => (c.choice.cta ?? 'drawn') === 'drawn')!
    expect(drawn.out.els.some(e => e.k === 'btn')).toBe(true)
    const drawnPlan = planLayout({ ...metaStoryArgs({ action: true }, 'perfOffer', 'performance'), choice: drawn.choice })!
    expect(drawnPlan.notPlaced).toEqual([])
  })

  it('Swiss never offers it, even on a platformButton format with an action line (it hides the action line instead)', () => {
    const swiss = candidatesForFrame(metaStoryArgs({ action: true }, 'statement', undefined))
    expect(swiss.length).toBeGreaterThan(0)
    expect(swiss.every(c => !('cta' in c.choice))).toBe(true)
  })

  // Task 2: every style that draws a button offers the choice, not Performance alone — Editorial's
  // link and Street's hard-edged box included (`STYLES[style].button`; only Swiss has none).
  it('Editorial and Street offer it too, on a platformButton format with an action line', () => {
    const editorial = candidatesForFrame(metaStoryArgs({ action: true, image: true }, 'edCover', 'editorial'))
    expect(editorial.length).toBeGreaterThan(0)
    expect(editorial.some(c => c.choice.cta === 'native')).toBe(true)
    expect(editorial.some(c => (c.choice.cta ?? 'drawn') === 'drawn')).toBe(true)

    const street = candidatesForFrame(metaStoryArgs({ action: true, image: false }, 'stFill', 'street'))
    expect(street.length).toBeGreaterThan(0)
    expect(street.some(c => c.choice.cta === 'native')).toBe(true)
    expect(street.some(c => (c.choice.cta ?? 'drawn') === 'drawn')).toBe(true)
  })

  it('Editorial and Street do not offer it without a platformButton format, or without an action line', () => {
    const noPlatformButton = candidatesForFrame(plainArgs({ action: true }, 'edCover', 'editorial'))
    expect(noPlatformButton.length).toBeGreaterThan(0)
    expect(noPlatformButton.every(c => !('cta' in c.choice))).toBe(true)

    const noAction = candidatesForFrame(metaStoryArgs({ action: false, image: false }, 'stFill', 'street'))
    expect(noAction.length).toBeGreaterThan(0)
    expect(noAction.every(c => !('cta' in c.choice))).toBe(true)
  })
})

// ═══════════════════════ Stage 4, Task 3 — content hints (ruling R9) ═══════════════════════
describe('contentHints (ruling R9)', () => {
  it('a rating of exactly 5.0 (recognised, or bare and tagged) gets the believability hint', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('q', '“Best shoe ever made in a long while.”', 0.05), tl('r', '5 ★', 0.03), tl('c', 'Free returns', 0.02)]
    expect(contentHints(read(layers), layers)).toEqual(['Ratings between 4.0 and 4.8 tend to read as more believable than a perfect 5.'])
    // 4.7 does not fire it.
    const under = [tl('t', 'Run lighter.', 0.12), tl('q', '“Best shoe ever made in a long while.”', 0.05), tl('r', '4.7 ★', 0.03)]
    expect(contentHints(read(under), under)).toEqual([])
    // A tagged bare "5" (no ★, no quote — never shaped into a review) still fires: the hint reads
    // whatever line holds the rating role, not only a formed review.
    const bare = [tl('t', 'Run lighter.', 0.12), tl('c', '5', 0.02)]
    expect(contentHints(read(bare, { c: 'rating' }), bare)).toEqual(['Ratings between 4.0 and 4.8 tend to read as more believable than a perfect 5.'])
    // No rating at all: nothing.
    expect(contentHints(read([tl('t', 'Run lighter.', 0.12)]), [tl('t', 'Run lighter.', 0.12)])).toEqual([])
  })

  // Both the offer and the "elsewhere" price line carry a currency mark, so Stage 1–3's own
  // number-like inference (`isNumberish`, `hierarchy.ts`) would compete with the offer for the
  // `date` slot (the first number-like middle line wins it). Tags settle it — the fixture is
  // still read as an ordinary Frame otherwise, only which line is the date is pinned.
  const dateIs = { d: 'details', dt: 'date' } as const

  it('a percentage offer with a price ≥ 100 elsewhere prefers an amount', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('d', 'Halden Trail 2, was $149', 0.04), tl('dt', '–30%', 0.03), tl('c', 'While stocks last.', 0.015)]
    expect(contentHints(read(layers, dateIs), layers)).toEqual(['For prices under 100, a percentage reads bigger; above it, an amount does.'])
    // The same offer with every other price under 100: no hint (a percentage is already right).
    const under100 = [tl('t', 'Run lighter.', 0.12), tl('d', 'Halden Trail 2, was $89', 0.04), tl('dt', '–30%', 0.03)]
    expect(contentHints(read(under100, dateIs), under100)).toEqual([])
    // No price named anywhere else: nothing to compare against.
    const noPrice = [tl('t', 'Run lighter.', 0.12), tl('d', 'Halden Trail 2', 0.04), tl('dt', '–30%', 0.03)]
    expect(contentHints(read(noPrice, dateIs), noPrice)).toEqual([])
  })

  it('an amount offer with a price under 100 elsewhere prefers a percentage', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('d', 'Now $79, was $149', 0.04), tl('dt', '$40 off', 0.03)]
    expect(contentHints(read(layers, dateIs), layers)).toEqual(['For prices under 100, a percentage reads bigger; above it, an amount does.'])
    // Every other price is ≥ 100: an amount already reads bigger, no hint.
    const allHigh = [tl('t', 'Run lighter.', 0.12), tl('d', 'Now $120, was $149', 0.04), tl('dt', '$40 off', 0.03)]
    expect(contentHints(read(allHigh, dateIs), allHigh)).toEqual([])
  })

  it('some list lines carry a marker and some don\'t: the partial-marker hint fires, verbatim', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('l', '1. Carbon plate\nUnder 200 g\n3. Free returns', 0.03)]
    expect(contentHints(read(layers, { l: 'list' }), layers)).toEqual(["Some lines start with a number and some don't."])
    // Every line marked: no hint (nothing partial about it).
    const allMarked = [tl('t', 'Run lighter.', 0.12), tl('l', '1. Carbon plate\n2. Under 200 g\n3. Free returns', 0.03)]
    expect(contentHints(read(allMarked, { l: 'list' }), allMarked)).toEqual([])
    // No line marked: no hint either.
    const noneMarked = [tl('t', 'Run lighter.', 0.12), tl('l', 'Carbon plate\nUnder 200 g\nFree returns', 0.03)]
    expect(contentHints(read(noneMarked, { l: 'list' }), noneMarked)).toEqual([])
  })

  it('neither hint on an ordinary Frame', () => {
    const layers = [tl('t', 'Weather Report', 0.12), tl('d', 'Ines Vollmer', 0.04), tl('dt', '19.09.–15.11.2026', 0.03), tl('c', 'Kunstraum Lenz', 0.02)]
    expect(contentHints(read(layers), layers)).toEqual([])
  })

  it('both hints can fire together', () => {
    const layers = [
      tl('t', 'Run lighter.', 0.12), tl('q', '“Best shoe ever made in a long while.”', 0.06), tl('r', '5 ★', 0.03),
      tl('d', 'Halden Trail 2, was $149', 0.04), tl('dt', '–30%', 0.03),
    ]
    expect(contentHints(read(layers, dateIs), layers)).toEqual([
      'Ratings between 4.0 and 4.8 tend to read as more believable than a perfect 5.',
      'For prices under 100, a percentage reads bigger; above it, an amount does.',
    ])
  })

  // Fix round 1: price parsing — thousands vs. decimal separators, currency after the number.
  const HINT = 'For prices under 100, a percentage reads bigger; above it, an amount does.'
  it('a thousands separator: "$1,299" reads as 1299 (≥ 100), not 1.299', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('d', 'Halden Trail 2, was $1,299', 0.04), tl('dt', '–30%', 0.03)]
    expect(contentHints(read(layers, dateIs), layers)).toEqual([HINT])
  })
  it('a decimal separator: "19,50" reads as 19.5 (< 100)', () => {
    // An amount offer with a comma-decimal price of 19.50 elsewhere (under 100): a percentage
    // would read bigger there — the hint fires.
    const layers = [tl('t', 'Run lighter.', 0.12), tl('d', 'Now €19,50', 0.04), tl('dt', '€8 off', 0.03)]
    expect(contentHints(read(layers, dateIs), layers)).toEqual([HINT])
    // The same price with a percentage offer: 19.50 is under 100, so a percentage is already
    // the right choice there — no hint.
    const withPercent = [tl('t', 'Run lighter.', 0.12), tl('d', 'Now €19,50', 0.04), tl('dt', '–30%', 0.03)]
    expect(contentHints(read(withPercent, dateIs), withPercent)).toEqual([])
  })
  it('the currency mark after the number ("149 €", "19,50 €") is recognised too', () => {
    const layers = [tl('t', 'Run lighter.', 0.12), tl('d', 'Halden Trail 2, was 149 €', 0.04), tl('dt', '–30%', 0.03)]
    expect(contentHints(read(layers, dateIs), layers)).toEqual([HINT])
    // As the offer itself (an amount, currency trailing): a price under 100 elsewhere prefers %.
    const asOffer = [tl('t', 'Run lighter.', 0.12), tl('d', 'Was 79 €', 0.04), tl('dt', '19,50 €', 0.03)]
    expect(contentHints(read(asOffer, dateIs), asOffer)).toEqual([HINT])
  })
  it('a non-global test regex: two Frames in a row each read correctly (no stale lastIndex)', () => {
    // A global RegExp's `.test` advances its own `lastIndex`; called on one Frame then another,
    // a leftover index can silently start the second scan mid-string and miss the match.
    const first = [tl('t', 'Run lighter.', 0.12), tl('d', 'Halden Trail 2, was $149', 0.04), tl('dt', '–30%', 0.03)]
    const second = [tl('t', 'Run lighter.', 0.12), tl('d', 'Halden Trail 2, was $149', 0.04), tl('dt', '–30%', 0.03)]
    expect(contentHints(read(first, dateIs), first)).toEqual([HINT])
    expect(contentHints(read(second, dateIs), second)).toEqual([HINT])
    expect(contentHints(read(first, dateIs), first)).toEqual([HINT])
  })
})

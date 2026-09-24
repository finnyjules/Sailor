// @vitest-environment happy-dom
//
// The Layout tab's Content section, hints and Button choice (Stage 4, Task 6): tags round-trip
// through `sailor_posterState.tags` as their own undo step (the real layer editor); a tag changes
// what the library offers; the R9 hints render under the section; the Button pills (ruling R7)
// appear only on a platform-button format with an action line.
import { describe, it, expect } from 'vitest'
import { reactive, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useLayoutVary } from '~/composables/useLayoutVary'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { createImageLayer, createTextLayer } from '~/composables/useCompositorLayers'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import LayoutVaryPanel from '~/components/vue-canvas/compositor/LayoutVaryPanel.vue'
import LayoutContentList from '~/components/vue-canvas/compositor/LayoutContentList.vue'
import { FRAME_FORMATS } from '~/lib/frame/formats'
import { adFrameLayers } from './helpers/frameLayoutFixtures'

const tl = (id: string, text: string, fontSize: number) =>
  createTextLayer({ id, text, fontSize, fontFamily: 'Inter', fontWeight: 600, color: '#111111' }) as LocalLayer

/** An ad Frame with a customer's words that recognition does not read as a quote (no quotation
 *  mark): Review is not offered until the line is tagged. */
function reviewFrame(): LocalLayer[] {
  return [...adFrameLayers('phrase', { image: true, action: false }), tl('q', 'Lightest shoe I have ever raced in.', 0.035)]
}

/** The tab over a node the real layer editor edits (its undo snapshot holds the tags). */
function realHarness(layers: LocalLayer[], extra: Record<string, unknown> = {}, size = { w: 895, h: 1280 }) {
  const node = reactive({ data: { widgetDefs: [], widgetsValues: [], properties: { sailor_localLayers: layers, ...extra } as Record<string, any> } })
  const ed = useLocalLayerEditor({ node: () => node as any, dims: () => ({ w: size.w, h: size.h }), getRect: () => null })
  const props = node.data.properties
  const remember = (st: Record<string, unknown>) => { props.sailor_posterState = { ...props.sailor_posterState, ...st } }
  const vary = useLayoutVary({
    props: () => props, frameW: () => size.w, frameH: () => size.h, connectedSlots: () => [],
    editor: () => ed, remember, measure: makeStubMeasure(),
  })
  return { node, props, ed, vary }
}

const offeredIds = (vary: ReturnType<typeof useLayoutVary>) => vary.library.value.filter(it => it.plan).map(it => it.id)
/** The library plans its first 12 layouts at once and the rest when idle. */
const idle = () => new Promise(r => setTimeout(r, 5))

describe('Content section — tags round-trip and undo', () => {
  it('setTag writes sailor_posterState.tags as ONE undo step; undo and redo restore it; Automatic removes it', async () => {
    const { props, ed, vary } = realHarness(reviewFrame(), { sailor_posterState: { patternId: 'statement', seed: 1, style: 'swiss' } })
    expect(vary.content.value.find(r => r.id === 'q')).toMatchObject({ kind: 'text', tag: null })
    const past = (ed as unknown as { canUndo: { value: boolean } }).canUndo
    expect(past.value).toBe(false)

    expect(vary.setTag('q', 'quote')).toBe(true)
    expect(props.sailor_posterState.tags).toEqual({ q: 'quote' })
    // The rest of the layout record is kept.
    expect(props.sailor_posterState).toMatchObject({ patternId: 'statement', seed: 1, style: 'swiss' })
    expect(past.value).toBe(true)
    expect(vary.content.value.find(r => r.id === 'q')!.tag).toBe('quote')
    // The same tag again is no change, and no undo step.
    expect(vary.setTag('q', 'quote')).toBe(false)

    ed.undo(); await nextTick()
    expect(props.sailor_posterState.tags).toBeUndefined()
    expect(props.sailor_posterState.patternId).toBe('statement')
    expect(vary.content.value.find(r => r.id === 'q')!.tag).toBeNull()
    expect(past.value).toBe(false)   // exactly one step

    ed.redo(); await nextTick()
    expect(props.sailor_posterState.tags).toEqual({ q: 'quote' })
    expect(vary.content.value.find(r => r.id === 'q')!.tag).toBe('quote')

    // Back to Automatic: the key goes when no tag is left.
    expect(vary.setTag('q', null)).toBe(true)
    expect('tags' in props.sailor_posterState).toBe(false)
  })

  it('a layer that is not the user\'s (or does not exist) cannot be tagged', () => {
    const { props, vary } = realHarness(reviewFrame())
    expect(vary.setTag('nope', 'quote')).toBe(false)
    expect(props.sailor_posterState).toBeUndefined()
  })

  it('rows: every text line of the user\'s, then each image beyond the first (named, else numbered)', () => {
    const layers = [
      ...reviewFrame(),
      { ...(createImageLayer('b.png', 1, { id: 'img2' }) as LocalLayer) },
      { ...(createImageLayer('c.png', 1, { id: 'img3' }) as LocalLayer), name: 'After' } as LocalLayer,
    ]
    const { vary } = realHarness(layers)
    const rows = vary.content.value
    expect(rows.filter(r => r.kind === 'text').map(r => r.id)).toEqual(['t', 'd', 'dt', 'c', 'q'])
    expect(rows.filter(r => r.kind === 'image')).toEqual([
      { id: 'img2', kind: 'image', text: '', n: 2, tag: null },
      { id: 'img3', kind: 'image', text: '', n: 3, name: 'After', tag: null },
    ])
  })
})

describe('Content section — a tag changes the library', () => {
  it('tagging a line as Quote makes Review appear; undo takes it away again', async () => {
    const { ed, vary } = realHarness(reviewFrame())
    vary.setStyle('performance')
    await idle()
    expect(vary.libraryDone.value).toBe(true)
    expect(offeredIds(vary)).not.toContain('perfReview')

    vary.setTag('q', 'quote')
    await idle()
    expect(offeredIds(vary)).toContain('perfReview')

    ed.undo(); await nextTick(); await idle()
    expect(offeredIds(vary)).not.toContain('perfReview')
  })

  it('Not used takes a line out of the layouts: it is left exactly where it is', async () => {
    const { props, vary } = realHarness(reviewFrame())
    const original = JSON.parse(JSON.stringify((props.sailor_localLayers as LocalLayer[]).find(l => l.id === 'c')))
    await idle()
    const placed = vary.library.value.find(it => it.id === 'statement')!.plan!.layers.find(l => l.id === 'c')
    expect(placed).not.toEqual(original)   // placed by the layout while Automatic
    vary.setTag('c', 'unused')
    await idle()
    const left = vary.library.value.find(it => it.id === 'statement')!.plan!.layers.find(l => l.id === 'c')
    expect(left).toEqual(original)
  })
})

describe('Content section — the hints (R9)', () => {
  it('a perfect 5 and a percentage beside a price of 100 or more give both hints, verbatim', () => {
    // The offer "–30%" beside "Was $149." in the fine print, and a review rated 5.0.
    const layers = [
      ...adFrameLayers('phrase', { image: true, action: false })
        .map(l => (l.id === 'c' ? { ...l, text: 'Was $149. Offer ends 12 October.' } as LocalLayer : l)),
      tl('q', '“Lightest shoe I have ever raced in.”', 0.035), tl('r', '5.0 ★', 0.03),
    ]
    const { vary } = realHarness(layers)
    expect(vary.hints.value).toEqual([
      'Ratings between 4.0 and 4.8 tend to read as more believable than a perfect 5.',
      'For prices under 100, a percentage reads bigger; above it, an amount does.',
    ])
  })

  it('no hint on the plain ad Frame', () => {
    const { vary } = realHarness(reviewFrame())
    expect(vary.hints.value).toEqual([])
  })

  it('render under the Content section, and show while it is collapsed', () => {
    const hint = 'Ratings between 4.0 and 4.8 tend to read as more believable than a perfect 5.'
    const wrap = mount(LayoutContentList, { props: { rows: [{ id: 'r', kind: 'text', text: '5.0 ★', tag: null }], hints: [hint] } })
    const details = wrap.get('details')
    expect(details.attributes('open')).toBeUndefined()   // collapsed by default
    expect(details.text()).toContain('Content')
    const hints = wrap.findAll('[data-testid="layout-content-hint"]')
    expect(hints.map(h => h.text())).toEqual([hint])
    // under the section, not inside it
    expect(details.find('[data-testid="layout-content-hint"]').exists()).toBe(false)
  })
})

describe('Content section — the rows', () => {
  const rows = [
    { id: 'q', kind: 'text' as const, text: 'Lightest shoe I have ever raced in.', tag: null },
    { id: 'r', kind: 'text' as const, text: '“Best run of my life, honestly.”', tag: 'quote' as const },
    { id: 'img2', kind: 'image' as const, text: '', n: 2, tag: null },
  ]
  it('quotes each line (24 characters, no doubled marks), offers the brief\'s labels, and emits tags', async () => {
    const wrap = mount(LayoutContentList, { props: { rows } })
    const text = wrap.text()
    expect(text).toContain('“Lightest shoe I have eve…”')   // the first 24 characters
    expect(text).toContain('“Best run of my life, ho…Quote')  // its own mark: no second pair
    expect(text).not.toContain('““')
    expect(text).toContain('Image 2')
    const selects = wrap.findAll('select')
    expect(selects).toHaveLength(3)
    expect(selects[0]!.findAll('option').map(o => o.text())).toEqual([
      'Automatic', 'Headline', 'Product or name', 'Offer or date', 'Fine print', 'Button', 'Quote',
      'Reviewer', 'Rating', 'List', 'Stat', 'Stat line', 'Competitor', 'Not used',
    ])
    expect(selects[2]!.findAll('option').map(o => o.text())).toEqual(['Automatic', 'Second image (before / after)', 'Not used'])
    expect((selects[1]!.element as HTMLSelectElement).value).toBe('quote')
    await selects[0]!.setValue('quote')
    await selects[1]!.setValue('auto')
    await selects[2]!.setValue('image2')
    expect(wrap.emitted('tag')).toEqual([['q', 'quote'], ['r', null], ['img2', 'image2']])
  })

  it('the panel shows the section under the style and forwards its tags', async () => {
    const wrap = mount(LayoutVaryPanel, {
      props: { name: '', candidates: [], index: 0, choices: [], library: [], layoutId: '', applied: false, frameW: 160, frameH: 90, content: rows },
      global: { stubs: { LayoutTile: true } },
    })
    const html = wrap.html()
    expect(html.indexOf('data-testid="layout-style"')).toBeLessThan(html.indexOf('data-testid="layout-content"'))
    await wrap.findAll('[data-testid="layout-content"] select')[0]!.setValue('by')
    expect(wrap.emitted('tag')).toEqual([['q', 'by']])
  })

  it('no text and no hints: no section', () => {
    const wrap = mount(LayoutVaryPanel, {
      props: { name: '', candidates: [], index: 0, choices: [], library: [], layoutId: '', applied: false, frameW: 160, frameH: 90, content: [], hints: [] },
      global: { stubs: { LayoutTile: true } },
    })
    expect(wrap.find('[data-testid="layout-content"]').exists()).toBe(false)
  })
})

describe('Choices — the Button pills (R7)', () => {
  const feed = FRAME_FORMATS.find(f => f.id === 'meta-feed-1x1')!
  const size = { w: feed.w, h: feed.h }
  const onFeed = { sailor_frame: { preset: 'meta-feed-1x1' } }

  /** Every Performance layout offered on this Frame, and its Button row (or undefined). */
  async function buttonRows(layers: LocalLayer[], extra: Record<string, unknown>, s = size, style: 'performance' | 'swiss' = 'performance') {
    const { vary } = realHarness(layers, extra, s)
    vary.setStyle(style)
    await idle()
    const out: { id: string; row: ReturnType<typeof vary.choices.value.find> }[] = []
    for (const id of offeredIds(vary)) {
      vary.select(id); await nextTick()
      out.push({ id, row: vary.choices.value.find(r => r.key === 'cta') })
    }
    return { out, vary }
  }

  it('a platform-button format with an action line: the Button row, "In the image" first and on', async () => {
    const { out, vary } = await buttonRows(adFrameLayers('phrase', { image: true, action: true }), onFeed)
    const withRow = out.filter(o => o.row)
    expect(withRow.length).toBeGreaterThan(0)
    for (const { row } of withRow) {
      expect(row!.label).toBe('Button')
      expect(row!.options.map(o => o.label)).toEqual(['In the image', 'Platform\'s own'])
      expect(row!.options[0]!.on).toBe(true)   // the first candidate is always drawn (R11b)
    }
    // Picking "Platform's own" applies a native candidate, and the pill follows.
    const id = withRow[0]!.id
    vary.select(id); await nextTick()
    vary.setChoice('cta', 'native'); await nextTick()
    const row = vary.choices.value.find(r => r.key === 'cta')!
    expect(row.options.find(o => o.on)!.label).toBe('Platform\'s own')
    expect(vary.candidates.value[vary.index.value]!.choice.cta).toBe('native')
  })

  it('no action line: no Button row', async () => {
    const { out } = await buttonRows(adFrameLayers('phrase', { image: true, action: false }), onFeed)
    expect(out.length).toBeGreaterThan(0)
    expect(out.every(o => !o.row)).toBe(true)
  })

  it('a format without a platform button (plain square): no Button row', async () => {
    const { out } = await buttonRows(adFrameLayers('phrase', { image: true, action: true }), {}, { w: 1080, h: 1080 })
    expect(out.length).toBeGreaterThan(0)
    expect(out.every(o => !o.row)).toBe(true)
  })

  it('Swiss on the same feed Frame: no Button row', async () => {
    const { out } = await buttonRows(adFrameLayers('phrase', { image: true, action: true }), onFeed, size, 'swiss')
    expect(out.length).toBeGreaterThan(0)
    expect(out.every(o => !o.row)).toBe(true)
  })
})

// @vitest-environment happy-dom
//
// The Layout tab's Content section, hints and Button choice (Stage 4, Task 6): tags round-trip
// through `sailor_posterState.tags` as their own undo step (the real layer editor); a tag changes
// what the library offers; the R9 hints render under the section; the Button pills (ruling R7)
// appear only on a platform-button format with an action line.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { reactive, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useLayoutVary, waitForFont, FACE_LOAD_MS } from '~/composables/useLayoutVary'
import type { LayoutVarySource } from '~/composables/useLayoutVary'
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
function realHarness(layers: LocalLayer[], extra: Record<string, unknown> = {}, size = { w: 895, h: 1280 }, more: Partial<LayoutVarySource> = {}) {
  const node = reactive({ data: { widgetDefs: [], widgetsValues: [], properties: { sailor_localLayers: layers, ...extra } as Record<string, any> } })
  const ed = useLocalLayerEditor({ node: () => node as any, dims: () => ({ w: size.w, h: size.h }), getRect: () => null })
  const props = node.data.properties
  const remember = (st: Record<string, unknown>) => { props.sailor_posterState = { ...props.sailor_posterState, ...st } }
  const vary = useLayoutVary({
    props: () => props, frameW: () => size.w, frameH: () => size.h, connectedSlots: () => [],
    editor: () => ed, remember, measure: makeStubMeasure(), ...more,
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
    // The rest of the layout record is kept (Task 6: the Frame's layout is applied again with the
    // new reading, so its seed is the re-apply's own).
    expect(props.sailor_posterState).toMatchObject({ patternId: 'statement', style: 'swiss' })
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

  it('a layer that is not the user\'s (or does not exist) cannot be tagged', async () => {
    const { props, vary } = realHarness(reviewFrame())
    expect(vary.setTag('nope', 'quote')).toBe(false)
    expect(props.sailor_posterState).toBeUndefined()
    // A layout's own piece (after a Performance apply) is not the user's: no tag, no undo step.
    vary.setStyle('performance')
    await idle()
    vary.select('perfOffer'); await nextTick()
    const owned = (props.sailor_localLayers as LocalLayer[]).find(l => (l as { owner?: { by: string } }).owner?.by === 'layout')
    expect(owned).toBeDefined()
    const before = JSON.stringify(props.sailor_posterState)
    expect(vary.setTag(owned!.id, 'quote')).toBe(false)
    expect(JSON.stringify(props.sailor_posterState)).toBe(before)
    expect(vary.content.value.some(r => r.id === owned!.id)).toBe(false)
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

  it('Not used takes a line out of the layouts: it is left where it is, hidden (ruling D3)', async () => {
    const { props, vary } = realHarness(reviewFrame())
    const original = JSON.parse(JSON.stringify((props.sailor_localLayers as LocalLayer[]).find(l => l.id === 'c')))
    await idle()
    const placed = vary.library.value.find(it => it.id === 'statement')!.plan!.layers.find(l => l.id === 'c')
    expect(placed).not.toEqual(original)   // placed by the layout while Automatic
    vary.setTag('c', 'unused')
    await idle()
    const left = vary.library.value.find(it => it.id === 'statement')!.plan!.layers.find(l => l.id === 'c') as LocalLayer & { layoutPrev?: unknown }
    // Not moved, not restyled: only hidden, and that tracked (a later layout that places it shows it).
    const { visible, layoutPrev, ...rest } = left
    expect(rest).toEqual(original)
    expect(visible).toBe(false)
    expect(layoutPrev).toEqual({ visible: { was: null, set: false, by: 'unused' } })   // no visibility of its own; hidden for the tag
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

  it('tagging the action line Not used takes the Button row away (the tags are in the content key); undo brings it back', async () => {
    const { ed, vary } = realHarness(adFrameLayers('phrase', { image: true, action: true }), onFeed, size)
    vary.setStyle('performance')
    await idle()
    vary.select('perfOffer'); await nextTick(); await idle()
    expect(vary.layoutId.value).toBe('perfOffer')
    expect(vary.choices.value.some(r => r.key === 'cta')).toBe(true)
    expect(vary.setTag('a', 'unused')).toBe(true)
    await nextTick(); await idle()
    expect(vary.choices.value.some(r => r.key === 'cta')).toBe(false)
    ed.undo(); await nextTick(); await idle()
    expect(vary.choices.value.some(r => r.key === 'cta')).toBe(true)
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

// Ruling R16: each role is held by one line — tagging a role another line holds moves the tag.
describe('Content section — a role moves to the line tagged last (R16)', () => {
  it('the previous holder goes back to Automatic, in the same single undo step', async () => {
    const layers = [...reviewFrame(), tl('q2', 'Best shoe of the season', 0.03)]
    const { props, ed, vary } = realHarness(layers)
    expect(vary.setTag('q', 'quote')).toBe(true)
    const past = (ed as unknown as { canUndo: { value: boolean } }).canUndo
    expect(vary.setTag('q2', 'quote')).toBe(true)
    expect(props.sailor_posterState.tags).toEqual({ q2: 'quote' })
    expect(vary.content.value.find(r => r.id === 'q')!.tag).toBeNull()
    expect(vary.content.value.find(r => r.id === 'q2')!.tag).toBe('quote')
    // One undo gives the role back to the first line.
    ed.undo(); await nextTick()
    expect(props.sailor_posterState.tags).toEqual({ q: 'quote' })
    expect(past.value).toBe(true)
    ed.undo(); await nextTick()
    expect(props.sailor_posterState.tags).toBeUndefined()
    expect(past.value).toBe(false)
  })

  it('"Not used" is not a role: many lines can be not used', () => {
    const { props, vary } = realHarness(reviewFrame())
    vary.setTag('q', 'unused')
    vary.setTag('c', 'unused')
    expect(props.sailor_posterState.tags).toEqual({ q: 'unused', c: 'unused' })
  })
})

// Review finding I3: a layout's own words (Reasons why's "1") stay the layout's words when the user
// moves them — never read as the user's content.
describe('Content section — a moved piece of the layout\'s own words is not content (I3)', () => {
  it('a moved owned "1" is not the offer, and has no Content row', async () => {
    const layers = [tl('t', 'Run lighter.', 0.1), tl('l', 'Carbon plate\n198 g per shoe\nGrips on wet rock', 0.022), tl('dt', 'Free returns', 0.02), createImageLayer('x.png', 1.25, { id: 'img', w: 0.5, h: 0.625 }) as LocalLayer]
    const { props, ed, vary } = realHarness(layers)
    vary.setStyle('performance')
    await idle()
    vary.select('perfListicle'); await nextTick()
    const one = (props.sailor_localLayers as LocalLayer[]).find(l => l.kind === 'text' && (l as { owner?: { key: string } }).owner && (l as { text?: string }).text === '1')
    expect(one, 'Reasons why numbers the list').toBeDefined()
    ed.setLocal(one!.id, { x: 0.3, y: 0.4 })
    const moved = (props.sailor_localLayers as LocalLayer[]).find(l => l.id === one!.id)!
    expect((moved as { owner?: unknown }).owner).toBeUndefined()           // the user's move de-owns it
    expect((moved as { fromLayout?: string }).fromLayout).toBeTruthy()      // …but it stays marked
    const { contentForFrame } = await import('~/lib/frame/patterns/kit/plan')
    const read = contentForFrame({ props, frameW: 895, frameH: 1280 })
    expect(Object.values(read.roles)).not.toContain(one!.id)
    expect(read.roles.date).toBeUndefined()
    await new Promise(r => setTimeout(r, 400)); await nextTick()
    expect(vary.content.value.some(r => r.id === one!.id)).toBe(false)
    expect(vary.setTag(one!.id, 'date')).toBe(false)
  })

  it('new words typed into it make it the user\'s own line', () => {
    const { props, ed } = realHarness([...reviewFrame(), { ...tl('own-x', '1', 0.05), owner: { by: 'layout', key: 'own-0' } } as LocalLayer])
    ed.setLocal('own-x', { text: 'Only 3 left' })
    const l = (props.sailor_localLayers as LocalLayer[]).find(x => x.id === 'own-x') as { owner?: unknown; fromLayout?: unknown }
    expect(l.owner).toBeUndefined()
    expect(l.fromLayout).toBeUndefined()
  })
})

// ── Frame layout decisions, Task 6: the Frame's layout is applied again ─────────────────────────
const layersOf = (props: Record<string, any>) => JSON.stringify(props.sailor_localLayers)
const layerOf = (props: Record<string, any>, id: string) => (props.sailor_localLayers as LocalLayer[]).find(l => l.id === id) as LocalLayer & { fontFamily?: string; fontSize: number }
const canUndo = (ed: unknown) => (ed as { canUndo: { value: boolean } }).canUndo.value

describe('Task 6 — a tag change applies the Frame\'s layout again, in the same undo step', () => {
  it('the fine print tagged Headline is placed as the headline at once; one undo restores the tag and the layers', async () => {
    const { props, ed, vary } = realHarness(reviewFrame())
    await idle()
    vary.select('statement'); await nextTick()
    const applied = layersOf(props)
    const small = layerOf(props, 'c').fontSize
    expect(vary.setTag('c', 'title')).toBe(true)
    expect(props.sailor_posterState.tags).toEqual({ c: 'title' })
    expect(props.sailor_posterState.patternId).toBe('statement')
    expect(props.sailor_posterState.roles.title).toBe('c')               // the new reading was applied
    expect(layerOf(props, 'c').fontSize).toBeGreaterThan(small)          // …at once, on the Frame
    expect(vary.layoutId.value).toBe('statement')
    expect(vary.applied.value).toBe(true)
    // ONE undo: the tag and the layers together.
    ed.undo(); await nextTick()
    expect(props.sailor_posterState.tags).toBeUndefined()
    expect(props.sailor_posterState.roles.title).toBe('t')
    expect(layersOf(props)).toBe(applied)
    // …and the step before it is the apply itself.
    ed.undo(); await nextTick()
    expect(canUndo(ed)).toBe(false)
    ed.redo(); ed.redo(); await nextTick()
    expect(props.sailor_posterState.tags).toEqual({ c: 'title' })
    expect(props.sailor_posterState.roles.title).toBe('c')
  })

  it('Not used (ruling D3): the fine print is gone from the Frame at once and listed; one undo restores tag and visibility; untagging brings it back', async () => {
    const { props, ed, vary } = realHarness(reviewFrame())
    await idle()
    vary.select('statement'); await nextTick()
    expect(props.sailor_posterState.roles.caption).toBe('c')
    expect(layerOf(props, 'c').visible).not.toBe(false)
    const applied = layersOf(props)
    vary.setTag('c', 'unused')
    expect(props.sailor_posterState.roles.caption).toBeUndefined()
    expect(layerOf(props, 'c').visible).toBe(false)                                   // hidden at once
    expect((layerOf(props, 'c') as { layoutPrev?: { visible?: { set: unknown } } }).layoutPrev?.visible?.set).toBe(false)   // tracked
    await idle()
    expect(vary.candidates.value[vary.index.value]!.plan.notPlaced).toContainEqual({ role: 'unused', text: (layerOf(props, 'c') as { text?: string }).text })
    // One undo: the tag and the visibility together.
    ed.undo(); await nextTick()
    expect(props.sailor_posterState.roles.caption).toBe('c')
    expect(props.sailor_posterState.tags).toBeUndefined()
    expect(layersOf(props)).toBe(applied)
    // Tag it again, then back to Automatic: the layout places it and shows it again.
    ed.redo(); await nextTick()
    expect(layerOf(props, 'c').visible).toBe(false)
    vary.setTag('c', null)
    expect(layerOf(props, 'c').visible).not.toBe(false)
    expect(props.sailor_posterState.roles.caption).toBe('c')
  })

  it('D3: a Frame with no tags plans byte-identically (the same plans as a Frame whose only tag names no layer)', async () => {
    const plain = realHarness(reviewFrame())
    const other = realHarness(reviewFrame(), { sailor_posterState: { tags: { nope: 'unused' } } })
    await idle()
    expect(plain.vary.library.value.length).toBeGreaterThan(10)
    expect(JSON.stringify(other.vary.library.value)).toBe(JSON.stringify(plain.vary.library.value))
  })

  it('D3 only takes an explicit tag: an untagged line with no role is left as it is (shown, not listed)', async () => {
    const { props, vary } = realHarness(reviewFrame())
    await idle()
    vary.select('statement'); await nextTick()
    expect(Object.values(props.sailor_posterState.roles)).not.toContain('q')           // no role
    expect(layerOf(props, 'q').visible).not.toBe(false)
    expect(vary.candidates.value[vary.index.value]!.plan.notPlaced.some(n => n.text.includes('Lightest'))).toBe(false)
    // Tagged Not used, it goes.
    const before = JSON.parse(JSON.stringify(layerOf(props, 'q')))
    vary.setTag('q', 'unused')
    expect(layerOf(props, 'q').visible).toBe(false)
    // Back to Automatic (fix round 2): it holds no role, and it was showing before — it comes back
    // exactly as it was (nothing else about it changed), and is not listed.
    vary.setTag('q', null)
    expect(layerOf(props, 'q').visible).not.toBe(false)
    expect(JSON.parse(JSON.stringify(layerOf(props, 'q')))).toEqual(before)
    await idle()
    expect(vary.candidates.value[vary.index.value]!.plan.notPlaced.some(n => n.text.includes('Lightest'))).toBe(false)
  })

  it('fix round 2: a line the user hid before a layout hid it stays hidden when untagged', async () => {
    const layers = reviewFrame().map(l => (l.id === 'q' ? { ...l, visible: false } as LocalLayer : l))
    const { props, vary } = realHarness(layers)
    await idle()
    vary.select('statement'); await nextTick()
    vary.setTag('q', 'unused')
    vary.setTag('q', null)
    expect(layerOf(props, 'q').visible).toBe(false)
  })

  it('the variation kept is the one on show when it is still offered', async () => {
    const { props, vary } = realHarness(reviewFrame())
    await idle()
    vary.select('statement'); await nextTick()
    expect(vary.candidates.value.length).toBeGreaterThan(2)
    vary.jump(2); await nextTick()
    const choice = { ...props.sailor_posterState.choice }
    vary.setTag('dt', 'unused')
    expect(props.sailor_posterState.roles.date).toBeUndefined()           // applied again…
    expect(props.sailor_posterState.choice).toEqual(choice)                 // …as the same variation
    expect(vary.index.value).toBe(vary.candidates.value.findIndex(c => JSON.stringify({ ...c.choice }) === JSON.stringify({ ...choice })))
  })

  it('a layout no longer offered: the tag is written, the Frame\'s layers are left exactly as they are', async () => {
    const { props, ed, vary } = realHarness(reviewFrame())
    vary.setStyle('performance')
    vary.setTag('q', 'quote'); await idle()
    vary.select('perfReview'); await nextTick()
    expect(props.sailor_posterState.patternId).toBe('perfReview')
    const layers = props.sailor_localLayers
    const json = layersOf(props)
    // Back to Automatic: the line no longer reads as a quote, so Review is not offered.
    expect(vary.setTag('q', null)).toBe(true)
    expect(props.sailor_posterState.tags).toBeUndefined()
    expect(props.sailor_localLayers).toBe(layers)                        // not even re-committed
    expect(layersOf(props)).toBe(json)
    // The tab keeps the layout, with nothing to vary (the panel's Vary is disabled at 0).
    expect(vary.layoutId.value).toBe('perfReview')
    expect(vary.candidates.value).toEqual([])
    await idle()
    expect(offeredIds(vary)).not.toContain('perfReview')
    // One undo gives the tag back.
    ed.undo(); await nextTick()
    expect(props.sailor_posterState.tags).toEqual({ q: 'quote' })
    expect(layersOf(props)).toBe(json)
  })

  it('no layout applied: a tag touches no layer', () => {
    const { props, vary } = realHarness(reviewFrame())
    const layers = props.sailor_localLayers
    vary.setTag('c', 'title')
    expect(props.sailor_localLayers).toBe(layers)
  })
})

describe('Task 6 — the suggested face: the layout is applied again once the face has loaded', () => {
  afterEach(() => { vi.restoreAllMocks() })
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await nextTick() }

  /** An editorial Frame with its layout applied, then the title moved by hand (its own step). */
  async function faceFrame() {
    let resolve!: (ok: boolean) => void
    let reject!: (e: unknown) => void
    const loadFont = vi.fn(() => new Promise<boolean>((res, rej) => { resolve = res; reject = rej }))
    const h = realHarness(reviewFrame(), {}, { w: 895, h: 1280 }, { loadFont })
    h.vary.setStyle('editorial'); await idle()
    const id = offeredIds(h.vary)[0]!
    h.vary.select(id); await nextTick()
    const placed = { x: layerOf(h.props, 't').x, y: layerOf(h.props, 't').y }
    h.ed.setLocal('t', { x: 0.9, y: 0.93 })
    const beforeFace = layersOf(h.props)
    const beforeState = JSON.stringify(h.props.sailor_posterState)
    return { ...h, id, placed, beforeFace, beforeState, loadFont, resolve: (ok: boolean) => resolve(ok), reject: (e: unknown) => reject(e) }
  }

  it('re-applies after the font loads, folded into the face\'s step: one undo in total', async () => {
    const f = await faceFrame()
    expect(f.vary.applySuggestedFace()).toBe(true)
    await flush()
    expect(f.loadFont).toHaveBeenCalledWith('400 16px "Instrument Serif"', FACE_LOAD_MS)
    // Not yet: the title keeps the hand-set place until the face has loaded.
    expect(layerOf(f.props, 't')).toMatchObject({ x: 0.9, y: 0.93, fontFamily: 'Instrument Serif' })
    f.resolve(true); await flush()
    const t = layerOf(f.props, 't')
    expect(t.fontFamily).toBe('Instrument Serif')
    expect({ x: t.x, y: t.y }).not.toEqual({ x: 0.9, y: 0.93 })           // placed by the layout again
    expect(f.props.sailor_posterState.patternId).toBe(f.id)
    // ONE undo: the face and the re-apply together, back to the hand-moved title in its old face.
    f.ed.undo(); await nextTick()
    expect(layersOf(f.props)).toBe(f.beforeFace)
    // The step before is the hand move.
    f.ed.undo(); await nextTick()
    expect({ x: layerOf(f.props, 't').x, y: layerOf(f.props, 't').y }).toEqual(f.placed)
    // Redo twice: the face with its re-apply comes back as one step.
    f.ed.redo(); f.ed.redo(); await nextTick()
    expect(layerOf(f.props, 't').fontFamily).toBe('Instrument Serif')
    expect({ x: layerOf(f.props, 't').x, y: layerOf(f.props, 't').y }).not.toEqual({ x: 0.9, y: 0.93 })
  })

  it('skipped when the user edited the Frame while the face loaded', async () => {
    const f = await faceFrame()
    f.vary.applySuggestedFace(); await flush()
    f.ed.setLocal('d', { x: 0.2 })                                         // an edit meanwhile
    const now = layersOf(f.props)
    f.resolve(true); await flush()
    expect(layersOf(f.props)).toBe(now)
    expect(layerOf(f.props, 't')).toMatchObject({ x: 0.9, y: 0.93 })
  })

  it('skipped after a step that changed nothing (a click records one) or an undo meanwhile', async () => {
    const f = await faceFrame()
    f.vary.applySuggestedFace(); await flush()
    f.ed.recordHistory()
    const now = layersOf(f.props)
    f.resolve(true); await flush()
    expect(layersOf(f.props)).toBe(now)

    const g = await faceFrame()
    g.vary.applySuggestedFace(); await flush()
    g.ed.undo(); await nextTick()                                         // the face undone
    g.resolve(true); await flush()
    expect(layersOf(g.props)).toBe(g.beforeFace)
    expect(JSON.stringify(g.props.sailor_posterState)).toBe(g.beforeState)
  })

  it('closing the tab while the face loads: no write when it arrives', async () => {
    const { effectScope } = await import('vue')
    let resolve!: (ok: boolean) => void
    const loadFont = vi.fn(() => new Promise<boolean>((res) => { resolve = res }))
    const scope = effectScope()
    const h = scope.run(() => realHarness(reviewFrame(), {}, { w: 895, h: 1280 }, { loadFont }))!
    h.vary.setStyle('editorial'); await idle()
    h.vary.select(offeredIds(h.vary)[0]!); await nextTick()
    h.ed.setLocal('t', { x: 0.9, y: 0.93 })
    h.vary.applySuggestedFace(); await flush()
    const layers = h.props.sailor_localLayers, state = h.props.sailor_posterState, order = h.props.sailor_stackOrder
    scope.stop()                                                            // the tab is closed
    resolve(true); await flush()
    expect(h.props.sailor_localLayers).toBe(layers)
    expect(h.props.sailor_posterState).toBe(state)
    expect(h.props.sailor_stackOrder).toBe(order)
  })

  it('the host says it is at a viewing size when the face arrives: no re-apply', async () => {
    const f = await faceFrame()
    let atDesign = true
    f.vary.applySuggestedFace({ canReapply: () => atDesign }); await flush()
    atDesign = false
    const now = layersOf(f.props)
    f.resolve(true); await flush()
    expect(layersOf(f.props)).toBe(now)
  })

  it('a face that does not load in time (or a loader that fails) leaves the face step as it is', async () => {
    const f = await faceFrame()
    f.vary.applySuggestedFace(); await flush()
    const now = layersOf(f.props)
    f.resolve(false); await flush()
    expect(layersOf(f.props)).toBe(now)
    f.ed.undo(); await nextTick()
    expect(layersOf(f.props)).toBe(f.beforeFace)                           // still exactly one step

    const g = await faceFrame()
    g.vary.applySuggestedFace(); await flush()
    const gNow = layersOf(g.props)
    g.reject(new Error('network')); await flush()
    expect(layersOf(g.props)).toBe(gNow)
  })
})

describe('Task 6 — waitForFont (the default loader)', () => {
  const doc = document as Document & { fonts?: unknown }
  const had = Object.getOwnPropertyDescriptor(doc, 'fonts')
  afterEach(() => {
    if (had) Object.defineProperty(doc, 'fonts', had)
    else delete (doc as { fonts?: unknown }).fonts
  })
  const stubFonts = (load: (spec: string) => Promise<unknown[]>) =>
    Object.defineProperty(doc, 'fonts', { configurable: true, value: { load: vi.fn(load), check: () => true } })

  it('no font set: nothing to wait for', async () => {
    Object.defineProperty(doc, 'fonts', { configurable: true, value: undefined })
    expect(await waitForFont('400 16px "Anton"', 50)).toBe(true)
  })

  it('asks again until the family\'s stylesheet has arrived (load finds no face before it does)', async () => {
    let n = 0
    stubFonts(async () => (++n < 3 ? [] : [{}]))
    expect(await waitForFont('400 16px "Anton"', 2000)).toBe(true)
    expect(n).toBe(3)
  })

  it('gives up after the wait: false', async () => {
    stubFonts(async () => [])
    const t0 = Date.now()
    expect(await waitForFont('400 16px "Anton"', 250)).toBe(false)
    expect(Date.now() - t0).toBeLessThan(1000)
  })

  it('a load that never settles or throws still gives up after the wait', async () => {
    stubFonts(() => new Promise(() => {}))
    expect(await waitForFont('400 16px "Anton"', 150)).toBe(false)
    stubFonts(async () => { throw new Error('bad') })
    expect(await waitForFont('400 16px "Anton"', 150)).toBe(false)
  })
})

// Final fix wave (M): a wired image is a user image everywhere — it has a Content row, Not used
// (ruling D7) is reachable from it, and an image's number is the same in its row and under
// "Not shown" (counted in document order among the user's images, wired ones included).
describe('Content section — wired images (final fix wave)', () => {
  const wired = (id: string, name?: string): LocalLayer => ({ id, kind: 'wired', slot: 0, w: 0.4, lastAspect: 1.25, x: 0.7, y: 0.7, rotation: 0, opacity: 1, ...(name ? { name } : {}) } as unknown as LocalLayer)
  const img = (id: string) => createImageLayer('b.png', 1, { id, w: 0.3, h: 0.3 }) as LocalLayer

  it('a wired image beyond the first gets a Content row (its own name when it has one)', () => {
    const { vary } = realHarness([...reviewFrame(), wired('w1'), wired('w2', 'Product shot')])
    expect(vary.content.value.filter(r => r.kind === 'image')).toEqual([
      { id: 'w1', kind: 'image', text: '', n: 2, tag: null },
      { id: 'w2', kind: 'image', text: '', n: 3, name: 'Product shot', tag: null },
    ])
  })

  it('tagging it Not used through setTag hides it and names it under Not shown', async () => {
    const { props, vary } = realHarness([...reviewFrame(), wired('w1')])
    await idle()
    vary.select('statement'); await nextTick(); await idle()
    expect(vary.applied.value).toBe(true)
    expect(vary.setTag('w1', 'unused')).toBe(true)
    await nextTick(); await idle()
    const w = (props.sailor_localLayers as LocalLayer[]).find(l => l.id === 'w1') as { visible?: boolean }
    expect(w.visible).toBe(false)
    expect(vary.candidates.value[vary.index.value]!.plan.notPlaced).toContainEqual({ role: 'unused', text: 'Image 2', image: true })
  })

  it('[image, wired, image]: the third is "Image 3" in its row and under Not shown', async () => {
    const { props, vary } = realHarness([...reviewFrame(), wired('w1'), img('img3')])
    expect(vary.content.value.filter(r => r.kind === 'image').map(r => [r.id, r.n])).toEqual([['w1', 2], ['img3', 3]])
    await idle()
    vary.select('statement'); await nextTick(); await idle()
    expect(vary.setTag('img3', 'unused')).toBe(true)
    await nextTick(); await idle()
    expect(((props.sailor_localLayers as LocalLayer[]).find(l => l.id === 'img3') as { visible?: boolean }).visible).toBe(false)
    expect(vary.candidates.value[vary.index.value]!.plan.notPlaced).toContainEqual({ role: 'unused', text: 'Image 3', image: true })
  })
})

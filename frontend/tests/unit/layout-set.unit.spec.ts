// @vitest-environment happy-dom
//
// Stage 5 (Make a set), Task 2: the Layout tab's "Make a set" section, the remembered format
// selection (no history step), the set's re-planning, and the set sheet — one tile per ticked
// format with the right chip (kept / swapped / nothing fits), and the covered-areas switch.
import { describe, it, expect, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import LayoutSetSection from '~/components/vue-canvas/compositor/LayoutSetSection.vue'
import LayoutSetSheet from '~/components/vue-canvas/compositor/LayoutSetSheet.vue'
import { useLayoutVary } from '~/composables/useLayoutVary'
import { useLayoutSet } from '~/composables/useLayoutSet'
import { FRAME_FORMATS, frameFormatGroup } from '~/lib/frame/formats'
import { planLayout } from '~/lib/frame/patterns/kit/plan'
import { makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { DEFAULT_CHOICE } from '~/lib/frame/patterns/kit/vary'
import type { Choice } from '~/lib/frame/patterns/kit/vary'
import type { SetEntry } from '~/lib/frame/patterns/kit/set'
import type { StyleId } from '~/lib/frame/patterns/kit/styles'
import type { Kind } from '~/lib/frame/patterns/kit/types'
import { frameLayers, palette } from './helpers/frameLayoutFixtures'

const SOURCE = FRAME_FORMATS.find(f => f.id === 'meta-feed-4x5')!

/** A portrait (4:5) Frame with `layoutId` applied at `choice`, as the Layout tab leaves it, and
 *  the tab's state over it (a fake editor that records every call). */
function appliedFrame(kind: Kind, layoutId: string, choice: Choice, style: StyleId = 'swiss', extra: Record<string, unknown> = {}) {
  const base = { sailor_localLayers: frameLayers(kind, { image: false, shape: false }), sailor_frame: { preset: SOURCE.id } } as Record<string, unknown>
  const plan = planLayout({ props: base, frameW: SOURCE.w, frameH: SOURCE.h, palette, connectedSlots: [], measure: makeStubMeasure(), style, layoutId, choice })!
  expect(plan.issues).toEqual([])
  const props: Record<string, unknown> = reactive({
    ...base, sailor_localLayers: plan.layers, sailor_stackOrder: plan.order,
    sailor_posterState: { ...plan.posterState, style, ...extra },
  })
  const editor = { recordHistory: vi.fn(), commit: vi.fn(), writeOrder: vi.fn(), writeGroups: vi.fn() }
  const remember = vi.fn()
  const vary = useLayoutVary({
    props: () => props, frameW: () => SOURCE.w, frameH: () => SOURCE.h, connectedSlots: () => [],
    editor: () => editor, remember, measure: makeStubMeasure(), active: () => false,
  })
  return { props, editor, remember, vary }
}
const RUNOFF = { ...DEFAULT_CHOICE, lines: 1, arr: 2 } as Choice

// ── the section ──

describe('LayoutSetSection — Make a set', () => {
  it('is collapsed until opened', async () => {
    const wrap = mount(LayoutSetSection, { props: { formats: [] } })
    expect(wrap.get('[data-testid="layout-set-toggle"]').text()).toBe('Make a set')
    expect(wrap.findAll('[data-testid="layout-set-format"]')).toHaveLength(0)
    expect(wrap.find('[data-testid="layout-set-open"]').exists()).toBe(false)
    await wrap.get('[data-testid="layout-set-toggle"]').trigger('click')
    expect(wrap.findAll('[data-testid="layout-set-format"]').length).toBeGreaterThan(0)
  })

  it('lists every format, each in its Size-menu group (Social, then Display ads)', async () => {
    const wrap = mount(LayoutSetSection, { props: { formats: [] } })
    await wrap.get('[data-testid="layout-set-toggle"]').trigger('click')
    const groups = wrap.findAll('[data-testid="layout-set-group"]')
    expect(groups.map(g => g.attributes('data-group'))).toEqual(['Social', 'Display ads'])
    const listed: string[] = []
    for (const g of groups) {
      expect(g.get('span').text()).toBe(g.attributes('data-group'))
      for (const row of g.findAll('[data-testid="layout-set-format"]')) {
        const id = row.attributes('data-format')!
        const fmt = FRAME_FORMATS.find(f => f.id === id)!
        expect(frameFormatGroup(id)).toBe(g.attributes('data-group'))
        expect(row.text()).toBe(fmt.label)
        listed.push(id)
      }
    }
    expect([...listed].sort()).toEqual(FRAME_FORMATS.map(f => f.id).sort())
  })

  it('Open the set is disabled with no format ticked; ticking emits the selection in table order', async () => {
    const wrap = mount(LayoutSetSection, { props: { formats: ['meta-story'] } })
    await wrap.get('[data-testid="layout-set-toggle"]').trigger('click')
    const box = (id: string) => wrap.get(`[data-format="${id}"] input`)
    expect((box('meta-story').element as HTMLInputElement).checked).toBe(true)
    await box('meta-feed-1x1').setValue(true)
    expect(wrap.emitted('update:formats')!.at(-1)).toEqual([['meta-feed-1x1', 'meta-story']])
    await box('meta-story').setValue(false)
    expect(wrap.emitted('update:formats')!.at(-1)).toEqual([[]])
    expect(wrap.get('[data-testid="layout-set-open"]').attributes('disabled')).toBeUndefined()
    await wrap.get('[data-testid="layout-set-open"]').trigger('click')
    expect(wrap.emitted('open')).toHaveLength(1)
    await wrap.setProps({ formats: [] })
    expect(wrap.get('[data-testid="layout-set-open"]').attributes('disabled')).toBeDefined()
  })
})

// ── the remembered selection, and the set's planning ──

describe('useLayoutVary — the set', () => {
  it('ticking persists on the Frame (sailor_posterState.set) without a history step', () => {
    const { props, editor, remember, vary } = appliedFrame('sentence', 'runoff', RUNOFF)
    const before = { ...(props.sailor_posterState as object) }
    vary.setSetFormats(['meta-story', 'nope', 'meta-feed-1x1'])
    expect((props.sailor_posterState as { set?: unknown }).set).toEqual({ formats: ['meta-feed-1x1', 'meta-story'] })
    expect(props.sailor_posterState).toMatchObject(before)             // the layout record is kept
    expect(vary.setFormats.value).toEqual(['meta-feed-1x1', 'meta-story'])
    for (const f of [editor.recordHistory, editor.commit, editor.writeOrder, editor.writeGroups, remember]) expect(f).not.toHaveBeenCalled()
  })

  it('reads a remembered selection back in table order, unknown ids left out', () => {
    const { vary } = appliedFrame('sentence', 'runoff', RUNOFF, 'swiss', { set: { formats: ['ad-320x50', 'gone', 'meta-feed-4x5'] } })
    expect(vary.setFormats.value).toEqual(['meta-feed-4x5', 'ad-320x50'])
  })

  it('plans the Frame\'s applied layout at each format, and never writes the Frame', () => {
    const { props, vary, editor } = appliedFrame('sentence', 'runoff', RUNOFF)
    const snap = JSON.stringify(props)
    const out = vary.planSet(['meta-feed-1x1', 'meta-story'])
    expect(out.map(e => [e.formatId, e.layoutId === 'runoff', e.swapped])).toEqual([['meta-feed-1x1', true, false], ['meta-story', false, true]])
    expect(JSON.stringify(props)).toBe(snap)
    expect(editor.commit).not.toHaveBeenCalled()
  })

  it('plans nothing without an applied layout', () => {
    const { props, vary } = appliedFrame('sentence', 'runoff', RUNOFF)
    props.sailor_posterState = {}
    expect(vary.planSet(['meta-feed-1x1'])).toEqual([])
  })
})

describe('useLayoutSet — when the set is planned', () => {
  it('plans on open and when the selection changes while open; never while closed', async () => {
    const sel = reactive({ ids: ['meta-feed-1x1'] as string[] })
    const plan = vi.fn((f: readonly string[]) => f.map(id => ({ formatId: id }) as SetEntry))
    const set = useLayoutSet({ formats: () => sel.ids, plan })
    sel.ids = ['meta-story']; await nextTick()
    expect(plan).not.toHaveBeenCalled()
    set.openSet()
    expect(set.open.value).toBe(true)
    expect(set.entries.value.map(e => e.formatId)).toEqual(['meta-story'])
    sel.ids = ['meta-story', 'ad-300x250']; await nextTick()
    expect(plan).toHaveBeenCalledTimes(2)
    expect(set.entries.value.map(e => e.formatId)).toEqual(['meta-story', 'ad-300x250'])
    set.close()
    expect(set.entries.value).toEqual([])
    sel.ids = []; await nextTick()
    expect(plan).toHaveBeenCalledTimes(2)
  })
})

// ── the sheet ──

const stubs = { LayoutTile: true }
/** One entry: `kept`, `swapped` (to "Frame") or `none`. */
function entry(formatId: string, kind: 'kept' | 'swapped' | 'none'): SetEntry {
  const f = FRAME_FORMATS.find(x => x.id === formatId)!
  const fits = kind !== 'none'
  const layoutId = kind === 'kept' ? 'runoff' : kind === 'swapped' ? 'frame' : null
  return {
    formatId, label: f.label, w: f.w, h: f.h,
    layoutId, layoutName: kind === 'kept' ? 'Run-off' : kind === 'swapped' ? 'Frame' : null,
    swapped: kind === 'swapped', choice: fits ? { ...DEFAULT_CHOICE } : null,
    plan: fits ? { layers: [], order: [], issues: [], posterState: { patternId: layoutId, seed: 1 } } as never : null,
    layers: fits ? [] : null, groups: fits ? [] : null,
  }
}

describe('LayoutSetSheet', () => {
  const entries = [entry('meta-feed-1x1', 'kept'), entry('meta-story', 'swapped'), entry('ad-320x50', 'none')]

  it('names the set and sums it up', () => {
    const wrap = mount(LayoutSetSheet, { props: { entries, layoutName: 'Run-off' }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-set-title"]').text()).toBe('Run-off, in 3 formats')
    expect(wrap.get('[data-testid="layout-set-summary"]').text()).toBe('1 as Run-off · 1 with another layout · 1 where nothing fits')
  })

  it('one tile per format, labelled, with the chip for kept / swapped / nothing fits', () => {
    const wrap = mount(LayoutSetSheet, { props: { entries, layoutName: 'Run-off' }, global: { stubs } })
    const tiles = wrap.findAll('[data-testid="layout-set-tile"]')
    expect(tiles.map(t => t.attributes('data-format'))).toEqual(['meta-feed-1x1', 'meta-story', 'ad-320x50'])
    const chips = tiles.map(t => t.get('[data-testid="layout-set-chip"]'))
    expect(chips.map(c => c.text())).toEqual(['Run-off', 'Frame — Run-off doesn\'t fit', 'Nothing fits this format'])
    expect(chips[1]!.classes().some(c => c.includes('amber'))).toBe(true)
    expect(chips[0]!.classes().some(c => c.includes('amber'))).toBe(false)
    // The painted tiles are the Frame's own renderer, at the format's own size, not pickable.
    const painted = wrap.findAllComponents({ name: 'LayoutTile' })
    expect(painted).toHaveLength(2)
    expect(painted.map(p => [p.props('frameW'), p.props('frameH'), p.props('label'), p.props('pickable')]))
      .toEqual([[1200, 1200, 'Meta feed · 1:1', false], [1080, 1920, 'Meta story / reel · 9:16', false]])
    expect(tiles[2]!.text()).toContain('Display ad · 320×50')
  })

  it('tiles keep the format\'s true proportions', () => {
    const wrap = mount(LayoutSetSheet, { props: { entries: [entry('meta-story', 'kept'), entry('ad-728x90', 'none')], layoutName: 'Run-off' }, global: { stubs } })
    const story = wrap.findAllComponents({ name: 'LayoutTile' })[0]!
    expect(story.props('maxPx')).toBe(180)
    const banner = wrap.get('[data-format="ad-728x90"] .rounded-md')
    const w = parseFloat((banner.element as HTMLElement).style.width), h = parseFloat((banner.element as HTMLElement).style.height)
    expect(Math.max(w, h)).toBe(360)                                  // a wide banner gets a wider cap
    expect(h).toBe(Math.round(360 * 90 / 728))                        // at its own aspect
  })

  it('Send to canvas emits the format; nothing-fits tiles have none', async () => {
    const wrap = mount(LayoutSetSheet, { props: { entries, layoutName: 'Run-off' }, global: { stubs } })
    expect(wrap.findAll('[data-testid="layout-set-send"]').map(b => b.text())).toEqual(['Send to canvas', 'Send to canvas'])
    await wrap.get('[data-format="meta-story"] [data-testid="layout-set-send"]').trigger('click')
    expect(wrap.emitted('send')).toEqual([['meta-story']])
  })

  it('the footer downloads the formats something fits, and says stills only when the Frame moves', async () => {
    const wrap = mount(LayoutSetSheet, { props: { entries, layoutName: 'Run-off' }, global: { stubs } })
    const dl = wrap.get('[data-testid="layout-set-download"]')
    expect(dl.text()).toBe('Download 2 images')
    expect(wrap.find('[data-testid="layout-set-stills"]').exists()).toBe(false)
    await dl.trigger('click')
    expect(wrap.emitted('download')).toHaveLength(1)
    await wrap.setProps({ hasMotion: true })
    expect(wrap.get('[data-testid="layout-set-stills"]').text()).toBe('Stills only for now.')
    await wrap.setProps({ entries: [entry('ad-320x50', 'none')] })
    expect(wrap.get('[data-testid="layout-set-download"]').attributes('disabled')).toBeDefined()
  })

  it('Show covered areas adds bands only on formats that have them', async () => {
    const wrap = mount(LayoutSetSheet, { props: { entries: [entry('meta-feed-1x1', 'kept'), entry('meta-story', 'kept'), entry('pmax-square', 'swapped')], layoutName: 'Run-off' }, global: { stubs } })
    const bands = () => wrap.findAll('[data-testid="layout-set-tile"]').filter(t => t.find('[data-testid="keep-clear-overlay"]').exists()).map(t => t.attributes('data-format'))
    expect(bands()).toEqual([])
    const sw = wrap.get('[data-testid="layout-set-covered"] [role="switch"]')
    expect(wrap.get('[data-testid="layout-set-covered"]').text()).toBe('Show covered areas')
    await sw.trigger('click')
    expect(bands()).toEqual(['meta-story', 'pmax-square'])
    // The story's bands are its own: top 14%, bottom 35% of the tile.
    const story = wrap.get('[data-format="meta-story"]')
    const top = story.get('[data-keep="top"]'), svg = story.get('[data-testid="keep-clear-overlay"]')
    expect(Number(top.attributes('height')) / Number(svg.attributes('height'))).toBeCloseTo(0.14, 2)
    expect(story.get('[data-keep="bottom"]').exists()).toBe(true)
  })

  it('no switch when no ticked format has covered areas', () => {
    const wrap = mount(LayoutSetSheet, { props: { entries: [entry('meta-feed-1x1', 'kept')], layoutName: 'Run-off' }, global: { stubs } })
    expect(wrap.find('[data-testid="layout-set-covered"]').exists()).toBe(false)
  })

  it('shows the real set: kept, swapped and nothing-fits chips from the planner', () => {
    const { vary } = appliedFrame('sentence', 'runoff', RUNOFF)
    const planned = vary.planSet(['meta-feed-1x1', 'meta-story', 'ad-320x50'])
    const wrap = mount(LayoutSetSheet, { props: { entries: planned, layoutName: 'Run-off' }, global: { stubs } })
    const chips = wrap.findAll('[data-testid="layout-set-tile"]').map(t => [t.attributes('data-kind'), t.get('[data-testid="layout-set-chip"]').text()])
    expect(chips[0]).toEqual(['kept', 'Run-off'])
    expect(chips[1]).toEqual(['swapped', `${planned[1]!.layoutName} — Run-off doesn't fit`])
    expect(planned[1]!.layoutName).toBeTruthy()
    const quiet = appliedFrame('sentence', 'edQuiet', DEFAULT_CHOICE, 'editorial')
    const none = quiet.vary.planSet(['ad-320x50'])
    const w2 = mount(LayoutSetSheet, { props: { entries: none, layoutName: 'Quiet' }, global: { stubs } })
    expect(w2.get('[data-testid="layout-set-chip"]').text()).toBe('Nothing fits this format')
    expect(w2.get('[data-testid="layout-set-summary"]').text()).toBe('1 where nothing fits')
  })
})

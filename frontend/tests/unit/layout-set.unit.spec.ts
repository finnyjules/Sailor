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
import { makeMeasurePool, makeStubMeasure } from '~/lib/frame/patterns/kit/measure'
import { planSet as planSetKit } from '~/lib/frame/patterns/kit/set'
import { createTextLayer } from '~/composables/useCompositorLayers'
import type { TextLayer } from '~/composables/useCompositorLayers'
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
  it('ticking persists on the Frame (sailor_layoutSet) without a history step, and leaves the layout record alone', () => {
    const { props, editor, remember, vary } = appliedFrame('sentence', 'runoff', RUNOFF)
    const record = props.sailor_posterState
    const before = JSON.stringify(record)
    vary.setSetFormats(['meta-story', 'nope', 'meta-feed-1x1'])
    expect(props.sailor_layoutSet).toEqual({ formats: ['meta-feed-1x1', 'meta-story'] })
    // The layout record is not replaced: a suggested face's pending re-apply compares its identity.
    expect(props.sailor_posterState).toBe(record)
    expect(JSON.stringify(props.sailor_posterState)).toBe(before)
    expect(vary.setFormats.value).toEqual(['meta-feed-1x1', 'meta-story'])
    for (const f of [editor.recordHistory, editor.commit, editor.writeOrder, editor.writeGroups, remember]) expect(f).not.toHaveBeenCalled()
  })

  it('reads a remembered selection back in table order, unknown ids left out', () => {
    const { props, vary } = appliedFrame('sentence', 'runoff', RUNOFF)
    props.sailor_layoutSet = { formats: ['ad-320x50', 'gone', 'meta-feed-4x5'] }
    expect(vary.setFormats.value).toEqual(['meta-feed-4x5', 'ad-320x50'])
  })

  it('a Frame saved with its ticks in sailor_posterState.set reads them, and the next tick moves them out', () => {
    const { props, vary } = appliedFrame('sentence', 'runoff', RUNOFF, 'swiss', { set: { formats: ['ad-320x50', 'gone', 'meta-feed-4x5'] } })
    expect(vary.setFormats.value).toEqual(['meta-feed-4x5', 'ad-320x50'])
    const st = props.sailor_posterState as Record<string, unknown>
    vary.setSetFormats(['meta-story'])
    expect(props.sailor_layoutSet).toEqual({ formats: ['meta-story'] })
    expect('set' in (props.sailor_posterState as object)).toBe(false)
    const { set: _set, ...rest } = st
    expect(props.sailor_posterState).toEqual(rest)                      // everything else is kept
    expect(vary.setFormats.value).toEqual(['meta-story'])
  })

  it('a tick does not cancel a suggested face\'s late re-apply', async () => {
    // An Editorial Frame whose title is not in the suggested face: applying the face waits for it
    // to load, then applies the layout again — only while the Frame (its layout record included)
    // has not changed. Ticking a format meanwhile must not count as a change.
    const base = { sailor_localLayers: frameLayers('sentence', { image: false, shape: false }), sailor_frame: { preset: SOURCE.id } } as Record<string, unknown>
    const plan = planLayout({ props: base, frameW: SOURCE.w, frameH: SOURCE.h, palette, connectedSlots: [], measure: makeStubMeasure(), style: 'editorial', layoutId: 'edQuiet', choice: DEFAULT_CHOICE })!
    const props: Record<string, unknown> = reactive({ ...base, sailor_localLayers: plan.layers, sailor_stackOrder: plan.order, sailor_posterState: { ...plan.posterState, style: 'editorial' } })
    const editor = {
      recordHistory: vi.fn(), historyRev: () => 1,
      commit: vi.fn((n: unknown) => { props.sailor_localLayers = n }), writeOrder: vi.fn((o: unknown) => { props.sailor_stackOrder = o }), writeGroups: vi.fn(),
    }
    let loaded!: (ok: boolean) => void
    const vary = useLayoutVary({
      props: () => props, frameW: () => SOURCE.w, frameH: () => SOURCE.h, connectedSlots: () => [],
      editor: () => editor as never, remember: vi.fn(), measure: makeStubMeasure(), active: () => true,
      loadFont: () => new Promise<boolean>((r) => { loaded = r }),
    })
    vary.setStyle('editorial')
    await nextTick()
    expect(vary.suggestedFace.value).not.toBeNull()
    expect(vary.applySuggestedFace()).toBe(true)
    const commits = editor.commit.mock.calls.length
    vary.setSetFormats(['meta-story'])                                  // ticked while the face loads
    await Promise.resolve(); await Promise.resolve()
    loaded(true)
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(editor.commit.mock.calls.length).toBeGreaterThan(commits)   // the re-apply still ran
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

describe('a set measures through one pool', () => {
  it('the pool gives one measure per set of faces, and a new one for other faces', () => {
    const make = vi.fn(() => makeStubMeasure())
    const pool = makeMeasurePool(make)
    const t = (o: Partial<TextLayer>) => createTextLayer({ fontFamily: 'Inter', fontWeight: 600, ...o }) as TextLayer
    const a = pool({ title: t({ id: 'x', text: 'One', x: 0.1 }), caption: t({ id: 'c', fontWeight: 400 }) })
    // Same faces (other text, place, size): the same measure.
    expect(pool({ title: t({ id: 'x', text: 'Two', x: 0.7, fontSize: 0.3 }), caption: t({ id: 'c', fontWeight: 400 }) })).toBe(a)
    expect(pool({ title: t({ id: 'x', fontWeight: 700 }), caption: t({ id: 'c', fontWeight: 400 }) })).not.toBe(a)
    expect(pool({ title: t({ id: 'x', textTransform: 'uppercase' }), caption: t({ id: 'c', fontWeight: 400 }) })).not.toBe(a)
    expect(pool({ title: t({ id: 'x' }) })).not.toBe(a)                  // another role set
    expect(make).toHaveBeenCalledTimes(4)
  })

  it('planSet with a pool plans exactly as with its measure, building one measure for every format', () => {
    const base = { sailor_localLayers: frameLayers('sentence', { image: false, shape: false }), sailor_frame: { preset: SOURCE.id } } as Record<string, unknown>
    const plan = planLayout({ props: base, frameW: SOURCE.w, frameH: SOURCE.h, palette, connectedSlots: [], measure: makeStubMeasure(), style: 'swiss', layoutId: 'runoff', choice: RUNOFF })!
    const props = { ...base, sailor_localLayers: plan.layers, sailor_stackOrder: plan.order, sailor_posterState: { ...plan.posterState, style: 'swiss' } }
    const formats = ['meta-feed-1x1', 'meta-story', 'ad-300x250', 'ad-728x90']
    const args = { props, frameW: SOURCE.w, frameH: SOURCE.h, palette, connectedSlots: [], style: 'swiss' as const, layoutId: 'runoff', choice: RUNOFF, formats }
    const make = vi.fn(() => makeStubMeasure())
    const pooled = planSetKit({ ...args, measures: makeMeasurePool(make) })
    const direct = planSetKit({ ...args, measure: makeStubMeasure() })
    expect(JSON.stringify(pooled)).toBe(JSON.stringify(direct))
    expect(make).toHaveBeenCalled()
    expect(make.mock.calls.length).toBeLessThanOrEqual(2)                // one per reading of the Frame, not per plan
  })
})

describe('useLayoutSet — when the set is planned', () => {
  /** A set over a fake Frame: `plan` records each call; idle slices run when `runIdle` is called. */
  function fakeSet(ids: string[]) {
    const sel = reactive({ ids })
    const frame = reactive({ layers: [{ id: 'a' }] as unknown[], choice: 'x' })
    let n = 0
    const plan = vi.fn((f: readonly string[], _o?: { measures?: unknown }) => f.map(id => ({ formatId: id, plan: { rev: n }, layers: [] }) as unknown as SetEntry))
    const queue: (() => void)[] = []
    const pools: unknown[] = []
    const set = useLayoutSet({
      formats: () => sel.ids, plan, inputs: () => [frame.layers, frame.choice],
      idle: (fn) => { queue.push(fn); return () => { const i = queue.indexOf(fn); if (i >= 0) queue.splice(i, 1) } },
      pool: () => { const p = () => ({}) as never; pools.push(p); return p },
    })
    const runIdle = () => { const fn = queue.shift(); fn?.() }
    const edit = () => { n++; frame.layers = [...frame.layers] }
    return { sel, frame, plan, set, queue, runIdle, edit, pools }
  }
  const ids = (set: ReturnType<typeof useLayoutSet>) => set.entries.value.map(e => [e.formatId, (e as { pending?: boolean }).pending ? 'pending' : (e.plan as unknown as { rev: number }).rev])

  it('never plans while closed; on open, one format per idle slice, a placeholder until then', async () => {
    const { sel, plan, set, runIdle, queue } = fakeSet(['meta-feed-1x1'])
    sel.ids = ['meta-story', 'ad-300x250']; await nextTick()
    expect(plan).not.toHaveBeenCalled()
    set.openSet()
    expect(set.open.value).toBe(true)
    expect(plan).not.toHaveBeenCalled()                                 // nothing blocks the open
    expect(ids(set)).toEqual([['meta-story', 'pending'], ['ad-300x250', 'pending']])
    expect(set.entries.value[0]).toMatchObject({ label: FRAME_FORMATS.find(f => f.id === 'meta-story')!.label, w: 1080, h: 1920 })
    runIdle()
    expect(plan).toHaveBeenCalledTimes(1)
    expect(plan.mock.calls[0]![0]).toEqual(['meta-story'])               // one format per slice
    expect(ids(set)).toEqual([['meta-story', 0], ['ad-300x250', 'pending']])
    runIdle()
    expect(ids(set)).toEqual([['meta-story', 0], ['ad-300x250', 0]])
    expect(queue).toHaveLength(0)
    set.close()
    expect(set.entries.value).toEqual([])
    sel.ids = []; await nextTick()
    expect(plan).toHaveBeenCalledTimes(2)
  })

  it('a tick plans only the format it adds; the others are kept from the cache', async () => {
    const { sel, plan, set, runIdle } = fakeSet(['meta-story'])
    set.openSet(); runIdle()
    sel.ids = ['meta-feed-1x1', 'meta-story']; await nextTick()
    expect(ids(set)).toEqual([['meta-feed-1x1', 'pending'], ['meta-story', 0]])
    runIdle()
    expect(plan.mock.calls.map(c => c[0])).toEqual([['meta-story'], ['meta-feed-1x1']])
    sel.ids = ['meta-story']; await nextTick()
    sel.ids = ['meta-feed-1x1', 'meta-story']; await nextTick()
    expect(ids(set)).toEqual([['meta-feed-1x1', 0], ['meta-story', 0]])
    expect(plan).toHaveBeenCalledTimes(2)
  })

  it('every plan of one set of inputs shares one measure pool; a change makes a new one', async () => {
    const { plan, set, runIdle, edit, pools } = fakeSet(['meta-story', 'ad-300x250'])
    set.openSet(); runIdle(); runIdle()
    expect(plan.mock.calls[0]![1]!.measures).toBe(plan.mock.calls[1]![1]!.measures)
    const first = plan.mock.calls[0]![1]!.measures
    edit(); set.flush()
    expect(plan.mock.calls[2]![1]!.measures).not.toBe(first)
    expect(pools.length).toBeGreaterThan(1)
  })

  it('follows the Frame while open: a change re-plans 300 ms after it settles, the old tiles shown meanwhile', async () => {
    vi.useFakeTimers()
    try {
      const { plan, set, runIdle, edit, frame } = fakeSet(['meta-story'])
      set.openSet(); runIdle()
      expect(ids(set)).toEqual([['meta-story', 0]])
      edit(); await nextTick()
      vi.advanceTimersByTime(200)
      edit(); await nextTick()                                             // still changing: the debounce restarts
      vi.advanceTimersByTime(299)
      expect(plan).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(1)
      expect(ids(set)).toEqual([['meta-story', 0]])                        // shown until its re-plan lands
      runIdle()
      expect(plan).toHaveBeenCalledTimes(2)
      expect(ids(set)).toEqual([['meta-story', 2]])
      // A value that comes back to what was planned re-plans nothing.
      const same = frame.layers
      frame.choice = 'y'; await nextTick(); frame.choice = 'x'; await nextTick()
      expect(frame.layers).toBe(same)
      vi.advanceTimersByTime(300)
      runIdle()
      expect(plan).toHaveBeenCalledTimes(2)
      // Closed: a change is not followed.
      set.close()
      edit(); await nextTick(); vi.advanceTimersByTime(1000); runIdle()
      expect(plan).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('Send and Download use a plan current at the click: a pending re-plan is flushed first', async () => {
    const { plan, set, runIdle, edit } = fakeSet(['meta-story', 'ad-300x250'])
    set.openSet(); runIdle(); runIdle()
    edit(); await nextTick()                                               // the debounce has not fired
    const e = set.entryFor('ad-300x250')!
    expect((e.plan as unknown as { rev: number }).rev).toBe(1)
    expect(ids(set)).toEqual([['meta-story', 1], ['ad-300x250', 1]])
    expect(plan).toHaveBeenCalledTimes(4)
    // A change the watcher has not even seen yet is caught too.
    edit()
    const saved: string[][] = []
    await set.download({ name: 'x', render: async en => new Blob([String((en.plan as unknown as { rev: number }).rev)]), zip: async f => { saved.push(await Promise.all(f.map(x => x.blob.text()))); return new Blob() }, save: () => {} })
    expect(saved).toEqual([['2', '2']])
    // Unplanned formats are planned at once too.
    expect(set.entryFor('meta-feed-1x1')).toBeUndefined()
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

  it('a format not planned yet shows a placeholder: no chip, no Send, not counted', () => {
    const f = FRAME_FORMATS.find(x => x.id === 'meta-story')!
    const pending = { ...entry('meta-story', 'none'), pending: true as const }
    const wrap = mount(LayoutSetSheet, { props: { entries: [entry('meta-feed-1x1', 'kept'), pending], layoutName: 'Run-off' }, global: { stubs } })
    const tile = wrap.get('[data-format="meta-story"]')
    expect(tile.attributes('data-kind')).toBe('pending')
    expect(tile.get('[data-testid="layout-set-pending"]').text()).toBe('Planning…')
    expect(tile.text()).toContain(f.label)
    expect(tile.find('[data-testid="layout-set-chip"]').exists()).toBe(false)
    expect(tile.find('[data-testid="layout-set-send"]').exists()).toBe(false)
    expect(wrap.get('[data-testid="layout-set-summary"]').text()).toBe('1 as Run-off')
    expect(wrap.get('[data-testid="layout-set-download"]').text()).toBe('Download images')
    expect(wrap.get('[data-testid="layout-set-download"]').attributes('disabled')).toBeUndefined()
  })

  it('each tile keeps one plan object across re-renders (a download\'s progress repaints nothing)', async () => {
    const wrap = mount(LayoutSetSheet, { props: { entries, layoutName: 'Run-off' }, global: { stubs } })
    const plans = () => wrap.findAllComponents({ name: 'LayoutTile' }).map(t => t.props('plan'))
    const before = plans()
    await wrap.setProps({ progress: 'Rendering 1 of 2…' })
    await wrap.setProps({ progress: 'Rendering 2 of 2…' })
    await wrap.setProps({ progress: null, entries: [...entries] })
    const after = plans()
    expect(after).toHaveLength(2)
    after.forEach((p, i) => expect(p).toBe(before[i]))
  })

  it('says the download adds effects and shader fills, only when the Frame has them', async () => {
    const wrap = mount(LayoutSetSheet, { props: { entries, layoutName: 'Run-off' }, global: { stubs } })
    expect(wrap.find('[data-testid="layout-set-effects"]').exists()).toBe(false)
    await wrap.setProps({ effectsInDownload: true })
    expect(wrap.get('[data-testid="layout-set-effects"]').text()).toBe('Effects and shader fills are added in the download.')
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

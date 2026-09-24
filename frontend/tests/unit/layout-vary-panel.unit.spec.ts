// @vitest-environment happy-dom
//
// The Layout tab's panel, Stage 3 (Task 8): the Style picker at the top, the style's suggested
// title face, the words for a style with nothing that fits, and the lines not shown — the
// format's hidden levels and the lines the current layout does not place.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import LayoutVaryPanel from '~/components/vue-canvas/compositor/LayoutVaryPanel.vue'

const base = { name: 'Offer', candidates: [], index: 0, choices: [], library: [], layoutId: 'perfOffer', applied: true, frameW: 160, frameH: 90 }
const stubs = { LayoutTile: true }
/** One candidate whose plan leaves the given lines out. */
const cand = (notPlaced: string[]) => ({
  choice: { lines: 0, arr: 0, scale: 'full', side: 'right' }, sig: 's0', score: 0,
  out: { els: [], did: 'The product fills the page.' },
  plan: { notPlaced: notPlaced.map(text => ({ role: 'caption', text })) },
}) as never

describe('LayoutVaryPanel — the Style picker', () => {
  it('offers the four styles in order, the current one on', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, styleId: 'performance' as const }, global: { stubs } })
    const buttons = wrap.get('[data-testid="layout-style"]').findAll('button')
    expect(buttons.map(b => b.text())).toEqual(['Swiss', 'Performance', 'Editorial', 'Street'])
    expect(buttons[1]!.classes()).toContain('bg-white')
    expect(buttons[0]!.classes()).not.toContain('bg-white')
  })

  it('is Swiss when no style is given', () => {
    const wrap = mount(LayoutVaryPanel, { props: base, global: { stubs } })
    expect(wrap.get('[data-testid="layout-style"]').findAll('button')[0]!.classes()).toContain('bg-white')
  })

  it('picking a style emits it; picking the current one emits nothing', async () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, styleId: 'swiss' as const }, global: { stubs } })
    const buttons = wrap.get('[data-testid="layout-style"]').findAll('button')
    await buttons[2]!.trigger('click')
    await buttons[0]!.trigger('click')
    expect(wrap.emitted('style')).toEqual([['editorial']])
  })
})

describe('LayoutVaryPanel — the suggested face', () => {
  it('names the face and its note, and offers it for the title\'s own text', async () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, styleId: 'street' as const,
      suggestedFace: { family: 'Anton', wt: 400, note: 'A heavy condensed face for the title', title: 'Run lighter.' } }, global: { stubs } })
    const block = wrap.get('[data-testid="layout-suggested-face"]')
    expect(block.get('p').text()).toBe('Suggested: Anton — A heavy condensed face for the title')
    const btn = wrap.get('[data-testid="layout-use-face"]')
    expect(btn.text()).toBe('Use Anton for “Run lighter.”')
    await btn.trigger('click')
    expect(wrap.emitted('use-face')).toHaveLength(1)
  })

  it('is absent without a suggestion', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, styleId: 'editorial' as const, suggestedFace: null }, global: { stubs } })
    expect(wrap.find('[data-testid="layout-suggested-face"]').exists()).toBe(false)
  })
})

describe('LayoutVaryPanel — the library of a style', () => {
  it('a style with no layout for this Frame says so, by its name', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, styleId: 'street' as const, library: [], libraryDone: true }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-none-fit"]').text()).toBe('None of the Street layouts fit this Frame yet.')
  })

  it('says nothing while the library is still being planned', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, styleId: 'street' as const, library: [], libraryDone: false }, global: { stubs } })
    expect(wrap.find('[data-testid="layout-none-fit"]').exists()).toBe(false)
  })

  it('layouts that fit but pass no check are still named, as before', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, styleId: 'editorial' as const, libraryDone: true,
      library: [{ id: 'edCover', name: 'Cover', plan: null, reason: 'None of its variations pass the checks.' }] }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-none-fit"]').text()).toBe('None of the Editorial layouts fit this Frame yet.')
    expect(wrap.get('[data-testid="layout-not-offered"]').text()).toBe('Not offered for this Frame: Cover.')
  })
})

describe('LayoutVaryPanel — lines not shown', () => {
  const fmt = { label: 'Video thumbnail · 16:9', notes: [], hidden: ['Halden Trail 2'] }

  it('only the format hides lines: Stage 2\'s words', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: fmt, candidates: [cand([])] }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-format-hidden"]').text()).toBe('Not shown in this format: “Halden Trail 2”.')
  })

  it('the layout leaves a line out too: both quoted, not only about the format', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: fmt, candidates: [cand(['Offer ends 12 October. While stocks last.'])] }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-format-hidden"]').text()).toBe('Not shown: “Halden Trail 2”, “Offer ends 12 October. W…”.')
  })

  it('no format: the lines the layout leaves out, on their own', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: null, candidates: [cand(['Offer ends 12 October.'])] }, global: { stubs } })
    expect(wrap.find('[data-testid="layout-format"]').exists()).toBe(false)
    expect(wrap.get('[data-testid="layout-not-shown"]').text()).toBe('Not shown: “Offer ends 12 October.”.')
  })

  it('a line that opens with its own quotation mark is not wrapped in a second pair', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: null, candidates: [cand(['“Lightest shoe I have ever raced in.”', '"Fast"', 'Offer ends'])] }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-not-shown"]').text()).toBe('Not shown: “Lightest shoe I have ev…, "Fast", “Offer ends”.')
  })

  it('review I1: the format\'s lines come from the plan on show (what it really hid), not the Frame\'s base reading', () => {
    const c = { ...(cand([]) as object), plan: { notPlaced: [], format: { id: 'video-thumb', label: 'Video thumbnail · 16:9', hidden: ['caption'], lines: ['Offer ends 12 October.'] } } } as never
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: { ...fmt, hidden: ['— Maya R., verified buyer'] }, candidates: [c] }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-format-hidden"]').text()).toBe('Not shown in this format: “Offer ends 12 October.”.')
  })

  it('an image the layout leaves out is named, not quoted', () => {
    const c = { ...(cand([]) as object), plan: { notPlaced: [{ role: 'quote', text: 'Fast shoe' }, { role: 'image2', text: 'Image 2', image: true }] } } as never
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: null, candidates: [c] }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-not-shown"]').text()).toBe('Not shown: “Fast shoe”, Image 2.')
  })

  it('a long list: the first three quoted, then how many more', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: null, candidates: [cand(['A', 'B', 'C', 'D', 'E'])] }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-not-shown"]').text()).toBe('Not shown: “A”, “B”, “C” and 2 more.')
  })

  it('exactly three: all quoted, no count', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: null, candidates: [cand(['A', 'B', 'C'])] }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-not-shown"]').text()).toBe('Not shown: “A”, “B”, “C”.')
  })

  it('four: "and 1 more"; the format\'s own list is capped the same way', () => {
    const four = mount(LayoutVaryPanel, { props: { ...base, format: fmt, candidates: [cand(['B', 'C', 'D'])] }, global: { stubs } })
    expect(four.get('[data-testid="layout-format-hidden"]').text()).toBe('Not shown: “Halden Trail 2”, “B”, “C” and 1 more.')
    const onlyFormat = mount(LayoutVaryPanel, { props: { ...base, format: { ...fmt, hidden: ['A', 'B', 'C', 'D', 'E', 'F'] }, candidates: [cand([])] }, global: { stubs } })
    expect(onlyFormat.get('[data-testid="layout-format-hidden"]').text()).toBe('Not shown in this format: “A”, “B”, “C” and 3 more.')
  })

  it('an image past the first three is counted, not named', () => {
    const c = { ...(cand([]) as object), plan: { notPlaced: [{ role: 'quote', text: 'A' }, { role: 'quote', text: 'B' }, { role: 'quote', text: 'C' }, { role: 'image2', text: 'Image 2', image: true }] } } as never
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: null, candidates: [c] }, global: { stubs } })
    expect(wrap.get('[data-testid="layout-not-shown"]').text()).toBe('Not shown: “A”, “B”, “C” and 1 more.')
  })

  it('nothing left out: no line', () => {
    const wrap = mount(LayoutVaryPanel, { props: { ...base, format: null, candidates: [cand([])] }, global: { stubs } })
    expect(wrap.find('[data-testid="layout-not-shown"]').exists()).toBe(false)
  })
})

// Ruling D4: the applied layout has no variation left after a tag change.
describe('LayoutVaryPanel — a layout that no longer fits (D4)', () => {
  // Ruling D4b: about the Frame, not only its lines (an image can be what no longer fits).
  const SENTENCE = 'This layout no longer fits the Frame.'
  const at = (p: Record<string, unknown>) => mount(LayoutVaryPanel, { props: { ...base, libraryDone: true, ...p }, global: { stubs } })
  it('applied, planned, and no variation: the sentence, where the count and description would be', () => {
    const wrap = at({})
    expect(wrap.get('[data-testid="layout-vary-no-longer-fits"]').text()).toBe(SENTENCE)
    expect(wrap.find('[data-testid="layout-vary-count"]').exists()).toBe(false)
    expect(wrap.find('[data-testid="layout-vary-did"]').exists()).toBe(false)
    expect(wrap.get('[data-testid="layout-vary-name"]').text()).toBe('Offer')
  })
  it('not while it fits, not before an apply, not while the library is still planning', () => {
    expect(at({ candidates: [cand([])] }).find('[data-testid="layout-vary-no-longer-fits"]').exists()).toBe(false)
    expect(at({ candidates: [cand([])] }).text()).toContain('The product fills the page.')
    expect(at({ applied: false }).find('[data-testid="layout-vary-no-longer-fits"]').exists()).toBe(false)
    expect(at({ libraryDone: false }).find('[data-testid="layout-vary-no-longer-fits"]').exists()).toBe(false)
  })
})

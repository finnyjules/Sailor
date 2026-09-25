// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import ShaderEffectGallery from '~/components/vue-canvas/ShaderEffectGallery.vue'
import { myEffectRecords, myEffectsLoaded, setMyEffectRecord } from '~/lib/myEffects/library'
import type { EffectDef } from '~/lib/shaderfx/types'

const d = (id: string, category: string, over: Partial<EffectDef> = {}): EffectDef => ({ id, name: id, category, animated: false, passes: 1, centerParam: null, textures: [], params: [], source: '', ...over })
const effects = [d('water_ripple', 'distortion'), d('mine_aaaaaaaaaaaa', 'mine', { mine: true, name: 'Rain on glass' })]
const body = () => document.body

let w: VueWrapper<any> | null = null
const reset = () => { myEffectRecords.value = []; myEffectsLoaded.value = false }
beforeEach(() => { reset(); setMyEffectRecord({ id: 'mine_aaaaaaaaaaaa' } as any) })
afterEach(() => { w?.unmount(); w = null; reset() })

describe('ShaderEffectGallery (spec §7.3)', () => {
  it('Make one ✦ first, Remix ✦ on every card, a My effects section and chip', async () => {
    w = mount(ShaderEffectGallery, { props: { open: true, effects, selectedId: null, thumbs: {}, canMake: true }, attachTo: document.body })
    expect(body().querySelector('[data-testid="effect-gallery"]')).not.toBeNull()
    const make = body().querySelector('[data-testid="effect-gallery-make"]')!
    expect(make.textContent).toContain('Make one')
    expect(make.textContent).toContain('~$0.24–0.42')
    expect(make.querySelector('[data-part="star"]')).not.toBeNull() // the pastel AI mark
    // Make one is the first thing in the first section (My effects)
    const first = body().querySelector('section')!
    expect(first.textContent).toContain('My effects')
    expect(first.querySelector('.grid')!.firstElementChild).toBe(make)
    expect(body().querySelectorAll('[data-testid="effect-gallery-remix"]')).toHaveLength(2)
    for (const r of body().querySelectorAll('[data-testid="effect-gallery-remix"]')) expect(r.querySelector('[data-part="star"]')).not.toBeNull()
    ;(make as HTMLElement).click(); await w.vm.$nextTick()
    expect(w.emitted('make')).toHaveLength(1)
    ;(body().querySelector('[data-testid="effect-gallery-remix"]') as HTMLElement).click()
    expect(w.emitted('remix')![0]![0]).toMatchObject({ id: 'mine_aaaaaaaaaaaa' })
    expect(w.emitted('confirm')).toBeUndefined() // Remix doesn't pick the effect
  })
  it('Remix shows on the card’s hover: the wrapper is the hover group', () => {
    w = mount(ShaderEffectGallery, { props: { open: true, effects, selectedId: null, thumbs: {}, canMake: true }, attachTo: document.body })
    const remix = body().querySelector('[data-testid="effect-gallery-remix"]')!
    expect(remix.className).toContain('group-hover:opacity-100')
    // Hidden, it can't be tapped: it takes the pointer only while shown (hover or keyboard focus).
    expect(remix.className).toContain('pointer-events-none')
    expect(remix.className).toContain('group-hover:pointer-events-auto')
    expect(remix.className).toContain('focus-visible:pointer-events-auto')
    expect(remix.parentElement!.classList.contains('group')).toBe(true)
  })
  it('a search hides Make one; the My effects chip keeps it', async () => {
    w = mount(ShaderEffectGallery, { props: { open: true, effects, selectedId: null, thumbs: {}, canMake: true }, attachTo: document.body })
    const input = body().querySelector('input')!
    input.value = 'ripple'; input.dispatchEvent(new Event('input')); await w.vm.$nextTick()
    expect(body().querySelector('[data-testid="effect-gallery-make"]')).toBeNull()
    input.value = ''; input.dispatchEvent(new Event('input')); await w.vm.$nextTick()
    const chip = [...body().querySelectorAll('button')].find(b => b.textContent?.startsWith('My effects'))!
    chip.click(); await w.vm.$nextTick()
    expect(body().querySelector('[data-testid="effect-gallery-make"]')).not.toBeNull()
    expect(body().querySelectorAll('[data-testid="effect-gallery-card"]')).toHaveLength(1)
  })
  it('without canMake: My effects are listed, but no Make one and no Remix', () => {
    w = mount(ShaderEffectGallery, { props: { open: true, effects, selectedId: null, thumbs: {} }, attachTo: document.body })
    expect(body().querySelector('[data-testid="effect-gallery-make"]')).toBeNull()
    expect(body().querySelectorAll('[data-testid="effect-gallery-remix"]')).toHaveLength(0)
    expect(body().querySelector('[data-effect-id="mine_aaaaaaaaaaaa"]')).not.toBeNull()
  })
  it('a My effect card says where it came from, never an id', () => {
    w = mount(ShaderEffectGallery, { props: { open: true, effects: [d('mine_aaaaaaaaaaaa', 'mine', { mine: true, name: 'Rain on glass', from: 'Water ripple' })], selectedId: null, thumbs: {} }, attachTo: document.body })
    const card = body().querySelector('[data-effect-id="mine_aaaaaaaaaaaa"]')!
    expect(card.textContent).toContain('Rain on glass')
    expect(card.textContent).toContain('My effect · from “Water ripple”')
    expect(card.textContent).not.toMatch(/\bMine\b/i)
    expect(card.textContent).not.toMatch(/mine_/)
  })
  it('hides drafts, old versions, and My effects no longer in the library', () => {
    const all = [...effects,
      d('mine_aaaaaaaaaaaa~v1', 'mine', { mine: true, versionOf: 'mine_aaaaaaaaaaaa' }),
      d('draft_1_0', 'mine', { draft: true, name: 'Take 1' }),
      d('mine_bbbbbbbbbbbb', 'mine', { mine: true, name: 'Someone else’s' })]
    w = mount(ShaderEffectGallery, { props: { open: true, effects: all, selectedId: null, thumbs: {} }, attachTo: document.body })
    const ids = [...body().querySelectorAll('[data-effect-id]')].map(e => e.getAttribute('data-effect-id'))
    expect(ids).toEqual(['mine_aaaaaaaaaaaa', 'water_ripple'])
  })
  it('a thumbnail when the host has one, a plain placeholder when not; emits what it shows', () => {
    w = mount(ShaderEffectGallery, { props: { open: true, effects, selectedId: null, thumbs: { water_ripple: 'data:image/jpeg;base64,xx' } }, attachTo: document.body })
    expect(body().querySelector('[data-effect-id="water_ripple"] img')).not.toBeNull()
    expect(body().querySelector('[data-effect-id="mine_aaaaaaaaaaaa"] img')).toBeNull()
    expect(body().querySelector('[data-effect-id="mine_aaaaaaaaaaaa"] [data-testid="effect-gallery-placeholder"]')).not.toBeNull()
    expect((w.emitted('visible')!.at(-1)![0] as EffectDef[]).map(e => e.id)).toEqual(['mine_aaaaaaaaaaaa', 'water_ripple'])
  })
  it('emits what it shows when it opens (not while closed), so hosts thumbnail on open', async () => {
    w = mount(ShaderEffectGallery, { props: { open: false, effects, selectedId: null, thumbs: {} }, attachTo: document.body })
    expect(w.emitted('visible')).toBeUndefined()
    await w.setProps({ open: true })
    expect((w.emitted('visible')!.at(-1)![0] as EffectDef[]).map(e => e.id)).toEqual(['mine_aaaaaaaaaaaa', 'water_ripple'])
  })
  it('confirm emits the id', async () => {
    w = mount(ShaderEffectGallery, { props: { open: true, effects, selectedId: 'water_ripple', thumbs: {} }, attachTo: document.body })
    const use = [...body().querySelectorAll('button')].find(b => b.textContent?.trim() === 'Use effect')!
    use.click(); await w.vm.$nextTick()
    expect(w.emitted('confirm')![0]).toEqual(['water_ripple'])
  })
  it('a version-chip id (`mine_x~v2`) still shows Current on its base card', () => {
    w = mount(ShaderEffectGallery, { props: { open: true, effects, selectedId: 'mine_aaaaaaaaaaaa~v2', thumbs: {} }, attachTo: document.body })
    const card = body().querySelector('[data-effect-id="mine_aaaaaaaaaaaa"]')!
    expect(card.closest('button')!.querySelector('span')!.textContent).toContain('Current')
    expect(body().querySelector('[data-effect-id="water_ripple"]')!.closest('button')!.textContent).not.toContain('Current')
  })
})

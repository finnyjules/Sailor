// @vitest-environment happy-dom
// ShaderEffectNode's side of the canvas prompt's effect takes (stage 5, Task 8):
// it answers with its SAVED effect, previews a take without touching its saved
// settings, is read-only while its strip is open, applies the kept effect (only
// non-default dial values stored), never thumbnails a draft, and lets go of every
// listener on unmount.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, ref } from 'vue'

const { catalog, render } = vi.hoisted(() => {
  const { ref } = require('vue')
  const param = { uniform: 'u_amount', label: 'Amount', type: 'float', min: 0, max: 1, step: 0.01, default: 0.5 }
  const def = (id: string, name: string, extra: object = {}) => ({ id, name, category: 'distort', params: [param], textures: [], source: 'void main(){}', ...extra })
  const catalog = ref({ effects: [def('water_ripple', 'Water ripple'), def('mine_rain@1', 'Rain'), def('draft_1_0', 'Take', { draft: true })] })
  const render = vi.fn(() => ({ toDataURL: () => 'data:thumb' }))
  return { catalog, render }
})
vi.mock('~/lib/shaderfx/catalog', () => ({
  useShaderCatalog: () => catalog,
  fetchShaderFxCatalog: async () => catalog.value,
  resolveEffectId: (id: string) => id,
  assetUrl: (f: string) => f,
}))
vi.mock('~/lib/shaderfx/renderer', () => ({
  shaderFx: { render, onContextChange: () => () => {} },
  expandPasses: () => [],
}))
vi.mock('~/composables/useVueNodes', () => ({ getTypeColor: () => '#888888' }))
vi.mock('~/components/CatalogModal.vue', () => ({ default: { name: 'CatalogModal', render: () => null } }))
vi.mock('~/components/vue-canvas/studio/StudioSlider.vue', () => ({ default: { name: 'StudioSlider', props: ['modelValue'], emits: ['update:modelValue'], render: () => null } }))

// happy-dom has no 2D canvas; the node draws a placeholder gradient at setup.
const ctx2d = { createLinearGradient: () => ({ addColorStop() {} }), fillRect() {}, drawImage() {}, fillStyle: '' }
;(HTMLCanvasElement.prototype as any).getContext = () => ctx2d

import ShaderEffectNode from '~/components/vue-canvas/ShaderEffectNode.vue'

const widgetDefs = [{ name: 'effect' }, { name: 'params' }, { name: 'seed' }]
function node() {
  const data = {
    nodeType: 'ShaderEffect', title: 'Shader Effect', inputs: [{ name: 'image', type: 'IMAGE', link: null }], outputs: [{ name: 'image', type: 'IMAGE', links: null }],
    widgetsValues: ['water_ripple', '{"u_amount":0.8}', 42], widgetDefs, mode: 0,
  }
  const w = mount(ShaderEffectNode, { props: { id: 's1', data }, global: { stubs: { VueCanvasNodePort: true } } })
  mounted.push(w)
  return { w, data }
}
const mounted: any[] = []
const fire = (name: string, detail: object) => window.dispatchEvent(new CustomEvent(name, { detail }))
const ask = (nodeId = 's1') => { let got: any = null; fire('sailor:shaderEffectTarget', { nodeId, reply: (o: any) => { got = o } }); return got }
const flush = async () => { await Promise.resolve(); await nextTick() }

describe('ShaderEffectNode: effect takes', () => {
  afterEach(() => { while (mounted.length) mounted.pop().unmount(); render.mockClear() })

  it('answers with its saved effect and that effect’s name, even while a take is previewed', async () => {
    const { w } = node()
    await flush()
    expect(ask()).toEqual({ image: null, effectId: 'water_ripple', title: 'Water ripple' })
    fire('sailor:shaderEffectPreview', { nodeId: 's1', effectId: 'draft_1_0' })
    await nextTick()
    expect(w.text()).toContain('Take') // the header shows the take
    expect(ask()).toEqual({ image: null, effectId: 'water_ripple', title: 'Water ripple' })
    expect(ask('other')).toBeNull() // another node's question is not ours
  })

  it('a preview never touches the saved settings; clearing it shows the saved effect again', async () => {
    const { w, data } = node()
    await flush()
    fire('sailor:shaderEffectPreview', { nodeId: 's1', effectId: 'draft_1_0' })
    await nextTick()
    expect(data.widgetsValues).toEqual(['water_ripple', '{"u_amount":0.8}', 42])
    fire('sailor:shaderEffectPreview', { nodeId: 's1', effectId: null })
    await nextTick()
    expect(w.text()).toContain('Water ripple')
    expect(data.widgetsValues).toEqual(['water_ripple', '{"u_amount":0.8}', 42])
  })

  it('while its strip is open the dials and picker are read-only and write nothing; they return when it closes', async () => {
    const { w, data } = node()
    await flush()
    const controls = () => w.get('[data-testid="shader-effect-controls"]')
    const slider = () => w.findComponent({ name: 'StudioSlider' })
    fire('sailor:shaderEffectLock', { nodeId: 's1', locked: true })
    await nextTick()
    expect(controls().classes()).toContain('opacity-40')
    expect(controls().attributes('inert')).toBeDefined()
    expect(w.get('[data-testid="shader-effect-picker"]').attributes('disabled')).toBeDefined()
    slider().vm.$emit('update:modelValue', 0.1) // even an event that gets through writes nothing
    await w.get('[data-testid="shader-effect-picker"]').trigger('click')
    expect(data.widgetsValues).toEqual(['water_ripple', '{"u_amount":0.8}', 42])
    fire('sailor:shaderEffectLock', { nodeId: 's1', locked: false })
    await nextTick()
    expect(controls().classes()).not.toContain('opacity-40')
    slider().vm.$emit('update:modelValue', 0.3)
    expect(data.widgetsValues[1]).toBe('{"u_amount":0.3}')
  })

  it('applying the kept effect writes the effect and only its non-default dial values', async () => {
    const { data } = node()
    await flush()
    fire('sailor:shaderEffectLock', { nodeId: 's1', locked: true })
    fire('sailor:shaderEffectPreview', { nodeId: 's1', effectId: 'draft_1_0' })
    const changed: any[] = []
    const on = (e: Event) => changed.push((e as CustomEvent).detail)
    window.addEventListener('sailor:shaderfx-changed', on)
    fire('sailor:shaderEffectApply', { nodeId: 's1', effectId: 'mine_rain@1', values: { u_amount: 0.5, u_unknown: 3 } })
    fire('sailor:shaderEffectApply', { nodeId: 's1', effectId: 'mine_rain@1', values: { u_amount: 0.9 } })
    window.removeEventListener('sailor:shaderfx-changed', on)
    expect(data.widgetsValues[0]).toBe('mine_rain@1')
    expect(data.widgetsValues[1]).toBe('{"u_amount":0.9}')
    expect(changed).toEqual([{ id: 's1' }, { id: 's1' }])
    fire('sailor:shaderEffectApply', { nodeId: 's1', effectId: 'mine_rain@1', values: { u_amount: 0.5 } })
    expect(data.widgetsValues[1]).toBe('{}') // the default is not stored
  })

  it('never renders or caches a thumbnail for a draft', async () => {
    node()
    await flush()
    render.mockClear()
    fire('sailor:shaderEffectPreview', { nodeId: 's1', effectId: 'draft_1_0' })
    await nextTick()
    const thumbs = (globalThis as any).__shaderFxThumbs ?? {}
    expect(Object.keys(thumbs)).not.toContain('draft_1_0')
  })

  it('lets go of every listener on unmount', async () => {
    const { w, data } = node()
    await flush()
    w.unmount(); mounted.length = 0
    expect(ask()).toBeNull()
    fire('sailor:shaderEffectApply', { nodeId: 's1', effectId: 'mine_rain@1', values: {} })
    expect(data.widgetsValues[0]).toBe('water_ripple')
  })
})

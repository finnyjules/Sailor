// @vitest-environment happy-dom
// Frame light layers, stage 1, Task 4: the panel components — the light inspector, the Light and
// shadow card, the row switches, Darkness — and the pure helpers behind them.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import LightInspector from '~/components/vue-canvas/compositor/LightInspector.vue'
import LightShadowControls from '~/components/vue-canvas/compositor/LightShadowControls.vue'
import LayerLightToggles from '~/components/vue-canvas/compositor/LayerLightToggles.vue'
import LightDarknessSlider from '~/components/vue-canvas/compositor/LightDarknessSlider.vue'
import { newLightLayer } from '~/lib/frame/lighting/settings'
import { lightingDragging, setLightingDrag } from '~/lib/frame/lighting/drag'
import { sliderGesture } from '~/lib/frame/lighting/gesture'
import { coneToDeg, degToCone, lightHex, lightLabel, LIGHT_SWATCHES } from '~/lib/frame/lighting/labels'

const lamp = () => ({ ...newLightLayer('lamp', { x: 0.2, y: 0.3 }), id: 'L1' })
const spot = () => ({ ...newLightLayer('spot', { x: 0.5, y: 0.04 }), id: 'S1' })
const sun = () => ({ ...newLightLayer('sun', { x: 0.02, y: 0.35 }), id: 'U1' })
const inspector = (light = lamp(), extra: Record<string, unknown> = {}) =>
  mount(LightInspector, { props: { light, darkness: 0.45, ...extra }, attachTo: document.body })

afterEach(() => { setLightingDrag(false); document.body.innerHTML = '' })

describe('labels', () => {
  it('names a light by its type unless the user named it', () => {
    expect(lightLabel(lamp())).toBe('Lamp')
    expect(lightLabel(spot())).toBe('Spot')
    expect(lightLabel(sun())).toBe('Sun')
    expect(lightLabel({ ...lamp(), name: 'Key' })).toBe('Key')
  })
  it('stores colours as lower-case #rrggbb, dropping any alpha', () => {
    expect(lightHex('#FFB36B')).toBe('#ffb36b')
    expect(lightHex('#ffb36b80')).toBe('#ffb36b')
    expect(lightHex('red')).toBeNull()
  })
  it('shows the cone as its full width in degrees and reads it back within range', () => {
    expect(coneToDeg(0.35)).toBe(40)
    expect(degToCone(40)).toBeCloseTo(0.349, 2)
    expect(degToCone(1)).toBe(0.1)
    expect(degToCone(200)).toBe(0.8)
  })
})

describe('sliderGesture', () => {
  it('records the first write of a pointer gesture only; writes outside a gesture each record', async () => {
    const g = sliderGesture()
    expect(g.take()).toBe(true)
    expect(g.take()).toBe(true)
    g.start()
    expect([g.take(), g.take(), g.take()]).toEqual([true, false, false])
    window.dispatchEvent(new Event('pointerup'))
    expect(g.take()).toBe(false) // the click-to-position write on the same pointerup still belongs to it
    await new Promise(r => setTimeout(r, 0))
    expect(g.take()).toBe(true)
  })
})

describe('LightInspector', () => {
  it('shows Lamp / Spot / Sun, the swatches, Brightness, Height, Reach, Delete light and All lights with Darkness', () => {
    const w = inspector()
    const t = w.text()
    for (const s of ['Lamp', 'Spot', 'Sun', 'Colour', 'Brightness', 'Height', 'Reach', 'Delete light', 'All lights', 'Darkness']) expect(t).toContain(s)
    expect(w.findAll('[data-testid="light-swatch"]').map(b => b.attributes('data-color'))).toEqual([...LIGHT_SWATCHES])
    expect(w.find('[data-testid="light-cone"]').exists()).toBe(false)
    expect(w.find('[data-testid="light-unavailable"]').exists()).toBe(false)
  })
  it('switching kind emits only the type, so the light keeps its position', async () => {
    const w = inspector()
    const spotBtn = w.get('[data-testid="light-type"]').findAll('button').find(b => b.text() === 'Spot')!
    await spotBtn.trigger('click')
    expect(w.emitted('change')![0]).toEqual([{ type: 'spot' }, true])
  })
  it('a swatch sets the colour', async () => {
    const w = inspector()
    const pink = w.findAll('[data-testid="light-swatch"]').find(b => b.attributes('data-color') === '#ff3fa4')!
    await pink.trigger('click')
    expect(w.emitted('change')![0]).toEqual([{ color: '#ff3fa4' }, true])
    expect(w.findAll('[data-testid="light-swatch"]')[0]!.attributes('aria-pressed')).toBe('true') // the lamp's own #ffb36b
  })
  it('any colour: the picker strips alpha, and a run of picker writes is one undo step', () => {
    const w = inspector()
    const pick = w.findComponent({ name: 'StudioColor' })
    ;(pick.vm as any).$emit('update:modelValue', '#2FE0FFcc')
    ;(pick.vm as any).$emit('update:modelValue', '#2fe0fe')
    expect(w.emitted('change')).toEqual([[{ color: '#2fe0ff' }, true], [{ color: '#2fe0fe' }, false]])
  })
  it('a spot shows Cone (degrees) and Edge; a sun has no Reach', () => {
    const s = inspector(spot())
    expect(s.find('[data-testid="light-cone"]').exists()).toBe(true)
    expect(s.find('[data-testid="light-edge"]').exists()).toBe(true)
    expect(s.get('[data-testid="light-cone"] [aria-valuetext]').attributes('aria-valuetext')).toBe('40')
    const u = inspector(sun())
    expect(u.find('[data-testid="light-reach"]').exists()).toBe(false)
    expect(u.find('[data-testid="light-cone"]').exists()).toBe(false)
  })
  it('Delete light emits delete', async () => {
    const w = inspector()
    await w.get('[data-testid="light-delete"]').trigger('click')
    expect(w.emitted('delete')).toHaveLength(1)
  })
  it('shows the muted note when the lighting pass is unavailable', () => {
    expect(inspector(lamp(), { available: false }).text()).toContain('Lights need graphics acceleration')
  })
  it('a dial write nudges the lighting drag flag (the fast preview), which times out by itself', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(LightDarknessSlider, { props: { darkness: 0.45 } })
      ;(w.findComponent({ name: 'StudioSlider' }).vm as any).$emit('update:modelValue', 60)
      expect(w.emitted('update')![0]).toEqual([0.6, true])
      expect(lightingDragging.value).toBe(true)
      vi.advanceTimersByTime(500)
      expect(lightingDragging.value).toBe(false)
    } finally { vi.useRealTimers() }
  })
})

describe('LightShadowControls', () => {
  it('shows Lit by lights, Casts shadows and Lift for a caster; no Lift when it does not cast', () => {
    const t = mount(LightShadowControls, { props: { layer: { kind: 'text' } } })
    expect(t.text()).toContain('Light and shadow')
    expect(t.text()).toContain('Lit by lights')
    expect(t.text()).toContain('Casts shadows')
    expect(t.find('[data-testid="layer-lift"]').exists()).toBe(true)
    const img = mount(LightShadowControls, { props: { layer: { kind: 'image' } } })
    expect(img.find('[data-testid="layer-lift"]').exists()).toBe(false)
  })
  it('writes the default as absent', async () => {
    const w = mount(LightShadowControls, { props: { layer: { kind: 'image' } } })
    const sw = w.findAllComponents({ name: 'StudioSwitch' })
    ;(sw[1]!.vm as any).$emit('update:modelValue', true)   // image: casts is off by default
    ;(sw[0]!.vm as any).$emit('update:modelValue', false)
    ;(sw[0]!.vm as any).$emit('update:modelValue', true)
    expect(w.emitted('change')).toEqual([[{ castsShadow: true }, true], [{ lit: false }, true], [{ lit: undefined }, true]])
  })
})

describe('LayerLightToggles', () => {
  it('reflects the layer with aria-pressed and emits on click', async () => {
    const w = mount(LayerLightToggles, { props: { layer: { kind: 'rect', lit: false } } })
    const lit = w.get('[data-testid="row-lit"]'), cast = w.get('[data-testid="row-casts-shadow"]')
    expect(lit.attributes('aria-pressed')).toBe('false')
    expect(cast.attributes('aria-pressed')).toBe('true')
    expect(lit.attributes('title')).toBeTruthy()
    expect(cast.attributes('title')).toBeTruthy()
    await lit.trigger('click'); await cast.trigger('click')
    expect(w.emitted('toggle-lit')).toHaveLength(1)
    expect(w.emitted('toggle-casts')).toHaveLength(1)
  })
  it('an image does not cast by default', () => {
    const w = mount(LayerLightToggles, { props: { layer: { kind: 'image' } } })
    expect(w.get('[data-testid="row-casts-shadow"]').attributes('aria-pressed')).toBe('false')
  })
})

// The Frame editor gates every light panel on the Frame having a light: with none, the panels
// are as before (no row switches, no Light and shadow card, no Darkness, no Background Lit).
describe('Frame editor wiring (source guard)', () => {
  const s = readFileSync(resolve(__dirname, '../../app/components/vue-canvas/CompositorModal.vue'), 'utf8')
  const tagLine = (tag: string) => { const i = s.indexOf(tag); expect(i).toBeGreaterThan(-1); return s.slice(i, s.indexOf('\n', i)) }
  it('hasLights is "the Frame holds a light layer"', () => {
    expect(s).toMatch(/const hasLights = computed\(\(\) => frameLightLayers\.value\.length > 0\)/)
  })
  it('the row switches, the Light and shadow card, Darkness and Background Lit show only with lights', () => {
    expect(tagLine('<LayerLightToggles')).toContain('v-if="hasLights &&')
    expect(tagLine('<LayerLightToggles')).toContain('!isLightRow(row)')
    expect(tagLine('<LightShadowControls')).toContain('v-if="hasLights"')
    expect(tagLine('<LightDarknessSlider')).toContain('v-if="hasLights"')
    expect(s).toMatch(/<div v-if="hasLights"[^>]*data-testid="background-lit"/)
  })
  it('a selected light shows only the light inspector (no add-effect, no generic cards)', () => {
    const light = s.indexOf('<div v-if="selectedIsLight" class="inspector-body')
    const addFx = s.indexOf('data-testid="inspector-add-effect"', light)
    expect(light).toBeGreaterThan(-1)
    expect(s.slice(light, addFx)).toContain('<template v-else>')
    expect(s.slice(light, addFx)).toContain('<LightInspector')
  })
  it('light rows get no effect plus and no fx disclosure', () => {
    const plus = s.indexOf('type="button" data-testid="add-effect"')
    expect(s.slice(plus - 200, plus)).toContain('!isLightRow(row)')
    const fx = s.indexOf('type="button" data-testid="layer-fx-toggle"')
    expect(s.slice(fx - 250, fx)).toContain('!isLightRow(row)')
  })
})

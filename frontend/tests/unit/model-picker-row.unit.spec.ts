// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { mount } from '@vue/test-utils'
import WidgetModelPicker from '~/components/vue-canvas/widgets/WidgetModelPicker.vue'

// Real catalog ids so the component's own lookups resolve without stubbing
// any store — WidgetModelPicker only reads plain data modules + localStorage.
const IMAGE_MODEL_ID = 'flux-1.1-pro'       // brand BFL, kind 'image'
const SHOT_PRESET_ID = 'push-in'             // kind 'shot_preset'
const TEXT_EFFECT_ID = 'liquid-chrome'       // kind 'text_effect'

describe('WidgetModelPicker — row', () => {
  it('is a 32px row with the node-row background, not its own boxed button', () => {
    const w = mount(WidgetModelPicker, { props: { modelValue: IMAGE_MODEL_ID, kind: 'image' } })
    const root = w.find('button')
    expect(root.classes()).toContain('h-8')
    expect(root.classes()).toContain('px-[11px]')
    expect(root.classes()).toContain('bg-white/[0.03]')
  })

  it('shows a left label "Model" for the image kind', () => {
    const w = mount(WidgetModelPicker, { props: { modelValue: IMAGE_MODEL_ID, kind: 'image' } })
    const label = w.find('[data-picker-label]')
    expect(label.exists()).toBe(true)
    expect(label.text()).toBe('Model')
    expect(label.classes()).toContain('text-white/55')
  })

  it('shows a left label "Shot" for shot_preset and "Effect" for text_effect', () => {
    const shot = mount(WidgetModelPicker, { props: { modelValue: SHOT_PRESET_ID, kind: 'shot_preset' } })
    expect(shot.find('[data-picker-label]').text()).toBe('Shot')

    const effect = mount(WidgetModelPicker, { props: { modelValue: TEXT_EFFECT_ID, kind: 'text_effect' } })
    expect(effect.find('[data-picker-label]').text()).toBe('Effect')
  })

  it('shows the model label as the value on the right', () => {
    const w = mount(WidgetModelPicker, { props: { modelValue: IMAGE_MODEL_ID, kind: 'image' } })
    expect(w.text()).toContain('Flux 1.1 Pro')
  })

  it('never renders an uppercase maker/kind line', () => {
    const w = mount(WidgetModelPicker, { props: { modelValue: IMAGE_MODEL_ID, kind: 'image' } })
    expect(w.find('.uppercase').exists()).toBe(false)
    expect(w.html()).not.toMatch(/\buppercase\b/)
  })

  it('keeps the chevron', () => {
    const w = mount(WidgetModelPicker, { props: { modelValue: IMAGE_MODEL_ID, kind: 'image' } })
    // lucide-vue-next renders an <svg>; look for the chevron wrapper class instead.
    expect(w.html()).toContain('size-3.5')
  })

  it('still dispatches sailor:openModelGallery on click, with kind in the detail', async () => {
    const seen: any[] = []
    const handler = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener('sailor:openModelGallery', handler)
    const w = mount(WidgetModelPicker, { props: { modelValue: IMAGE_MODEL_ID, kind: 'image', nodeId: 'n1' } })
    await w.find('button').trigger('click')
    window.removeEventListener('sailor:openModelGallery', handler)
    expect(seen).toEqual([{ nodeId: 'n1', kind: 'image' }])
  })
})

describe('WidgetText — prompt well hairline fill is opaque', () => {
  it('sets --pastel-hairline-bg to an opaque colour, not a see-through rgba()', () => {
    const src = readFileSync(
      resolve(__dirname, '../../app/components/vue-canvas/widgets/WidgetText.vue'),
      'utf-8',
    )
    expect(src).not.toMatch(/--pastel-hairline-bg:\s*rgba\(/)
    expect(src).toMatch(/--pastel-hairline-bg:\s*#111113/)
  })
})

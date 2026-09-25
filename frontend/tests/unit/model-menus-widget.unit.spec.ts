// @vitest-environment happy-dom
/**
 * The combo widget with Sailor's hidden list (model line-up, Task H1): a
 * hidden value the node already holds renders, labelled "(hidden)", and stays
 * selected; a node on another value doesn't offer it.
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ComfyNodeWidget from '~/components/vue-canvas/ComfyNodeWidget.vue'

const def = {
  name: 'model',
  type: 'COMBO',
  options: ['Nano Banana 2', 'Flux Kontext Pro', 'Flux 2 Pro'],
  default: 'Nano Banana 2',
  hidden_options: ['Flux Kontext Pro'],
}

const mountWidget = (modelValue: string) => mount(ComfyNodeWidget, {
  props: { widgetDef: def, modelValue, nodeType: 'EditImageNode', nodeId: '7' },
})

/** Every option the row's select offers: value → text. */
function offered(w: ReturnType<typeof mountWidget>): Record<string, string> {
  return Object.fromEntries(w.findAll('option').map(o => [o.attributes('value') ?? o.text(), o.text().trim()]))
}

describe('combo widget: hidden options', () => {
  it('a hidden value selected on a node renders, labelled, and stays selected', () => {
    const w = mountWidget('Flux Kontext Pro')
    expect(w.text()).toContain('Flux Kontext Pro (hidden)')
    expect(offered(w)).toEqual({
      'Nano Banana 2': 'Nano Banana 2',
      'Flux Kontext Pro': 'Flux Kontext Pro (hidden)',
      'Flux 2 Pro': 'Flux 2 Pro',
    })
    expect((w.get('select').element as HTMLSelectElement).value).toBe('Flux Kontext Pro')
    expect(w.emitted('update:modelValue')).toBeUndefined()
  })

  it('on another value the hidden option is left out', () => {
    const w = mountWidget('Nano Banana 2')
    expect(w.text()).not.toContain('Flux Kontext Pro')
    expect(w.text()).toContain('Nano Banana 2')
    expect(Object.keys(offered(w))).toEqual(['Nano Banana 2', 'Flux 2 Pro'])
    expect((w.get('select').element as HTMLSelectElement).value).toBe('Nano Banana 2')
  })
})

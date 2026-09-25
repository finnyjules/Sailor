// @vitest-environment happy-dom
/**
 * Task F12 fix round 1 (review minor 1): the settings Bria Product Shot
 * can't honour (product size, keep the product exact, seed) are hidden while
 * its switch is on, and shown while it is off — proved on the mounted
 * NodeInspector and ComfyNode (the node body and its title-bar seed lock),
 * not by matching their source.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import NodeInspector from '~/components/vue-canvas/NodeInspector.vue'
import ComfyNode from '~/components/vue-canvas/ComfyNode.vue'

const g = globalThis as any
const saved = g.useRuntimeConfig
afterEach(() => { g.useRuntimeConfig = saved })

/** The public runtime config the inspector reads at setup. */
function switches(runnerEnabled: boolean, runnerFamilies: string) {
  g.useRuntimeConfig = () => ({ public: { runnerEnabled, runnerFamilies } })
}

/** Renders each widget the inspector hands it as its name. */
const WidgetStub = defineComponent({
  props: { widgetDef: { type: Object, required: true } },
  setup: props => () => h('div', { class: 'widget', 'data-name': (props.widgetDef as { name: string }).name }),
})

/** A Product shot node as the canvas holds it (the Python schema's widgets, in order). */
function productShot(nodeType = 'ProductShotNode') {
  return {
    id: '7',
    data: {
      nodeType,
      title: 'Bottle on a rock',
      widgetDefs: [
        { name: 'scene_prompt', type: 'STRING' },
        { name: 'aspect', type: 'COMBO', options: ['Square', 'Portrait', 'Landscape'] },
        { name: 'product_size', type: 'COMBO', options: ['Original', '80'] },
        { name: 'keep_product_exact', type: 'BOOLEAN', advanced: true },
        { name: 'seed', type: 'INT', advanced: true },
      ],
      widgetsValues: ['a beach', 'Square', 'Original', true, 0],
      properties: {},
    },
  }
}

function shown(node = productShot()): string[] {
  const w = mount(NodeInspector, { props: { node }, global: { stubs: { VueCanvasComfyNodeWidget: WidgetStub } } })
  return w.findAll('.widget').map(x => x.attributes('data-name')!)
}

describe('the inspector hides what Bria Product Shot can\'t honour, only while its switch is on', () => {
  it('off (runner on, every other family): exactness and seed are shown', () => {
    switches(true, 'ref-edits,qwen-2511-angles,nano-actions')
    expect(shown()).toEqual(['keep_product_exact', 'seed'])
  })

  it('runner off, even with the family listed: shown', () => {
    switches(false, 'bria-product-shot')
    expect(shown()).toEqual(['keep_product_exact', 'seed'])
  })

  it('on: both hidden (product size lives on the node body, not here)', () => {
    switches(true, 'bria-product-shot')
    expect(shown()).toEqual([])
  })

  it('on: another node\'s seed and advanced settings are untouched', () => {
    switches(true, 'bria-product-shot')
    expect(shown(productShot('RotateCameraNode'))).toEqual(['keep_product_exact', 'seed'])
  })
})

/** The node body's widgets (by name) and whether the title bar has a seed lock. */
function nodeBody(nodeType = 'ProductShotNode'): { widgets: string[], seedLock: boolean } {
  const n = productShot(nodeType)
  const data = { ...n.data, inputs: [{ name: 'image', type: 'IMAGE' }], outputs: [{ name: 'IMAGE', type: 'IMAGE' }] }
  const w = mount(ComfyNode as any, { props: { id: n.id, data, selected: false }, shallow: true, global: { stubs: { VueCanvasComfyNodeWidget: WidgetStub } } })
  return {
    widgets: w.findAll('.widget').map(x => x.attributes('data-name')!),
    seedLock: w.findAll('button').some(b => /Lock the seed|Seed locked/.test(b.attributes('title') ?? '')),
  }
}

describe('the node body hides them too, and drops the seed lock, only while the switch is on', () => {
  it('off: product size on the body (exactness and seed live in the inspector), the seed lock shown', () => {
    switches(true, 'ref-edits')
    expect(nodeBody()).toEqual({ widgets: ['scene_prompt', 'aspect', 'product_size'], seedLock: true })
  })

  it('on: product size hidden, no seed lock', () => {
    switches(true, 'bria-product-shot')
    expect(nodeBody()).toEqual({ widgets: ['scene_prompt', 'aspect'], seedLock: false })
  })

  it('on, another node: untouched', () => {
    switches(true, 'bria-product-shot')
    expect(nodeBody('RotateCameraNode')).toEqual({ widgets: ['scene_prompt', 'aspect', 'product_size'], seedLock: true })
  })
})

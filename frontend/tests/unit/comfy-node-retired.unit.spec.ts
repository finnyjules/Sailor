// @vitest-environment happy-dom
/**
 * A saved workflow holding a retired partner node (Task R4.1, fix round 1):
 * it opens; the node card — or the subgraph card holding one — is marked
 * retired, with the plain message reachable by keyboard, touch and screen
 * readers (a focusable badge with a tooltip and a description); its Run row
 * shows no price, no scope menu and "Retired", and its Run button says why it
 * can't run. Step 4, C4: Sailor's own retired nodes (Font Playground, Kinetic
 * Typography, the hidden per-model Replicate nodes) open the same way, each
 * naming its replacement.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { RETIRED_NODE_MESSAGE } from '#shared/runner/retired'
import { useVueNodes } from '~/composables/useVueNodes'
import ComfyNode from '~/components/vue-canvas/ComfyNode.vue'
import NodeRunRow from '~/components/vue-canvas/NodeRunRow.vue'

const CATALOG = JSON.parse(gunzipSync(readFileSync(join(process.cwd(), 'server/native/objectInfo.baseline.json.gz'))).toString('utf8')) as Record<string, any>
const KLING = 'KlingImage2VideoNode'
const SG = '5f0c1a2b-0000-4000-8000-00000000abcd'

const g = globalThis as any
const savedConfig = g.useRuntimeConfig
beforeEach(() => { g.useRuntimeConfig = () => ({ public: { runnerEnabled: true, runnerFamilies: '' } }) })
afterEach(() => { g.useRuntimeConfig = savedConfig })

/** reka-ui's tooltip parts, rendered through so the badge and the tooltip's words are in the DOM. */
const through = (name: string) => defineComponent({ name, inheritAttrs: false, setup: (_, { slots }) => () => h('div', { 'data-part': name }, slots.default?.()) })
const STUBS = {
  VueCanvasComfyNodeWidget: defineComponent({ setup: () => () => h('div') }),
  TooltipProvider: through('TooltipProvider'),
  TooltipRoot: through('TooltipRoot'),
  TooltipTrigger: through('TooltipTrigger'),
  TooltipPortal: through('TooltipPortal'),
  TooltipContent: through('TooltipContent'),
  NodeRunRow: false as const,
}

function open(workflow: any) {
  const vn = useVueNodes()
  vn.objectInfo.value = CATALOG
  vn.convertFromLiteGraph({ last_node_id: 9, last_link_id: 0, links: [], groups: [], config: {}, extra: {}, version: 0.4, ...workflow }, workflow.definitions)
  return vn.nodes.value as any[]
}
const card = (node: any) => mount(ComfyNode as any, { props: { id: node.id, data: node.data, selected: false }, shallow: true, attachTo: document.body, global: { stubs: STUBS } })

const klingNode = (id = 1) => ({ id, type: KLING, pos: [0, 0], size: [280, 400], inputs: [], outputs: [], widgets_values: ['a fox runs', '', 'kling-v2-master', 0.8, 'std', '16:9', '5'], properties: {} })

function expectRetiredBadge(w: ReturnType<typeof card>) {
  const badge = w.find('[data-retired]')
  expect(badge.exists()).toBe(true)
  expect(badge.element.tagName).toBe('BUTTON') // focusable: keyboard and touch reach it
  expect(badge.text()).toBe('Retired')
  const described = document.getElementById(badge.attributes('aria-describedby')!)
  expect(described?.textContent).toBe(RETIRED_NODE_MESSAGE)
  expect(w.find('[data-part="TooltipContent"]').text()).toBe(RETIRED_NODE_MESSAGE)
}

describe('a saved retired node', () => {
  it('opens, and its card is marked retired with the message reachable by everyone', () => {
    const [node] = open({ nodes: [klingNode()] })
    expect(node.data.nodeType).toBe(KLING)
    const w = card(node)
    expectRetiredBadge(w)
    w.unmount()
  })

  it('its Run row: no price, no scope menu, "Retired", and the Run button says why it can\'t run', async () => {
    const [node] = open({ nodes: [klingNode()] })
    const w = card(node)
    const row = w.findComponent(NodeRunRow)
    expect(row.props('price')).toBeNull()
    expect(row.props('canRun')).toBe(false)
    expect(row.props('status')).toEqual({ tone: 'idle', text: 'Retired' })
    expect(w.find('[aria-label="Run scope options"]').exists()).toBe(false)
    const run = row.find('button')
    expect(run.attributes('disabled')).toBeUndefined() // focusable, inert
    expect(run.attributes('aria-disabled')).toBe('true')
    expect(document.getElementById(run.attributes('aria-describedby')!)?.textContent).toBe(RETIRED_NODE_MESSAGE)
    expect(run.attributes('title')).toBe(RETIRED_NODE_MESSAGE)
    await run.trigger('click')
    expect(row.emitted('run')).toBeUndefined()
    w.unmount()
  })

  it('FaceRestore and LipSync open, show Retired, and name their replacement', () => {
    for (const [type, message] of [
      ['FaceRestore', 'This node was retired. Use Fix faces instead.'],
      ['LipSync', 'This node was retired. Use Lip-sync a character instead.'],
    ] as const) {
      const [node] = open({ nodes: [{ ...klingNode(), type, widgets_values: [] }] })
      expect(node.data.nodeType).toBe(type)
      const w = card(node)
      expect(w.find('[data-part="TooltipContent"]').text()).toBe(message)
      expect(w.find('[data-retired]').text()).toBe('Retired')
      // These classes are no longer in the catalogue, so the card may draw no Run row at all; if it does, it can't run.
      const row = w.findComponent(NodeRunRow)
      if (row.exists()) { expect(row.props('canRun')).toBe(false); expect(row.props('blockedReason')).toBe(message) }
      w.unmount()
    }
  })

  it('step 4, C4: Sailor\'s own retired nodes open from their saved widgets, show Retired, can\'t run, and name their replacement', () => {
    for (const [type, widgets, message] of [
      ['RenderType', ['{"text":"Hi"}'], 'This node was retired. Use Vector Type instead.'],
      ['FluxProRemoteNode', ['a fox', '1:1', 1024, 1024, 2, false, 'webp', 0], 'This node was retired. Use Generate an image instead.'],
      ['IdeogramV3TurboRemoteNode', ['a fox', '1:1', 'Auto', 'Auto', 0], 'This node was retired. Use Generate an image instead.'],
      ['FluxKontextRemoteNode', ['make it blue', 'match_input_image', 2, false, 'png', 0], 'This node was retired. Use Edit an image instead.'],
      ['ClarityUpscaleRemoteNode', ['masterpiece', 2, 0.35, 0.6, '', 18, 0], 'This node was retired. Use Upscale an image instead.'],
      ['Seedance2RemoteNode', ['a fox runs', '16:9', '1080p', 5, false, 0], 'This node was retired. Use Generate a video instead.'],
      ['Veo3RemoteNode', ['a fox runs', '16:9', '', 0], 'This node was retired. Use Generate a video instead.'],
      ['KlingVideoRemoteNode', ['a fox runs', '16:9', 5, '', 0.5], 'This node was retired. Use Generate a video instead.'],
    ] as const) {
      const [node] = open({ nodes: [{ ...klingNode(), type, widgets_values: widgets }] })
      expect(node.data.nodeType, type).toBe(type)
      const w = card(node)
      expect(w.find('[data-retired]').text(), type).toBe('Retired')
      expect(w.find('[data-part="TooltipContent"]').text(), type).toBe(message)
      // The Font Playground and Kinetic Typography cards draw no Run row (their own editor ran them); any row drawn can't run.
      const row = w.findComponent(NodeRunRow)
      if (type.endsWith('RemoteNode')) expect(row.exists(), type).toBe(true)
      if (row.exists()) { expect(row.props('canRun'), type).toBe(false); expect(row.props('blockedReason'), type).toBe(message) }
      w.unmount()
    }
  })

  it('C4: a saved Kinetic Typography node opens as Vector Type; one its migration left as it was shows Retired, naming Vector Type', () => {
    const [migrated] = open({ nodes: [{ ...klingNode(), type: 'KineticType', widgets_values: ['{"text":"Hi"}'] }] })
    expect(migrated.data.nodeType).toBe('VectorType')
    // migrateKinetic.ts keeps a node it can't migrate as a KineticType: its card is the retired card.
    const [base] = open({ nodes: [{ ...klingNode(), type: 'RenderType', widgets_values: ['{}'] }] })
    const w = card({ ...base, data: { ...base.data, nodeType: 'KineticType' } })
    expect(w.find('[data-retired]').text()).toBe('Retired')
    expect(w.find('[data-part="TooltipContent"]').text()).toBe('This node was retired. Use Vector Type instead.')
    w.unmount()
  })

  it('any other node is untouched: no badge, its price and scope menu stay', () => {
    const [node] = open({ nodes: [{ ...klingNode(), type: 'GenerateVideoNode', widgets_values: [] }] })
    const w = card(node)
    expect(w.find('[data-retired]').exists()).toBe(false)
    const row = w.findComponent(NodeRunRow)
    expect(row.props('blockedReason')).toBeNull()
    expect(row.props('status')).not.toEqual({ tone: 'idle', text: 'Retired' })
    expect(w.find('[aria-label="Run scope options"]').exists()).toBe(true)
    w.unmount()
  })
})

describe('a subgraph holding a retired node', () => {
  const definition = (inner: any[]) => ({ subgraphs: [
    { id: SG, name: 'Fox clip maker', inputNode: { id: -10 }, outputNode: { id: -20 }, inputs: [], outputs: [], nodes: inner, links: [] },
    { id: 'inner-sg', name: 'Inner', inputNode: { id: -10 }, outputNode: { id: -20 }, inputs: [], outputs: [], nodes: [klingNode()], links: [] },
  ] })
  const instance = { id: 7, type: SG, title: 'My clip', pos: [0, 0], size: [200, 100], inputs: [], outputs: [], widgets_values: [], properties: {} }

  it('its card is marked retired, nested subgraphs too', () => {
    for (const inner of [[klingNode()], [{ ...klingNode(3), type: 'inner-sg' }]]) {
      const [node] = open({ nodes: [instance], definitions: definition(inner) })
      expect(node.data.isSubgraph).toBe(true)
      expect(node.data.containsRetired).toBe(true)
      const w = card(node)
      expectRetiredBadge(w)
      w.unmount()
    }
  })

  it('one without is not', () => {
    const [node] = open({ nodes: [instance], definitions: definition([{ ...klingNode(), type: 'SaveImage' }]) })
    expect(node.data.containsRetired).toBeUndefined()
    expect(card(node).find('[data-retired]').exists()).toBe(false)
  })
})

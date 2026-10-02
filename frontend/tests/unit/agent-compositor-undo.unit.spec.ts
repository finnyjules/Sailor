import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reactive } from 'vue'

// Final review Q1: an assistant proposal is ONE undo step. The agent records once, before its
// first write; the Frame's setState writes layers, lighting and bands without recording.
const plan = vi.hoisted(() => ({ text: '' }))
vi.mock('ofetch', () => ({
  $fetch: vi.fn(async (url: string) => {
    if (url === '/api/agent-plan') return { text: plan.text }
    throw new Error(`unexpected fetch ${url}`)
  }),
}))

import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'
import { useCompositorAgent } from '~/composables/useCompositorAgent'
import { mergeAgentBands } from '~/lib/motionx/adapter/agentBands'
import type { CompositorState } from '~/lib/agent/surfaces/compositor'
import type { LocalLayer } from '~/composables/useCompositorLayers'

const RECT = { id: 'R', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0 }

/** The editor over a reactive Frame node, and the agent wired to it the way CompositorModal is. */
function setup() {
  const properties: Record<string, any> = { sailor_localLayers: [RECT], sailor_motion: { fps: 30, duration: 4, motionx: [] } }
  const node = reactive({ data: { properties } })
  const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 680, h: 680 }), getRect: () => null })
  let steps = 0
  const motion = () => node.data.properties.sailor_motion
  const agent = useCompositorAgent({
    getState: () => ({
      layers: ed.localLayers.value, background: ed.background.value, postEffects: ed.postEffects.value,
      grid: ed.layoutGrid.value, aspect: 1, motion: motion(), lighting: ed.lighting.value,
    }) as CompositorState,
    setState: (s) => {
      ed.commit(s.layers as LocalLayer[])
      if (s.background !== ed.background.value) ed.setBackground(s.background, false)
      if (JSON.stringify(s.postEffects ?? []) !== JSON.stringify(ed.postEffects.value)) ed.setPostEffects(s.postEffects ?? [], false)
      if (s.grid && JSON.stringify(s.grid) !== JSON.stringify(ed.layoutGrid.value)) ed.setLayoutGrid(s.grid, false)
      if (s.lighting && JSON.stringify(s.lighting) !== JSON.stringify(ed.lighting.value)) ed.setLighting(s.lighting, false)
      const lightIds = new Set([...s.layers, ...ed.localLayers.value].filter(l => l.kind === 'light').map(l => l.id))
      const next = mergeAgentBands(motion().motionx ?? [], s.motion?.motionx ?? [], lightIds)
      node.data.properties.sailor_motion = { ...motion(), motionx: next }
    },
    recordHistory: () => { steps++; ed.recordHistory() },
    apiKey: () => 'test',
  })
  return { node, ed, agent, steps: () => steps, motion }
}
const kinds = (ed: ReturnType<typeof useLocalLayerEditor>) => ed.localLayers.value.map(l => l.kind)

describe('an assistant proposal is one undo step', () => {
  beforeEach(() => {
    plan.text = JSON.stringify({ reasoning: '', message: 'A warm lamp at night.', commands: [
      { op: 'addLight', args: { id: 'lamp', type: 'lamp', x: 0.15, y: 0.35, color: '#ffb066' } },
      { op: 'setLighting', args: { darkness: 0.85 } },
      { op: 'animateLight', target: 'lamp', args: { key: 'brightness', from: 0, to: 3 } },
      { op: 'setBackground', args: { color: '#102030' } },
    ] })
  })

  it('addLight + setLighting + animateLight: one history entry; one undo restores layers, lighting and motion', async () => {
    const { ed, agent, steps, motion, node } = setup()
    const before = { layers: JSON.stringify(ed.localLayers.value), lighting: node.data.properties.sailor_localLighting, bg: ed.background.value }
    await agent.ask('make it night with a warm lamp that fades in')
    expect(agent.changes.value.length).toBeGreaterThanOrEqual(3)
    expect(kinds(ed)).toEqual(['rect', 'light'])
    expect(ed.lighting.value.darkness).toBe(0.85)
    expect(motion().motionx.map((t: any) => t.path)).toContain('layers.lamp.light.brightness')
    expect(steps()).toBe(1)

    // Toggling rows re-pushes the proposal: still the one step.
    agent.rejectChange(1); agent.acceptChange(1)
    expect(steps()).toBe(1)
    agent.keep()

    ed.undo()
    expect(JSON.stringify(ed.localLayers.value)).toBe(before.layers)
    expect(node.data.properties.sailor_localLighting).toEqual(before.lighting)
    expect(ed.background.value).toEqual(before.bg)
    expect(motion().motionx ?? []).toEqual([])
    expect(ed.canUndo.value).toBe(false)
  })

  it('a reverted proposal adds no second step, and a plan that applies nothing records none', async () => {
    const a = setup()
    await a.agent.ask('make it night')
    a.agent.revert()
    expect(a.steps()).toBe(1)
    expect(kinds(a.ed)).toEqual(['rect'])

    plan.text = JSON.stringify({ reasoning: '', message: 'Nothing to do.', commands: [] })
    const b = setup()
    await b.agent.ask('do nothing')
    expect(b.steps()).toBe(0)
    expect(b.ed.canUndo.value).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import { applyCompositorCommand, describeCompositor } from '~/lib/agent/surfaces/compositor'
import type { CompositorState } from '~/lib/agent/surfaces/compositor'
import { effectStackOf } from '~/lib/compositor/effectStack'

const baseState = (): CompositorState => ({
  layers: [{ id: 'a', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0 } as any],
})

describe('setLayerTornEdge', () => {
  it('sets a torn edge with clamped params and defaults', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'setLayerTornEdge', target: 'a', args: { patch: { style: 'ripped', amount: 9999, lipWidth: 12 } },
    })
    expect(r.ok).toBe(true)
    const layer = (r as any).template.layers[0]
    // Torn edge now lives in the layer's effect stack, not layer.tornEdge (Task 4).
    const fx = effectStackOf(layer).find(e => e.type === 'torn_edge') as any
    expect(fx.style).toBe('ripped')
    expect(fx.amount).toBeLessThanOrEqual(200)
    expect(fx.lipWidth).toBe(12)
  })

  it('merges a partial patch over an existing torn edge', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'setLayerTornEdge', target: 'a', args: { patch: { amount: 20 } } }) as any).template
    const s2 = (applyCompositorCommand(s1, { op: 'setLayerTornEdge', target: 'a', args: { patch: { grain: 5 } } }) as any).template
    const fx = effectStackOf(s2.layers[0]).find((e: any) => e.type === 'torn_edge') as any
    expect(fx.amount).toBe(20)
    expect(fx.grain).toBe(5)
  })

  it('remove:true clears the torn edge', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'setLayerTornEdge', target: 'a', args: { patch: { amount: 20 } } }) as any).template
    const s2 = (applyCompositorCommand(s1, { op: 'setLayerTornEdge', target: 'a', args: { remove: true } }) as any).template
    expect(s2.layers[0].tornEdge).toBeUndefined()
  })

  it('errors on an unknown layer', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setLayerTornEdge', target: 'nope', args: { patch: {} } })
    expect(r.ok).toBe(false)
  })

  it('describeCompositor reports an active torn edge', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'setLayerTornEdge', target: 'a', args: { patch: { amount: 20 } } }) as any).template
    const snap = describeCompositor(s1)
    // The summary line reads the stack now and reports the human label, not the
    // raw field name (EFFECT_LABELS.torn_edge === 'Torn edge').
    expect(JSON.stringify(snap)).toContain('Torn edge')
  })
})

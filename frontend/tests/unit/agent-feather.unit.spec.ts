import { describe, it, expect } from 'vitest'
import { applyCompositorCommand, describeCompositor } from '~/lib/agent/surfaces/compositor'
import type { CompositorState } from '~/lib/agent/surfaces/compositor'
import { effectStackOf } from '~/lib/compositor/effectStack'

const baseState = (): CompositorState => ({
  layers: [{ id: 'a', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0 } as any],
})

describe('setLayerFeather', () => {
  it('sets a feather with clamped amount and defaults', () => {
    const r = applyCompositorCommand(baseState(), {
      op: 'setLayerFeather', target: 'a', args: { patch: { amount: 99, curve: 'smooth' } },
    })
    expect(r.ok).toBe(true)
    const layer = (r as any).template.layers[0]
    // Feather now lives in the layer's effect stack, not layer.feather (Task 4).
    const fx = effectStackOf(layer).find(e => e.type === 'feather') as any
    expect(fx.amount).toBe(1)     // clamped
    expect(fx.curve).toBe('smooth')
  })

  it('merges a partial patch over an existing feather', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'setLayerFeather', target: 'a', args: { patch: { amount: 0.2 } } }) as any).template
    const s2 = (applyCompositorCommand(s1, { op: 'setLayerFeather', target: 'a', args: { patch: { curve: 'linear' } } }) as any).template
    const fx = effectStackOf(s2.layers[0]).find((e: any) => e.type === 'feather') as any
    expect(fx.amount).toBe(0.2)
    expect(fx.curve).toBe('linear')
  })

  it('remove:true clears the feather', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'setLayerFeather', target: 'a', args: { patch: { amount: 0.2 } } }) as any).template
    const s2 = (applyCompositorCommand(s1, { op: 'setLayerFeather', target: 'a', args: { remove: true } }) as any).template
    expect(s2.layers[0].feather).toBeUndefined()
  })

  it('errors on an unknown layer', () => {
    const r = applyCompositorCommand(baseState(), { op: 'setLayerFeather', target: 'nope', args: { patch: {} } })
    expect(r.ok).toBe(false)
  })

  it('describeCompositor reports an active feather', () => {
    const s1 = (applyCompositorCommand(baseState(), { op: 'setLayerFeather', target: 'a', args: { patch: { amount: 0.2 } } }) as any).template
    const snap = describeCompositor(s1)
    // The summary line reads the stack now and reports the human label, not the
    // raw field name (EFFECT_LABELS.feather === 'Feather').
    expect(JSON.stringify(snap)).toContain('Feather')
  })
})

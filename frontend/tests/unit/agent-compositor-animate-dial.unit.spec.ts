import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyCompositorCommand, type CompositorState } from '~/lib/agent/surfaces/compositor'

const state = (): CompositorState => ({
  layers: [{
    id: 'L1', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3,
    fill: '#fff', stroke: '', strokeWidth: 0, radius: 0,
    effects: [
      { id: 'e-grain', type: 'grain', amount: 0.5, size: 3, visible: true },
      { id: 'e-duo', type: 'duotone', shadows: '#000000', highlights: '#ffffff', mix: 1, visible: true },
    ],
  } as any] as LocalLayer[],
})
const GRAIN = 'layers.L1.effects.e-grain.amount'

describe('animateDial authors timeline bands (motionx), not legacy dial tracks', () => {
  it('writes one two-point band and leaves motion.tracks alone', () => {
    const r = applyCompositorCommand(state(), { op: 'animateDial', target: 'L1', args: { effect: 'grain', dial: 'amount', from: 0, to: 0.9, start: 1, end: 3 } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.motion?.tracks ?? []).toEqual([])
    expect(r.template.motion?.motionx).toEqual([
      { path: GRAIN, type: 'number', keyframes: [{ t: 1, value: 0, ease: 'easeInOut' }, { t: 3, value: 0.9, ease: 'linear' }] },
    ])
  })
  it('re-animating the same dial replaces its band', () => {
    // applyCompositorCommand clones its input and returns a FRESH template rather than
    // mutating the state passed in — so the second call must be seeded from the first
    // call's result, not from the original `s`.
    const r1 = applyCompositorCommand(state(), { op: 'animateDial', target: 'L1', args: { effect: 'grain', dial: 'amount', from: 0, to: 0.9 } })
    expect(r1.ok).toBe(true); if (!r1.ok) return
    const r = applyCompositorCommand(r1.template, { op: 'animateDial', target: 'L1', args: { effect: 'grain', dial: 'amount', from: 0.2, to: 0.4 } })
    expect(r.ok).toBe(true); if (!r.ok) return
    const bands = (r.template.motion?.motionx ?? []).filter((t) => t.path === GRAIN)
    expect(bands).toHaveLength(1)
    expect(bands[0]!.keyframes.map((k) => k.value)).toEqual([0.2, 0.4])
  })
  it('a colour dial band mixes in oklch, like the old tracks did', () => {
    const r = applyCompositorCommand(state(), { op: 'animateDial', target: 'L1', args: { effect: 'duotone', dial: 'shadows', from: '#ff0000', to: '#0000ff' } })
    expect(r.ok).toBe(true); if (!r.ok) return
    expect(r.template.motion?.motionx?.[0]).toMatchObject({ path: 'layers.L1.effects.e-duo.shadows', type: 'color', space: 'oklch' })
  })
})

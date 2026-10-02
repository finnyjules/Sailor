import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyCompositorCommand, type CompositorState } from '~/lib/agent/surfaces/compositor'

// Frame light layers stage 4 — animateLight authors lighting bands the way animateDial authors
// effect-dial bands: one two-point motionx band per key, clamped through the light sanitizers.
const state = (): CompositorState => ({
  layers: [
    { id: 'R', kind: 'rect', x: 0.5, y: 0.5, rotation: 0, opacity: 1, w: 0.4, h: 0.3, fill: '#fff', stroke: '', strokeWidth: 0, radius: 0 },
    { id: 'L', kind: 'light', x: 0.2, y: 0.2, rotation: 0, opacity: 1, light: { type: 'spot', height: 0.8, color: '#fff1d6', brightness: 2.2, reach: 1.4, aimX: 0.5, aimY: 0.5, cone: 0.35, edge: 0.5 } },
  ] as unknown as LocalLayer[],
})
const run = (target: string, args: Record<string, unknown>) => applyCompositorCommand(state(), { op: 'animateLight', target, args })
const bandOf = (r: ReturnType<typeof run>) => { expect(r.ok).toBe(true); if (!r.ok) throw new Error(r.detail); return r.template.motion!.motionx! }

describe('animateLight', () => {
  it('a light dial: one two-point band on layers.<id>.light.<key>, clamped to the dial range', () => {
    expect(bandOf(run('L', { key: 'brightness', from: -1, to: 9, start: 1, end: 3 }))).toEqual([
      { path: 'layers.L.light.brightness', type: 'number', keyframes: [{ t: 1, value: 0, ease: 'easeInOut' }, { t: 3, value: 3, ease: 'linear' }] },
    ])
    expect(bandOf(run('L', { key: 'cone', from: 0, to: 1 }))[0]!.keyframes.map(k => k.value)).toEqual([0.1, 0.8])
    expect(bandOf(run('L', { key: 'reach', from: 0, to: 5 }))[0]!.keyframes.map(k => k.value)).toEqual([0.2, 2])
  })

  it('a light\'s colour lands as #rrggbb and blends in oklab (no space set)', () => {
    const [b] = bandOf(run('L', { key: 'color', from: '#FF0000', to: '#0000ff' }))
    expect(b).toMatchObject({ path: 'layers.L.light.color', type: 'color' })
    expect(b).not.toHaveProperty('space')
    expect(b!.keyframes.map(k => k.value)).toEqual(['#ff0000', '#0000ff'])
    expect(run('L', { key: 'color', from: 'red', to: '#0000ff' }).ok).toBe(false)
    expect(run('L', { key: 'color', from: 'rgba(0,0,0,1)', to: '#0000ff' }).ok).toBe(false)
  })

  it('a light\'s position: layers.<id>.x|y, clamped -0.5..1.5', () => {
    const [b] = bandOf(run('L', { key: 'x', from: -2, to: 0.9 }))
    expect(b!.path).toBe('layers.L.x')
    expect(b!.keyframes.map(k => k.value)).toEqual([-0.5, 0.9])
  })

  it('a layer\'s lift and the Frame\'s darkness', () => {
    const [lift] = bandOf(run('R', { key: 'lift', from: 0, to: 1 }))
    expect(lift!.path).toBe('layers.R.lift')
    expect(lift!.keyframes.map(k => k.value)).toEqual([0.005, 0.15])
    const [dark] = bandOf(run('frame', { key: 'darkness', from: 0.2, to: 1.4, ease: 'easeIn' }))
    expect(dark).toMatchObject({ path: 'frame.darkness', type: 'number' })
    expect(dark!.keyframes).toEqual([{ t: 0, value: 0.2, ease: 'easeIn' }, expect.objectContaining({ value: 1, ease: 'linear' })])
  })

  it('validates the key per target', () => {
    expect(run('frame', { key: 'brightness', from: 0, to: 1 }).ok).toBe(false)
    expect(run('L', { key: 'lift', from: 0, to: 0.1 }).ok).toBe(false)     // a light has no lift
    expect(run('L', { key: 'type', from: 0, to: 1 }).ok).toBe(false)       // enums are not animated
    expect(run('L', { key: 'edge', from: 0, to: 1 }).ok).toBe(false)       // edge is not animated
    expect(run('R', { key: 'brightness', from: 0, to: 1 }).ok).toBe(false) // not a light
    expect(run('nope', { key: 'lift', from: 0, to: 1 }).ok).toBe(false)
    expect(run('L', { key: 'height', from: 'low', to: 1 }).ok).toBe(false)
  })

  it('re-animating the same key replaces its band; the inverse restores the motion doc', () => {
    const r1 = run('frame', { key: 'darkness', from: 0, to: 1 })
    expect(r1.ok).toBe(true); if (!r1.ok) return
    const r2 = applyCompositorCommand(r1.template, { op: 'animateLight', target: 'frame', args: { key: 'darkness', from: 0.3, to: 0.6 } })
    expect(r2.ok).toBe(true); if (!r2.ok) return
    const bands = r2.template.motion!.motionx!.filter(t => t.path === 'frame.darkness')
    expect(bands).toHaveLength(1)
    expect(bands[0]!.keyframes.map(k => k.value)).toEqual([0.3, 0.6])
    const back = applyCompositorCommand(r1.template, r1.inverse)
    expect(back.ok && back.template.motion).toBeUndefined()
  })
})

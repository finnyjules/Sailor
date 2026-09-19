import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyResolvedValue, applyMotionxTracks, applyTextBehaviours, frameTarget, animatableProperties } from '~/lib/motionx/adapter/frame'
import type { GradientStop } from '~/lib/color/harmony'
import type { StoredBehaviour, Track } from '~/lib/motionx'

const grad = () => ({ type: 'linear' as const, angle: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ff0000' }] })
const layer = (over: Partial<any> = {}) => ({ id: 'L1', x: 0.5, y: 0.5, rotation: 0, scale: 1, opacity: 1, fill: grad(), effects: [], ...over } as unknown as LocalLayer)

describe('applyResolvedValue', () => {
  it('sets a transform/opacity number field on a clone', () => {
    const out = applyResolvedValue(layer(), 'opacity', 0.4)
    expect((out as any).opacity).toBe(0.4)
    expect(out).not.toBe(layer())
  })
  it('fill gradient value rebuilds the fill (offset shape, type/angle kept)', () => {
    const stops: GradientStop[] = [{ pos: 0, color: '#0000ff' }, { pos: 1, color: '#ffffff' }]
    const out = applyResolvedValue(layer(), 'fill', stops) as any
    expect(out.fill.type).toBe('linear'); expect(out.fill.stops[0]).toHaveProperty('offset')
  })
  it('fill.phase scrolls the gradient stops', () => {
    const out = applyResolvedValue(layer(), 'fill.phase', 0.25) as any
    expect(out.fill.stops.length).toBeGreaterThan(2) // scrolled wheel resample
  })
  it('unknown prop returns the input unchanged', () => {
    const l = layer(); expect(applyResolvedValue(l, 'nope', 1)).toBe(l)
  })
})

describe('applyMotionxTracks', () => {
  const opacityTrack: Track = { path: 'layers.L1.opacity', type: 'number', keyframes: [
    { t: 0, value: 0, ease: 'linear' }, { t: 1, value: 1, ease: 'linear' } ] }
  it('same reference when idle', () => {
    const arr = [layer()]
    expect(applyMotionxTracks(arr, undefined, 0)).toBe(arr)
    expect(applyMotionxTracks(arr, [], 0)).toBe(arr)
  })
  it('applies a resolved value onto the targeted layer', () => {
    const out = applyMotionxTracks([layer()], [opacityTrack], 0.5)
    expect((out[0] as any).opacity).toBeCloseTo(0.5, 6)
  })
  it('leaves non-targeted layers by identity', () => {
    const other = layer({ id: 'L2' })
    const out = applyMotionxTracks([layer(), other], [opacityTrack], 0.5)
    expect(out[1]).toBe(other)
  })
})

describe('frameTarget + animatableProperties', () => {
  it('target reads current values', () => {
    const tg = frameTarget(layer({ opacity: 0.7 }))
    expect(tg.get('opacity')).toBe(0.7)
    expect(Array.isArray(tg.get('fill'))).toBe(true) // gradient -> {pos,color}[]
    expect(tg.get('nope')).toBeUndefined()
  })
  it('enumerates transform + fill properties for a gradient-filled layer', () => {
    const paths = animatableProperties(layer()).map(p => p.path)
    expect(paths).toContain('layers.L1.opacity')
    expect(paths).toContain('layers.L1.fill')
    expect(paths).toContain('layers.L1.fill.phase')
  })
  it('tags every property with a group (Transform / Fill / Effects)', () => {
    const props = animatableProperties(layer())
    expect(props.find(p => p.path === 'layers.L1.x')!.group).toBe('Transform')
    expect(props.find(p => p.path === 'layers.L1.fill')!.group).toBe('Fill')
    expect(props.every(p => ['Transform', 'Fill', 'Effects'].includes(p.group))).toBe(true)
  })
  it('enumerates every number/colour/gradient effect dial, with range, skipping enum/bool dials', () => {
    const l = layer({ effects: [{ id: 'fx1', type: 'bloom', threshold: 0.5, radius: 0.1, intensity: 1 }] })
    const props = animatableProperties(l)
    const intensity = props.find(p => p.path === 'layers.L1.effects.fx1.intensity')!
    expect(intensity).toMatchObject({ type: 'number', group: 'Effects', min: 0, max: 2 })
    expect(intensity.label).toMatch(/Bloom .* Intensity/i)
    expect(props.filter(p => p.group === 'Effects')).toHaveLength(3)   // threshold, radius, intensity
  })
})

describe('Add property → effect dial band drives the render fold', () => {
  it('a seeded Bloom·intensity band, edited, changes the effect dial at t', async () => {
    const { seedHoldTrack, setPointValue } = await import('~/lib/motionx/bandEdit')
    const l = layer({ effects: [{ id: 'fx1', type: 'bloom', threshold: 0.5, radius: 0.1, intensity: 1 }] })
    const path = 'layers.L1.effects.fx1.intensity'
    const hold = seedHoldTrack(path, 'number', 1, 4)
    // flat hold: byte-identical effect value at any t
    expect((applyMotionxTracks([l], [hold], 2)[0] as any).effects[0].intensity).toBe(1)
    // edit the end point → ramps 1 → 0 across the band
    const ramp = setPointValue(hold, 1, 0)
    expect((applyMotionxTracks([l], [ramp], 4)[0] as any).effects[0].intensity).toBe(0)
    expect((applyMotionxTracks([l], [ramp], 2)[0] as any).effects[0].intensity).toBeCloseTo(0.5, 6)
  })
})

describe('scale on every layer kind', () => {
  it('a layer with a native scale field still gets `scale`', () => {
    const l = layer({ kind: 'path', scale: 2 })
    expect((applyResolvedValue(l, 'scale', 3) as any).scale).toBe(3)
    expect((applyResolvedValue(l, 'scale', 3) as any).motionScale).toBeUndefined()
  })
  it('a layer without one gets the transient motionScale and keeps no `scale` key', () => {
    const { scale: _drop, ...rect } = layer({ kind: 'rect', w: 0.3, h: 0.2 }) as any
    const out = applyResolvedValue(rect, 'scale', 1.5) as any
    expect(out.motionScale).toBe(1.5)
    expect('scale' in out).toBe(false)
  })
  it('behaviours read a base scale of 1 on such layers', () => {
    const { scale: _drop, ...rect } = layer({ kind: 'rect', w: 0.3, h: 0.2 }) as any
    expect(frameTarget(rect).get('scale')).toBe(1)
  })
})

// ── letter behaviours: the fold that hands the painter a per-frame `textMotion` ──
//
// Same contract as `motionScale`: CLONES only, never persisted, and the SAME array
// reference back whenever there is nothing to attach — which is what keeps a frame
// with no letter behaviour byte-identical.

describe('applyTextBehaviours', () => {
  const text = (id: string, over: Partial<any> = {}) =>
    ({ id, kind: 'text', x: 0.5, y: 0.5, rotation: 0, opacity: 1, text: 'AB', ...over } as unknown as LocalLayer)
  const cascade = (layerId: string, over: Partial<StoredBehaviour> = {}): StoredBehaviour => ({
    id: `b-${layerId}`, layerId, kind: 'text.cascade', timing: { start: 0, duration: 1 }, params: {}, ...over,
  })
  const slide = (layerId: string): StoredBehaviour =>
    ({ id: `s-${layerId}`, layerId, kind: 'text.maskSlide', timing: { start: 0, duration: 1 } })
  // A non-text behaviour on the same layer — compiled to motionx tracks elsewhere, and
  // never part of the letter payload.
  const nudge = (layerId: string): StoredBehaviour =>
    ({ id: `n-${layerId}`, layerId, kind: 'fadeIn', timing: { start: 0, duration: 1 } })

  it('same reference when there is no clock', () => {
    const arr = [text('L1')]
    expect(applyTextBehaviours(arr, [cascade('L1')], undefined)).toBe(arr)
  })

  it('same reference with no behaviours at all', () => {
    const arr = [text('L1')]
    expect(applyTextBehaviours(arr, undefined, 0.5)).toBe(arr)
    expect(applyTextBehaviours(arr, [], 0.5)).toBe(arr)
  })

  it('same reference when no behaviour is a text.* one', () => {
    const arr = [text('L1')]
    expect(applyTextBehaviours(arr, [nudge('L1')], 0.5)).toBe(arr)
  })

  it('same reference when the targeted layer is not in the list', () => {
    const arr = [text('L1')]
    expect(applyTextBehaviours(arr, [cascade('nope')], 0.5)).toBe(arr)
  })

  it('clones ONLY the targeted text layer and attaches the clock', () => {
    const a = text('L1'), b = text('L2')
    const out = applyTextBehaviours([a, b], [cascade('L1')], 0.25)
    expect(out).not.toBe([a, b])
    expect(out[1]).toBe(b)                                    // untargeted: by identity
    expect(out[0]).not.toBe(a)
    expect((out[0] as any).textMotion.t).toBe(0.25)
    expect((a as any).textMotion).toBeUndefined()             // never mutates the input
  })

  it('a NON-text layer targeted by a text.* behaviour is left alone', () => {
    const rect = layer({ id: 'R1', kind: 'rect', w: 0.3, h: 0.2 })
    const arr = [rect]
    expect(applyTextBehaviours(arr, [cascade('R1')], 0.5)).toBe(arr)
  })

  it("the clone carries only that layer's own text.* behaviours", () => {
    const out = applyTextBehaviours(
      [text('L1'), text('L2')],
      [cascade('L1'), nudge('L1'), slide('L1'), cascade('L2')],
      0.5,
    )
    const own = (out[0] as any).textMotion.behaviours as StoredBehaviour[]
    expect(own.map(b => b.id)).toEqual(['b-L1', 's-L1'])       // no 'n-L1', no 'b-L2'
    expect((out[1] as any).textMotion.behaviours.map((b: StoredBehaviour) => b.id)).toEqual(['b-L2'])
  })
})

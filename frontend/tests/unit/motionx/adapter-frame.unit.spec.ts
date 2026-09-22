import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyResolvedValue, applyMotionxTracks, applyTextBehaviours, frameTarget, animatableProperties, CLONER_PROPERTIES } from '~/lib/motionx/adapter/frame'
import { DEFAULT_CLONER, expandClones, type Cloner } from '~/composables/useCloner'
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

  // `textMotion` excludes a layer from the silhouette raster cache and sends every draw down
  // the per-glyph path, so it must only be attached while a bar can actually move a letter —
  // not for the whole clip because an entrance played once at the start.
  it('same reference once every bar on that layer has finished (an entrance)', () => {
    const arr = [text('L1')]
    expect(applyTextBehaviours(arr, [cascade('L1')], 5)).toBe(arr)      // bar is 0 → 1
  })

  it('STILL clones after a finished exit — hidden is not at rest', () => {
    const out = applyTextBehaviours([text('L1')], [cascade('L1', { params: { dir: 'out', style: 'fade' } })], 5)
    expect((out[0] as any).textMotion.t).toBe(5)
  })

  it('a layer whose own bars are done is left alone while another layer still moves', () => {
    const a = text('L1'), b = text('L2')
    const out = applyTextBehaviours([a, b], [cascade('L1'), cascade('L2', { timing: { start: 4, duration: 1 } })], 4.5)
    expect(out[0]).toBe(a)
    expect((out[1] as any).textMotion.t).toBe(4.5)
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

// ── Cloner dials as motion properties: 'Copies' group ──
//
// A layer's `cloner` config isn't a Frame property in the usual sense — it never has
// its own x/y/opacity — but each enabled dial (Count, Spacing, Radius…) is itself
// animatable, at path `layers.<id>.cloner.<key>`. No cloner (or a disabled one) offers
// nothing; a linear cloner offers the linear + 'both' keys, a radial one the radial +
// 'both' keys — never the other mode's keys.

describe('Cloner dials in animatableProperties (Copies group)', () => {
  const cloner = (over: Partial<Cloner> = {}): Cloner => ({ ...DEFAULT_CLONER, enabled: true, ...over })

  it('no Copies entries without an enabled cloner', () => {
    expect(animatableProperties(layer()).some(p => p.group === 'Copies')).toBe(false)
    const disabled = layer({ cloner: cloner({ enabled: false }) })
    expect(animatableProperties(disabled).some(p => p.group === 'Copies')).toBe(false)
  })

  it('a linear cloner lists exactly the linear + both keys, group Copies, after Effects', () => {
    const l = layer({
      effects: [{ id: 'fx1', type: 'bloom', threshold: 0.5, radius: 0.1, intensity: 1 }],
      cloner: cloner({ mode: 'linear' }),
    })
    const props = animatableProperties(l)
    const copies = props.filter(p => p.group === 'Copies')
    const expectedKeys = CLONER_PROPERTIES.filter(p => p.mode === 'linear' || p.mode === 'both').map(p => p.key)
    expect(copies.map(p => p.path)).toEqual(expectedKeys.map(k => `layers.L1.cloner.${k}`))
    for (const p of copies) {
      const spec = CLONER_PROPERTIES.find(s => `layers.L1.cloner.${s.key}` === p.path)!
      expect(p.label).toBe(spec.label)
      expect(p.min).toBe(spec.min)
      expect(p.max).toBe(spec.max)
      expect(p.type).toBe('number')
    }
    // radial-only keys must not appear
    expect(copies.some(p => p.path === 'layers.L1.cloner.count')).toBe(false)
    expect(copies.some(p => p.path === 'layers.L1.cloner.radius')).toBe(false)
    // after the Effects entries
    const lastEffectsIdx = props.map(p => p.group).lastIndexOf('Effects')
    const firstCopiesIdx = props.map(p => p.group).indexOf('Copies')
    expect(firstCopiesIdx).toBeGreaterThan(lastEffectsIdx)
  })

  it('a radial cloner lists exactly the radial + both keys', () => {
    const l = layer({ cloner: cloner({ mode: 'radial' }) })
    const props = animatableProperties(l)
    const copies = props.filter(p => p.group === 'Copies')
    const expectedKeys = CLONER_PROPERTIES.filter(p => p.mode === 'radial' || p.mode === 'both').map(p => p.key)
    expect(copies.map(p => p.path)).toEqual(expectedKeys.map(k => `layers.L1.cloner.${k}`))
    expect(copies.some(p => p.path === 'layers.L1.cloner.countX')).toBe(false)
    expect(copies.some(p => p.path === 'layers.L1.cloner.spacingX')).toBe(false)
  })
})

describe('applyResolvedValue for cloner.<key>', () => {
  it('returns a NEW layer with cloner.<key> set, original untouched', () => {
    const l = layer({ cloner: { ...DEFAULT_CLONER, enabled: true, count: 6 } })
    const out = applyResolvedValue(l, 'cloner.count', 4) as any
    expect(out).not.toBe(l)
    expect(out.cloner.count).toBe(4)
    expect((l as any).cloner.count).toBe(6)
  })

  it('a layer without a cloner returns the same reference', () => {
    const l = layer()
    expect(applyResolvedValue(l, 'cloner.count', 4)).toBe(l)
  })
})

describe('frameTarget for cloner.<key>', () => {
  it('reads the value and reports has() true', () => {
    const l = layer({ cloner: { ...DEFAULT_CLONER, enabled: true, radius: 0.42 } })
    const tg = frameTarget(l)
    expect(tg.get('cloner.radius')).toBe(0.42)
    expect(tg.has('cloner.radius')).toBe(true)
  })

  it('without a cloner: undefined / false', () => {
    const tg = frameTarget(layer())
    expect(tg.get('cloner.radius')).toBeUndefined()
    expect(tg.has('cloner.radius')).toBe(false)
  })
})

describe('applyMotionxTracks folds a cloner.count band into expandClones', () => {
  it('count ramps 1 → 6 over 0–1s: 3 copies at t=0.5 (floor(3.5)), 6 at t=1', () => {
    const l = layer({ cloner: { ...DEFAULT_CLONER, enabled: true, mode: 'radial' as const, count: 1 } })
    const track: Track = {
      path: 'layers.L1.cloner.count', type: 'number',
      keyframes: [{ t: 0, value: 1, ease: 'linear' }, { t: 1, value: 6, ease: 'linear' }],
    }
    const mid = applyMotionxTracks([l], [track], 0.5)[0] as any
    expect(expandClones(mid.cloner, 1)).toHaveLength(3)
    const end = applyMotionxTracks([l], [track], 1)[0] as any
    expect(expandClones(end.cloner, 1)).toHaveLength(6)
  })
})

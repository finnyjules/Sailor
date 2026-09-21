import { describe, it, expect } from 'vitest'
import {
  trackSpan, bandsForLayer, numberBandCurve, colorBandCss, gradientBandCss, behaviourLabel,
} from '~/lib/motionx/bands'
import type { Track } from '~/lib/motionx'

const num = (path: string, ks: Array<[number, number]>): Track => ({
  path, type: 'number', keyframes: ks.map(([t, value]) => ({ t, value, ease: 'linear' })),
})

describe('trackSpan', () => {
  it('returns min/max keyframe t', () => {
    expect(trackSpan(num('layers.a.opacity', [[0.5, 0], [2, 1], [1, 0.5]]))).toEqual({ start: 0.5, end: 2 })
  })
  it('start == end for a single keyframe', () => {
    expect(trackSpan(num('layers.a.opacity', [[1.2, 1]]))).toEqual({ start: 1.2, end: 1.2 })
  })
  it('empty track spans 0..0', () => {
    expect(trackSpan({ path: 'layers.a.x', type: 'number', keyframes: [] })).toEqual({ start: 0, end: 0 })
  })
})

describe('bandsForLayer', () => {
  const tracks: Track[] = [
    num('layers.a.opacity', [[0, 0], [1, 1]]),
    num('layers.b.x', [[0, 0], [2, 100]]),          // other layer — excluded
    {
      path: 'layers.a.fill', type: 'gradient', keyframes: [
        { t: 0, value: [{ pos: 0, color: '#000' }], ease: 'linear' },
        { t: 3, value: [{ pos: 0, color: '#fff' }], ease: 'linear' },
      ],
    },
  ]
  it('includes only this layer\'s tracks, as bands with span + type', () => {
    const bands = bandsForLayer('a', tracks)
    expect(bands.map((b) => b.path)).toEqual(['layers.a.opacity', 'layers.a.fill'])
    expect(bands[0]).toMatchObject({ kind: 'number', type: 'number', start: 0, end: 1, key: 'layers.a.opacity' })
    expect(bands[1]).toMatchObject({ kind: 'gradient', start: 0, end: 3 })
  })
  it('uses labelFor for the human label, falling back to the last path segment', () => {
    const bands = bandsForLayer('a', tracks, (p) => (p.endsWith('opacity') ? 'Opacity' : ''))
    expect(bands[0].label).toBe('Opacity')
    expect(bands[1].label).toBe('fill')
  })
})

describe('numberBandCurve', () => {
  const t = {
    path: 'layers.a.opacity', type: 'number' as const, keyframes: [
      { t: 0, value: 0, ease: 'linear' as const }, { t: 2, value: 10, ease: 'linear' as const },
    ],
  }
  it('samples x across 0..1 and y normalised 0..1 against value min/max', () => {
    const pts = numberBandCurve(t, 3)
    expect(pts).toHaveLength(3)
    expect(pts[0]).toEqual({ x: 0, y: 0 })       // min value → 0
    expect(pts[2]).toEqual({ x: 1, y: 1 })       // max value → 1
    expect(pts[1].x).toBeCloseTo(0.5, 5)
    expect(pts[1].y).toBeCloseTo(0.5, 5)
  })
  it('flat track → y all 0.5 (no divide-by-zero)', () => {
    const flat = {
      path: 'layers.a.x', type: 'number' as const, keyframes: [
        { t: 0, value: 5, ease: 'linear' as const }, { t: 1, value: 5, ease: 'linear' as const }],
    }
    expect(numberBandCurve(flat, 2).every((p) => p.y === 0.5)).toBe(true)
  })
  it('a steps ease is oversampled past the default request, so the stairs actually show', () => {
    const stepsTrack = {
      path: 'layers.a.opacity', type: 'number' as const, keyframes: [
        { t: 0, value: 0, ease: { type: 'steps', count: 24 } as never },
        { t: 1, value: 1, ease: 'linear' as const },
      ],
    }
    const pts = numberBandCurve(stepsTrack)   // default samples=24 — far too coarse for 24 jumps
    expect(pts.length).toBeGreaterThan(24)
    const distinctY = new Set(pts.map((p) => +p.y.toFixed(6)))
    expect(distinctY.size).toBeGreaterThanOrEqual(20)   // most of the 24 plateaus show up
  })
})

describe('colorBandCss', () => {
  it('is a linear-gradient across the keyframe colours by fractional t', () => {
    const css = colorBandCss({
      path: 'layers.a.fill', type: 'color', keyframes: [
        { t: 0, value: '#ff0000', ease: 'linear' }, { t: 4, value: '#0000ff', ease: 'linear' }],
    })
    expect(css).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff 100%)')
  })
})

describe('gradientBandCss', () => {
  it('renders the first gradient keyframe stops as a 90deg gradient', () => {
    const css = gradientBandCss({
      path: 'layers.a.fill', type: 'gradient', keyframes: [
        { t: 0, value: [{ pos: 0, color: '#000' }, { pos: 1, color: '#fff' }], ease: 'linear' }],
    })
    expect(css).toBe('linear-gradient(90deg, #000 0%, #fff 100%)')
  })
  it('empty → transparent', () => {
    expect(gradientBandCss({ path: 'layers.a.fill', type: 'gradient', keyframes: [] })).toBe('transparent')
  })
})

describe('behaviourLabel — letter behaviours', () => {
  it('Cascade in / Cascade out by dir', () => {
    expect(behaviourLabel({ kind: 'text.cascade', params: { dir: 'in' } })).toBe('Cascade in')
    expect(behaviourLabel({ kind: 'text.cascade', params: { dir: 'out' } })).toBe('Cascade out')
  })
  it('Typewriter / Typewriter delete by dir', () => {
    expect(behaviourLabel({ kind: 'text.typewriter', params: { dir: 'type' } })).toBe('Typewriter')
    expect(behaviourLabel({ kind: 'text.typewriter', params: { dir: 'delete' } })).toBe('Typewriter delete')
  })
  it('Mask slide / Mask slide out by dir', () => {
    expect(behaviourLabel({ kind: 'text.maskSlide', params: { dir: 'reveal' } })).toBe('Mask slide')
    expect(behaviourLabel({ kind: 'text.maskSlide', params: { dir: 'hide' } })).toBe('Mask slide out')
  })
  it('Scramble + mode suffix', () => {
    expect(behaviourLabel({ kind: 'text.scramble', params: { mode: 'settle' } })).toBe('Scramble · settle')
    expect(behaviourLabel({ kind: 'text.scramble', params: { mode: 'scatter' } })).toBe('Scramble · scatter')
    expect(behaviourLabel({ kind: 'text.scramble', params: { mode: 'loop' } })).toBe('Scramble · keep going')
  })
  it('Decode / Decode out by dir', () => {
    expect(behaviourLabel({ kind: 'text.decode', params: { dir: 'resolve' } })).toBe('Decode')
    expect(behaviourLabel({ kind: 'text.decode', params: { dir: 'dissolve' } })).toBe('Decode out')
    expect(behaviourLabel({ kind: 'text.decode', params: {} })).toBe('Decode')
  })
  it('Slot slide / Slot slide out by dir', () => {
    expect(behaviourLabel({ kind: 'text.slot', params: { dir: 'in' } })).toBe('Slot slide')
    expect(behaviourLabel({ kind: 'text.slot', params: { dir: 'out' } })).toBe('Slot slide out')
    expect(behaviourLabel({ kind: 'text.slot', params: {} })).toBe('Slot slide')
  })
  it('Wave, Bounce, Jitter — no dir variant', () => {
    expect(behaviourLabel({ kind: 'text.wave', params: {} })).toBe('Wave')
    expect(behaviourLabel({ kind: 'text.bounce', params: {} })).toBe('Bounce')
    expect(behaviourLabel({ kind: 'text.jitter', params: {} })).toBe('Jitter')
  })
  it('labels a dither bar by its direction', () => {
    expect(behaviourLabel({ kind: 'dither', params: {} })).toBe('Dither in')
    expect(behaviourLabel({ kind: 'dither', params: { dir: 'out' } })).toBe('Dither out')
  })
  it('labels an Assemble-style dither bar "Assemble in" / "Assemble out"', () => {
    expect(behaviourLabel({ kind: 'dither', params: { style: 'assemble' } })).toBe('Assemble in')
    expect(behaviourLabel({ kind: 'dither', params: { style: 'assemble', dir: 'out' } })).toBe('Assemble out')
    // a non-assemble style keeps the plain Dither label
    expect(behaviourLabel({ kind: 'dither', params: { style: 'wipe', dir: 'out' } })).toBe('Dither out')
  })

  it('labels a settle bar "<Label> in" / "<Label> out", read through settleParams', () => {
    expect(behaviourLabel({ kind: 'settle', params: {} })).toBe('Slice in')   // default effect + dir
    expect(behaviourLabel({ kind: 'settle', params: { effect: 'slice' } })).toBe('Slice in')
    expect(behaviourLabel({ kind: 'settle', params: { effect: 'slice', dir: 'out' } })).toBe('Slice out')
    expect(behaviourLabel({ kind: 'settle', params: { effect: 'split', dir: 'out' } })).toBe('Colour split out')
    expect(behaviourLabel({ kind: 'settle', params: { effect: 'zoomblur' } })).toBe('Zoom blur in')
    expect(behaviourLabel({ kind: 'settle', params: { effect: 'not-real', dir: 'out' } })).toBe('Slice out')   // unknown → default
  })
})

describe('bands carry the loop flag', () => {
  it('property bands from track.loop; behaviour bands from their compiled track', async () => {
    const { bandsForLayer, behaviourBandsForLayer } = await import('~/lib/motionx/bands')
    const kf = [{ t: 0, value: 0, ease: 'linear' as const }, { t: 1, value: 1, ease: 'linear' as const }]
    const tracks = [
      { path: 'layers.a.x', type: 'number' as const, keyframes: kf, loop: true },
      { path: 'layers.a.y', type: 'number' as const, keyframes: kf },
      { path: 'layers.a.rotation', type: 'number' as const, keyframes: kf, loop: true, behaviourId: 'b1' },
    ]
    const props = bandsForLayer('a', tracks)
    expect(props.find((b) => b.path === 'layers.a.x')!.loop).toBe(true)
    expect(props.find((b) => b.path === 'layers.a.y')!.loop ?? false).toBe(false)
    const beh = behaviourBandsForLayer('a', [{ id: 'b1', layerId: 'a', kind: 'spin', params: {}, timing: { start: 0, duration: 1 } } as never], tracks)
    expect(beh[0]!.loop).toBe(true)
  })
})

describe('legacyBandForLayer — an older In/Loop/Out animation, shown as one locked bar', () => {
  it('no animation → null', async () => {
    const { legacyBandForLayer } = await import('~/lib/motionx/bands')
    expect(legacyBandForLayer({ id: 'a' }, 4)).toBeNull()
    expect(legacyBandForLayer({ id: 'a', animation: { offset: 0 } }, 4)).toBeNull()   // empty shell
  })
  it('spans the layer window and names its presets in plain words', async () => {
    const { legacyBandForLayer } = await import('~/lib/motionx/bands')
    const b = legacyBandForLayer({ id: 'a', animation: { offset: 0.5, duration: 2, in: { presetId: 'fade-in' }, loop: { presetId: 'float' } } }, 4)!
    expect(b).toMatchObject({ key: 'legacy:a', kind: 'legacy', start: 0.5, end: 2.5, label: 'Older animation · Fade in, Float' })
  })
  it('no duration → runs to the end of the timeline; never past it', async () => {
    const { legacyBandForLayer } = await import('~/lib/motionx/bands')
    expect(legacyBandForLayer({ id: 'a', animation: { offset: 1, out: { presetId: 'fade-out' } } }, 4)!.end).toBe(4)
    expect(legacyBandForLayer({ id: 'a', animation: { offset: 3, duration: 9, in: { presetId: 'grow-in' } } }, 4)!.end).toBe(4)
  })
  it('keyframes-only animations still get a bar', async () => {
    const { legacyBandForLayer } = await import('~/lib/motionx/bands')
    expect(legacyBandForLayer({ id: 'a', animation: { offset: 0, keyframes: [{ t: 0 }, { t: 1 }] } }, 4)!.label).toBe('Older animation · Keyframes')
  })
})

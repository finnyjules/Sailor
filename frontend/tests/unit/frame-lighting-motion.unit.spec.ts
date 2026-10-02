import { describe, it, expect } from 'vitest'
import type { LocalLayer } from '~/composables/useCompositorLayers'
import { applyLightValue, applyLightingTracks, isLightBandPath, LIGHT_MOTION_KEYS } from '~/lib/frame/lighting/motion'
import { newLightLayer, DEFAULT_LIGHTING, type LightLayer } from '~/lib/frame/lighting/settings'
import type { Track } from '~/lib/motionx'

const lamp = () => newLightLayer('lamp') as unknown as LocalLayer
const text = () => ({ id: 't', kind: 'text', text: 'Hi', x: 0.5, y: 0.5, rotation: 0, opacity: 1 } as unknown as LocalLayer)
const lightOf = (l: LocalLayer) => (l as unknown as LightLayer).light
const band = (path: string, a: number, b: number, extra: Partial<Track> = {}): Track =>
  ({ path, type: 'number', keyframes: [{ t: 0, value: a, ease: 'linear' }, { t: 1, value: b, ease: 'linear' }], ...extra })

describe('applyLightValue', () => {
  const ranges: Record<string, [number, number]> = {
    height: [0, 1], brightness: [0, 3], reach: [0.2, 2], aimX: [-0.5, 1.5], aimY: [-0.5, 1.5], cone: [0.1, 0.8],
  }
  for (const [key, [lo, hi]] of Object.entries(ranges)) {
    it(`light.${key} applies and clamps to ${lo}..${hi}`, () => {
      const l = lamp()
      const mid = (lo + hi) / 2
      const out = applyLightValue(l, `light.${key}`, mid)
      expect(out).not.toBe(l)
      expect((lightOf(out) as any)[key]).toBeCloseTo(mid, 10)
      expect((lightOf(applyLightValue(l, `light.${key}`, hi + 5)) as any)[key]).toBe(hi)
      expect((lightOf(applyLightValue(l, `light.${key}`, lo - 5)) as any)[key]).toBe(lo)
      // The rest of the light is untouched; the stored layer is not mutated.
      expect(lightOf(out).type).toBe('lamp')
      expect(lightOf(l)).toEqual(lightOf(lamp()))
    })
  }

  it('every motion key is covered (edge and type are not animated)', () => {
    expect([...LIGHT_MOTION_KEYS].sort()).toEqual(['aimX', 'aimY', 'brightness', 'color', 'cone', 'height', 'reach'])
    const l = lamp()
    expect(applyLightValue(l, 'light.edge', 0.1)).toBe(l)
    expect(applyLightValue(l, 'light.type', 'spot' as any)).toBe(l)
  })

  it('colour lands only as #rrggbb', () => {
    const l = lamp()
    expect(lightOf(applyLightValue(l, 'light.color', '#3366FF')).color).toBe('#3366ff')
    expect(applyLightValue(l, 'light.color', 'red')).toBe(l)
    expect(applyLightValue(l, 'light.color', '#fff')).toBe(l)
    expect(applyLightValue(l, 'light.color', 0.5)).toBe(l)
    expect(applyLightValue(l, 'light.height', '#ffffff')).toBe(l)
    expect(applyLightValue(l, 'light.height', Number.NaN)).toBe(l)
  })

  it('lift applies and clamps on a non-light layer; ignored on a light', () => {
    const t = text()
    expect((applyLightValue(t, 'lift', 0.08) as any).lift).toBe(0.08)
    expect((applyLightValue(t, 'lift', 1) as any).lift).toBe(0.15)
    expect((applyLightValue(t, 'lift', 0) as any).lift).toBe(0.005)
    expect(applyLightValue(t, 'lift', '#ffffff')).toBe(t)
    const l = lamp()
    expect(applyLightValue(l, 'lift', 0.08)).toBe(l)
  })

  it('light keys are ignored on a text; unknown props ⇒ same ref', () => {
    const t = text()
    expect(applyLightValue(t, 'light.brightness', 2)).toBe(t)
    expect(applyLightValue(t, 'nope', 2)).toBe(t)
  })
})

describe('applyLightingTracks', () => {
  const lighting = { darkness: 0.3, backgroundLit: false }
  it('idle ⇒ the same ref', () => {
    expect(applyLightingTracks(lighting, undefined, 0.5)).toBe(lighting)
    expect(applyLightingTracks(lighting, [], 0.5)).toBe(lighting)
    expect(applyLightingTracks(lighting, [band('frame.darkness', 0, 1)], undefined)).toBe(lighting)
    expect(applyLightingTracks(undefined, [band('layers.a.opacity', 0, 1)], 0.5)).toBeUndefined()
    expect(applyLightingTracks(lighting, [band('layers.a.light.height', 0, 1)], 0.5)).toBe(lighting)
  })
  it('a Darkness band sets the mid-band value, keeping the rest of the record', () => {
    const out = applyLightingTracks(lighting, [band('frame.darkness', 0, 1)], 0.5)!
    expect(out).not.toBe(lighting)
    expect(out.darkness).toBeCloseTo(0.5, 10)
    expect(out.backgroundLit).toBe(false)
    expect(lighting.darkness).toBe(0.3)
  })
  it('clamps 0..1; no record ⇒ the defaults with the band\'s Darkness', () => {
    expect(applyLightingTracks(lighting, [band('frame.darkness', 2, 3)], 0.5)!.darkness).toBe(1)
    expect(applyLightingTracks(lighting, [band('frame.darkness', -2, -1)], 0.5)!.darkness).toBe(0)
    expect(applyLightingTracks(undefined, [band('frame.darkness', 0, 1)], 0.25)).toEqual({ ...DEFAULT_LIGHTING, darkness: 0.25 })
  })
  it('a muted band is ignored', () => {
    expect(applyLightingTracks(lighting, [band('frame.darkness', 0, 1, { muted: true })], 0.5)).toBe(lighting)
  })
})

describe('isLightBandPath', () => {
  it('light dials, Lift and Darkness only', () => {
    for (const p of ['layers.a.light.height', 'layers.a.light.color', 'layers.a.lift', 'frame.darkness']) expect(isLightBandPath(p)).toBe(true)
    for (const p of ['layers.a.x', 'layers.a.light', 'layers.a.light.x.y', 'frame.backgroundLit', 'layers.a.effects.e.lift']) expect(isLightBandPath(p)).toBe(false)
  })
})

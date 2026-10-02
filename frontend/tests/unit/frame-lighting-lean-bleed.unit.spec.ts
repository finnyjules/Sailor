import { describe, it, expect, vi, beforeEach } from 'vitest'

// Final review I3: the web export's per-paint bleed under a Darkness band, and the lean stub's
// routing-miss reports.
const reported = vi.hoisted(() => [] as string[])
vi.mock('~/lib/embed/frame/leanStub.embed', () => ({ leanFeatureUsed: (f: string) => { reported.push(f) } }))

import * as lean from '~/lib/embed/frame/lightMotionLean.embed'
import * as full from '~/lib/frame/lighting/motion'
import { bleedAmbientAlpha, bleedDarknessAt } from '~/lib/embed/frame/bleed'
import type { Track } from '~/lib/motionx'

const darkBand = (muted = false): Track => ({
  path: 'frame.darkness', type: 'number', ...(muted ? { muted: true } : {}),
  keyframes: [{ t: 0, value: 0, ease: 'linear' }, { t: 4, value: 1, ease: 'linear' }],
} as Track)

describe('the lean stand-in for lighting/motion', () => {
  beforeEach(() => { reported.length = 0 })

  it('reports Animated lights for a Lift or a light dial, and changes nothing', () => {
    const layer = { id: 'a' }
    expect(lean.applyLightValue(layer, 'lift', 0.1)).toBe(layer)
    expect(lean.applyLightValue(layer, 'light.brightness', 2)).toBe(layer)
    expect(reported).toEqual(['Animated lights', 'Animated lights'])
  })
  it('stays silent for a property that is not a light one', () => {
    lean.applyLightValue({ id: 'a' }, 'opacity', 0.5)
    lean.applyLightingTracks({ darkness: 0.4 }, [{ path: 'layers.a.x' }], 1)
    lean.applyLightingTracks({ darkness: 0.4 }, undefined, 1)
    expect(reported).toEqual([])
  })
  it('reports a live Darkness band, not a muted one', () => {
    const lighting = { darkness: 0.4 }
    expect(lean.applyLightingTracks(lighting, [darkBand(true)], 1)).toBe(lighting)
    expect(reported).toEqual([])
    expect(lean.applyLightingTracks(lighting, [darkBand()], 1)).toBe(lighting)
    expect(reported).toEqual(['Animated lights'])
  })
  it('shares the full module\'s band paths (one definition)', () => {
    expect(lean.isLightBandPath).toBe(full.isLightBandPath)
    expect(lean.DARKNESS_PATH).toBe(full.DARKNESS_PATH)
    expect(lean.LIGHT_MOTION_KEYS).toBe(full.LIGHT_MOTION_KEYS)
  })
})

describe('the export bleed follows a Darkness band per paint', () => {
  const base = { hasVisibleLight: true, lighting: { darkness: 0.3, backgroundLit: true }, available: () => true }
  it('moves with the band: t = 0 and the end differ, each at the band\'s own Darkness', () => {
    const at0 = bleedDarknessAt({ ...base, motionx: [darkBand()], tSec: 0 })
    const at2 = bleedDarknessAt({ ...base, motionx: [darkBand()], tSec: 2 })
    const at4 = bleedDarknessAt({ ...base, motionx: [darkBand()], tSec: 4 })
    expect(at0).toBeCloseTo(bleedAmbientAlpha(0), 10)
    expect(at2).toBeCloseTo(bleedAmbientAlpha(0.5), 10)
    expect(at4).toBeCloseTo(bleedAmbientAlpha(1), 10)
    expect(at4).toBeGreaterThan(at0)
  })
  it('a muted band or no band: the stored Darkness', () => {
    expect(bleedDarknessAt({ ...base, motionx: [darkBand(true)], tSec: 4 })).toBeCloseTo(bleedAmbientAlpha(0.3), 10)
    expect(bleedDarknessAt({ ...base, motionx: undefined, tSec: 4 })).toBeCloseTo(bleedAmbientAlpha(0.3), 10)
  })
  it('0 with no visible light, the background unlit, or no lighting pass', () => {
    expect(bleedDarknessAt({ ...base, hasVisibleLight: false, motionx: [darkBand()], tSec: 4 })).toBe(0)
    expect(bleedDarknessAt({ ...base, lighting: { darkness: 0.3, backgroundLit: false }, motionx: [darkBand()], tSec: 4 })).toBe(0)
    expect(bleedDarknessAt({ ...base, available: () => false, motionx: [darkBand()], tSec: 4 })).toBe(0)
  })
})

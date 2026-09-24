import { describe, it, expect } from 'vitest'
import {
  DEFAULT_FRAME_LIGHT, LIGHT_PRESETS, LIGHT_PRESET_LABELS, sanitizeLight, readFrameLight, presetOf, lightWorld,
} from '~/lib/compositor/frameLight'

describe('frame light', () => {
  it('defaults to the top-left preset when the Frame has none', () => {
    expect(readFrameLight(undefined)).toEqual(DEFAULT_FRAME_LIGHT)
    expect(readFrameLight({})).toEqual(DEFAULT_FRAME_LIGHT)
    expect(presetOf(DEFAULT_FRAME_LIGHT)).toBe('top_left')
  })
  it('reads a stored light', () => {
    expect(readFrameLight({ sailor_localLight: { x: 0.4, y: 0.6, height: 0.3 } })).toEqual({ x: 0.4, y: 0.6, height: 0.3 })
  })
  it('clamps position to a half-Frame beyond each edge and height to 0..1; junk falls back per field', () => {
    expect(sanitizeLight({ x: 9, y: -9, height: 2 })).toEqual({ x: 1.5, y: -0.5, height: 1 })
    expect(sanitizeLight({ x: 'a', y: null })).toEqual(DEFAULT_FRAME_LIGHT)
  })
  it('labels presets in sentence case', () => {
    expect(Object.values(LIGHT_PRESET_LABELS)).toEqual(['Top left', 'Top right', 'Overhead', 'Raking'])
  })
  it('recognises a preset exactly, and a dragged light as none', () => {
    expect(presetOf(LIGHT_PRESETS.raking)).toBe('raking')
    expect(presetOf({ x: 0.33, y: 0.33, height: 0.5 })).toBeNull()
  })
  it('maps to shader world space: centre is the origin, y points up, height lifts z', () => {
    expect(lightWorld({ x: 0.5, y: 0.5, height: 0 }, 1.25)).toEqual([0, 0, 0.3])
    const [x, y, z] = lightWorld({ x: 0, y: 0, height: 1 }, 1.25)
    expect(x).toBeCloseTo(-0.5); expect(y).toBeCloseTo(0.625); expect(z).toBeCloseTo(2.0)
  })
})

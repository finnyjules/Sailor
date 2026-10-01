import { describe, it, expect } from 'vitest'
import {
  defaultRelightSettings, sanitizeRelight, RELIGHT_MAX_LIGHTS, newLightId, RELIGHT_SWATCHES,
  readLegacyRelightLights,
} from '~/lib/relight/settings'
import { RELIGHT_SETUP_NAMES, relightSetup, isRelightSetupName } from '~/lib/relight/presets'

describe('relight settings', () => {
  it('starts with Golden key\'s Original light and the photo defaults, and no lights of its own', () => {
    const d = defaultRelightSettings()
    expect(d).toEqual({ keep: 0.12, depth: 4, texture: 2, shine: 0, shadows: true })
    expect(d.keep).toBe(relightSetup('Golden key').keep)
    expect('lights' in sanitizeRelight({ type: 'relight', ...d })).toBe(false)
  })
  it('gives a fresh object every call', () => {
    expect(defaultRelightSettings()).not.toBe(defaultRelightSettings())
  })
  it('clamps and fills gaps; an old effect\'s lights are dropped from the effect', () => {
    const l = { x: 9, y: -9, height: 5, color: 'nope', brightness: -1, reach: 0, on: 'yes' }
    const f = sanitizeRelight({ lights: [l, l, l, l, l], keep: 7, depth: -3, texture: 99, shine: 2, shadows: 'x' })
    expect(f).toEqual({ type: 'relight', visible: true, keep: 1, depth: 0, texture: 8, shine: 1, shadows: true })
  })
  it('reads an old effect\'s lights for the conversion: clamped, capped at three', () => {
    const l = { x: 9, y: -9, height: 5, color: 'nope', brightness: -1, reach: 0, on: 'yes' }
    const ls = readLegacyRelightLights({ lights: [l, l, l, l, l] })
    expect(ls).toHaveLength(RELIGHT_MAX_LIGHTS)
    expect(ls[0]).toMatchObject({ x: 1.4, y: -0.4, height: 1, color: '#ffffff', brightness: 0, reach: 0.1, on: true })
    expect(ls[0]!.id).toMatch(/\S/)
    expect(readLegacyRelightLights({ lights: [{ x: 0.2, height: -0.2 }] })[0]).toMatchObject({ x: 0.2, height: -0.2 })
  })
  it('reads no legacy lights from a stage 2 effect or junk', () => {
    expect(readLegacyRelightLights(sanitizeRelight(null))).toEqual([])
    expect(readLegacyRelightLights(null)).toEqual([])
    expect(readLegacyRelightLights({ lights: 'x' })).toEqual([])
  })
  it('reads junk as the default effect', () => {
    expect(sanitizeRelight(null)).toEqual({ type: 'relight', visible: true, ...defaultRelightSettings() })
  })
  it('makes unique light ids', () => {
    expect(new Set(Array.from({ length: 50 }, newLightId)).size).toBe(50)
  })
  it('has the six swatches by name', () => {
    expect(RELIGHT_SWATCHES.map(s => s.label)).toEqual(['Warm', 'Tungsten', 'Daylight', 'Blue hour', 'Magenta', 'Cyan'])
  })
})

describe('relight setups', () => {
  it('lists the five setups in order', () => {
    expect(RELIGHT_SETUP_NAMES).toEqual(['Window', 'Golden key', 'Rim', 'Neon', 'Under'])
    expect(isRelightSetupName('Rim')).toBe(true)
    expect(isRelightSetupName('rim')).toBe(false)
  })
  it('describes each setup as box-fraction light specs plus Original light', () => {
    expect(relightSetup('Golden key')).toEqual({ keep: 0.12, lights: [{ x: 0.85, y: 0.3, height: 0.4, color: '#ffcf94', brightness: 3.2, reach: 1.4 }] })
    expect(relightSetup('Rim').lights.map(l => l.height)).toEqual([-0.05, 0.4])
    expect(relightSetup('Neon').lights).toHaveLength(2)
    expect(relightSetup('Window').keep).toBe(0.3)
    expect(relightSetup('Under').lights[0]).toMatchObject({ x: 0.5, y: 1.05 })
  })
  it('hands out a copy (the table cannot be mutated)', () => {
    const s = relightSetup('Window') as { lights: { x: number }[] }
    s.lights[0]!.x = 9
    expect(relightSetup('Window').lights[0]!.x).toBe(-0.05)
  })
})

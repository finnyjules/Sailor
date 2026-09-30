import { describe, it, expect } from 'vitest'
import { defaultRelightSettings, sanitizeRelight, RELIGHT_MAX_LIGHTS, newLightId, RELIGHT_SWATCHES } from '~/lib/relight/settings'
import { applySetup, setupOf, RELIGHT_SETUP_NAMES } from '~/lib/relight/presets'

const fx = () => sanitizeRelight({ type: 'relight', visible: true, ...defaultRelightSettings() })

describe('relight settings', () => {
  it('starts from Golden key with the photo defaults', () => {
    const f = fx()
    expect(setupOf(f)).toBe('Golden key')
    expect(f).toMatchObject({ depth: 4, texture: 2, shine: 0, shadows: true, keep: 0.12 })
    expect(f.lights).toHaveLength(1)
  })
  it('gives a fresh object every call (no shared lights array)', () => {
    const a = defaultRelightSettings(), b = defaultRelightSettings()
    expect(a.lights).not.toBe(b.lights)
    expect(a.lights[0]).not.toBe(b.lights[0])
  })
  it('clamps, caps at three lights, and fills gaps', () => {
    const l = { x: 9, y: -9, height: 5, color: 'nope', brightness: -1, reach: 0, on: 'yes' }
    const f = sanitizeRelight({ lights: [l, l, l, l, l], keep: 7, depth: -3, texture: 99, shine: 2, shadows: 'x' })
    expect(f.lights).toHaveLength(RELIGHT_MAX_LIGHTS)
    expect(f.lights[0]).toMatchObject({ x: 1.4, y: -0.4, height: 1, color: '#ffffff', brightness: 0, reach: 0.1, on: true })
    expect(f.lights[0]!.id).toMatch(/\S/)
    expect(f).toMatchObject({ type: 'relight', visible: true, keep: 1, depth: 0, texture: 8, shine: 1, shadows: true })
  })
  it('reads junk as the default effect', () => {
    expect(setupOf(sanitizeRelight(null))).toBe('Golden key')
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
  })
  it('applies a setup and recognises it, ignoring light ids', () => {
    for (const name of RELIGHT_SETUP_NAMES) expect(setupOf(applySetup(fx(), name))).toBe(name)
  })
  it('keeps the photo controls when a setup is applied', () => {
    const f = { ...fx(), depth: 9, texture: 1, shine: 0.5, shadows: false }
    expect(applySetup(f, 'Neon')).toMatchObject({ depth: 9, texture: 1, shine: 0.5, shadows: false })
  })
  it('stops recognising a setup once a light moves', () => {
    const f = applySetup(fx(), 'Rim')
    f.lights[0]!.x += 0.05
    expect(setupOf(f)).toBeNull()
  })
})

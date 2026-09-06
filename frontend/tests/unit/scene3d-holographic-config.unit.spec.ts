import { describe, it, expect } from 'vitest'
import { parseDoc, MATERIAL_TYPES, MATERIAL_DEFAULTS } from '~/lib/scene3d/config'

const docWith = (material: Record<string, unknown>): string =>
  JSON.stringify({
    version: 1,
    objects: [{ id: 'a', name: 'A', kind: 'primitive', primitive: 'sphere', visible: true,
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], material }],
  })

const HOLO_FIELDS = [
  'holoStrength', 'holoBands', 'holoAngle', 'holoFlakes', 'holoFlakeSize', 'holoGloss', 'holoHueShift',
] as const

describe('holographic material — config', () => {
  it('registers the type, right after opalescent', () => {
    expect(MATERIAL_TYPES).toContain('holographic')
    expect(MATERIAL_TYPES.indexOf('holographic')).toBe(MATERIAL_TYPES.indexOf('opalescent') + 1)
  })

  it('ships defaults for every holo field', () => {
    expect(MATERIAL_DEFAULTS.holoStrength).toBe(1)
    expect(MATERIAL_DEFAULTS.holoBands).toBe(3)
    expect(MATERIAL_DEFAULTS.holoAngle).toBe(0)
    expect(MATERIAL_DEFAULTS.holoFlakes).toBe(0) // a clean linear foil by default
    expect(MATERIAL_DEFAULTS.holoFlakeSize).toBe(0.08)
    expect(MATERIAL_DEFAULTS.holoGloss).toBe(0.85)
    expect(MATERIAL_DEFAULTS.holoHueShift).toBe(0)
  })

  it('round-trips authored holo fields through parseDoc', () => {
    const doc = parseDoc(docWith({
      type: 'holographic', color: '#dddddd', roughness: 0.4, metalness: 1,
      holoStrength: 1.5, holoBands: 5, holoAngle: 45, holoFlakes: 0.8, holoFlakeSize: 0.05, holoGloss: 0.3, holoHueShift: 120,
      gradientStops: [{ pos: 0, color: '#ff0000' }, { pos: 1, color: '#00ff00' }],
    }))
    const m = doc.objects[0]!.material as any
    expect(m.type).toBe('holographic')
    expect(m.holoStrength).toBe(1.5)
    expect(m.holoBands).toBe(5)
    expect(m.holoAngle).toBe(45)
    expect(m.holoFlakes).toBe(0.8)
    expect(m.holoFlakeSize).toBe(0.05)
    expect(m.holoGloss).toBe(0.3)
    expect(m.holoHueShift).toBe(120)
    expect(m.gradientStops).toHaveLength(2)
  })

  it('leaves absent holo fields absent (exact round-trip, defaults applied downstream)', () => {
    const doc = parseDoc(docWith({ type: 'holographic', color: '#dddddd', roughness: 0.5, metalness: 1 }))
    const m = doc.objects[0]!.material as any
    for (const k of HOLO_FIELDS) expect(m[k], k).toBeUndefined()
  })

  it('rejects non-numeric holo fields (falls back to absent)', () => {
    const doc = parseDoc(docWith({ type: 'holographic', color: '#dddddd', roughness: 0.5, metalness: 1,
      holoBands: 'lots' as unknown as number, holoFlakes: null as unknown as number }))
    const m = doc.objects[0]!.material as any
    expect(m.holoBands).toBeUndefined()
    expect(m.holoFlakes).toBeUndefined()
  })
})

import { describe, it, expect } from 'vitest'
import { SCENE_CONTROLS } from '~/lib/scene3d/controls'
import { createPrimitive } from '~/lib/scene3d/config'
import type { SceneDoc, SceneObject } from '~/lib/scene3d/config'

const HOLO_KEYS = [
  'object.material.holoStrength',
  'object.material.holoBands',
  'object.material.holoAngle',
  'object.material.holoFlakes',
  'object.material.holoFlakeSize',
  'object.material.holoGloss',
  'object.material.holoHueShift',
]

const objWithType = (type: SceneObject['material']['type']): SceneObject => {
  const o = createPrimitive('sphere', [])
  o.material.type = type
  return o
}

const shows = (doc: SceneDoc, obj: SceneObject, key: string): boolean => {
  const c = SCENE_CONTROLS.find((s) => s.key === key)!
  return !c.when || c.when(doc, obj)
}

describe('holographic controls — gating', () => {
  const doc = { version: 1, objects: [] } as unknown as SceneDoc

  it('registers all seven holo sliders', () => {
    for (const k of HOLO_KEYS) expect(SCENE_CONTROLS.some((c) => c.key === k), k).toBe(true)
  })

  it('offers the holo sliders on a holographic material', () => {
    const obj = objWithType('holographic')
    for (const k of HOLO_KEYS) expect(shows(doc, obj, k), k).toBe(true)
  })

  it('withholds the holo sliders on every other material — opalescent included', () => {
    for (const type of ['opalescent', 'standard', 'gradient'] as const) {
      const obj = objWithType(type)
      for (const k of HOLO_KEYS) expect(shows(doc, obj, k), `${type} ${k}`).toBe(false)
    }
  })

  it('offers base tint + the glossy-coat / reflection knobs on a holographic material', () => {
    const obj = objWithType('holographic')
    expect(shows(doc, obj, 'object.material.color')).toBe(true)
    expect(shows(doc, obj, 'object.material.clearcoat')).toBe(true)
    expect(shows(doc, obj, 'object.material.clearcoatRoughness')).toBe(true)
    expect(shows(doc, obj, 'object.material.envMapIntensity')).toBe(true)
  })

  it('does NOT offer roughness / metalness — a foil is metal and Gloss owns its roughness', () => {
    const obj = objWithType('holographic')
    expect(shows(doc, obj, 'object.material.roughness')).toBe(false)
    expect(shows(doc, obj, 'object.material.metalness')).toBe(false)
  })

  it('does NOT offer the texture set — materials.ts never binds one on a foil', () => {
    const obj = objWithType('holographic')
    expect(shows(doc, obj, 'object.material.texture')).toBe(false)
    expect(shows(doc, obj, 'object.material.textureTiling')).toBe(false)
    // …while the types that do carry one keep it.
    expect(shows(doc, objWithType('opalescent'), 'object.material.texture')).toBe(true)
    expect(shows(doc, objWithType('standard'), 'object.material.textureTiling')).toBe(true)
  })

  it('withholds the rest of the physical block (sheen / transmission)', () => {
    expect(shows(doc, objWithType('holographic'), 'object.material.transmission')).toBe(false)
    expect(shows(doc, objWithType('holographic'), 'object.material.sheen')).toBe(false)
  })

  it('the material type select offers it', () => {
    const c = SCENE_CONTROLS.find((s) => s.key === 'object.material.type') as { options: string[] }
    expect(c.options).toContain('holographic')
  })

  it('every holo row carries a sentence-case label and a plain-English hint', () => {
    for (const k of HOLO_KEYS) {
      const c = SCENE_CONTROLS.find((s) => s.key === k) as { label: string; hint?: string; kind: string }
      expect(c.kind, k).toBe('slider')
      expect(c.label, `${k} label`).toMatch(/^[A-Z]/)
      expect(c.label, `${k} label must not be an identifier`).not.toMatch(/[a-z][A-Z]/)
      expect(c.hint, `${k} hint`).toBeTruthy()
    }
  })

  it('Rainbow strength and Flakes are the summary rows', () => {
    const summary = (k: string) => (SCENE_CONTROLS.find((s) => s.key === k) as { summary?: number }).summary
    expect(summary('object.material.holoStrength')).toBe(1)
    expect(summary('object.material.holoFlakes')).toBe(2)
  })
})

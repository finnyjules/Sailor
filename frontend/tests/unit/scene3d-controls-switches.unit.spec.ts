import { describe, it, expect } from 'vitest'
import { SCENE_CONTROLS, visibleSceneControls } from '~/lib/scene3d/controls'
import { showIfVisible } from '~/lib/studio/sections'
import { getByPath } from '~/lib/studio/path'
import { defaultDoc, createPrimitive, DEFAULT_MATERIAL, MATERIAL_DEFAULTS } from '~/lib/scene3d/config'
import type { SceneDoc, SceneObject } from '~/lib/scene3d/config'
import { sceneAgentControls, sceneBindableControls } from '~/lib/scene3d/agentControls'

const objWithType = (type: SceneObject['material']['type']): SceneObject => {
  const o = createPrimitive('sphere', [])
  o.material.type = type
  return o
}

describe('new switches: object.material.unlit + showFloor', () => {
  it('new switches resolve on the doc and reach the agent', () => {
    const keys = SCENE_CONTROLS.map((c) => c.key)
    expect(keys).toContain('object.material.unlit')
    expect(keys).toContain('showFloor')

    // Defaults resolve on a real doc/material through the same dotted-path machinery
    // sweeps use.
    const doc = defaultDoc()
    expect(getByPath(doc, 'showFloor')).toBe(true)
    expect(doc.showFloor).toBe(true)
    expect(MATERIAL_DEFAULTS.unlit).toBe(false)

    const unlitControl = SCENE_CONTROLS.find((c) => c.key === 'object.material.unlit')!
    expect(unlitControl.kind).toBe('switch')
    expect((unlitControl as { default: boolean }).default).toBe(false)
    const showFloorControl = SCENE_CONTROLS.find((c) => c.key === 'showFloor')!
    expect(showFloorControl.kind).toBe('switch')
    expect((showFloorControl as { default: boolean }).default).toBe(true)
    expect(showFloorControl.group).toBe('Background')

    // Reaches the agent (doc-level showFloor is unconditional; unlit needs a shaderFill obj).
    const agentKeys = sceneAgentControls(doc).map((c) => c.key)
    expect(agentKeys).toContain('showFloor')
    const shaderObj = objWithType('shaderFill')
    const agentKeysWithShaderObj = sceneAgentControls(doc, shaderObj).map((c) => c.key)
    expect(agentKeysWithShaderObj).toContain('object.material.unlit')

    // Reaches the bindable (Collection) vocabulary too.
    expect(sceneBindableControls(doc).map((c) => c.key)).toContain('showFloor')
  })

  it('object.material.unlit is gated to shaderFill + image (the two types with a Basic-vs-Standard choice)', () => {
    const doc = defaultDoc()
    const unlitControl = SCENE_CONTROLS.find((c) => c.key === 'object.material.unlit')!
    expect(unlitControl.when!(doc, objWithType('shaderFill'))).toBe(true)
    expect(unlitControl.when!(doc, objWithType('image'))).toBe(true)
    expect(unlitControl.when!(doc, objWithType('standard'))).toBe(false)
    expect(unlitControl.when!(doc, objWithType('glass'))).toBe(false)
    expect(unlitControl.when!(doc, objWithType('phong'))).toBe(false)
  })

  it('showFloor carries no `when` gate — always visible, doc-level', () => {
    const showFloorControl = SCENE_CONTROLS.find((c) => c.key === 'showFloor')!
    expect(showFloorControl.when).toBeUndefined()
    const doc = defaultDoc()
    const keys = visibleSceneControls(doc, objWithType('standard')).map((c) => c.key)
    expect(keys).toContain('showFloor')
  })

  it('Background is a declared SCENE_SECTIONS group (not silently dropped)', () => {
    const doc = defaultDoc()
    const keys = visibleSceneControls(doc).map((c) => c.key)
    expect(keys).toContain('showFloor')
  })
})

describe('roughness/metalness showIf composes with their existing `when` gate', () => {
  const doc = defaultDoc()

  // Mimics a schema-driven reader: `when` gates by material type (as visibleSceneControls
  // does today), `showIf` additionally reads the live `object.material.unlit` value off the
  // object exactly as a real inspector would (relative to the active object, so the
  // 'object.' prefix is stripped before going through getByPath).
  const visibleAndShown = (obj: SceneObject, key: string): boolean => {
    const c = SCENE_CONTROLS.find((s) => s.key === key)!
    if (c.when && !c.when(doc, obj)) return false
    return showIfVisible(c, (k) => getByPath(obj, k.replace(/^object\./, '')) as any)
  }

  it('a material type with no unlit concept (standard) still shows roughness/metalness — proves equals:false would have been wrong', () => {
    const obj = objWithType('standard')
    expect(obj.material.unlit).toBeUndefined()
    expect(visibleAndShown(obj, 'object.material.roughness')).toBe(true)
    expect(visibleAndShown(obj, 'object.material.metalness')).toBe(true)
  })

  it('shaderFill with unlit absent/false shows roughness/metalness', () => {
    const obj = objWithType('shaderFill')
    expect(visibleAndShown(obj, 'object.material.roughness')).toBe(true)
    expect(visibleAndShown(obj, 'object.material.metalness')).toBe(true)
    obj.material.unlit = false
    expect(visibleAndShown(obj, 'object.material.roughness')).toBe(true)
    expect(visibleAndShown(obj, 'object.material.metalness')).toBe(true)
  })

  it('shaderFill with unlit true hides roughness/metalness', () => {
    const obj = objWithType('shaderFill')
    obj.material.unlit = true
    expect(visibleAndShown(obj, 'object.material.roughness')).toBe(false)
    expect(visibleAndShown(obj, 'object.material.metalness')).toBe(false)
  })

  it('image with unlit absent/false shows roughness/metalness', () => {
    const obj = objWithType('image')
    expect(visibleAndShown(obj, 'object.material.roughness')).toBe(true)
    expect(visibleAndShown(obj, 'object.material.metalness')).toBe(true)
    obj.material.unlit = false
    expect(visibleAndShown(obj, 'object.material.roughness')).toBe(true)
    expect(visibleAndShown(obj, 'object.material.metalness')).toBe(true)
  })

  it('image with unlit true hides roughness/metalness', () => {
    const obj = objWithType('image')
    obj.material.unlit = true
    expect(visibleAndShown(obj, 'object.material.roughness')).toBe(false)
    expect(visibleAndShown(obj, 'object.material.metalness')).toBe(false)
  })

  it('roughness/metalness default (DEFAULT_MATERIAL) is unaffected by these gates', () => {
    expect(DEFAULT_MATERIAL.roughness).toBe(0.6)
    expect(DEFAULT_MATERIAL.metalness).toBe(0.0)
  })
})

describe('agent vocabulary never leaks the `bindable` schema-only field', () => {
  it('sceneAgentControls output carries no `bindable` field on any control', () => {
    const doc = defaultDoc()
    const prim = createPrimitive('box', [])
    doc.objects.push(prim)
    const out = sceneAgentControls(doc, prim)
    expect(out.length).toBeGreaterThan(0)
    for (const c of out) expect(c).not.toHaveProperty('bindable')
  })

  it('sceneBindableControls output carries no `bindable` field on any control', () => {
    const doc = defaultDoc()
    const prim = createPrimitive('box', [])
    doc.objects.push(prim)
    const out = sceneBindableControls(doc)
    expect(out.length).toBeGreaterThan(0)
    for (const c of out) expect(c).not.toHaveProperty('bindable')
  })
})

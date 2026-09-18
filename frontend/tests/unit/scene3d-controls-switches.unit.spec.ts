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

describe('new controls: object.material.unlit + floorMode', () => {
  it('new controls resolve on the doc and reach the agent', () => {
    const keys = SCENE_CONTROLS.map((c) => c.key)
    expect(keys).toContain('object.material.unlit')
    expect(keys).toContain('floorMode')

    // Defaults resolve on a real doc/material through the same dotted-path machinery
    // sweeps use.
    const doc = defaultDoc()
    expect(getByPath(doc, 'floorMode')).toBe('shadow')
    expect(doc.floorMode).toBe('shadow')
    expect(MATERIAL_DEFAULTS.unlit).toBe(false)

    const unlitControl = SCENE_CONTROLS.find((c) => c.key === 'object.material.unlit')!
    expect(unlitControl.kind).toBe('switch')
    expect((unlitControl as { default: boolean }).default).toBe(false)
    const floorControl = SCENE_CONTROLS.find((c) => c.key === 'floorMode')!
    expect(floorControl.kind).toBe('select')
    expect((floorControl as { default: string }).default).toBe('shadow')
    expect(floorControl.group).toBe('Background')

    // Reaches the agent (doc-level floorMode is unconditional; unlit needs a shaderFill obj).
    const agentKeys = sceneAgentControls(doc).map((c) => c.key)
    expect(agentKeys).toContain('floorMode')
    const shaderObj = objWithType('shaderFill')
    const agentKeysWithShaderObj = sceneAgentControls(doc, shaderObj).map((c) => c.key)
    expect(agentKeysWithShaderObj).toContain('object.material.unlit')

    // Reaches the bindable (Collection) vocabulary too.
    expect(sceneBindableControls(doc).map((c) => c.key)).toContain('floorMode')
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

  it('floorMode carries no `when` gate — always visible, doc-level', () => {
    const floorControl = SCENE_CONTROLS.find((c) => c.key === 'floorMode')!
    expect(floorControl.when).toBeUndefined()
    const doc = defaultDoc()
    const keys = visibleSceneControls(doc, objWithType('standard')).map((c) => c.key)
    expect(keys).toContain('floorMode')
  })

  it('Background is a declared SCENE_SECTIONS group (not silently dropped)', () => {
    const doc = defaultDoc()
    const keys = visibleSceneControls(doc).map((c) => c.key)
    expect(keys).toContain('floorMode')
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

// `showIf` above governs what the PANEL draws; the agent's vocabulary is filtered on
// `when` alone (sceneAgentControls -> visibleSceneControls), so `hasPbrSurface` excluding
// an unlit image is the thing that actually keeps roughness/metalness out of what the
// model may write for a flat picture — pin that directly rather than through the panel path.
describe('agent vocabulary drops roughness/metalness for an unlit image (hasPbrSurface)', () => {
  it('an unlit image never offers roughness/metalness to the agent', () => {
    const doc = defaultDoc()
    const obj = objWithType('image')
    obj.material.unlit = true
    const keys = sceneAgentControls(doc, obj).map((c) => c.key)
    expect(keys).not.toContain('object.material.roughness')
    expect(keys).not.toContain('object.material.metalness')
  })

  it('a lit image still offers both — proves the assertion above is not vacuous', () => {
    const doc = defaultDoc()
    const obj = objWithType('image')
    const keys = sceneAgentControls(doc, obj).map((c) => c.key)
    expect(keys).toContain('object.material.roughness')
    expect(keys).toContain('object.material.metalness')
  })
})

// `object.material.opacity`'s `when` was widened from `isPhysicalMaterial` to `hasOpacity`
// (Task 8) so an image material offers it too. A panel-level test cannot prove this: opacity
// carries no `showIf`, so a REVERTED `when` would still pass through the panel's own
// showIf-composed check — sceneAgentControls filters on `when` alone (see the roughness/
// metalness describe above for the same trap), so pin the widening directly here.
describe('agent vocabulary widens opacity to image (hasOpacity)', () => {
  it('an image material now offers opacity to the agent', () => {
    const doc = defaultDoc()
    const obj = objWithType('image')
    const keys = sceneAgentControls(doc, obj).map((c) => c.key)
    expect(keys).toContain('object.material.opacity')
  })

  it('a physical material (standard) still offers it too — the widening only adds, never narrows', () => {
    const doc = defaultDoc()
    const obj = objWithType('standard')
    const keys = sceneAgentControls(doc, obj).map((c) => c.key)
    expect(keys).toContain('object.material.opacity')
  })

  it('a material with neither concept (toon) still withholds it — proves the assertions above are not vacuous', () => {
    const doc = defaultDoc()
    const obj = objWithType('toon')
    const keys = sceneAgentControls(doc, obj).map((c) => c.key)
    expect(keys).not.toContain('object.material.opacity')
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

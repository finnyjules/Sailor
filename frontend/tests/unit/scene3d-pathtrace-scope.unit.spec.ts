import { describe, it, expect } from 'vitest'
import { cinematicScope, cinematicScopeWarning, isPathTraceableMaterial, PATH_TRACEABLE_MATERIALS } from '~/lib/scene3d/pathtrace/scope'
import { defaultDoc, createPrimitive, type SceneDoc, type SceneObject } from '~/lib/scene3d/config'

function docWith(objs: SceneObject[]): SceneDoc {
  const d = defaultDoc()
  d.objects = objs
  return d
}
function prim(materialType: string, extra: Partial<SceneObject> = {}): SceneObject {
  const o = createPrimitive('gem', [])
  o.material.type = materialType as SceneObject['material']['type']
  return Object.assign(o, extra)
}

describe('pathtrace scope', () => {
  it('only standard/glass/gemstone are path-traceable', () => {
    expect([...PATH_TRACEABLE_MATERIALS].sort()).toEqual(['gemstone', 'glass', 'standard'])
    for (const t of ['standard', 'glass', 'gemstone']) expect(isPathTraceableMaterial(t as never), t).toBe(true)
    for (const t of ['phong', 'toon', 'matcap', 'fresnel', 'gradient', 'opalescent', 'holographic', 'image', 'shaderFill']) {
      expect(isPathTraceableMaterial(t as never), t).toBe(false)
    }
  })

  it('an all-physical scene needs no warning and simplifies nothing', () => {
    const doc = docWith([prim('gemstone'), prim('glass'), prim('standard')])
    const s = cinematicScope(doc)
    expect(s.total).toBe(3)
    expect(s.simplified).toHaveLength(0)
    expect(s.hasCustomMaterial).toBe(false)
    expect(s.hasTreatment).toBe(false)
    expect(cinematicScopeWarning(doc)).toBeNull()
  })

  it('flags custom-shader materials as simplified', () => {
    const doc = docWith([prim('gemstone'), prim('holographic'), prim('gradient')])
    const s = cinematicScope(doc)
    expect(s.simplified).toHaveLength(2)
    expect(s.hasCustomMaterial).toBe(true)
    expect(cinematicScopeWarning(doc)).toContain('shader materials')
    expect(cinematicScopeWarning(doc)).toContain('2 objects')
  })

  it('flags an object with an active treatment even if its material path-traces', () => {
    const treated = prim('gemstone', { treatments: [{ id: 't1', kind: 'blur', enabled: true }] } as Partial<SceneObject>)
    const doc = docWith([treated, prim('glass')])
    const s = cinematicScope(doc)
    expect(s.hasTreatment).toBe(true)
    expect(s.simplified).toHaveLength(1)
    expect(cinematicScopeWarning(doc)).toContain('object effects')
  })

  it('a disabled treatment does not count', () => {
    const treated = prim('gemstone', { treatments: [{ id: 't1', kind: 'blur', enabled: false }] } as Partial<SceneObject>)
    const doc = docWith([treated])
    expect(cinematicScope(doc).hasTreatment).toBe(false)
    expect(cinematicScopeWarning(doc)).toBeNull()
  })

  it('lights and decals are not counted as scene bodies', () => {
    const doc = defaultDoc()
    const gem = prim('gemstone')
    doc.objects = [gem, { id: 'L', kind: 'light', name: 'L' } as unknown as SceneObject]
    expect(cinematicScope(doc).total).toBe(1)
  })

  it('the warning names both when custom materials AND treatments are present', () => {
    const doc = docWith([
      prim('holographic'),
      prim('gemstone', { treatments: [{ id: 't1', kind: 'glow', enabled: true }] } as Partial<SceneObject>),
    ])
    const w = cinematicScopeWarning(doc)!
    expect(w).toContain('shader materials and object effects')
  })
})

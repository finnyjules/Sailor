import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { planClones, mergeClones, applyModifiers } from '~/lib/scene3d/modifiers'
import { DEFAULT_VARY, type VarySettings } from '~/lib/vary'

const SETTINGS = {
  mode: 0, offset: [1, 0, 0] as [number, number, number], radius: 1, axis: 1,
  gridCount: [2, 2, 1] as [number, number, number], spacing: [1, 1, 1] as [number, number, number],
  stepRot: [0, 0, 0] as [number, number, number], stepScale: 1,
}
const V = (over: Partial<VarySettings> = {}): VarySettings => ({ ...DEFAULT_VARY, ...over })

describe('planClones', () => {
  it('produces one recipe per copy with ascending indexes', () => {
    const r = planClones(4, SETTINGS)
    expect(r.length).toBe(4)
    expect(r.map((x) => x.index)).toEqual([0, 1, 2, 3])
  })

  it('places linear copies along the offset, unchanged from before', () => {
    const r = planClones(3, SETTINGS)
    const p = r.map((x) => new THREE.Vector3().setFromMatrixPosition(x.matrix).x)
    expect(p).toEqual([0, 1, 2])
  })

  it('assigns no colour when vary is absent or colour is off', () => {
    expect(planClones(3, SETTINGS).every((x) => x.color === undefined)).toBe(true)
    expect(planClones(3, SETTINGS, V()).every((x) => x.color === undefined)).toBe(true)
  })

  it('cycles the palette across copies when colour is on', () => {
    const r = planClones(4, SETTINGS, V({ colorEnabled: true, palette: ['#ff0000', '#00ff00'] }))
    expect(r.map((x) => x.color)).toEqual(['#ff0000', '#00ff00', '#ff0000', '#00ff00'])
  })

  it('leaves sequence-mode step transforms bit-identical to the un-varied plan', () => {
    const s = { ...SETTINGS, stepScale: 0.9, stepRot: [0, 30, 0] as [number, number, number] }
    const plain = planClones(5, s)
    const varied = planClones(5, s, V())
    for (let i = 0; i < 5; i++) {
      expect(varied[i]!.matrix.elements).toEqual(plain[i]!.matrix.elements)
    }
  })

  it('scales the step transform by the weight in falloff mode', () => {
    const s = { ...SETTINGS, stepScale: 0.5 }
    const v = V({ mode: 'falloff', falloffCenter: 0, falloffRadius: 0.01 })
    const r = planClones(4, s, v)
    // Beyond the reach, weight is 0 → the step is fully damped → uniform scale 1.
    const last = new THREE.Vector3().setFromMatrixScale(r[3]!.matrix)
    expect(last.x).toBeCloseTo(1, 6)
  })
})

describe('mergeClones', () => {
  const box = () => new THREE.BoxGeometry(1, 1, 1)

  it('writes no colour attribute when no recipe carries one', () => {
    const g = mergeClones(box(), planClones(3, SETTINGS))
    expect(g.getAttribute('color')).toBeUndefined()
  })

  it('writes one colour per copy when recipes carry colours', () => {
    const base = box()
    const per = base.getAttribute('position').count
    const recipes = planClones(2, SETTINGS, V({ colorEnabled: true, palette: ['#ff0000', '#0000ff'] }))
    const g = mergeClones(base, recipes)
    const col = g.getAttribute('color')!
    expect(col.count).toBe(per * 2)
    // Copy 0 is pure red, copy 1 pure blue (linear-space, so 1 and 0 stay exact).
    expect(col.getX(0)).toBeCloseTo(1, 5)
    expect(col.getZ(0)).toBeCloseTo(0, 5)
    expect(col.getX(per)).toBeCloseTo(0, 5)
    expect(col.getZ(per)).toBeCloseTo(1, 5)
  })
})

describe('applyModifiers regression guard', () => {
  it('returns the input untouched when nothing is set', () => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    expect(applyModifiers(g, undefined)).toBe(g)
    expect(applyModifiers(g, undefined, DEFAULT_VARY)).toBe(g)
  })

  it('adds no colour attribute for a cloned object with vary untouched', () => {
    const g = new THREE.BoxGeometry(1, 1, 1)
    const out = applyModifiers(g, { cloneCount: 4 }, DEFAULT_VARY)
    expect(out.getAttribute('color')).toBeUndefined()
  })
})

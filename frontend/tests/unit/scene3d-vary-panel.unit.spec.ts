import { describe, it, expect } from 'vitest'
import { scenePanelControls } from '~/lib/scene3d/panelPresentation'
import { varyOn, varyColorable, varyColorOn, varyModeOf } from '~/lib/scene3d/controls'
import { NO_BASE_COLOR, type SceneDoc, type SceneObject } from '~/lib/scene3d/config'

// S1 Task 6 moved the Cloner's Vary controls OFF the schema-driven Geometry panel and onto the
// per-modifier inspector (rendered bespoke by Scene3DStudioSurface.vue when the Cloner row is
// selected, bag-backed via modOf/setMod). So `scenePanelControls` no longer emits any vary row —
// this spec pins that removal, and pins the gate RULES the inspector still follows: those rules are
// controls.ts's varyOn / varyColorable / varyColorOn (also the `when` guards on the schema vary
// rows), which the surface mirrors with a STACK-sourced clone count. The rendered inspector flow is
// covered by the Task 8 Playwright lab page.

const DOC = {
  objects: [], background: '#000000', showFloor: false,
  camera: { fov: 45 }, lighting: {},
} as unknown as SceneDoc

const obj = (modifiers: Record<string, number> = {}, matType = 'standard'): SceneObject => ({
  id: 'o', kind: 'primitive', primitive: 'box',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: matType, color: '#ffffff' }, modifiers,
} as unknown as SceneObject)

const keys = (o: SceneObject) => scenePanelControls(DOC, o).map((r) => r.key)

const CLONED = { cloneCount: 6 }

describe('vary is no longer on the schema Geometry panel', () => {
  it('emits no vary row for a cloned primitive — every vary dial moved to the modifier inspector', () => {
    const varyKeys = keys(obj({ ...CLONED, varyMode: 1, varyColor: 1 })).filter((k) => k.toLowerCase().includes('vary'))
    expect(varyKeys).toEqual([])
  })

  it('emits no modifier or cloner dial at all — only the cost readout survives on the panel', () => {
    const k = keys(obj({ ...CLONED }))
    expect(k.filter((key) => key.startsWith('ui.mod.') || key.startsWith('object.modifiers.'))).toEqual([])
    // The cloner placement dials are gone too; the one cloner row left is the cost readout.
    expect(k.filter((key) => key.startsWith('ui.cloner.'))).toEqual(['ui.cloner.cost'])
  })
})

describe('the Vary gate rules the inspector follows (controls.ts)', () => {
  it('the block needs more than one copy', () => {
    expect(varyOn(obj({ cloneCount: 1 }))).toBe(false)
    expect(varyOn(obj(CLONED))).toBe(true)
  })

  it('the seed belongs to random mode, centre/reach to falloff mode', () => {
    expect(varyModeOf(obj({ ...CLONED, varyMode: 1 }))).toBe(1)
    expect(varyModeOf(obj({ ...CLONED, varyMode: 2 }))).toBe(2)
  })

  it('the colour half is off for every material with no base colour, driven by NO_BASE_COLOR', () => {
    // Derived from the render-side set itself, so a type added there can never leave a dead
    // colour control behind in the inspector.
    expect([...NO_BASE_COLOR].sort()).toEqual(['gradient', 'image', 'opalescent', 'shaderFill'])
    for (const t of NO_BASE_COLOR) {
      expect(varyColorable(obj({ ...CLONED, varyColor: 1 }, t)), t).toBe(false)
      expect(varyColorOn(obj({ ...CLONED, varyColor: 1 }, t)), t).toBe(false)
    }
  })

  it('the colour half stays available on a material that does have a base colour', () => {
    for (const t of ['standard', 'glass', 'phong', 'toon', 'matcap', 'fresnel']) {
      expect(varyColorable(obj({ ...CLONED, varyColor: 1 }, t)), t).toBe(true)
      expect(varyColorOn(obj({ ...CLONED, varyColor: 1 }, t)), t).toBe(true)
      expect(varyColorOn(obj({ ...CLONED, varyColor: 0 }, t)), `${t} off`).toBe(false)
    }
  })
})

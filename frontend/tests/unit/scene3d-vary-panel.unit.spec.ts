import { describe, it, expect } from 'vitest'
import { scenePanelControls } from '~/lib/scene3d/panelPresentation'
import { NO_BASE_COLOR, type SceneDoc, type SceneObject } from '~/lib/scene3d/config'

const DOC = {
  objects: [], background: '#000000', showFloor: false,
  camera: { fov: 45 }, lighting: {},
} as unknown as SceneDoc

const obj = (modifiers: Record<string, number> = {}, matType = 'standard'): SceneObject => ({
  id: 'o', kind: 'primitive', primitive: 'box',
  position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  material: { type: matType, color: '#ffffff' }, modifiers,
} as unknown as SceneObject)

/** The row keys the inspector would draw for this selection. */
const keys = (o: SceneObject) => scenePanelControls(DOC, o).map((r) => r.key)
/** The card a given row landed in. */
const cardOf = (o: SceneObject, key: string) =>
  scenePanelControls(DOC, o).find((r) => r.key === key)?.group

const CLONED = { cloneCount: 6 }

describe('vary rows land on the Cloner card', () => {
  it('routes the numeric vary rows to Cloner, not Modifiers', () => {
    const o = obj({ ...CLONED, varyMode: 1 })
    expect(cardOf(o, 'object.modifiers.varySeed')).toBe('Geometry/Cloner')
  })

  it('routes the vary anchors to Cloner', () => {
    const o = obj(CLONED)
    expect(cardOf(o, 'ui.cloner.varyMode')).toBe('Geometry/Cloner')
  })

  it('leaves the deformation rows on Modifiers', () => {
    expect(cardOf(obj(CLONED), 'object.modifiers.twist')).toBe('Geometry/Modifiers')
  })
})

describe('vary row gating', () => {
  it('hides the whole block while the cloner makes a single copy', () => {
    const k = keys(obj({ cloneCount: 1 }))
    expect(k).not.toContain('ui.cloner.vary')
    expect(k).not.toContain('ui.cloner.varyMode')
    expect(k).not.toContain('ui.cloner.varyColor')
  })

  it('adds nothing at all to a single-copy object', () => {
    // ZERO-CHANGE: the rows a one-copy object draws must be exactly the pre-Vary set.
    const k = keys(obj({ cloneCount: 1 }))
    expect(k.filter((key) => key.toLowerCase().includes('vary'))).toEqual([])
  })

  it('shows the caption and driver picker once there is more than one copy', () => {
    const k = keys(obj(CLONED))
    expect(k).toContain('ui.cloner.vary')
    expect(k).toContain('ui.cloner.varyMode')
  })

  it('shows the seed only in random mode', () => {
    expect(keys(obj(CLONED))).not.toContain('object.modifiers.varySeed')
    expect(keys(obj({ ...CLONED, varyMode: 1 }))).toContain('object.modifiers.varySeed')
    expect(keys(obj({ ...CLONED, varyMode: 2 }))).not.toContain('object.modifiers.varySeed')
  })

  it('shows centre and reach only in falloff mode', () => {
    const k = keys(obj({ ...CLONED, varyMode: 2 }))
    expect(k).toContain('object.modifiers.varyFalloffCenter')
    expect(k).toContain('object.modifiers.varyFalloffRadius')
    const r = keys(obj({ ...CLONED, varyMode: 1 }))
    expect(r).not.toContain('object.modifiers.varyFalloffCenter')
    expect(r).not.toContain('object.modifiers.varyFalloffRadius')
  })

  it('reveals the palette, spread and strength only when colour is on', () => {
    const off = keys(obj(CLONED))
    expect(off).not.toContain('ui.cloner.varyPalette')
    expect(off).not.toContain('ui.cloner.varyColorSpread')
    expect(off).not.toContain('object.modifiers.varyColorStrength')
    const on = keys(obj({ ...CLONED, varyColor: 1 }))
    expect(on).toContain('ui.cloner.varyPalette')
    expect(on).toContain('ui.cloner.varyColorSpread')
    expect(on).toContain('object.modifiers.varyColorStrength')
  })

  it('hides the colour half for every material with no base colour, driven by NO_BASE_COLOR', () => {
    // Derived from the render-side set itself, so a type added there can never leave a
    // dead colour control behind in the inspector.
    expect([...NO_BASE_COLOR].sort()).toEqual(['gradient', 'image', 'opalescent', 'shaderFill'])
    for (const t of NO_BASE_COLOR) {
      const k = keys(obj({ ...CLONED, varyColor: 1 }, t))
      expect(k, t).not.toContain('ui.cloner.varyColor')
      expect(k, t).not.toContain('ui.cloner.varyPalette')
      expect(k, t).not.toContain('ui.cloner.varyColorSpread')
      expect(k, t).not.toContain('object.modifiers.varyColorStrength')
      // the driver half still applies — it varies the step transforms too
      expect(k, t).toContain('ui.cloner.varyMode')
    }
  })

  it('keeps the colour half on a material that does have a base colour', () => {
    for (const t of ['standard', 'glass', 'phong', 'toon', 'matcap', 'fresnel']) {
      const k = keys(obj({ ...CLONED, varyColor: 1 }, t))
      expect(k, t).toContain('ui.cloner.varyColor')
      expect(k, t).toContain('ui.cloner.varyPalette')
    }
  })
})

describe('vary picker presentation', () => {
  it('gives every option picker readable labels, never the stored words', () => {
    const rows = scenePanelControls(DOC, obj({ ...CLONED, varyColor: 1 }))
    for (const key of ['ui.cloner.varyMode', 'ui.cloner.varyColorSpread', 'ui.cloner.varyColor']) {
      const row = rows.find((r) => r.key === key)
      expect(row, key).toBeTruthy()
      // A caption is never an internal identifier.
      expect(row!.label, key).not.toMatch(/^[a-z]/)
    }
  })
})

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  SCENE_CONTROLS, SCENE_SECTIONS, visibleSceneControls,
} from '~/lib/scene3d/controls'
import {
  defaultDoc, createPrimitive, createLight, createGlbObject, MATERIAL_DEFAULTS, DEFAULT_MATERIAL,
  MATERIAL_TYPES, type MaterialType,
} from '~/lib/scene3d/config'
import { getByPath } from '~/lib/studio/path'
import { describeControls, validatePatch } from '~/lib/spacetype/controlDescriptor'

describe('SCENE_CONTROLS integrity', () => {
  it('every control has a non-empty key, label and group', () => {
    for (const c of SCENE_CONTROLS) {
      expect(c.key, 'key').toBeTruthy()
      expect(c.label, `${c.key} label`).toBeTruthy()
      expect(c.group, `${c.key} group`).toBeTruthy()
    }
  })

  it('every group is declared in SCENE_SECTIONS', () => {
    for (const c of SCENE_CONTROLS) {
      expect(SCENE_SECTIONS, `${c.key} group "${c.group}"`).toContain(c.group)
    }
  })

  it('has unique keys', () => {
    const keys = SCENE_CONTROLS.map((c) => c.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('every select default is one of its own options', () => {
    for (const c of SCENE_CONTROLS) {
      if (c.kind !== 'select') continue
      expect(c.options, c.key).toContain(c.default)
    }
  })

  it('every slider default sits inside its own range', () => {
    for (const c of SCENE_CONTROLS) {
      if (c.kind !== 'slider') continue
      expect(c.default, `${c.key} default`).toBeGreaterThanOrEqual(c.min)
      expect(c.default, `${c.key} default`).toBeLessThanOrEqual(c.max)
      expect(c.max, `${c.key} range`).toBeGreaterThan(c.min)
    }
  })

  // The anti-drift guard: MATERIAL_DEFAULTS is materials.ts's/the Selection UI's real source
  // of truth for these per-type params. Mapped explicitly (rather than derived from the key
  // string) because the relief.* keys use a different naming convention on each side
  // (object.material.relief.scale vs MATERIAL_DEFAULTS.reliefScale) — an explicit map also
  // means a typo'd or removed MATERIAL_DEFAULTS entry fails loudly instead of silently
  // skipping the check.
  const MATERIAL_DEFAULT_KEYS: Record<string, keyof typeof MATERIAL_DEFAULTS> = {
    'object.material.shininess': 'shininess',
    'object.material.clearcoat': 'clearcoat',
    'object.material.clearcoatRoughness': 'clearcoatRoughness',
    'object.material.sheen': 'sheen',
    'object.material.emissiveIntensity': 'emissiveIntensity',
    'object.material.opacity': 'opacity',
    'object.material.iridescence': 'iridescence',
    'object.material.iridescenceIOR': 'iridescenceIOR',
    'object.material.envMapIntensity': 'envMapIntensity',
    'object.material.ior': 'ior',
    'object.material.transmission': 'transmission',
    'object.material.thickness': 'thickness',
    'object.material.relief.scale': 'reliefScale',
    'object.material.relief.contrast': 'reliefContrast',
    'object.material.relief.tiling': 'reliefTiling',
    'object.material.opalHueShift': 'opalHueShift',
    'object.material.opalFrequency': 'opalFrequency',
    'object.material.opalAngleMix': 'opalAngleMix',
    'object.material.opalFlowSpeed': 'opalFlowSpeed',
    'object.material.opalStrength': 'opalStrength',
    'object.material.holoStrength': 'holoStrength',
    'object.material.holoBands': 'holoBands',
    'object.material.holoAngle': 'holoAngle',
    'object.material.holoFlakes': 'holoFlakes',
    'object.material.holoFlakeSize': 'holoFlakeSize',
    'object.material.holoGloss': 'holoGloss',
    'object.material.holoHueShift': 'holoHueShift',
    'object.material.dispersion': 'dispersion',
    'object.material.attenuationDistance': 'attenuationDistance',
    'object.material.toonSteps': 'toonSteps',
    'object.material.fresnelPower': 'fresnelPower',
    'object.material.paletteHue': 'paletteHue',
    'object.material.paletteSat': 'paletteSat',
    'object.material.paletteLight': 'paletteLight',
    'object.material.gradientYaw': 'gradientYaw',
    'object.material.gradientPitch': 'gradientPitch',
    'object.material.gradientOffset': 'gradientOffset',
    'object.material.gradientSpread': 'gradientSpread',
    'object.material.textureTiling': 'textureTiling',
    'object.material.imageBoxBlend': 'imageBoxBlend',
    'object.material.imageSeamless': 'imageSeamless',
    'object.material.imageTiling': 'imageTiling',
    'object.material.imageTilingY': 'imageTilingY',
    'object.material.imageOffsetX': 'imageOffsetX',
    'object.material.imageOffsetY': 'imageOffsetY',
    'object.material.imageRotation': 'imageRotation',
    'object.material.imageCutout': 'imageCutout',
    'object.material.imageGlow': 'imageGlow',
    'object.material.imageBrightness': 'imageBrightness',
    'object.material.imageContrast': 'imageContrast',
    'object.material.imageSaturation': 'imageSaturation',
    'object.material.screen.density': 'screenDensity',
    'object.material.screen.angle': 'screenAngle',
    'object.material.screen.contrast': 'screenContrast',
    'object.material.screen.softness': 'screenSoftness',
    'object.material.screen.misregister': 'screenMisregister',
  }

  it('slider defaults match MATERIAL_DEFAULTS where a matching entry exists', () => {
    // Every object.material.* slider is accounted for by EITHER MATERIAL_DEFAULTS
    // (per-type params) or DEFAULT_MATERIAL (the base color/roughness/metalness the two
    // don't share) — so nothing here is silently untested against its real default.
    const materialSliders = SCENE_CONTROLS.filter((c) => c.kind === 'slider' && c.key.startsWith('object.material.')).map((c) => c.key)
    const BASE_KEYS: Record<string, keyof typeof DEFAULT_MATERIAL> = {
      'object.material.roughness': 'roughness',
      'object.material.metalness': 'metalness',
    }
    expect([...Object.keys(MATERIAL_DEFAULT_KEYS), ...Object.keys(BASE_KEYS)].sort()).toEqual([...materialSliders].sort())
    for (const [key, mdKey] of Object.entries(MATERIAL_DEFAULT_KEYS)) {
      const c = SCENE_CONTROLS.find((ctrl) => ctrl.key === key)
      expect(c, key).toBeTruthy()
      expect(c!.kind, key).toBe('slider')
      expect((c as { default: number }).default, key).toBe(MATERIAL_DEFAULTS[mdKey])
    }
    for (const [key, dmKey] of Object.entries(BASE_KEYS)) {
      const c = SCENE_CONTROLS.find((ctrl) => ctrl.key === key)
      expect(c, key).toBeTruthy()
      expect((c as { default: number }).default, key).toBe(DEFAULT_MATERIAL[dmKey])
    }
  })

  it('imports no three — the Collection resolver dynamically imports this module', () => {
    const src = readFileSync(fileURLToPath(new URL('../../app/lib/scene3d/controls.ts', import.meta.url)), 'utf-8')
    expect(src).not.toMatch(/from ['"]three['"]/)
    expect(src).not.toMatch(/from ['"]three\//)
  })

  it('object transform controls are declared not animatable (ObjectMotion owns transforms)', () => {
    const transform = SCENE_CONTROLS.filter((c) => c.group === 'Transform')
    expect(transform.length).toBeGreaterThan(0)
    for (const c of transform) expect(c.animatable, c.key).toBe(false)
  })

  it('transform control keys resolve to actual values on a scene object (array indices, not properties)', () => {
    // Build a test object with known position, rotation, scale
    const obj = createPrimitive('box', [])
    obj.position = [1.5, 2.5, 3.5]
    obj.rotation = [0.1, 0.2, 0.3]
    obj.scale = [2, 3, 4]

    // Verify each transform control's key resolves via getByPath (after stripping 'object.' prefix)
    const transformControls = SCENE_CONTROLS.filter((c) => c.group === 'Transform')
    expect(transformControls.length).toBe(9) // 3 position + 3 rotation + 3 scale

    const resolvedValues: Record<string, unknown> = {}
    for (const control of transformControls) {
      // Strip 'object.' prefix to get the path relative to the object
      const relativePath = control.key.replace(/^object\./, '')
      const value = getByPath(obj, relativePath)
      resolvedValues[control.key] = value
      // Verify it resolves to a number, not undefined
      expect(value, `${control.key} must resolve to a number`).not.toBeUndefined()
      expect(typeof value, `${control.key} must be numeric`).toBe('number')
    }

    // Spot-check specific values
    expect(resolvedValues['object.position.0']).toBe(1.5)
    expect(resolvedValues['object.position.1']).toBe(2.5)
    expect(resolvedValues['object.position.2']).toBe(3.5)
    expect(resolvedValues['object.rotation.0']).toBe(0.1)
    expect(resolvedValues['object.rotation.1']).toBe(0.2)
    expect(resolvedValues['object.rotation.2']).toBe(0.3)
    expect(resolvedValues['object.scale.0']).toBe(2)
    expect(resolvedValues['object.scale.1']).toBe(3)
    expect(resolvedValues['object.scale.2']).toBe(4)
  })

  it('exposes lighting.environment as a select over ENVIRONMENT_KINDS', () => {
    const c = SCENE_CONTROLS.find((c) => c.key === 'lighting.environment')
    expect(c).toBeTruthy()
    expect(c!.kind).toBe('select')
    expect((c as any).options).toEqual(['room', 'darkStrips', 'softbox', 'colorGels', 'studio'])
  })
})

describe('visibleSceneControls', () => {
  it('drops material controls for a light object', () => {
    const doc = defaultDoc()
    const light = createLight('point', [])
    const keys = visibleSceneControls(doc, light).map((c) => c.key)
    expect(keys.some((k) => k.startsWith('object.material.'))).toBe(false)
  })

  it('keeps the core material controls for a primitive object (default standard material)', () => {
    const doc = defaultDoc()
    const prim = createPrimitive('box', [])
    const keys = visibleSceneControls(doc, prim).map((c) => c.key)
    expect(keys).toContain('object.material.color')
    expect(keys).toContain('object.material.roughness')
    expect(keys).toContain('object.material.metalness')
    expect(keys).toContain('object.material.type')
    expect(keys).toContain('object.material.clearcoat')
    expect(keys).toContain('object.material.relief.scale')
    // phong-only fields are withheld while the material is 'standard'
    expect(keys).not.toContain('object.material.shininess')
  })

  it('drops material controls for a GLB without materialOverride, keeps them once it is set', () => {
    const doc = defaultDoc()
    const glb = createGlbObject('https://example.com/m.glb', [])
    expect(visibleSceneControls(doc, glb).some((c) => c.key.startsWith('object.material.'))).toBe(false)
    glb.materialOverride = true
    expect(visibleSceneControls(doc, glb).some((c) => c.key === 'object.material.color')).toBe(true)
  })

  it('always offers Lighting, Camera and Post controls regardless of the active object', () => {
    const doc = defaultDoc()
    const light = createLight('point', [])
    const keys = visibleSceneControls(doc, light).map((c) => c.key)
    expect(keys).toContain('lighting.sunAzimuth')
    expect(keys).toContain('camera.fov')
    expect(keys).toContain('post.bloomStrength')
  })

  it('returns only members of SCENE_CONTROLS, in SCENE_SECTIONS order', () => {
    const doc = defaultDoc()
    const prim = createPrimitive('box', [])
    const all = new Set(SCENE_CONTROLS.map((c) => c.key))
    const visible = visibleSceneControls(doc, prim)
    for (const c of visible) expect(all.has(c.key), c.key).toBe(true)
    const seenGroups = visible.map((c) => SCENE_SECTIONS.indexOf(c.group as (typeof SCENE_SECTIONS)[number]))
    const sorted = [...seenGroups].sort((a, b) => a - b)
    expect(seenGroups).toEqual(sorted)
  })
})

describe('text-kind controls for the agent', () => {
  const ctl = { key: 'object.material.texture', label: 'Texture', kind: 'text', default: '', group: 'Material', aiEditable: true, hint: 'h' } as any
  it('is described only when opted in', () => {
    expect(describeControls([ctl], {})).toHaveLength(1)
    expect(describeControls([{ ...ctl, aiEditable: undefined }], {})).toHaveLength(0)
  })
  it('validates as a trimmed, capped string', () => {
    const d = describeControls([ctl], {})
    expect(validatePatch({ 'object.material.texture': '  wood planks ' }, d)).toEqual({ 'object.material.texture': 'wood planks' })
    expect(validatePatch({ 'object.material.texture': '' }, d)).toEqual({})
    expect(validatePatch({ 'object.material.texture': 7 }, d)).toEqual({})
    expect(validatePatch({ 'object.material.texture': 'x'.repeat(200) }, d)['object.material.texture']).toHaveLength(80)
  })
})

describe('screen finish controls', () => {
  const keysFor = (type: MaterialType) => {
    const doc = defaultDoc()
    const prim = createPrimitive('sphere', [])
    prim.material.type = type
    return visibleSceneControls(doc, prim).map((c) => c.key)
  }
  it('offers the screen rows on every material type except the transmissive ones (glass, gemstone)', () => {
    const noScreen = new Set(['glass', 'gemstone'])
    for (const type of MATERIAL_TYPES) {
      const keys = keysFor(type)
      const has = keys.includes('object.material.screen.pattern')
      expect(has, type).toBe(!noScreen.has(type))
      if (has) {
        for (const k of ['density', 'angle', 'contrast', 'softness', 'misregister', 'invert', 'gap', 'gapColor', 'ink', 'inkColor']) {
          expect(keys, `${type} ${k}`).toContain(`object.material.screen.${k}`)
        }
      }
    }
  })
  it('the pattern select lists none/dots/lines/cross with plain labels', () => {
    const c = SCENE_CONTROLS.find((c) => c.key === 'object.material.screen.pattern') as any
    expect(c.options).toEqual(['none', 'dots', 'lines', 'cross'])
    expect(c.optionLabels).toEqual(['None', 'Dots', 'Lines', 'Cross'])
  })
  it('every screen row has a plain-language hint (except the colour rows and the switch)', () => {
    for (const c of SCENE_CONTROLS.filter((c) => c.key.startsWith('object.material.screen.'))) {
      if (c.kind === 'color' || c.kind === 'switch') continue
      expect((c as any).hint, c.key).toBeTruthy()
    }
  })
  it('gap and ink colours show only when their mode is colour', () => {
    const gap = SCENE_CONTROLS.find((c) => c.key === 'object.material.screen.gapColor') as any
    expect(gap.showIf).toEqual({ key: 'object.material.screen.gap', equals: 'colour' })
    const ink = SCENE_CONTROLS.find((c) => c.key === 'object.material.screen.inkColor') as any
    expect(ink.showIf).toEqual({ key: 'object.material.screen.ink', equals: 'colour' })
  })

  describe('floor controls', () => {
    const byKey = (k: string) => SCENE_CONTROLS.find((c) => c.key === k) as any
    const doc = (floorMode: string) => ({ ...defaultDoc(), floorMode }) as any

    it('floorMode is a select with four sentence-case labels', () => {
      const c = byKey('floorMode')
      expect(c.kind).toBe('select')
      expect(c.options).toEqual(['off', 'shadow', 'reflection', 'polished'])
      expect(c.optionLabels).toEqual(['Off', 'Shadow only', 'Reflection', 'Polished'])
    })
    it('reflectivity shows for reflection and polished only', () => {
      const c = byKey('floorReflectivity')
      expect(c.when(doc('off'))).toBe(false)
      expect(c.when(doc('shadow'))).toBe(false)
      expect(c.when(doc('reflection'))).toBe(true)
      expect(c.when(doc('polished'))).toBe(true)
    })
    it('floor colour shows for polished only', () => {
      const c = byKey('floorColor')
      expect(c.when(doc('polished'))).toBe(true)
      expect(c.when(doc('reflection'))).toBe(false)
      expect(c.when(doc('off'))).toBe(false)
    })
  })
})

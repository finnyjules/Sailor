import { describe, it, expect } from 'vitest'
import {
  createPrimitive, defaultDoc, parseDoc, serializeDoc, screenOf, MATERIAL_DEFAULTS, MATERIAL_TYPES,
  SCREEN_PATTERNS, SCREEN_GAPS, SCREEN_INKS, type SceneMaterial,
} from '~/lib/scene3d/config'

const withScreen = (screen: Partial<SceneMaterial['screen']>) => {
  const doc = defaultDoc()
  const o = createPrimitive('sphere', doc.objects)
  o.material.screen = screen as SceneMaterial['screen']
  doc.objects.push(o)
  return doc
}

describe('scene3d screen — config', () => {
  it('the material type list is untouched — a screen is a finish, not a type', () => {
    expect(MATERIAL_TYPES).toEqual(['standard', 'phong', 'toon', 'matcap', 'glass', 'fresnel', 'gradient', 'opalescent', 'holographic', 'image', 'shaderFill'])
    expect([...SCREEN_PATTERNS]).toEqual(['none', 'dots', 'lines', 'cross'])
    expect([...SCREEN_GAPS]).toEqual(['transparent', 'colour'])
    expect([...SCREEN_INKS]).toEqual(['lit', 'colour'])
  })

  it('a doc without a screen round-trips with no screen field at all', () => {
    const doc = defaultDoc()
    doc.objects.push(createPrimitive('box', doc.objects))
    const back = parseDoc(serializeDoc(doc))
    expect(back).toEqual(doc)
    expect((back.objects[0] as any).material.screen).toBeUndefined()
  })

  it('screenOf fills every field from MATERIAL_DEFAULTS and reads pattern none when absent', () => {
    const s = screenOf({})
    expect(s).toEqual({
      pattern: 'none', density: MATERIAL_DEFAULTS.screenDensity, angle: MATERIAL_DEFAULTS.screenAngle,
      contrast: MATERIAL_DEFAULTS.screenContrast, softness: MATERIAL_DEFAULTS.screenSoftness,
      misregister: MATERIAL_DEFAULTS.screenMisregister, invert: false,
      gap: 'transparent', gapColor: MATERIAL_DEFAULTS.screenGapColor, ink: 'lit', inkColor: MATERIAL_DEFAULTS.screenInkColor,
    })
    expect(MATERIAL_DEFAULTS.screenDensity).toBe(48)
    expect(MATERIAL_DEFAULTS.screenAngle).toBe(45)
    expect(MATERIAL_DEFAULTS.screenContrast).toBe(1)
    expect(MATERIAL_DEFAULTS.screenSoftness).toBe(0.15)
    expect(MATERIAL_DEFAULTS.screenMisregister).toBe(0)
    expect(MATERIAL_DEFAULTS.screenGapColor).toBe('#ffffff')
    expect(MATERIAL_DEFAULTS.screenInkColor).toBe('#111111')
  })

  it('a full screen block round-trips exactly', () => {
    const doc = withScreen({ pattern: 'dots', density: 60, angle: 30, contrast: 1.5, softness: 0.2, misregister: 0.4, invert: true, gap: 'colour', gapColor: '#ff2d95', ink: 'colour', inkColor: '#000000' })
    expect(parseDoc(serializeDoc(doc))).toEqual(doc)
  })

  it('junk degrades field by field, never dropping the block', () => {
    const raw = JSON.parse(serializeDoc(withScreen({ pattern: 'dots' })))
    raw.objects[0].material.screen = { pattern: 'stipple', density: 'lots', angle: 999, contrast: -3, softness: 2, misregister: 7, gap: 'holes', ink: 'wax', gapColor: 12 }
    const s = parseDoc(JSON.stringify(raw)).objects[0]!.material.screen!
    expect(s.pattern).toBe('none')
    expect(s.density).toBe(MATERIAL_DEFAULTS.screenDensity)
    expect(s.angle).toBe(180)        // clamped
    expect(s.contrast).toBe(0.25)    // clamped
    expect(s.softness).toBe(1)       // clamped
    expect(s.misregister).toBe(1)    // clamped
    expect(s.gap).toBe('transparent')
    expect(s.ink).toBe('lit')
    expect(s.gapColor).toBeUndefined()
  })

  it('density clamps to 4..200', () => {
    const raw = JSON.parse(serializeDoc(withScreen({ pattern: 'lines', density: 1000 })))
    expect(parseDoc(JSON.stringify(raw)).objects[0]!.material.screen!.density).toBe(200)
    raw.objects[0].material.screen.density = 1
    expect(parseDoc(JSON.stringify(raw)).objects[0]!.material.screen!.density).toBe(4)
  })
})

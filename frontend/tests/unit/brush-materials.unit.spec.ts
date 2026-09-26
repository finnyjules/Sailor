import { describe, it, expect } from 'vitest'
import { MATERIAL_IDS, MATERIALS, isMaterialId, MATERIAL_GLSL } from '~/lib/brushTips/materials'

describe('brush materials catalogue', () => {
  it('has the six materials in order with exact labels', () => {
    expect(MATERIAL_IDS).toEqual(['foil', 'chrome', 'lava', 'ink', 'neon', 'oil'])
    expect(MATERIAL_IDS.map(id => MATERIALS[id].label)).toEqual(['Holographic foil', 'Liquid chrome', 'Lava', 'Marbled ink', 'Neon', 'Oil slick'])
    expect(MATERIAL_IDS.map(id => MATERIALS[id].index)).toEqual([1, 2, 3, 4, 5, 6])
    for (const id of MATERIAL_IDS) expect(MATERIALS[id].swatchColor).toMatch(/^#[0-9a-f]{6}$/)
  })
  it('recognises ids', () => {
    expect(isMaterialId('lava')).toBe(true)
    expect(isMaterialId('paint')).toBe(false)
    expect(isMaterialId(undefined)).toBe(false)
  })
  it('GLSL defines shadeMaterial with a stroke and a surface variant per material, size-independent chrome', () => {
    expect(MATERIAL_GLSL).toContain('vec4 shadeMaterial(int mat, float a, float d, vec2 surf, bool has, float sU, float sV, float sSeed, float uTime, vec3 N)')
    expect(MATERIAL_GLSL).not.toMatch(/uCss|gl_FragCoord/)   // no screen-space terms: looks must not depend on render size
    expect((MATERIAL_GLSL.match(/has \?/g) || []).length).toBeGreaterThanOrEqual(6)
  })
})

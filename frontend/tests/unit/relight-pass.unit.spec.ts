import { describe, it, expect } from 'vitest'
import { packLights, relightShouldRun, RELIGHT_FRAG } from '~/lib/relight/relightPass'
import { sanitizeRelightWithLegacyLights as sanitizeRelight } from '~/lib/relight/settings'
import { applySetup } from '~/lib/relight/presets'

describe('relight pass', () => {
  it('packs only lights that are on, in order, as vec2 pairs', () => {
    const fx = applySetup(sanitizeRelight(null), 'Neon')
    fx.lights[0]!.on = false
    const p = packLights(fx)
    expect(p.uLightCount).toBe(1)
    expect([...p.uLightPos.slice(0, 2)]).toEqual([expect.closeTo(0.95, 5), expect.closeTo(0.45, 5)])
    expect([...p.uLightHR.slice(0, 2)]).toEqual([expect.closeTo(0.35, 5), expect.closeTo(0.8, 5)])
    // #29d8ff → 0x29/255, 0xd8/255 | 0xff/255, brightness 2.2
    expect(p.uLightRG[0]).toBeCloseTo(0x29 / 255, 5)
    expect(p.uLightRG[1]).toBeCloseTo(0xd8 / 255, 5)
    expect(p.uLightBP[0]).toBeCloseTo(1, 5)
    expect(p.uLightBP[1]).toBeCloseTo(2.2, 5)
    expect(p.uLightPos).toHaveLength(6)
  })
  it('runs when visible, skips when hidden', () => {
    const fx = sanitizeRelight(null)
    expect(relightShouldRun(fx)).toBe(true)
    expect(relightShouldRun({ ...fx, visible: false })).toBe(false)
  })
  it('declares every uniform the packer sends', () => {
    for (const u of ['uLightPos', 'uLightHR', 'uLightRG', 'uLightBP', 'uLightCount', 'uKeep', 'uRelief', 'uDetail', 'uGloss', 'uShadows', 'uAspect', 'uDepthTexel', 'uImgTexel'])
      expect(RELIGHT_FRAG).toContain(u)
  })
  it('keeps the source alpha (straight alpha, like DOF)', () => {
    expect(RELIGHT_FRAG).toMatch(/fragColor = vec4\(toSrgb\(col\), src\.a\)/)
  })
  it('declares uNormals and uHasNormals', () => {
    expect(RELIGHT_FRAG).toContain('uNormals')
    expect(RELIGHT_FRAG).toContain('uHasNormals')
  })
  it('flips the model normal map\'s green channel (green = up; lighting space is y-down)', () => {
    expect(RELIGHT_FRAG).toMatch(/m\.y = -m\.y/)
  })
  it('samples normals through the same depth-rect mapping the depth lookup uses', () => {
    const hDef = RELIGHT_FRAG.match(/float H\(vec2 p\) \{ return texture\(uDepth, (\w+)\(p\)\)\.r; \}/)
    expect(hDef).toBeTruthy()
    const helper = hDef![1]!
    expect(RELIGHT_FRAG).toContain(`texture(uNormals, ${helper}(p))`)
  })
})

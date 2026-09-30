import { describe, it, expect } from 'vitest'
import { packLights, relightShouldRun, RELIGHT_FRAG } from '~/lib/relight/relightPass'
import { sanitizeRelight } from '~/lib/relight/settings'
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
})

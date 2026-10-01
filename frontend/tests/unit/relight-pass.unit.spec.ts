import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { relightShouldRun, RELIGHT_FRAG } from '~/lib/relight/relightPass'
import {
  FACING_FRAG, facingUniforms, originalLightLods, originalLightActive, FACING_CONTACT_DIRS, FACING_CONTACT_ELEVATION,
} from '~/lib/frame/lighting/facingPass'
import { sanitizeRelight } from '~/lib/relight/settings'
import { FULL_DEPTH_RECT } from '~/lib/relight/depthFieldCore'

// Light layers stage 2: Relight's per-photo pass makes the facing tile and Original light; the
// lights are the Frame's. The normal / relief / contact maths is the old pass's, verbatim.
const PRE_STAGE2 = readFileSync(fileURLToPath(new URL('./fixtures/relight-frag-pre-stage2.glsl', import.meta.url)), 'utf8')
  .split('\n').filter(l => !l.startsWith('// RELIGHT_FRAG (') && !l.startsWith('// the stage 2 facing pass')).join('\n').trim()

describe('relight per-photo pass (light layers stage 2)', () => {
  it('ports the old shader\'s G / fieldUv / H / slopeAt / normalAt / shadowTo VERBATIM', () => {
    expect(PRE_STAGE2.length).toBeGreaterThan(2000)
    expect(FACING_FRAG).toContain(PRE_STAGE2)
    expect(RELIGHT_FRAG).toBe(FACING_FRAG)
  })
  it('lights nothing itself: no light uniforms', () => {
    for (const u of ['uLightPos', 'uLightHR', 'uLightRG', 'uLightBP', 'uLightCount', 'uGloss']) expect(FACING_FRAG).not.toContain(u)
  })
  it('runs when visible, skips when hidden', () => {
    const fx = sanitizeRelight(null)
    expect(relightShouldRun(fx)).toBe(true)
    expect(relightShouldRun({ ...fx, visible: false })).toBe(false)
  })
  it('keeps the source alpha in both modes', () => {
    expect(FACING_FRAG).toMatch(/fragColor = vec4\(toSrgb\(min\([^;]*\), src\.a\);/)
    expect(FACING_FRAG).toMatch(/fragColor = vec4\(\(128\.0 \+ clamp\(r, -1\.0, 1\.0\) \* 127\.0\) \/ 255\.0, contact, src\.a\);/)
  })
  it('flips the model normal map\'s green channel (green = up; lighting space is y-down)', () => {
    expect(FACING_FRAG).toMatch(/m\.y = -m\.y/)
  })
  it('samples normals through the same depth-rect mapping the depth lookup uses', () => {
    const hDef = FACING_FRAG.match(/float H\(vec2 p\) \{ return texture\(uDepth, (\w+)\(p\)\)\.r; \}/)
    expect(hDef).toBeTruthy()
    expect(FACING_FRAG).toContain(`texture(uNormals, ${hDef![1]!}(p))`)
  })
  it('contact is shadowTo averaged round the pixel, only with Shadows on', () => {
    expect(FACING_CONTACT_DIRS).toBe(8)
    expect(FACING_CONTACT_ELEVATION).toBe(0.6)
    expect(FACING_FRAG).toContain('s += shadowTo(P, P + vec3(cos(a), sin(a), 0.60));')
    expect(FACING_FRAG).toContain('float contact = uShadows > 0.5 ? contactAt(P) : 1.0;')
  })
  it('the tile\'s normal is turned by the layer rotation', () => {
    expect(FACING_FRAG).toContain('vec2 r = vec2(N.x * uRot.x - N.y * uRot.y, N.x * uRot.y + N.y * uRot.x);')
  })
})

describe('facingUniforms', () => {
  const fx = { ...sanitizeRelight(null), depth: 6, texture: 3, shadows: false }
  it('sends the dials as the old pass did (Depth → relief, Texture → detail, Shadows), the crop, and the rotation', () => {
    const u = facingUniforms(fx, { u0: 0, v0: 0.25, du: 1, dv: 0.5 }, 1000, 1000, 200, 100, 90, true)
    expect(u.uRelief).toBe(6)
    expect(u.uDetail).toBe(3)
    expect(u.uShadows).toBe(0)
    expect(u.uHasNormals).toBe(1)
    expect(u.uAspect).toBe(2)
    expect(u.uMode).toBe(1)
    expect(u.uDepthRect.vec4).toEqual([0, 0.25, 1, 0.5])
    expect(u.uRot[0]).toBeCloseTo(0, 9)
    expect(u.uRot[1]).toBeCloseTo(1, 9)
    expect([...u.uImgTexel]).toEqual([1 / 200, 1 / 100].map(v => expect.closeTo(v, 9)))
  })
  it('no rotation ⇒ (1, 0); no surfaces ⇒ uHasNormals 0', () => {
    const u = facingUniforms(fx, FULL_DEPTH_RECT, 10, 10, 10, 10, 0, false)
    expect([...u.uRot]).toEqual([1, 0])
    expect(u.uHasNormals).toBe(0)
  })
})

describe('Original light', () => {
  it('keep 1 changes nothing (no pass); anything less flattens', () => {
    expect(originalLightActive(1)).toBe(false)
    expect(originalLightActive(0.12)).toBe(true)
    expect(originalLightActive(0)).toBe(true)
  })
  it('reads the baked light at ~1/4 of the box and the mean at the top mip', () => {
    expect(originalLightLods(1024, 512)).toEqual({ uBlurLod: 8, uMeanLod: 10 })
    expect(originalLightLods(4, 4).uBlurLod).toBe(0)
  })
  it('flattens toward the mean by (1 − keep), clamped, keeping alpha', () => {
    expect(FACING_FRAG).toContain('float k = clamp(lm / max(lb, 1e-4), 0.5, 2.0);')
    expect(FACING_FRAG).toContain('mix(1.0, k, 1.0 - uKeep)')
  })
})

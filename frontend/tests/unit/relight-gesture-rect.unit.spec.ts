// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { recordOnce, wheelGestureRecorder } from '~/lib/relight/gestureHistory'
import { relightDepthRect } from '~/composables/useCompositorLayers'
import { depthRectUniforms, RELIGHT_FRAG } from '~/lib/relight/relightPass'
import { FULL_DEPTH_RECT } from '~/lib/relight/depthFieldCore'

describe('Relight gesture history', () => {
  it('a drag records once, on its first move — a click that never moves records nothing', () => {
    let n = 0
    const click = recordOnce(() => n++)
    expect(n).toBe(0)
    void click
    const drag = recordOnce(() => n++)
    drag(); drag(); drag()
    expect(n).toBe(1)
  })
  it('a wheel run records once; a new run after 300 ms of quiet records again', () => {
    let n = 0, t = 0
    const wheel = wheelGestureRecorder(() => n++, () => t)
    for (let i = 0; i < 40; i++) { wheel(); t += 16 }   // a trackpad flick, 16 ms apart
    expect(n).toBe(1)
    t += 299 - 16; wheel()                              // 299 ms after the last event
    expect(n).toBe(1)                                   // still the same run
    t += 300; wheel()
    expect(n).toBe(2)
  })
})

describe('relightDepthRect', () => {
  it('is the whole image without a cover crop', () => {
    expect(relightDepthRect(1000, 1000, 400, 200, null)).toBe(FULL_DEPTH_RECT)
    expect(relightDepthRect(1000, 1000, 400, 200, { fit: 'fill' })).toBe(FULL_DEPTH_RECT)
  })
  it('matches the cover crop drawLayerContent draws (square photo in a 2:1 box)', () => {
    const r = relightDepthRect(1000, 1000, 400, 200, { fit: 'cover' })
    expect(r).toEqual({ u0: 0, v0: 0.25, du: 1, dv: 0.5 })
    const top = relightDepthRect(1000, 1000, 400, 200, { fit: 'cover', fy: 0 })
    expect(top.v0).toBe(0)
  })
  it('crops horizontally for a tall box, around the focus point', () => {
    const r = relightDepthRect(2000, 1000, 100, 100, { fit: 'cover', fx: 1 })
    expect(r).toEqual({ u0: 0.5, v0: 0, du: 0.5, dv: 1 })
  })
})

describe('depth rect uniforms', () => {
  it('sends the rect and one field texel in box units', () => {
    const u = depthRectUniforms({ u0: 0, v0: 0.25, du: 1, dv: 0.5 }, 1000, 1000)
    expect(u.uDepthRect.vec4).toEqual([0, 0.25, 1, 0.5])
    expect(u.uDepthTexel[0]).toBeCloseTo(1 / 1000, 8)
    expect(u.uDepthTexel[1]).toBeCloseTo(1 / 500, 8)    // half the field spans the box: a texel is twice as big
  })
  it('the shader reads depth through the rect', () => {
    expect(RELIGHT_FRAG).toMatch(/uniform vec4 uDepthRect/)
    expect(RELIGHT_FRAG).toMatch(/vec2 fieldUv\(vec2 p\) \{ return G\(uDepthRect\.xy \+ p \* uDepthRect\.zw\); \}/)
    expect(RELIGHT_FRAG).toMatch(/texture\(uDepth, fieldUv\(p\)\)/)
  })
})

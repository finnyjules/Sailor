// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useBrushPaint, effectLayerMatches, shaderPaintMatches, paintTargetMatches,
} from '~/composables/useBrushPaint'

const STORE_KEY = 'sailor.brushTips.v1'
beforeEach(() => localStorage.clear())

describe('brush mode + effect + shaderPaint defaults', () => {
  it('defaults to paint mode, water_ripple effect, no shaderPaint', () => {
    const b = useBrushPaint()
    expect(b.mode.value).toBe('paint')
    expect(b.effect.value).toBe('water_ripple')
    expect(b.shaderPaint.value).toBeNull()
  })
})

describe('persistence round trip', () => {
  it('remembers mode, effect and shaderPaint across instances', () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ mode: 'effect', effect: 'bloom', shaderPaint: 'prism' }))
    const b = useBrushPaint()
    expect(b.mode.value).toBe('effect')
    expect(b.effect.value).toBe('bloom')
    expect(b.shaderPaint.value).toBe('prism')
  })
  it('falls back to defaults on bad values', () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ mode: 'bogus', effect: 42, shaderPaint: 7 }))
    const b = useBrushPaint()
    expect(b.mode.value).toBe('paint')
    expect(b.effect.value).toBe('water_ripple')
    expect(b.shaderPaint.value).toBeNull()
  })
  it('accepts mask, rejects anything outside paint/effect/mask', () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ mode: 'mask' }))
    expect(useBrushPaint().mode.value).toBe('mask')
    localStorage.setItem(STORE_KEY, JSON.stringify({ mode: 'wat' }))
    expect(useBrushPaint().mode.value).toBe('paint')
  })
})

describe('mutual clearing', () => {
  it('choosing a material clears shaderPaint', () => {
    const b = useBrushPaint()
    b.chooseShaderPaint('prism')
    expect(b.shaderPaint.value).toBe('prism')
    b.chooseMaterial('lava')
    expect(b.material.value).toBe('lava')
    expect(b.shaderPaint.value).toBeNull()
  })
  it('choosing Colour (material null) clears shaderPaint', () => {
    const b = useBrushPaint()
    b.chooseShaderPaint('prism')
    b.chooseMaterial(null)
    expect(b.material.value).toBeNull()
    expect(b.shaderPaint.value).toBeNull()
  })
  it('choosing a shaderPaint clears material', () => {
    const b = useBrushPaint()
    b.chooseMaterial('foil')
    b.chooseShaderPaint('prism')
    expect(b.shaderPaint.value).toBe('prism')
    expect(b.material.value).toBeNull()
  })
})

describe('effectLayerMatches', () => {
  const layer = (extra: Record<string, unknown> = {}) => ({ showPaint: false, effects: [], ...extra })
  it('true when showPaint is false and a visible backdrop_shader targets the effect', () => {
    const l = layer({ effects: [{ type: 'backdrop_shader', effectId: 'water_ripple', visible: true }] })
    expect(effectLayerMatches(l, 'water_ripple')).toBe(true)
  })
  it('false for a different effectId', () => {
    const l = layer({ effects: [{ type: 'backdrop_shader', effectId: 'bloom', visible: true }] })
    expect(effectLayerMatches(l, 'water_ripple')).toBe(false)
  })
  it('false when showPaint is not false (paint layer)', () => {
    const l = layer({ showPaint: true, effects: [{ type: 'backdrop_shader', effectId: 'water_ripple', visible: true }] })
    expect(effectLayerMatches(l, 'water_ripple')).toBe(false)
  })
  it('false when the backdrop_shader is hidden', () => {
    const l = layer({ effects: [{ type: 'backdrop_shader', effectId: 'water_ripple', visible: false }] })
    expect(effectLayerMatches(l, 'water_ripple')).toBe(false)
  })
  it('false when the layer is undefined or has no effect stack', () => {
    expect(effectLayerMatches(undefined, 'water_ripple')).toBe(false)
    expect(effectLayerMatches(layer(), 'water_ripple')).toBe(false)
  })
})

describe('shaderPaintMatches', () => {
  const shaderFill = (effectId: string) => ({ type: 'shader', a: '#000', b: '#fff', textColor: '#000', angle: 0, density: 1, shader: { effectId, params: {}, anchor: 'frame', speed: 0, seed: 42 } })
  it('null shaderId is always false', () => {
    expect(shaderPaintMatches(shaderFill('prism'), null)).toBe(false)
  })
  it('true for a shader fill with a matching effectId', () => {
    expect(shaderPaintMatches(shaderFill('prism'), 'prism')).toBe(true)
  })
  it('false for a different effectId', () => {
    expect(shaderPaintMatches(shaderFill('prism'), 'chrome_shader')).toBe(false)
  })
  it('false for a non-shader fill or non-fill value', () => {
    expect(shaderPaintMatches({ type: 'solid', a: '#000', b: '#fff', textColor: '#000', angle: 0, density: 1 }, 'prism')).toBe(false)
    expect(shaderPaintMatches('#ff0000', 'prism')).toBe(false)
    expect(shaderPaintMatches(undefined, 'prism')).toBe(false)
  })
})

describe('paintTargetMatches', () => {
  const shaderFill = (effectId: string) => ({ type: 'shader', a: '#000', b: '#fff', textColor: '#000', angle: 0, density: 1, shader: { effectId, params: {}, anchor: 'frame', speed: 0, seed: 42 } })
  it('a Colour layer matches a Colour toolbar', () => {
    expect(paintTargetMatches({}, { material: null, shaderPaint: null })).toBe(true)
  })
  it('a material layer matches the same material toolbar, not a different one', () => {
    expect(paintTargetMatches({ material: { id: 'lava' } }, { material: 'lava', shaderPaint: null })).toBe(true)
    expect(paintTargetMatches({ material: { id: 'lava' } }, { material: 'foil', shaderPaint: null })).toBe(false)
  })
  it('a shader-paint layer matches the same shaderPaint toolbar, not a different one', () => {
    expect(paintTargetMatches({ fill: shaderFill('prism') }, { material: null, shaderPaint: 'prism' })).toBe(true)
    expect(paintTargetMatches({ fill: shaderFill('prism') }, { material: null, shaderPaint: 'chrome_shader' })).toBe(false)
  })
  it('a shaderPaint toolbar requires no material on the layer', () => {
    const l = { material: { id: 'lava' as const }, fill: shaderFill('prism') }
    expect(paintTargetMatches(l, { material: null, shaderPaint: 'prism' })).toBe(false)
  })
  it('an effect layer (showPaint: false) never matches Paint mode', () => {
    const l = { showPaint: false, fill: shaderFill('prism') }
    expect(paintTargetMatches(l, { material: null, shaderPaint: 'prism' })).toBe(false)
    expect(paintTargetMatches({ showPaint: false }, { material: null, shaderPaint: null })).toBe(false)
  })
})

import { describe, it, expect } from 'vitest'
import {
  halationTintInPlace, defaultPostEffect, chainActive, isChainEffect,
  POST_FX_PARAM_CLAMP, type HalationEffect,
} from '~/lib/compositor/postEffects'
import { EFFECT_ORDER, EFFECT_LABELS, regionOf } from '~/lib/compositor/effectStack'

const px = (r: number, g: number, b: number, a = 255) => new Uint8ClampedArray([r, g, b, a])

describe('halationTintInPlace', () => {
  it('drops pixels under the threshold to transparent', () => {
    const d = px(40, 40, 40)
    halationTintInPlace(d, 0.7, [1, 0.2, 0.05])
    expect(d[3]).toBe(0)
  })
  it('recolours a bright pixel by its luminance times the tint — red regardless of source hue', () => {
    const d = px(200, 255, 255)            // a bright cyan
    halationTintInPlace(d, 0.5, [1, 0.2, 0.05])
    const lum = 0.2126 * 200 + 0.7152 * 255 + 0.0722 * 255
    expect(d[0]).toBe(Math.round(lum))
    expect(d[1]).toBe(Math.round(lum * 0.2))
    expect(d[2]).toBe(Math.round(lum * 0.05))
    expect(d[3]).toBe(255)
  })
})

describe('halation registration', () => {
  it('has readable defaults', () => {
    expect(defaultPostEffect('halation')).toEqual({ type: 'halation', amount: 0.6, spread: 1, visible: true })
  })
  it('clamps its dials for the panel and the agent', () => {
    expect(POST_FX_PARAM_CLAMP.halation).toEqual({ amount: [0, 1.5], spread: [0.3, 2] })
  })
  it('is a chain kind, so a document with only halation runs the post chain', () => {
    const h: HalationEffect = { type: 'halation', amount: 0.6, spread: 1, visible: true }
    expect(isChainEffect(h)).toBe(true)
    expect(chainActive([h])).toBe(true)
  })
  it('sits right after bloom in the layer stack, in the pixel region, labelled in sentence case', () => {
    const i = (EFFECT_ORDER as readonly string[]).indexOf('halation')
    expect((EFFECT_ORDER as readonly string[])[i - 1]).toBe('bloom')
    expect(regionOf('halation')).toBe('pixel')
    expect(EFFECT_LABELS.halation).toBe('Halation')
  })
})

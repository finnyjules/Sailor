// frontend/tests/unit/shaderfill-needs-clock.unit.spec.ts
//
// Pins `hasAnimatedShaderFill` — the pure predicate the Frame node card and the
// Compositor modal both use to decide whether THEY need to own a clock (start a
// rAF loop) at all. It must be exact: a `speed: 0` shader fill is deliberately
// frozen and must NOT be treated as "needs a clock" (a Frame with only frozen
// fills must gain no new per-frame cost), while any `speed !== 0` fill DOES need
// one, whether it lives on a local layer's fill/stroke or on the doc background.
import { describe, expect, it } from 'vitest'
import { hasAnimatedShaderFill, type StackItem } from '~/composables/useCompositorLayers'
import { DEFAULT_SHADER_SPEC, type Fill } from '~/lib/spacetype/fillTile'

const solidFill: Fill = { type: 'solid', a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 45, density: 8 }
const shaderFill = (speed: number): Fill => ({
  ...solidFill,
  type: 'shader',
  shader: { ...DEFAULT_SHADER_SPEC, speed },
})

// Minimal LocalLayer fixtures — `as any` matches the pattern used elsewhere in this
// suite (e.g. layer-edits.unit.spec.ts) for fixtures that only exercise a few fields.
const rectLayer = (fill: Fill, stroke?: Fill): any => ({
  id: 'r1', kind: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2, rotation: 0, opacity: 1, fill, stroke,
})
const textLayer = (color: Fill | string, strokeColor?: Fill): any => ({
  id: 't1', kind: 'text', x: 0.5, y: 0.5, w: 0.2, h: 0.2, rotation: 0, opacity: 1,
  text: 'hi', color, strokeColor, fontFamily: 'Inter', fontSize: 24,
})
const localItem = (layer: any): StackItem => ({ type: 'local', key: `l:${layer.id}`, layer })
const wiredItem = (key = 'w:1'): StackItem => ({ type: 'wired', key, draw: () => {} })

describe('hasAnimatedShaderFill', () => {
  it('is false for no items and no background', () => {
    expect(hasAnimatedShaderFill([])).toBe(false)
  })

  it('is false when a layer carries a plain (non-shader) fill', () => {
    expect(hasAnimatedShaderFill([localItem(rectLayer(solidFill))])).toBe(false)
  })

  it('is false for a FROZEN shader fill (speed: 0) — must stay expressible as "still"', () => {
    expect(hasAnimatedShaderFill([localItem(rectLayer(shaderFill(0)))])).toBe(false)
  })

  it('is true for a LIVE shader fill (speed !== 0) on a layer fill', () => {
    expect(hasAnimatedShaderFill([localItem(rectLayer(shaderFill(1)))])).toBe(true)
  })

  it('is true for a negative speed too (still "not zero")', () => {
    expect(hasAnimatedShaderFill([localItem(rectLayer(shaderFill(-2)))])).toBe(true)
  })

  it('checks the STROKE slot as well as fill', () => {
    expect(hasAnimatedShaderFill([localItem(rectLayer(solidFill, shaderFill(1)))])).toBe(true)
    expect(hasAnimatedShaderFill([localItem(rectLayer(solidFill, shaderFill(0)))])).toBe(false)
  })

  it('checks a text layer\'s color/strokeColor slots (kind-specific layerPaints)', () => {
    expect(hasAnimatedShaderFill([localItem(textLayer(shaderFill(1)))])).toBe(true)
    expect(hasAnimatedShaderFill([localItem(textLayer('#fff', shaderFill(1)))])).toBe(true)
    expect(hasAnimatedShaderFill([localItem(textLayer(shaderFill(0)))])).toBe(false)
  })

  it('ignores wired items entirely (they carry no Paint of their own)', () => {
    expect(hasAnimatedShaderFill([wiredItem(), localItem(rectLayer(shaderFill(0)))])).toBe(false)
  })

  it('a live background fill counts even with zero/only-frozen layers', () => {
    expect(hasAnimatedShaderFill([], shaderFill(1))).toBe(true)
    expect(hasAnimatedShaderFill([localItem(rectLayer(shaderFill(0)))], shaderFill(1))).toBe(true)
  })

  it('a frozen background fill does not count', () => {
    expect(hasAnimatedShaderFill([], shaderFill(0))).toBe(false)
  })

  it('one live fill among many frozen/plain ones is enough to flip it true', () => {
    const items = [
      localItem(rectLayer(solidFill)),
      localItem(rectLayer(shaderFill(0))),
      localItem(rectLayer(shaderFill(2))),
    ]
    expect(hasAnimatedShaderFill(items)).toBe(true)
  })
})

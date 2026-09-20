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
import { setShaderFxCatalog } from '~/lib/shaderfx/catalogStore'

// F5 Task 4: a shader-catalog-as-a-pass EFFECT (distinct from a shader FILL above) can
// also be animated, and the modal's live loop must recognise it too, or a picked
// animated effect at a nonzero speed renders once and freezes. Live requires BOTH the
// catalog def's `animated: true` AND a nonzero speed — a static def (e.g. the real
// `chromatic_aberration`) never reads u_time regardless of speed, so speed alone must
// never flip this true. `anim_fx`'s catalog def is animated:true; `still_fx`'s is
// animated:false — both fixtures are otherwise identical so only the `animated` flag
// (and, separately, `speed`) is under test.
setShaderFxCatalog({
  version: 1,
  effects: [
    { id: 'anim_fx', name: 'Anim FX', category: 'test', animated: true, passes: 1, centerParam: null, textures: [], params: [], source: 'void main(){}' },
    { id: 'still_fx', name: 'Still FX', category: 'test', animated: false, passes: 1, centerParam: null, textures: [], params: [], source: 'void main(){}' },
  ],
} as any)

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

// F5 Task 4: a shader-catalog-as-a-pass EFFECT fixture (`layer.effects`, not `layer.fill`).
const shaderEffectLayer = (effectId: string, speed: number, visible = true): any => ({
  id: 'r2', kind: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2, rotation: 0, opacity: 1, fill: solidFill,
  effects: [{ id: 'sh', type: 'shader', visible, effectId, params: {}, speed, seed: 42 }],
})

// F6 Task 4: the backdrop_shader twin — same shader-catalog-as-a-pass shape, run over the
// layers behind this one. Its liveness predicate is identical to `shader`'s.
const backdropShaderEffectLayer = (effectId: string, speed: number, visible = true): any => ({
  id: 'r3', kind: 'rect', x: 0.5, y: 0.5, w: 0.2, h: 0.2, rotation: 0, opacity: 1, fill: solidFill,
  effects: [{ id: 'bd', type: 'backdrop_shader', visible, effectId, params: {}, speed, seed: 42 }],
})

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

  // F5 Task 4: an animated shader-catalog EFFECT (not a fill) must also flip the
  // predicate, or the modal's live loop never advances for it and the effect
  // freezes after its first paint.
  describe('a shader EFFECT (layer.effects, not layer.fill)', () => {
    it('is false when the picked effect\'s catalog def is animated but speed is 0 (frozen at t=0)', () => {
      expect(hasAnimatedShaderFill([localItem(shaderEffectLayer('anim_fx', 0))])).toBe(false)
    })

    it('is true when the picked effect\'s catalog def is animated AND speed !== 0', () => {
      expect(hasAnimatedShaderFill([localItem(shaderEffectLayer('anim_fx', 1))])).toBe(true)
    })

    it('is false when speed !== 0 but the catalog def is NOT animated (static frag never reads u_time)', () => {
      expect(hasAnimatedShaderFill([localItem(shaderEffectLayer('still_fx', 1))])).toBe(false)
    })

    it('is false for a non-animated effect at speed 0 (genuinely still)', () => {
      expect(hasAnimatedShaderFill([localItem(shaderEffectLayer('still_fx', 0))])).toBe(false)
    })

    it('ignores an invisible shader effect (it never paints, so it never needs to advance)', () => {
      expect(hasAnimatedShaderFill([localItem(shaderEffectLayer('anim_fx', 1, false))])).toBe(false)
    })

    it('is false for an unknown effectId (no catalog def) at speed 0', () => {
      expect(hasAnimatedShaderFill([localItem(shaderEffectLayer('nope', 0))])).toBe(false)
    })
  })

  // F6 Task 4: a backdrop_shader EFFECT is the same shader-catalog-as-a-pass shape (run over the
  // layers behind this one), so it must flip the predicate on exactly the same terms — an
  // animated catalog def AND a nonzero speed. A fresh backdrop_shader defaults to speed 0, so the
  // frozen-at-0 case is the one that keeps a just-added effect from spinning the live loop.
  describe('a backdrop_shader EFFECT (F6, layer.effects)', () => {
    it('is true when the picked effect\'s catalog def is animated AND speed !== 0', () => {
      expect(hasAnimatedShaderFill([localItem(backdropShaderEffectLayer('anim_fx', 1))])).toBe(true)
    })

    it('is false when the catalog def is animated but speed is 0 (the fresh-default: inert)', () => {
      expect(hasAnimatedShaderFill([localItem(backdropShaderEffectLayer('anim_fx', 0))])).toBe(false)
    })

    it('is false when speed !== 0 but the catalog def is NOT animated (static frag never reads u_time)', () => {
      expect(hasAnimatedShaderFill([localItem(backdropShaderEffectLayer('still_fx', 2))])).toBe(false)
    })

    it('ignores an invisible backdrop_shader (it never paints, so it never needs to advance)', () => {
      expect(hasAnimatedShaderFill([localItem(backdropShaderEffectLayer('anim_fx', 1, false))])).toBe(false)
    })
  })
})

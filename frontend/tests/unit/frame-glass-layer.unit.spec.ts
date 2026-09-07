import { describe, it, expect, beforeAll } from 'vitest'
import { setShaderFxCatalog } from '~/lib/shaderfx/catalogStore'
import { isGlassLayer } from '~/composables/useCompositorLayers'
import type { RectLayer, TextLayer } from '~/composables/useCompositorLayers'
import type { Fill } from '~/lib/spacetype/fillTile'

const CATALOG = { effects: [
  { id: 'liquify', name: 'Liquify', source: 'texture(u_image0, uv);' },
  { id: 'plasma', name: 'Plasma', source: 'gl_FragColor = vec4(1.0);', generative: true },
]} as any

function shaderFill(effectId: string, extra: Record<string, unknown> = {}): Fill {
  return {
    type: 'shader',
    a: '#ffffff', b: '#000000', textColor: '#ffffff', angle: 0, density: 8,
    shader: {
      effectId, params: {}, anchor: 'object', speed: 1, seed: 0,
      input: { type: 'solid', a: '#000000', b: '#ffffff', textColor: '#ffffff', angle: 0, density: 8 },
      ...extra,
    },
  } as Fill
}

function rect(fill: Fill | string): RectLayer {
  return {
    id: 'r1', kind: 'rect', x: 0, y: 0, w: 10, h: 10, opacity: 1,
    fill, stroke: 'none', strokeWidth: 0, radius: 0,
  } as unknown as RectLayer
}

function text(color: Fill | string): TextLayer {
  return {
    id: 't1', kind: 'text', x: 0, y: 0, w: 10, h: 10, opacity: 1,
    text: 'Hi', color, strokeColor: 'none',
  } as unknown as TextLayer
}

describe('isGlassLayer', () => {
  beforeAll(() => setShaderFxCatalog(CATALOG))

  it('true for a shader fill reading backdrop with an eligible effect', () => {
    expect(isGlassLayer(rect(shaderFill('liquify', { readsBackdrop: true })))).toBe(true)
  })

  it('false when readsBackdrop is absent', () => {
    expect(isGlassLayer(rect(shaderFill('liquify')))).toBe(false)
  })

  it('false when the effect is purely generative', () => {
    expect(isGlassLayer(rect(shaderFill('plasma', { readsBackdrop: true })))).toBe(false)
  })

  it('false for a non-shader fill', () => {
    expect(isGlassLayer(rect('#ff0000'))).toBe(false)
  })

  it('false for a text layer whose .color is a backdrop-reading shader fill — text has no .fill slot', () => {
    expect(isGlassLayer(text(shaderFill('liquify', { readsBackdrop: true })))).toBe(false)
  })
})

// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { EffectDef } from '~/lib/shaderfx/types'

// Task 3 (glass lens): `renderFieldWithBase` binds an externally supplied canvas as
// `u_image0` instead of rasterising `spec.input` through the input-tile cache. This
// test mocks the WebGL renderer singleton (`shaderFx`, from ~/lib/shaderfx/renderer —
// field.ts's real accessor; there is no `getShaderFx()` getter) so no real GL context
// is needed in vitest/jsdom, and mocks the catalog store so `resolve()` finds an
// effect def for 'liquify' synchronously (in the real app this comes from the fetched
// shader_effects catalog — see catalogStore.ts).

const { renderSpy } = vi.hoisted(() => ({ renderSpy: vi.fn(() => document.createElement('canvas')) }))
vi.mock('~/lib/shaderfx/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/shaderfx/renderer')>()
  return { ...actual, shaderFx: { render: renderSpy } }
})

const FAKE_EFFECT: EffectDef = {
  id: 'liquify', name: 'Liquify', category: 'distort', animated: true, passes: 1,
  centerParam: null, textures: [], params: [], source: '#version 300 es\nvoid main(){}',
}
vi.mock('~/lib/shaderfx/catalogStore', () => ({
  getEffectSync: (id: string) => (id === 'liquify' ? FAKE_EFFECT : null),
  refetchShaderFxCatalog: () => null,
}))

import { renderFieldWithBase } from '~/lib/shaderfill/field'

beforeEach(() => {
  renderSpy.mockClear()
})

describe('renderFieldWithBase', () => {
  it('binds the provided base as the render input, not a tile derived from spec.input', () => {
    const base = document.createElement('canvas')
    base.width = 8; base.height = 8
    const spec = { effectId: 'liquify', params: {}, anchor: 'object', speed: 1, seed: 0, input: '#123456' } as any

    renderFieldWithBase(spec, base, 8, 8)

    expect(renderSpy).toHaveBeenCalledTimes(1)
    // render(passes, base, w, h) — second positional arg must be our exact base canvas,
    // never a canvas derived from spec.input's '#123456' via the input-tile cache.
    expect(renderSpy.mock.calls[0]![1]).toBe(base)
    expect(renderSpy.mock.calls[0]![2]).toBe(8)
    expect(renderSpy.mock.calls[0]![3]).toBe(8)
  })

  it('throws rather than silently falling back when the effect is not in the catalog', () => {
    const base = document.createElement('canvas')
    base.width = 4; base.height = 4
    const spec = { effectId: 'not_a_real_effect', params: {}, anchor: 'object', speed: 1, seed: 0, input: '#000000' } as any

    expect(() => renderFieldWithBase(spec, base, 4, 4)).toThrow()
    expect(renderSpy).not.toHaveBeenCalled()
  })
})

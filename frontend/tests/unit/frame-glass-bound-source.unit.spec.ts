import { describe, it, expect, vi } from 'vitest'
import { resolveGlassSource } from '~/composables/useCompositorLayers'

// Pure helper — no canvas/DOM involved. `renderLayer` and every source/canvas
// stand-in are plain sentinel objects so the test only exercises the resolution
// logic (mask-style byKey lookup + dangling-key fallback), never real painting.

describe('resolveGlassSource', () => {
  it('renders the bound layer when readsLayerKey resolves in byKey', () => {
    const snap = { kind: 'snapshot' }
    const target = { kind: 'stack-item', key: 'l:t1' }
    const rendered = { kind: 'rendered-layer' }
    const byKey = new Map([['l:t1', target]])
    const renderLayer = vi.fn(() => rendered)

    const source = resolveGlassSource({ readsLayerKey: 'l:t1' }, byKey, snap, renderLayer)

    expect(renderLayer).toHaveBeenCalledTimes(1)
    expect(renderLayer).toHaveBeenCalledWith(target)
    expect(source).toBe(rendered)
  })

  it('falls back to the backdrop snapshot when the key is dangling', () => {
    const snap = { kind: 'snapshot' }
    const byKey = new Map([['l:other', { kind: 'stack-item', key: 'l:other' }]])
    const renderLayer = vi.fn(() => ({ kind: 'rendered-layer' }))

    const source = resolveGlassSource({ readsLayerKey: 'l:missing' }, byKey, snap, renderLayer)

    expect(renderLayer).not.toHaveBeenCalled()
    expect(source).toBe(snap)
  })

  it('falls back to the backdrop snapshot when no readsLayerKey is set ("Layers behind")', () => {
    const snap = { kind: 'snapshot' }
    const byKey = new Map([['l:t1', { kind: 'stack-item', key: 'l:t1' }]])
    const renderLayer = vi.fn(() => ({ kind: 'rendered-layer' }))

    const source = resolveGlassSource({}, byKey, snap, renderLayer)

    expect(renderLayer).not.toHaveBeenCalled()
    expect(source).toBe(snap)
  })

  it('falls back to the backdrop snapshot when byKey itself is absent', () => {
    const snap = { kind: 'snapshot' }
    const renderLayer = vi.fn(() => ({ kind: 'rendered-layer' }))

    const source = resolveGlassSource({ readsLayerKey: 'l:t1' }, undefined, snap, renderLayer)

    expect(renderLayer).not.toHaveBeenCalled()
    expect(source).toBe(snap)
  })
})

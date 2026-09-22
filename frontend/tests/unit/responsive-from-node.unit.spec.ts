import { describe, it, expect } from 'vitest'
import { createRectLayer } from '~/composables/useCompositorLayers'
import { frameDocFromProps, isResponsiveFrame } from '~/lib/frame/responsive/fromNode'

describe('frameDocFromProps', () => {
  it('reads the sailor_* bag into a FrameDoc; missing keys default', () => {
    const l = createRectLayer({ id: 'a' })
    const props = { sailor_localLayers: [l], sailor_stackOrder: ['l:a'], sailor_frame: { responsive: true } }
    const d = frameDocFromProps(props, 1920, 1080)
    expect(d.responsive).toBe(true)
    expect(d.layers).toBe(props.sailor_localLayers)   // by reference — the identity fast path depends on it
    expect(d.stackOrder).toEqual(['l:a'])
    expect(d.groups).toEqual([]); expect(d.grid).toBeNull(); expect(d.motion).toBeNull()
    expect(d.designW).toBe(1920); expect(d.designH).toBe(1080)
  })
  it('a grid that is off reads as null; on reads through readGrid defaults', () => {
    expect(frameDocFromProps({ sailor_localGrid: { mode: 'off' } }, 10, 10).grid).toBeNull()
    expect(frameDocFromProps({ sailor_localGrid: { mode: 'explicit', columns: 3 } }, 10, 10).grid?.columns).toBe(3)
  })
  it('isResponsiveFrame is false for every Frame that exists today', () => {
    expect(isResponsiveFrame(undefined)).toBe(false)
    expect(isResponsiveFrame({})).toBe(false)
    expect(isResponsiveFrame({ sailor_frame: { preset: '16:9' } })).toBe(false)
    expect(isResponsiveFrame({ sailor_frame: { responsive: true } })).toBe(true)
  })
})

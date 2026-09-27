import { describe, it, expect } from 'vitest'
import { createRectLayer } from '~/composables/useCompositorLayers'
import { frameDocFromProps, isResponsiveFrame } from '~/lib/frame/responsive/fromNode'
import { readLayoutGrid } from '~/lib/frame/layoutGrid'
import { formatFor } from '~/lib/frame/formats'

describe('frameDocFromProps', () => {
  it('reads the sailor_* bag into a FrameDoc; missing keys default', () => {
    const l = createRectLayer({ id: 'a' })
    const props = { sailor_localLayers: [l], sailor_stackOrder: ['l:a'], sailor_frame: { responsive: true } }
    const d = frameDocFromProps(props, 1920, 1080)
    expect(d.responsive).toBe(true)
    expect(d.layers).toBe(props.sailor_localLayers)   // by reference — the identity fast path depends on it
    expect(d.stackOrder).toEqual(['l:a'])
    expect(d.groups).toEqual([]); expect(d.motion).toBeNull()
    expect(d.designW).toBe(1920); expect(d.designH).toBe(1080)
  })
  it('the grid is the Frame\'s layout grid at the design size, with the design size\'s format', () => {
    const props = { sailor_localLayers: [createRectLayer({ id: 'a' })] }
    const d = frameDocFromProps(props, 1080, 1350)
    const fmt = formatFor(props, 1080, 1350)
    expect(d.format).toEqual(fmt)
    expect(d.grid).toEqual(readLayoutGrid(props, 1080, 1350, fmt))
  })
  it('an old explicit sailor_localGrid migrates through readLayoutGrid', () => {
    const d = frameDocFromProps({ sailor_localGrid: { mode: 'explicit', columns: 3 } }, 1000, 1000)
    expect(d.grid!.auto).toBe(false)
    expect(d.grid!.cols.count).toBe(3)
  })
  it('a hidden grid still holds (showing the grid is a view setting)', () => {
    const d = frameDocFromProps({ sailor_localLayers: [createRectLayer({ id: 'a' })] }, 1000, 1000)
    expect(d.grid!.show).toBe(false)                   // an old Frame's grid reads hidden…
    expect(d.grid).not.toBeNull()                      // …and is still what layers hold to
  })
  it('no grid for an empty design size', () => {
    expect(frameDocFromProps({}, 0, 0).grid).toBeNull()
  })
  it('isResponsiveFrame is false for every Frame that exists today', () => {
    expect(isResponsiveFrame(undefined)).toBe(false)
    expect(isResponsiveFrame({})).toBe(false)
    expect(isResponsiveFrame({ sailor_frame: { preset: '16:9' } })).toBe(false)
    expect(isResponsiveFrame({ sailor_frame: { responsive: true } })).toBe(true)
  })
})

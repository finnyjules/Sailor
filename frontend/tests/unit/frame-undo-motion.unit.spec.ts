import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'

// Timeline edits write `sailor_motion` (motionx bands / behaviours / dial tracks), not layers.
// The undo snapshot used to hold layers only, so Cmd+Z after a timeline edit did nothing.
function makeEditor(motion?: Record<string, unknown>) {
  const properties: Record<string, any> = { sailor_localLayers: [] }
  if (motion) properties.sailor_motion = motion
  const node = reactive({ data: { properties } })
  const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 680, h: 680 }), getRect: () => null })
  return { node, ed }
}
const band = (v: number) => [{ path: 'layers.a.opacity', type: 'number', keyframes: [{ t: 0, value: v, ease: 'linear' }] }]

describe('undo / redo covers timeline edits', () => {
  it('restores motionx + behaviours + dial tracks', () => {
    const { node, ed } = makeEditor({ fps: 30, duration: 4, motionx: band(0), behaviours: [{ id: 'b1' }], tracks: [] })
    ed.recordHistory()
    node.data.properties.sailor_motion = { fps: 30, duration: 4, motionx: band(1), behaviours: [], tracks: [{ id: 't' }] }
    ed.undo()
    expect(node.data.properties.sailor_motion.motionx).toEqual(band(0))
    expect(node.data.properties.sailor_motion.behaviours).toEqual([{ id: 'b1' }])
    expect(node.data.properties.sailor_motion.tracks).toEqual([])
    ed.redo()
    expect(node.data.properties.sailor_motion.motionx).toEqual(band(1))
    expect(node.data.properties.sailor_motion.tracks).toEqual([{ id: 't' }])
  })
  it('undoing the FIRST timeline edit removes the bands again', () => {
    const { node, ed } = makeEditor()
    ed.recordHistory()
    node.data.properties.sailor_motion = { fps: 30, duration: 4, motionx: band(1) }
    ed.undo()
    expect(node.data.properties.sailor_motion?.motionx ?? []).toEqual([])
  })
  it('leaves fps / duration / loop alone — those are transport settings, not edits', () => {
    const { node, ed } = makeEditor({ fps: 30, duration: 4, motionx: band(0) })
    ed.recordHistory()
    node.data.properties.sailor_motion = { fps: 60, duration: 8, loop: true, motionx: band(1) }
    ed.undo()
    expect(node.data.properties.sailor_motion).toMatchObject({ fps: 60, duration: 8, loop: true, motionx: band(0) })
  })
  it('a frame with no motion stays free of a sailor_motion key after undo', () => {
    const { node, ed } = makeEditor()
    ed.recordHistory()
    ed.undo()
    expect('sailor_motion' in node.data.properties).toBe(false)
  })
})

// The Frame section's size and Responsive edits (lib/frame/frameSize) are output, not a guide:
// they undo like any other edit, one step each, without touching the edit before them.
describe('undo / redo covers the frame size', () => {
  function sizedEditor() {
    const properties: Record<string, any> = { sailor_localLayers: [{ id: 'a', kind: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }
    const node = reactive({ data: {
      widgetDefs: [{ name: 'width' }, { name: 'height' }], widgetsValues: [1024, 1024], properties,
    } })
    const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 680, h: 680 }), getRect: () => null })
    return { node, ed }
  }
  it('undoing a size change restores the size and leaves the earlier layer edit alone', async () => {
    const { node, ed } = sizedEditor()
    const { applyFramePreset } = await import('~/lib/frame/frameSize')
    ed.setLocal('a', { x: 0.5 })                      // a layer edit (records its own step)
    ed.recordHistory(); applyFramePreset(node.data, 'A4')
    ed.undo()
    expect(node.data.widgetsValues).toEqual([1024, 1024])
    expect((node.data.properties.sailor_localLayers as any[])[0].x).toBe(0.5)
    ed.redo()
    expect(node.data.widgetsValues).toEqual([1240, 1754])
    expect(node.data.properties.sailor_frame.preset).toBe('A4')
  })
  it('undoing Responsive turns it back off', async () => {
    const { node, ed } = sizedEditor()
    const { setFrameResponsive } = await import('~/lib/frame/frameSize')
    ed.recordHistory(); setFrameResponsive(node.data, true, 1)
    ed.undo()
    expect(node.data.properties.sailor_frame).toBeUndefined()
  })
  it('a node with no size widgets undoes exactly as before', () => {
    const properties: Record<string, any> = { sailor_localLayers: [] }
    const node = reactive({ data: { properties } })
    const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 680, h: 680 }), getRect: () => null })
    ed.recordHistory()
    ed.undo()
    expect(Object.keys(node.data.properties)).not.toContain('sailor_frame')
  })
})

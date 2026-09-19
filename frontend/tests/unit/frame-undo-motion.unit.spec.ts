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

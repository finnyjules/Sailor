import { describe, it, expect } from 'vitest'
import { reactive } from 'vue'
import { useLocalLayerEditor } from '~/composables/useLocalLayerEditor'

// Task 2: duplicate keeps the motion (bands + behaviours) aimed at the copy, not the original.
const L = (id: string): any => ({ id, kind: 'rect', x: 0.2, y: 0.2, rotation: 0, opacity: 1, w: 0.1, h: 0.1 })

function makeEditor() {
  const properties: Record<string, any> = {
    sailor_localLayers: [L('a')],
    sailor_motion: {
      motionx: [{ path: 'layers.a.opacity', type: 'number', keyframes: [{ t: 0, value: 0, ease: 'linear' }], behaviourId: 'bh1' }],
      behaviours: [{ id: 'bh1', kind: 'settle', layerId: 'a', timing: { start: 0, duration: 1 }, params: { effect: 'slice' } }],
      tracks: [],
    },
  }
  const node = reactive({ data: { properties } })
  const ed = useLocalLayerEditor({ node: () => node, dims: () => ({ w: 680, h: 680 }), getRect: () => null })
  return { node, ed }
}

describe('duplicateSelection carries the motion', () => {
  it('the copy gets its own band + behaviour, distinct ids, same timing', async () => {
    const { node, ed } = makeEditor()
    ed.selectLocal('a')
    await ed.duplicateSelection()

    const layerIds = (node.data.properties.sailor_localLayers as any[]).map(l => l.id)
    expect(layerIds).toHaveLength(2)
    const newId = layerIds.find(id => id !== 'a')!

    const motion = node.data.properties.sailor_motion as any
    expect(motion.motionx.map((t: any) => t.path).sort()).toEqual(['layers.a.opacity', `layers.${newId}.opacity`].sort())
    expect(motion.behaviours).toHaveLength(2)
    const orig = motion.behaviours.find((b: any) => b.layerId === 'a')
    const copy = motion.behaviours.find((b: any) => b.layerId === newId)
    expect(orig.id).not.toBe(copy.id)
    expect(copy.timing).toEqual(orig.timing)
    expect(copy.kind).toBe(orig.kind)

    ed.undo()
    expect(node.data.properties.sailor_localLayers).toHaveLength(1)
    expect(node.data.properties.sailor_motion.motionx).toHaveLength(1)
    expect(node.data.properties.sailor_motion.behaviours).toHaveLength(1)
  })
})

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

// Fix (final-review, 2026-09-21): a WIRED layer's motion is keyed to ITS id, and
// ⌘D/copy bake a wired member into a brand-new real layer (`materializeWired`)
// rather than duplicating it in place — so without re-targeting, any band or
// behaviour aimed at the wired layer never reaches the baked copy. A host that
// returns the baked id from `materializeWired` lets the editor carry it; a host
// that returns nothing (old hosts) keeps today's behaviour (motion not carried).
const W = (id: string, slot = 0): any => ({ id, kind: 'wired', slot, x: 0.5, y: 0.5, w: 0.2, lastAspect: 1 })
const BAKED: any = { id: 'baked1', kind: 'rect', x: 0.52, y: 0.5, rotation: 0, opacity: 1, w: 0.2, h: 0.2 }

function makeWiredEditor(materializeWired?: (w: any) => any) {
  const properties: Record<string, any> = {
    sailor_localLayers: [W('w1')],
    sailor_motion: {
      motionx: [{ path: 'layers.w1.opacity', type: 'number', keyframes: [{ t: 0, value: 0, ease: 'linear' }], behaviourId: 'bh-w1' }],
      behaviours: [{ id: 'bh-w1', kind: 'settle', layerId: 'w1', timing: { start: 0, duration: 1 }, params: { effect: 'slice' } }],
      tracks: [],
    },
  }
  const node = reactive({ data: { properties } })
  const ed = useLocalLayerEditor({
    node: () => node, dims: () => ({ w: 680, h: 680 }), getRect: () => null,
    materializeWired,
  })
  return { node, ed }
}

describe('duplicateSelection carries a WIRED layer\'s motion onto its baked copy', () => {
  it('a materializeWired that returns the baked id re-targets the band + behaviour', async () => {
    const { node, ed } = makeWiredEditor((w) => {
      // Mirrors CompositorModal's copyWiredIntoFrame: bakes a real layer,
      // leaves the wired layer itself in place (only hidden), returns its id.
      node.data.properties.sailor_localLayers = [...node.data.properties.sailor_localLayers, { ...BAKED }]
      expect(w.id).toBe('w1')
      return 'baked1'
    })
    ed.selectLocal('w1')
    await ed.duplicateSelection()

    // The wired layer is not removed by materializing — only the baked copy is new.
    const layerIds = (node.data.properties.sailor_localLayers as any[]).map(l => l.id)
    expect(layerIds).toEqual(['w1', 'baked1'])
    // `ids` (the clonable, non-wired part of the selection) was empty, so
    // `duplicateLayers` never ran — baked1 is not itself further duplicated.
    expect(layerIds).toHaveLength(2)

    const motion = node.data.properties.sailor_motion as any
    expect(motion.motionx.map((t: any) => t.path).sort()).toEqual(['layers.baked1.opacity', 'layers.w1.opacity'])
    expect(motion.behaviours).toHaveLength(2)
    const orig = motion.behaviours.find((b: any) => b.layerId === 'w1')
    const copy = motion.behaviours.find((b: any) => b.layerId === 'baked1')
    expect(orig).toBeTruthy()
    expect(copy).toBeTruthy()
    expect(copy.id).not.toBe(orig.id)
    expect(copy.timing).toEqual(orig.timing)
    expect(copy.kind).toBe(orig.kind)
  })

  it('a materializeWired that returns nothing (old hosts) carries no motion', async () => {
    const { node, ed } = makeWiredEditor((_w) => {
      node.data.properties.sailor_localLayers = [...node.data.properties.sailor_localLayers, { ...BAKED }]
      // old-style host: bakes the layer but returns void
    })
    ed.selectLocal('w1')
    await ed.duplicateSelection()

    const layerIds = (node.data.properties.sailor_localLayers as any[]).map(l => l.id)
    expect(layerIds).toEqual(['w1', 'baked1'])

    const motion = node.data.properties.sailor_motion as any
    // Unchanged from the initial doc — still just the wired layer's own band/behaviour.
    expect(motion.motionx).toHaveLength(1)
    expect(motion.motionx[0].path).toBe('layers.w1.opacity')
    expect(motion.behaviours).toHaveLength(1)
    expect(motion.behaviours[0].layerId).toBe('w1')
  })
})

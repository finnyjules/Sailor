import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { Template, SlotKind } from './types'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

export function snapshotFrameAsTemplate(input: {
  id: string; name: string; layers: LocalLayer[]; groups: LayerGroup[]
  frameSize: { w: number; h: number }; mkKey: (index: number) => string
}): Template {
  return {
    id: input.id, name: input.name, version: 1,
    layers: input.layers.map((layer, i) => ({ key: input.mkKey(i), layer: clone(layer) })),
    groups: clone(input.groups),
    slots: [],
    frameSize: { ...input.frameSize },
  }
}

export function addSlot(t: Template, layerKey: string, kind: SlotKind, label: string, mkId: () => string): Template {
  if (!t.layers.some(l => l.key === layerKey)) throw new Error(`no template layer with key ${layerKey}`)
  return { ...t, slots: [...t.slots, { id: mkId(), layerKey, kind, label }] }
}

export function removeSlot(t: Template, slotId: string): Template {
  return { ...t, slots: t.slots.filter(s => s.id !== slotId) }
}

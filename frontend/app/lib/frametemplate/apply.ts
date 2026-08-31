import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'
import type { Template, TemplateInstance, SlotKind } from './types'

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

/** Set a slot's value onto a (cloned) layer, mutating it in place. */
export function applySlotToLayer(layer: any, kind: SlotKind, value: string): void {
  if (kind === 'text') { layer.text = value; return }
  if (kind === 'image') { layer.filename = value; return }
  // color slot → the layer's fill field, by kind
  if (layer.kind === 'text') layer.color = value
  else if (layer.kind === 'image') layer.tint = value
  else if (layer.kind === 'line') layer.stroke = value
  else layer.fill = value // rect / ellipse / path / polygon / star
}

export interface PlaceCtx { mkLayerId: () => string; mkGroupId: () => string; mkInstanceId: () => string }

export function placeTemplate(
  current: { layers: LocalLayer[]; groups: LayerGroup[] },
  t: Template,
  slotValues: Record<string, string>,
  ctx: PlaceCtx,
): { layers: LocalLayer[]; groups: LayerGroup[]; instance: TemplateInstance } {
  const slotByLayerKey = new Map(t.slots.map(s => [s.layerKey, s]))
  const groupIdMap = new Map<string, string>() // template groupId → fresh groupId
  for (const g of t.groups) groupIdMap.set(g.id, ctx.mkGroupId())
  const placedKeys: Record<string, string> = {}

  const newLayers = t.layers.map(({ key, layer }) => {
    const copy: any = clone(layer)
    copy.id = ctx.mkLayerId()
    if (copy.groupId) copy.groupId = groupIdMap.has(copy.groupId) ? groupIdMap.get(copy.groupId) : undefined
    const slot = slotByLayerKey.get(key)
    const slotValue = slot ? slotValues[slot.id] : undefined
    if (slot && slotValue !== undefined) applySlotToLayer(copy, slot.kind, slotValue)
    placedKeys[key] = copy.id
    return copy as LocalLayer
  })

  const newGroups = t.groups.map(g => {
    const ng: any = clone(g)
    ng.id = groupIdMap.get(g.id)!
    if (ng.parentId) ng.parentId = groupIdMap.has(ng.parentId) ? groupIdMap.get(ng.parentId) : undefined
    return ng as LayerGroup
  })

  const instance: TemplateInstance = {
    instanceId: ctx.mkInstanceId(),
    templateId: t.id,
    templateVersion: t.version,
    slotValues: { ...slotValues },
    placedKeys,
  }
  return { layers: [...current.layers, ...newLayers], groups: [...current.groups, ...newGroups], instance }
}

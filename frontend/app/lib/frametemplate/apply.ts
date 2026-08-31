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

export function setInstanceSlot(
  layers: LocalLayer[], t: Template, instance: TemplateInstance, slotId: string, value: string,
): { layers: LocalLayer[]; instance: TemplateInstance } {
  const slot = t.slots.find(s => s.id === slotId)
  if (!slot) throw new Error(`no slot ${slotId}`)
  const layerId = instance.placedKeys[slot.layerKey]
  const next = layers.map(l => {
    if (l.id !== layerId) return l
    const copy: any = clone(l); applySlotToLayer(copy, slot.kind, value); return copy as LocalLayer
  })
  return { layers: next, instance: { ...instance, slotValues: { ...instance.slotValues, [slotId]: value } } }
}

export function freezeInstance(instances: TemplateInstance[], instanceId: string): TemplateInstance[] {
  return instances.filter(i => i.instanceId !== instanceId)
}

export function slotCompatible(t: Template, instance: TemplateInstance): boolean {
  const tplSlotIds = t.slots.map(s => s.id).sort()
  const instSlotIds = Object.keys(instance.slotValues).sort()
  if (tplSlotIds.length !== instSlotIds.length) return false
  return tplSlotIds.every((id, i) => id === instSlotIds[i])
}

export function staleInstances(
  instances: TemplateInstance[], byId: (id: string) => Template | undefined,
): { instance: TemplateInstance; template: Template }[] {
  const out: { instance: TemplateInstance; template: Template }[] = []
  for (const instance of instances) {
    const template = byId(instance.templateId)
    if (!template) continue
    if (instance.templateVersion < template.version && slotCompatible(template, instance)) out.push({ instance, template })
  }
  return out
}

export function updateInstance(
  current: { layers: LocalLayer[]; groups: LayerGroup[] },
  t: Template,
  instance: TemplateInstance,
  ctx: { mkLayerId: () => string; mkGroupId: () => string },
): { layers: LocalLayer[]; groups: LayerGroup[]; instance: TemplateInstance } {
  // Remove this copy's placed layers, then re-materialize from the new template,
  // preserving slot values and reusing placed ids where the key still exists.
  const placedIds = new Set(Object.values(instance.placedKeys))
  const kept = current.layers.filter(l => !placedIds.has(l.id))
  const re = placeTemplate({ layers: kept, groups: current.groups }, t, instance.slotValues, {
    mkLayerId: ctx.mkLayerId, mkGroupId: ctx.mkGroupId, mkInstanceId: () => instance.instanceId,
  })
  // Reuse prior placed ids for keys that survived, so animation/mask refs stay put.
  for (const [key, oldId] of Object.entries(instance.placedKeys)) {
    const newId = re.instance.placedKeys[key]
    if (!newId) continue
    const layer = re.layers.find(l => l.id === newId); if (layer) (layer as any).id = oldId
    re.instance.placedKeys[key] = oldId
  }
  return { layers: re.layers, groups: re.groups, instance: re.instance }
}

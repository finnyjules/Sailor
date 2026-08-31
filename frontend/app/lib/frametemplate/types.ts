import type { LocalLayer } from '~/composables/useCompositorLayers'
import type { LayerGroup } from '~/lib/compositor/layerGroups'

export type SlotKind = 'text' | 'color' | 'image'

export interface SlotMark {
  id: string
  layerKey: string
  kind: SlotKind
  label: string
}

export interface TemplateLayer {
  key: string
  layer: LocalLayer
}

export interface Template {
  id: string
  name: string
  version: number
  layers: TemplateLayer[]
  groups: LayerGroup[]
  slots: SlotMark[]
  frameSize: { w: number; h: number }
}

export interface TemplateInstance {
  instanceId: string
  templateId: string
  templateVersion: number
  slotValues: Record<string, string>
  /** The kind each slot had at placement time, so a later template version that keeps a slot's
   *  id but changes its kind (e.g. text → color) is correctly treated as incompatible. */
  slotKinds: Record<string, SlotKind>
  placedKeys: Record<string, string>
}

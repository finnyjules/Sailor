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
  placedKeys: Record<string, string>
}

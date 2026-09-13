<script lang="ts">
import type { Component } from 'vue'
import { Droplets, Sparkles, Grid3x3, Ghost, Palette, Wind, Grip, Aperture, Tv2, Layers, Sun, Square, Scan, Hexagon, SquareDashed, Sticker, Spline, CloudFog, Gem, Hash, Shell } from 'lucide-vue-next'
import type { TreatmentKind } from '~/lib/scene3d/treatments'
/** Shared with the object row's add menu so a kind has ONE icon everywhere. */
export const TREATMENT_ICONS: Record<TreatmentKind, Component> = {
  blur: Droplets, glow: Sparkles, pixelate: Grid3x3, fade: Ghost, colorGrade: Palette, dissolve: Wind, halftone: Grip, chromaticSplit: Aperture, glitch: Tv2, dropShadow: Layers,
  rimLight: Sun, outline: Square, xray: Scan, wireframe: Hexagon,
  dashedOutline: SquareDashed, silhouetteCutout: Sticker,
  edgeLines: Spline, depthFog: CloudFog, curvatureWear: Gem, crossHatch: Hash,
  opalescence: Shell,
}
</script>

<script setup lang="ts">
// One treatment row under its object in the Objects tree (design spec §2). A pseudo-child:
// it is NOT a scene object, so selection, delete and duplicate are routed to the surface's
// treatment handlers, never the object ones. Drag-and-drop reorders within the parent's
// list only — the parent row decides whether a drop is legal.
import { Eye, EyeOff, Copy, Trash2 } from 'lucide-vue-next'
import { TREATMENT_LABELS, type Treatment } from '~/lib/scene3d/treatments'

defineProps<{
  treatment: Treatment
  objectId: string
  depth: number
  selected: boolean
  /** True when this frame's plan skipped the treatment (cap or second inversion). */
  notRendered: boolean
}>()
const emit = defineEmits<{
  select: [objectId: string, treatmentId: string]
  remove: [objectId: string, treatmentId: string]
  duplicate: [objectId: string, treatmentId: string]
  toggleEnabled: [objectId: string, treatmentId: string]
  dragStart: [objectId: string, treatmentId: string]
  dropOn: [objectId: string, treatmentId: string]
}>()
</script>

<template>
  <div class="group flex items-center gap-2 rounded px-2 py-1 text-xs"
    data-testid="treatment-row" :data-treatment-id="treatment.id" :data-treatment-kind="treatment.kind" :data-object-id="objectId"
    :class="[selected ? 'bg-white/15' : 'hover:bg-white/5', treatment.enabled ? '' : 'opacity-50']"
    :style="{ paddingLeft: `${8 + depth * 12}px` }"
    draggable="true"
    @click.stop="emit('select', objectId, treatment.id)"
    @dragstart="($event.dataTransfer?.setData('text/plain', treatment.id), emit('dragStart', objectId, treatment.id))"
    @dragover.prevent
    @drop.prevent="emit('dropOn', objectId, treatment.id)">
    <span class="w-2 shrink-0" />
    <component :is="TREATMENT_ICONS[treatment.kind]" class="h-3.5 w-3.5 shrink-0 opacity-60" />
    <span class="flex-1 truncate">{{ TREATMENT_LABELS[treatment.kind] }}</span>
    <span v-if="notRendered" data-testid="treatment-not-rendered"
      class="shrink-0 text-[10px] text-amber-300/80"
      title="Too many treated objects this frame, or a second Everything else — this one is not drawn">Not rendered</span>
    <button type="button" :class="treatment.enabled ? 'opacity-0 group-hover:opacity-70' : 'opacity-70'"
      :aria-label="treatment.enabled ? 'Hide treatment' : 'Show treatment'"
      @click.stop="emit('toggleEnabled', objectId, treatment.id)">
      <component :is="treatment.enabled ? Eye : EyeOff" class="h-3.5 w-3.5" />
    </button>
    <button type="button" class="opacity-0 group-hover:opacity-70" aria-label="Duplicate treatment"
      @click.stop="emit('duplicate', objectId, treatment.id)"><Copy class="h-3.5 w-3.5" /></button>
    <button type="button" class="opacity-0 group-hover:opacity-70" aria-label="Remove treatment"
      @click.stop="emit('remove', objectId, treatment.id)"><Trash2 class="h-3.5 w-3.5" /></button>
  </div>
</template>

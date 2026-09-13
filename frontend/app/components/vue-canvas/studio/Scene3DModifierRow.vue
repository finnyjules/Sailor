<script lang="ts">
import type { Component } from 'vue'
import { Grid2x2, Triangle, Tornado, Spline, Waves, Vibrate, Boxes,
  Move, Circle, Blend, Droplet, Grid3x3, Orbit, Slice, FlipHorizontal2, Minimize2, Box, Combine } from 'lucide-vue-next'
import type { ModifierKind } from '~/lib/scene3d/modifierStack'
/** Shared with the object row's add menu so a kind has ONE icon everywhere. */
export const MODIFIER_ICONS: Record<ModifierKind, Component> = {
  subdivide: Grid2x2, taper: Triangle, twist: Tornado, bend: Spline,
  noise: Waves, jitter: Vibrate, cloner: Boxes,
  shear: Move, spherify: Circle, smooth: Blend, melt: Droplet, lattice: Grid3x3,
  array: Orbit, shatter: Slice, mirror: FlipHorizontal2, decimate: Minimize2,
  voxelise: Box, boolean: Combine,
}
</script>

<script setup lang="ts">
// One modifier row under its primitive in the Objects tree — the treatment-row UX applied to
// the modifier stack (design spec §2 / S1 Task 5). A pseudo-child: it is NOT a scene object, so
// selection, delete and duplicate are routed to the surface's modifier handlers, which run every
// mutation through modifierStackOf → list op → writeModifierStack (keeping the Vary bag alive).
//
// Subdivide and the cloner are PINNED (subdivide always first, cloner always last, one of each):
// they carry a pin affordance instead of a drag handle and are refused as a drag source/target
// by the surface's canReorderModifier guard. Drag-reorder reorders only within THIS object's
// orderable middle region — the parent row decides whether a drop is legal.
import { computed } from 'vue'
import { Eye, EyeOff, Copy, Trash2, Pin } from 'lucide-vue-next'
import { MODIFIER_LABELS, isPinnedModifier, type ModifierInstance } from '~/lib/scene3d/modifierStack'

const props = defineProps<{
  modifier: ModifierInstance
  objectId: string
  depth: number
  selected: boolean
}>()
const emit = defineEmits<{
  select: [objectId: string, modifierId: string]
  remove: [objectId: string, modifierId: string]
  duplicate: [objectId: string, modifierId: string]
  toggleEnabled: [objectId: string, modifierId: string]
  dragStart: [objectId: string, modifierId: string]
  dropOn: [objectId: string, modifierId: string]
}>()

const pinned = computed(() => isPinnedModifier(props.modifier.kind))
</script>

<template>
  <div class="group flex items-center gap-2 rounded px-2 py-1 text-xs"
    data-testid="modifier-row" :data-modifier-id="modifier.id" :data-kind="modifier.kind" :data-object-id="objectId"
    :class="[selected ? 'bg-white/15' : 'hover:bg-white/5', modifier.enabled ? '' : 'opacity-50']"
    :style="{ paddingLeft: `${8 + depth * 12}px` }"
    :draggable="!pinned"
    @click.stop="emit('select', objectId, modifier.id)"
    @dragstart="($event.dataTransfer?.setData('text/plain', modifier.id), emit('dragStart', objectId, modifier.id))"
    @dragover.prevent
    @drop.prevent="emit('dropOn', objectId, modifier.id)">
    <span class="w-2 shrink-0" />
    <component :is="MODIFIER_ICONS[modifier.kind]" class="h-3.5 w-3.5 shrink-0 opacity-60" />
    <span class="flex-1 truncate">{{ MODIFIER_LABELS[modifier.kind] }}</span>
    <Pin v-if="pinned" data-testid="modifier-pinned"
      class="h-3 w-3 shrink-0 opacity-30" title="Pinned — subdivide runs first, the cloner last" />
    <button type="button" :class="modifier.enabled ? 'opacity-0 group-hover:opacity-70' : 'opacity-70'"
      :aria-label="modifier.enabled ? 'Hide modifier' : 'Show modifier'"
      @click.stop="emit('toggleEnabled', objectId, modifier.id)">
      <component :is="modifier.enabled ? Eye : EyeOff" class="h-3.5 w-3.5" />
    </button>
    <button v-if="!pinned" type="button" class="opacity-0 group-hover:opacity-70" aria-label="Duplicate modifier"
      @click.stop="emit('duplicate', objectId, modifier.id)"><Copy class="h-3.5 w-3.5" /></button>
    <button type="button" class="opacity-0 group-hover:opacity-70" aria-label="Remove modifier"
      @click.stop="emit('remove', objectId, modifier.id)"><Trash2 class="h-3.5 w-3.5" /></button>
  </div>
</template>

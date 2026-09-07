<script setup lang="ts">
// One effect row under its layer in the Compositor's layer tree. A pseudo-child: it is not a
// layer, so every event is routed to the modal's effect handlers, never the layer ones.
// Drag reorders within the layer's own orderable region — the modal decides whether a drop
// is legal (a pinned row refuses). The drop stops propagating so it never also reaches the
// layer list's own drop handler, and `dragEnd` fires even on an aborted drag so the modal
// can clear its drag state instead of leaving it armed for the next, unrelated drop.
import { Eye, EyeOff, Copy, Trash2, Pin } from 'lucide-vue-next'
import { EFFECT_LABELS, type EffectInstance } from '~/lib/compositor/effectStack'

defineProps<{
  effect: EffectInstance
  layerId: string
  depth: number
  selected: boolean
  /** Pinned kinds (background blur, depth of field, drop shadow) cannot move. */
  pinned: boolean
}>()
const emit = defineEmits<{
  select: [layerId: string, effectId: string]
  remove: [layerId: string, effectId: string]
  duplicate: [layerId: string, effectId: string]
  toggleVisible: [layerId: string, effectId: string]
  dragStart: [layerId: string, effectId: string]
  dropOn: [layerId: string, effectId: string]
  /** The drag finished — dropped anywhere, or aborted with Escape / outside the list. */
  dragEnd: []
}>()

function onDragStart(ev: DragEvent, layerId: string, effectId: string) {
  // Firefox refuses to start a drag with no payload.
  ev.dataTransfer?.setData('text/plain', effectId)
  emit('dragStart', layerId, effectId)
}
</script>

<template>
  <div
    class="group/fx flex items-center gap-1.5 pr-2 py-1 rounded transition-colors cursor-pointer"
    data-testid="effect-row"
    :data-effect-id="effect.id"
    :data-effect-kind="effect.type"
    :data-layer-id="layerId"
    :style="{ paddingLeft: (depth * 14 + 4) + 'px' }"
    :class="[
      selected ? 'bg-white/10' : 'hover:bg-white/[0.04]',
      effect.visible ? '' : 'opacity-50',
      'border-l border-white/10',
    ]"
    :draggable="!pinned"
    @click.stop="emit('select', layerId, effect.id)"
    @dragstart="onDragStart($event, layerId, effect.id)"
    @dragend="emit('dragEnd')"
    @dragover.prevent
    @drop.prevent.stop="emit('dropOn', layerId, effect.id)"
  >
    <span class="w-3 shrink-0" />
    <Pin v-if="pinned" class="size-3 text-white/30 shrink-0" title="Fixed position in the pipeline" />
    <span v-else class="w-3 shrink-0" />
    <span class="text-xs truncate flex-1 text-white/70">{{ EFFECT_LABELS[effect.type] }}</span>
    <button type="button" class="shrink-0 text-white/40 hover:text-white/80"
      :class="effect.visible ? 'opacity-0 group-hover/fx:opacity-100' : 'opacity-100'"
      :aria-label="effect.visible ? 'Hide effect' : 'Show effect'"
      @click.stop="emit('toggleVisible', layerId, effect.id)">
      <component :is="effect.visible ? Eye : EyeOff" class="size-3.5" />
    </button>
    <button v-if="!pinned" type="button" class="shrink-0 opacity-0 group-hover/fx:opacity-100 text-white/40 hover:text-white/80"
      aria-label="Duplicate effect" @click.stop="emit('duplicate', layerId, effect.id)">
      <Copy class="size-3.5" />
    </button>
    <button type="button" class="shrink-0 opacity-0 group-hover/fx:opacity-100 text-white/40 hover:text-white/80"
      aria-label="Remove effect" @click.stop="emit('remove', layerId, effect.id)">
      <Trash2 class="size-3.5" />
    </button>
  </div>
</template>

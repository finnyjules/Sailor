<script setup lang="ts">
// One stroke row under its layer in the Compositor's layer tree — the sibling of
// CompositorEffectRow, with stroke words. A pseudo-child: it is not a layer, so every event
// routes to the modal's stroke handlers, never the layer ones. Drag reorders within the
// layer's own strokes; the drop stops propagating so it never also reaches the layer list's
// drop handler, and `dragEnd` fires even on an aborted drag so the modal can clear its drag
// state instead of leaving it armed for the next, unrelated drop.
//
// No `pinned`: unlike effects, no stroke has a fixed position in the list — every one of
// them can move. Accessibility is the effect row's, statement for statement (role/tabindex,
// Enter and Space select, hover buttons revealing on `group-focus-within` too), because
// "effect rows a keyboard could not reach" was a finding in that feature's own review.
import { Eye, EyeOff, Copy, Trash2 } from 'lucide-vue-next'
import FillSwatch from '~/components/vue-canvas/compositor/FillSwatch.vue'
import { strokeRowLabel, type StrokeInstance } from '~/lib/compositor/strokeStack'

const props = defineProps<{
  stroke: StrokeInstance
  layerId: string
  depth: number
  selected: boolean
  /** Output width in px — `strokeRowLabel` turns the stored normalized width into the same
   *  px the inspector's own size fields show. */
  outWidth: number
}>()
const emit = defineEmits<{
  select: [layerId: string, strokeId: string]
  remove: [layerId: string, strokeId: string]
  duplicate: [layerId: string, strokeId: string]
  toggleVisible: [layerId: string, strokeId: string]
  dragStart: [layerId: string, strokeId: string]
  dropOn: [layerId: string, strokeId: string]
  /** The drag finished — dropped anywhere, or aborted with Escape / outside the list. */
  dragEnd: []
}>()

const label = () => strokeRowLabel(props.stroke, props.outWidth)

function onDragStart(ev: DragEvent, layerId: string, strokeId: string) {
  // Firefox refuses to start a drag with no payload.
  ev.dataTransfer?.setData('text/plain', strokeId)
  emit('dragStart', layerId, strokeId)
}
</script>

<template>
  <div
    class="group/st flex items-center gap-1.5 pr-2 py-1 rounded transition-colors cursor-pointer"
    data-testid="stroke-row"
    :data-stroke-id="stroke.id"
    :data-layer-id="layerId"
    :style="{ paddingLeft: (depth * 14 + 4) + 'px' }"
    :class="[
      selected ? 'bg-white/10' : 'hover:bg-white/[0.04]',
      stroke.visible === false ? 'opacity-50' : '',
      'border-l border-white/10',
    ]"
    draggable="true"
    role="button"
    tabindex="0"
    :aria-label="'Outline — ' + label()"
    @click.stop="emit('select', layerId, stroke.id)"
    @keydown.enter.prevent="emit('select', layerId, stroke.id)"
    @keydown.space.prevent="emit('select', layerId, stroke.id)"
    @dragstart="onDragStart($event, layerId, stroke.id)"
    @dragend="emit('dragEnd')"
    @dragover.prevent
    @drop.prevent.stop="emit('dropOn', layerId, stroke.id)"
  >
    <span class="w-3 shrink-0" />
    <!-- The stroke's own paint, so a stack of four reads at a glance. -->
    <FillSwatch :paint="stroke.paint" :size="12" />
    <span class="text-xs truncate flex-1 text-white/70">{{ label() }}</span>
    <button type="button" class="shrink-0 text-white/40 hover:text-white/80"
      :class="stroke.visible === false ? 'opacity-100' : 'opacity-0 group-hover/st:opacity-100 group-focus-within/st:opacity-100'"
      :aria-label="stroke.visible === false ? 'Show outline' : 'Hide outline'"
      @click.stop="emit('toggleVisible', layerId, stroke.id)">
      <component :is="stroke.visible === false ? EyeOff : Eye" class="size-3.5" />
    </button>
    <button type="button" class="shrink-0 opacity-0 group-hover/st:opacity-100 group-focus-within/st:opacity-100 text-white/40 hover:text-white/80"
      aria-label="Duplicate outline" @click.stop="emit('duplicate', layerId, stroke.id)">
      <Copy class="size-3.5" />
    </button>
    <button type="button" class="shrink-0 opacity-0 group-hover/st:opacity-100 group-focus-within/st:opacity-100 text-white/40 hover:text-white/80"
      aria-label="Remove outline" @click.stop="emit('remove', layerId, stroke.id)">
      <Trash2 class="size-3.5" />
    </button>
  </div>
</template>

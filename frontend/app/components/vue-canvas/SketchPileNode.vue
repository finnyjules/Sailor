<!-- frontend/app/components/vue-canvas/SketchPileNode.vue -->
<script setup lang="ts">
// Frontend-only sketch results deck (spec 2026-07-21-sketch-pile-design.md):
// one pile node holding the batch of cheap options in properties.sailor_sketch.
// Click (a true click, not a drag) or the expand rail button opens the
// canvas-owned stack overlay — the choose-one moment. Wears the dashed sketch
// token; shimmers while a (re-)sketch is in flight.
import { Maximize2 } from 'lucide-vue-next'
import { SKETCH_PROP, type SketchPilePayload } from '~/lib/sketch/sketchPile'
import PileStack from './PileStack.vue'

const props = defineProps<{ id: string; data: any; selected?: boolean }>()

const payload = computed<SketchPilePayload | null>(
  () => props.data?.properties?.[SKETCH_PROP] ?? null)
const images = computed(() => (payload.value?.items ?? []).map(i => i.image))
const loading = computed(() => !!payload.value?.loading)

function openStack() {
  window.dispatchEvent(new CustomEvent('sailor:openSketchStack', { detail: { nodeId: props.id } }))
}

// Click-vs-drag: Vue Flow drags start on pointerdown; only open the stack for
// a true click (pointer travelled < 5px), so moving the pile doesn't pop it.
let downAt: { x: number, y: number } | null = null
function onPointerDown(e: PointerEvent) { downAt = { x: e.clientX, y: e.clientY } }
function onClick(e: MouseEvent) {
  if (loading.value && !images.value.length) return // nothing to expand yet
  if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) >= 5) return
  openStack()
}

const btnCls = 'size-7 rounded-md bg-black/55 hover:bg-black/75 backdrop-blur-sm border border-white/15 '
  + 'flex items-center justify-center text-white/75 hover:text-white transition-colors cursor-pointer shadow-md'
</script>

<template>
  <div class="content-card w-[220px] select-none" :data-selected="selected || undefined" @pointerdown="onPointerDown" @click="onClick">
    <div class="content-card__name"><span class="truncate flex-1 min-w-0">Sketches</span></div>
    <PileStack
      :images="images"
      :seed-key="String(props.id)"
      :selected="selected"
      dashed
      :loading="loading"
    >
      <template #rail>
        <button v-if="images.length" :class="btnCls" title="Expand" @click.stop="openStack">
          <Maximize2 class="size-3.5" />
        </button>
      </template>
    </PileStack>
  </div>
</template>

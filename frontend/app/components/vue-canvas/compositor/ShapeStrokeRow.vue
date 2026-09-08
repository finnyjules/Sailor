<script setup lang="ts">
/**
 * The extra rows a `style: 'shapes'` stroke gets: which library shape marches along the
 * edge, how big each mark is, how far apart they sit, and whether they turn with the edge.
 *
 * Every dial here is read by `paintShapeStroke` (useCompositorLayers.ts) — `spec.shapeId`
 * through `shapeById`, `spec.size`/`spec.spacing` through its own `size > 0` / `spacing > 0`
 * gates, and `spec.follow !== false` as the per-mark rotation. Nothing else on the stroke
 * reaches that painter, which is why the band's Width, Alignment, Corners and Dash rows are
 * hidden while Shapes is picked rather than shown and ignored.
 *
 * `size` and `spacing` are stored in the SAME units as a band's `width` (normalized to
 * canvas width, or a path layer's local units at scale 1), so the px conversion is
 * StrokeStyleRow's, `scale` and all.
 *
 * Emits ONE patch per edit — the host writes it onto the stroke and through
 * `writeStrokeStackToLayer` in a single `setLocal`, so an edit is one undo step.
 */
import { computed, ref } from 'vue'
import ShapePicker from '~/components/vue-canvas/studio/ShapePicker.vue'
import { shapeById } from '~/lib/shapes/catalog'
import { SHAPE_PICKER_WIDTH } from '~/lib/shapes/pickerLayout'
import type { ShapeStrokeSpec } from '~/lib/compositor/strokeStack'

const props = defineProps<{
  spec: ShapeStrokeSpec
  /** Output width in px — the same scale every other size field in this inspector uses. */
  outWidth: number
  /** A path layer's `(layer.scale || 1)`; see StrokeStyleRow's own `scale` doc. */
  scale?: number
}>()
const emit = defineEmits<{ (e: 'update', patch: Partial<ShapeStrokeSpec>): void }>()

const scale = computed(() => {
  const s = props.scale
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : 1
})
const px = (norm: number) => Math.round(norm * props.outWidth * scale.value)
const norm = (v: number) => Math.max(0, v) / (props.outWidth * scale.value)

const shape = computed(() => shapeById(props.spec.shapeId))
/** The picker's own `modelValue` must be a real id; an unset/unknown one shows as no
 *  selection rather than as a bogus tile. */
const shapeName = computed(() => shape.value?.name ?? 'Choose a shape')
const follow = computed(() => props.spec.follow !== false)

const pickerOpen = ref(false)
const anchor = ref({ x: 0, y: 0 })
const buttonRef = ref<HTMLElement | null>(null)
function openPicker() {
  if (pickerOpen.value) { pickerOpen.value = false; return }
  const r = buttonRef.value?.getBoundingClientRect()
  anchor.value = r ? { x: r.right - SHAPE_PICKER_WIDTH, y: r.bottom + 4 } : { x: 16, y: 16 }
  pickerOpen.value = true
}

const numClass = 'w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none'
</script>

<template>
  <div class="space-y-1.5" data-testid="stroke-shapes-rows">
    <div>
      <div class="panel-label mb-1.5">Shape</div>
      <button
        ref="buttonRef"
        type="button"
        data-stroke-shape
        class="w-full flex items-center gap-2 bg-white/[0.04] hover:bg-white/[0.08] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 cursor-pointer transition-colors"
        title="Pick the shape that marches along the edge"
        @click="openPicker"
      >
        <svg v-if="shape" viewBox="0 0 96 96" class="size-4 shrink-0" fill="currentColor" aria-hidden="true"><path :d="shape.d" :fill-rule="shape.fillRule" /></svg>
        <span class="flex-1 text-left">{{ shapeName }}</span>
      </button>
      <ShapePicker
        v-if="pickerOpen"
        :model-value="spec.shapeId"
        :allow-none="false"
        :anchor="anchor"
        :ignore="buttonRef"
        @update:model-value="(id: string) => emit('update', { shapeId: id })"
        @close="pickerOpen = false"
      />
    </div>
    <div class="grid grid-cols-2 gap-1.5">
      <div>
        <div class="panel-label mb-1">Size</div>
        <input v-scrubnum type="number" min="0" step="1" :value="px(spec.size)" :class="numClass" data-stroke-shape-size
          @input="emit('update', { size: norm(parseFloat(($event.target as HTMLInputElement).value) || 0) })">
      </div>
      <div>
        <div class="panel-label mb-1">Spacing</div>
        <input v-scrubnum type="number" min="0" step="1" :value="px(spec.spacing)" :class="numClass" data-stroke-shape-spacing
          @input="emit('update', { spacing: norm(parseFloat(($event.target as HTMLInputElement).value) || 0) })">
      </div>
    </div>
    <label class="flex items-center gap-2 text-xs text-white/70 cursor-pointer">
      <input type="checkbox" class="accent-white cursor-pointer" data-stroke-shape-follow
        :checked="follow" @change="emit('update', { follow: ($event.target as HTMLInputElement).checked })">
      Turn with the edge
    </label>
  </div>
</template>

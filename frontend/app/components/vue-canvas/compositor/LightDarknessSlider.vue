<script setup lang="ts">
/** Darkness (Frame light layers, stage 1): how dark the Frame sits around its lights, 0–100%.
 *  One undo step per gesture; a drag repaints through the lighting fast path. */
import StudioSlider from '~/components/vue-canvas/studio/StudioSlider.vue'
import { DEFAULT_LIGHTING } from '~/lib/frame/lighting/settings'
import { nudgeLightingDrag } from '~/lib/frame/lighting/drag'
import { sliderGesture } from '~/lib/frame/lighting/gesture'

defineProps<{ darkness: number }>()
const emit = defineEmits<{ update: [value: number, record: boolean] }>()
const gesture = sliderGesture()
function onInput(v: number) {
  nudgeLightingDrag()
  emit('update', Math.min(1, Math.max(0, v / 100)), gesture.take())
}
</script>

<template>
  <div data-testid="light-darkness" @pointerdown.capture="gesture.start()">
    <StudioSlider label="Darkness" hint="Applies to the whole Frame" :min="0" :max="100" :step="1"
      :default="Math.round(DEFAULT_LIGHTING.darkness * 100)" :bindable="false"
      :model-value="Math.round(darkness * 100)" @update:model-value="onInput" />
  </div>
</template>

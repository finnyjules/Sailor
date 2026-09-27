<!-- app/components/vue-canvas/compositor/BrushSnapFeedback.vue -->
<script setup lang="ts">
// Canvas overlay for hold-to-snap: a filling ring while the finger holds still,
// then a tag naming the shape it snapped to. No hand trail, no tether.
import { computed } from 'vue'

const props = defineProps<{ x: number; y: number; progress: number | null; label: string | null }>()

const R = 12
const STROKE = 2.5
const CIRC = 2 * Math.PI * R

const dashoffset = computed(() => CIRC * (1 - Math.min(1, Math.max(0, props.progress ?? 0))))
</script>

<template>
  <div
    class="brush-snap-feedback"
    :style="{ position: 'absolute', left: `${x}px`, top: `${y}px`, pointerEvents: 'none' }"
  >
    <svg
      v-if="progress !== null"
      data-testid="brush-hold-ring"
      class="ring"
      :width="(R + STROKE) * 2"
      :height="(R + STROKE) * 2"
      :viewBox="`0 0 ${(R + STROKE) * 2} ${(R + STROKE) * 2}`"
    >
      <circle
        :cx="R + STROKE"
        :cy="R + STROKE"
        :r="R"
        fill="none"
        stroke="rgba(216,199,255,.95)"
        :stroke-width="STROKE"
        :stroke-dasharray="CIRC"
        :stroke-dashoffset="dashoffset"
        stroke-linecap="round"
        transform="rotate(-90 14.5 14.5)"
      />
    </svg>
    <div v-if="label !== null" class="tag" data-testid="brush-snap-tag">{{ label }}</div>
  </div>
</template>

<style scoped>
.brush-snap-feedback {
  pointer-events: none;
}
.ring {
  position: absolute;
  left: -14.5px;
  top: -14.5px;
}
.tag {
  position: absolute;
  transform: translate(14px, -34px);
  background: #d8c7ff;
  color: #1a1424;
  font-size: 12px;
  font-weight: 600;
  padding: 6px 10px;
  border-radius: 999px;
  white-space: nowrap;
}
</style>

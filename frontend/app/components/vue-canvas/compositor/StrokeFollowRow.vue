<!-- frontend/app/components/vue-canvas/compositor/StrokeFollowRow.vue -->
<script setup lang="ts">
/**
 * The rows a stroke gets when its fill can FOLLOW THE LINE: the Fill choice itself, and — for an
 * ombre that follows — which way its grain fades and, along the line, how many times.
 *
 * Every row is gated by `strokeInspectorRows` (the modal passes the answers in as `show*`), the
 * same way StrokeStyleRow is: the painter decides what is live, this only draws it.
 * Emits ONE value per edit; the host writes it onto the stroke in a single `setLocal`.
 */
import { STROKE_FOLLOW_OPTIONS, STROKE_FADE_OPTIONS } from '~/lib/compositor/strokeInspector'
import type { StrokeFade } from '~/lib/compositor/strokeStack'

defineProps<{
  follow: boolean
  fade: StrokeFade
  fadeRepeats: number
  showFollow: boolean
  showFade: boolean
  showFadeRepeats: boolean
}>()
const emit = defineEmits<{
  (e: 'update:follow', v: boolean): void
  (e: 'update:fade', v: StrokeFade): void
  (e: 'update:fadeRepeats', v: number): void
}>()
const numClass = 'w-full bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1.5 text-xs text-white/90 outline-none'
const selClass = numClass + ' cursor-pointer'
</script>

<template>
  <div v-if="showFollow" class="space-y-1.5">
    <div>
      <div class="panel-label mb-1.5">Fill</div>
      <select :value="follow ? 'follow' : 'still'" :class="selClass" data-stroke-follow
        @change="emit('update:follow', ($event.target as HTMLSelectElement).value === 'follow')">
        <option v-for="o in STROKE_FOLLOW_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div v-if="showFade">
      <div class="panel-label mb-1.5">Ombre fades</div>
      <select :value="fade" :class="selClass" data-stroke-fade
        @change="emit('update:fade', ($event.target as HTMLSelectElement).value as StrokeFade)">
        <option v-for="o in STROKE_FADE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div v-if="showFadeRepeats">
      <div class="panel-label mb-1">Repeats</div>
      <input v-scrubnum type="number" min="1" max="50" step="1" :value="fadeRepeats" :class="numClass" data-stroke-fade-repeats
        @input="emit('update:fadeRepeats', Math.max(1, Math.min(50, Math.round(parseFloat(($event.target as HTMLInputElement).value) || 1))))">
    </div>
  </div>
</template>

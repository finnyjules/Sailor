<script setup lang="ts">
// The Frame's one light, as seen from a finish's inspector: four presets plus a pointer to the
// on-canvas handle. Shared by Gold foil and Spot UV so the two never drift.
import { computed } from 'vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import { LIGHT_PRESETS, LIGHT_PRESET_LABELS, presetOf, type FrameLight, type LightPreset } from '~/lib/compositor/frameLight'

const props = defineProps<{ light: FrameLight }>()
const emit = defineEmits<{ update: [light: FrameLight] }>()
const keys = Object.keys(LIGHT_PRESETS) as LightPreset[]
const current = computed<string>({
  get: () => presetOf(props.light) ?? '',
  set: (k: string) => { const p = LIGHT_PRESETS[k as LightPreset]; if (p) emit('update', { ...p }) },
})
</script>

<template>
  <div class="space-y-1" data-testid="finish-light-preset">
    <p class="text-xs text-white/50">Light</p>
    <StudioSegmented v-model="current" :options="keys" :option-labels="keys.map(k => LIGHT_PRESET_LABELS[k])" />
    <p class="text-[11px] text-white/40">Drag the light on the canvas to move it. Every finish on this Frame shares it.</p>
  </div>
</template>

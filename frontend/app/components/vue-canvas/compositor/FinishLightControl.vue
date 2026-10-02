<script setup lang="ts">
// The Frame's one light, as seen from a finish's inspector: four presets plus a pointer to the
// on-canvas handle. Shared by Gold foil and Spot UV so the two never drift.
import { computed } from 'vue'
import StudioSegmented from '~/components/vue-canvas/studio/StudioSegmented.vue'
import { LIGHT_PRESETS, LIGHT_PRESET_LABELS, presetOf, type FrameLight, type LightPreset } from '~/lib/compositor/frameLight'

// `framelit`: the Frame has light layers, so the finish is lit by them and the hidden light's presets retire.
const props = defineProps<{ light: FrameLight; framelit?: boolean }>()
const emit = defineEmits<{ update: [light: FrameLight]; 'select-light': [] }>()
const keys = Object.keys(LIGHT_PRESETS) as LightPreset[]
const current = computed<string>({
  get: () => presetOf(props.light) ?? '',
  set: (k: string) => { const p = LIGHT_PRESETS[k as LightPreset]; if (p) emit('update', { ...p }) },
})
</script>

<template>
  <div v-if="framelit" class="space-y-1" data-testid="finish-light-framelit-row">
    <p class="text-xs text-white/50">
      <span title="Every light on this Frame lights the finish." class="cursor-help underline decoration-dotted decoration-white/20 underline-offset-2">Light</span>
    </p>
    <button type="button" data-testid="finish-light-framelit"
      class="w-full rounded-md border border-white/10 bg-white/5 px-2.5 py-1.5 text-left text-xs text-white/80 hover:bg-white/10"
      @click="emit('select-light')">Lit by the Frame's lights</button>
  </div>
  <div v-else class="space-y-1" data-testid="finish-light-preset">
    <p class="text-xs text-white/50">Light</p>
    <StudioSegmented v-model="current" :options="keys" :option-labels="keys.map(k => LIGHT_PRESET_LABELS[k])" />
    <p class="text-[11px] text-white/40">Drag the light on the canvas to move it. Every finish on this Frame shares it.</p>
  </div>
</template>
